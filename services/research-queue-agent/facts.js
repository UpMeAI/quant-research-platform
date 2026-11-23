'use strict';
/**
 * 事实包 RQ_CHECK_FACT_PACK_V1 / REVIEW_AI_FACT_PACK_V1 的检查（§5.6、§5.9）：形状、来源防火墙（RF1116 §3.4）、核对报告不得当输入、作者行（AQ-44）、
 * 单次调用的 token 上限与按矩阵行切分，以及「文字里的数字必须在被引用的事实里」用的数字抽取。纯函数，不读文件。
 */
const { canonicalJson, isObj, SHA64, SECRET_SHAPED } = require('./canon');

const MAX_CALL_TOKENS = 40000;
const FACT_ID = /^F-\d{3,}$/;
const FACT_ID_G = /F-\d+/g;
const MINING_OUT = /(^|\/)mining[^/]*\/(.*\/)?out(\/|$)/i;
const FORBIDDEN_FILE = /(MINING_SELECTION_V1|MINING_GATE_RECORD_V1)/;
const VAULT_PATH = /(^|\/)(vaults?|holdout[-_]vaults?)(\/|$)/i;
const RACE_PAPER_PATH = /(^|\/)(race|paper)\/results?(\/|$)/i;
const FORBIDDEN_TYPE = /^(MINING_SELECTION|MINING_GATE_RECORD|VAULT_EVENT|HOLDOUT_VAULT|RACE_RESULT|PAPER_RESULT)/;
const CHECK_REPORT_PATH = /check_report/i;
const FORBIDDEN_KEY = /owner|desk/i;

/** 这条事实的来源在防火墙后面吗？ */
function firewallHit(fact) {
  const s = (fact && fact.source) || {};
  const p = typeof s.path === 'string' ? s.path : '';
  return MINING_OUT.test(p) || FORBIDDEN_FILE.test(p) || VAULT_PATH.test(p) || RACE_PAPER_PATH.test(p) || (typeof s.record_type === 'string' && FORBIDDEN_TYPE.test(s.record_type));
}
const isCheckReportSource = (fact) => {
  const s = (fact && fact.source) || {};
  return s.record_type === 'RQ_CHECK_REPORT_V1' || (typeof s.path === 'string' && CHECK_REPORT_PATH.test(s.path));
};

/** 文字里的数字记号：带字母前缀的（RS60、W47、R1）是标识符，不算数字；F-nnn 先去掉。 */
function numericTokens(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const m of text.replace(FACT_ID_G, ' ').matchAll(/[A-Za-z_]*\d+(?:[.,]\d+)*/g)) {
    const n = Number(m[0].replace(/,/g, ''));   // identifiers with digits (RS60, W47, R1) are NaN here and skipped
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
const factNumbers = (fact) => new Set([...numericTokens(JSON.stringify(fact.value === undefined ? null : fact.value)), ...numericTokens(typeof fact.at === 'string' ? fact.at : '')]);

/** text 里每个数字都要出现在 citedIds 所引的事实里（没引用时 = 整个包的事实）。返回不在的数字。 */
function numbersNotInFacts(text, citedIds, factsById) {
  const universe = new Set();
  const ids = Array.isArray(citedIds) && citedIds.length ? citedIds : [...factsById.keys()];
  for (const id of ids) if (factsById.has(id)) for (const n of factNumbers(factsById.get(id))) universe.add(n);
  return numericTokens(text).filter((n) => !universe.has(n));
}

const estimateTokens = (obj) => Math.ceil(Buffer.byteLength(typeof obj === 'string' ? obj : JSON.stringify(obj)) / 3);
const factsMap = (pack) => new Map(((pack && pack.facts) || []).filter((f) => isObj(f) && typeof f.id === 'string').map((f) => [f.id, f]));

const WEEK_KEYS = ['week', 'weekId', 'week_id'];
/**
 * The ISO week of a fact pack. The desk writes `weekId` (REVIEW_AI_FACT_PACK_V1, ops/review-loop/ai-review-facts.cjs), the queue's own packs `week` / `week_id`. Every alias that is
 * present must be the same non-empty string; otherwise (none, empty, not a string, disagreeing) there is no week: null. rq/packshape.py reads the same keys.
 */
function packWeek(pack) {
  if (!isObj(pack)) return null;
  const present = WEEK_KEYS.filter((k) => k in pack).map((k) => pack[k]);
  return present.length > 0 && present.every((v) => typeof v === 'string' && v !== '' && v === present[0]) ? present[0] : null;
}

/**
 * The repeated-pattern counts of a pack, [{key, count, fact_id}]: the pack's own `code_counts` array when it has one (the queue's shape); otherwise one entry per code of every
 * COUNT fact (the desk's shape: value {subject, counts: {code: n}}), key `<subject>:<code>` (the subjects do not share a namespace), codes sorted, in fact order.
 * The card validator and the prompt's repeated_pattern_counts both read this, nothing else.
 */
function codeCounts(pack) {
  if (!isObj(pack)) return [];
  if (Array.isArray(pack.code_counts)) return pack.code_counts;
  const out = [];
  for (const f of Array.isArray(pack.facts) ? pack.facts : []) {
    const v = isObj(f) && f.kind === 'COUNT' && typeof f.id === 'string' ? f.value : null;
    if (!isObj(v) || typeof v.subject !== 'string' || v.subject === '' || !isObj(v.counts)) continue;
    for (const code of Object.keys(v.counts).sort()) if (Number.isInteger(v.counts[code])) out.push({ key: `${v.subject}:${code}`, count: v.counts[code], fact_id: f.id });
  }
  return out;
}

function scanKeys(v, found = []) {
  if (Array.isArray(v)) v.forEach((x) => scanKeys(x, found));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (FORBIDDEN_KEY.test(k)) found.push(k); scanKeys(x, found); }
  return found;
}

/**
 * @param {object} pack
 * @param {{purpose: 'CHECK'|'CARD'|'PROPOSAL'|'PREREG_BUNDLE'|'GENERATOR_VIEW', check_admission_sha256?: string, author_required?: boolean, maxTokens?: number}} o
 */
function checkPack(pack, o = {}) {
  const errors = [];
  const add = (code, detail) => errors.push({ code, detail });
  if (!isObj(pack) || !Array.isArray(pack.facts) || pack.facts.length === 0) { add('PACK_INVALID', 'facts'); return { ok: false, errors }; }
  const seen = new Set();
  for (const f of pack.facts) {
    const s = isObj(f) ? f.source : null;
    const good = isObj(f) && FACT_ID.test(f.id || '') && isObj(s) && typeof s.path === 'string' && s.path !== '' && SHA64.test(s.sha256 || '')
      && typeof s.pointer === 'string' && typeof f.at === 'string' && 'value' in f;
    if (!good) { add('PACK_FACT_INVALID', isObj(f) ? f.id : null); continue; }
    if (seen.has(f.id)) add('PACK_FACT_DUPLICATE', f.id);
    seen.add(f.id);
    if (firewallHit(f)) add('PACK_FIREWALL_SOURCE', f.id);
    if (o.purpose !== 'CHECK' && isCheckReportSource(f)) add('PACK_CHECK_REPORT_AS_INPUT', f.id);
  }
  const keys = [...scanKeys(pack.facts.map((f) => f && f.value)), ...scanKeys({ ...pack, facts: undefined })];
  if (keys.length) add('PACK_FORBIDDEN_FIELD', keys[0]);
  if (SECRET_SHAPED.test(JSON.stringify(pack))) add('PACK_SECRET_SHAPED');
  const m = pack.evidence_matrix;
  if (o.purpose === 'CHECK' && (!Array.isArray(m) || m.length === 0)) add('PACK_MATRIX_MISSING');
  if (Array.isArray(m)) {
    for (const row of m) {
      if (!isObj(row) || typeof row.req_id !== 'string' || !Array.isArray(row.fact_ids)) { add('PACK_MATRIX_INVALID'); continue; }
      for (const id of row.fact_ids) if (!seen.has(id)) add('PACK_MATRIX_FACT_UNKNOWN', `${row.req_id}:${id}`);
    }
  }
  if (estimateTokens(pack) > (o.maxTokens || MAX_CALL_TOKENS)) add('PACK_TOO_LARGE', estimateTokens(pack));
  if (o.purpose === 'CHECK') {
    const a = pack.author;
    if (a === undefined || a === null) { if (o.author_required) add('PACK_AUTHOR_MISSING'); }
    else if (!(isObj(a) && typeof a.kind === 'string' && a.kind && SHA64.test(a.prompt_admission_sha256 || '') && typeof a.model === 'string' && a.model)) add('PACK_AUTHOR_INVALID');
    else if (o.check_admission_sha256 && a.prompt_admission_sha256 === o.check_admission_sha256) add('PACK_AUTHOR_IS_CHECKER');
  }
  return { ok: errors.length === 0, errors };
}

/** 按矩阵行切：每部分只带它那些行引用的事实；一行不拆；贪心装到 maxTokens。 */
function splitPackByRow(pack, { maxTokens = MAX_CALL_TOKENS } = {}) {
  const make = (rows) => {
    const cited = new Set(rows.flatMap((r) => r.fact_ids));
    return { ...pack, evidence_matrix: rows, facts: pack.facts.filter((f) => cited.has(f.id)) };
  };
  const parts = [];
  let cur = [];
  for (const row of pack.evidence_matrix || []) {
    const rowsWith = [...cur, row];
    if (cur.length && estimateTokens(make(rowsWith)) > maxTokens) { parts.push(make(cur)); cur = [row]; } else cur = rowsWith;
  }
  if (cur.length) parts.push(make(cur));
  return parts;
}

module.exports = { MAX_CALL_TOKENS, FACT_ID, firewallHit, isCheckReportSource, numericTokens, numbersNotInFacts, estimateTokens, factsMap, packWeek, codeCounts, checkPack, splitPackByRow, canonicalJson };
