'use strict';

/**
 * G-MECH、K2 §0 四行、AI 输入检查 —— 研究框架修订 2026-11-12 §4.4、§5、§2.4（冻结审阅 E12–E15 取 (a)），
 * 接进海外与 A 股封存结论导入器（同一套 importVerdicts，在 G-TRIAL 之后）。
 *
 * 只对修订冻结之后才冻结的 K2 生效：entry.k2_frozen_at ≥ EFFECTIVE_FROM（FREEZE_1：2026-11-15T22:47:42+08:00，此前冻结的不追溯）。
 * 不适用的题导入器照原样写锁（锁行逐字节不变）。门只拒绝导入（失败即关），从不改写结论，也不替代导入器已有的校验。
 *
 *   K2 §0 四行（§5）：K2 正文（导入器按 sha256 复验后的字节）里四个固定标签都在、标签后不为空（K2_SECTION0_LINE_MISSING:<n>）；
 *     第 2、3 行只是披露，内容不评价。
 *   G-MECH（§4.4）：第 1 行写出的 id 集合 = entry.mechanism_ids；entry.mechanism_prior_table 按 sha256 绑定一份
 *     MECHANISM_PRIOR_TABLE_V1，且这个 sha256 写在 K2 正文里；表的 as_of 不晚于 K2 冻结；表写的登记表提交在 QRP git 里，
 *     那一版登记表的 sha256 与表一致，id 都在那一版里；用那一版登记表加 as_of 之前登记的数据段标签重算，逐字节相同（MECHANISM_*）。
 *   AI 输入（§2.4、§5 第 4 行）：entry.ai_inputs 必须有；每项 { category, ref, desc_zh }，类别只有 EXTRACTED_FACT 与 AI_MINED_CANDIDATE；
 *     空数组 ⇔ 第 4 行写「无」，否则第 4 行里两种类别记号的个数 = 项数，且不写别的类别（AI_ROLE_*）。
 *   AI_MINED_CANDIDATE（RF1116 §2.4、§6 第 2 条，签字 fd22876f；P1）：项要写 candidate_id 与 round_id，第 4 行写出这两个编号；
 *     entry.factor_refs 里有挖掘因子（因子库 origin AI_MINED_*）时，每个挖掘因子都要有一项 AI_MINED_CANDIDATE（候选编号与轮次和因子库的 mining 一致），
 *     否则 AI_ROLE_MINED_CANDIDATE_MISSING；协调会话裁定 2：另扫 K2 正文，出现挖掘因子编号、挖掘候选或轮次编号（按记号边界）而没有对应项 → 同一拒绝。
 *   门的裁定（entry.mechanism_ruling，A 股导入规格 V1 修订 6；R-XM-1 ★IMP1 (a)，协调会话 2026-11-17）：一页按 sha256 绑定的协调会话裁定，
 *     写法同 trial_gates_ruling：{ spec, deviations[], line4_text? }。只放行 RULING_DEVIATIONS 里写明的两种偏差，记 DEVIATION_ACCEPTED（不记 PASS）：
 *     - MECHANISM_PRIOR_TABLE_NOT_IN_K2：表的 sha256 不在 K2 正文里（表在冻结之后按冻结前的数据生成）。门核实 K2 里确实没有这个 sha256，
 *       裁定页写出表的 sha256、登记表提交与 as_of；表的其余检查（as_of 不晚于冻结、登记表提交与 sha256、逐字节重算）照旧；
 *     - AI_ROLE_K2_LINE4_READ_AS_NONE：第 4 行以「无」开头、后面还有说明（门只认「无」），读作「无」。门核实第 4 行逐字等于 line4_text、
 *       不是单独的「无」、行内没有大写类别记号、entry.ai_inputs 为空；裁定页写出 line4_text 原文；其余 AI 输入检查照旧。
 *     页上缺字 → MECHANISM_RULING_TEXT_DOES_NOT_STATE；事实不成立 → MECHANISM_RULING_FACT_NOT_HOLD；不过门的题带裁定 → MECHANISM_RULING_ON_UNGATED_ENTRY。
 *     没有登记 mechanism_ruling 的题，代码路径与返回值逐字节不变。
 */
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const mech = require('./index');
const { MARKET } = require('../trial-ledger/back_register');
const amendment = require('../research-framework-amendment-20261112');

/** 修订冻结时刻：冻结页 FREEZE_1 写出的唯一常量，与 G-CAUSAL 共用（E13 / G14），不在这里另写。 */
const EFFECTIVE_FROM = amendment.EFFECTIVE_FROM;
const LINE_LABELS = Object.freeze(['**机制**：', '**预期失效方式**：', '**可能被哪条现行规则解释**：', '**AI 输入**：']);
const AI_CATEGORIES = Object.freeze(['EXTRACTED_FACT', 'AI_MINED_CANDIDATE']);
const MINED = 'AI_MINED_CANDIDATE';
const ID_IN_LINE = /(?:SEL|RISK|ACCT|EXEC)\.[A-Z0-9_]+\.[A-Z0-9_]+/g;
const CATEGORY_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const QRP_ROOT = path.join(__dirname, '..', '..');
const SHA64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** 门的裁定能放行的偏差（A 股导入规格 V1 修订 6）。 */
const NOT_IN_K2 = 'MECHANISM_PRIOR_TABLE_NOT_IN_K2';
const LINE4_AS_NONE = 'AI_ROLE_K2_LINE4_READ_AS_NONE';
const RULING_DEVIATIONS = Object.freeze([NOT_IN_K2, LINE4_AS_NONE]);
const NONE_LINE = /^无[。.]?$/;

class MechanismGateError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new MechanismGateError(code, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isoAt = (v) => typeof v === 'string' && /[zZ]|[+-]\d{2}:\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const cstDate = (iso) => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10);
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 默认从 QRP git 读某个提交里的登记表；读不到返回 null。 */
function gitRegisterAt(commit) {
  try {
    return execFileSync('git', ['-C', QRP_ROOT, 'show', `${commit}:${mech.REGISTER_PATH}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** 这道题过不过门（同 G-TRIAL 的读法：草稿、没有 K2 的不过；封存在生效日及以后却没写 k2_frozen_at 的，判断不了，拒绝）。 */
function applies(entry, effectiveFrom) {
  if (!effectiveFrom) return { applies: false, reason: 'AMENDMENT_NOT_FROZEN' };
  need(isoAt(effectiveFrom), 'MECHANISM_GATE_EFFECTIVE_FROM_INVALID', String(effectiveFrom));
  if (!entry.k2 || entry.kind === 'DRAFT') return { applies: false, reason: entry.k2 ? 'DRAFT_NOT_FROZEN' : 'NO_K2' };
  if (entry.k2_frozen_at !== undefined && entry.k2_frozen_at !== null) {
    need(isoAt(entry.k2_frozen_at), 'MECHANISM_GATE_K2_FROZEN_AT_INVALID', `${entry.id}:${entry.k2_frozen_at}`);
    const after = Date.parse(entry.k2_frozen_at) >= Date.parse(effectiveFrom);
    return { applies: after, reason: after ? 'FROZEN_AFTER_AMENDMENT' : 'FROZEN_BEFORE_AMENDMENT' };
  }
  need(!(typeof entry.sealed_on === 'string' && entry.sealed_on >= cstDate(effectiveFrom)), 'MECHANISM_GATE_K2_FROZEN_AT_MISSING', entry.id);
  return { applies: false, reason: 'SEALED_BEFORE_AMENDMENT' };
}

/** §0 四行：每个标签第一次出现处到行尾的内容（去空白后不为空）。 */
function section0(text) {
  return LINE_LABELS.map((label, i) => {
    const at = text.indexOf(label);
    need(at >= 0, 'K2_SECTION0_LINE_MISSING', String(i + 1));
    const content = text.slice(at + label.length).split('\n')[0].trim();
    need(content, 'K2_SECTION0_LINE_MISSING', String(i + 1));
    return content;
  });
}

function marketOf(entry) {
  const market = mech.normalizeMarket(entry.market !== undefined ? entry.market : MARKET[entry.strategy_ref]);
  need(market, 'MECHANISM_MARKET_UNKNOWN', `${entry.id}:${entry.strategy_ref}`);
  return market;
}

function checkMechanism(entry, text, line1, priorTableBytes, { registerAt, marks }, ruling = null) {
  const ids = entry.mechanism_ids;
  need(Array.isArray(ids) && ids.length && ids.every(isText), 'MECHANISM_IDS_MISSING', entry.id);
  const want = [...new Set(ids)].sort();
  const named = [...new Set(line1.match(ID_IN_LINE) || [])].sort();
  need(sameSet(want, named), 'MECHANISM_K2_IDS_MISMATCH', `${entry.id}:${named.join(',') || '—'}≠${want.join(',')}`);
  const spec = entry.mechanism_prior_table;
  need(isObject(spec) && SHA64.test(spec.sha256 || ''), 'MECHANISM_PRIOR_TABLE_MISSING', entry.id);
  const ruledNotInK2 = Boolean(ruling && ruling.deviations.includes(NOT_IN_K2));
  if (ruledNotInK2) {
    // 裁定写的事实要成立：K2 正文里确实没有这个 sha256；裁定页写出了它
    need(!text.includes(spec.sha256), 'MECHANISM_RULING_FACT_NOT_HOLD', `${entry.id}:${NOT_IN_K2}`);
    need(ruling.text.includes(spec.sha256), 'MECHANISM_RULING_TEXT_DOES_NOT_STATE', `${entry.id}:${spec.sha256}`);
  } else need(text.includes(spec.sha256), 'MECHANISM_PRIOR_TABLE_NOT_IN_K2', entry.id);
  const bytes = priorTableBytes();
  need(bytes && sha256(bytes) === spec.sha256, 'MECHANISM_PRIOR_TABLE_MISSING', `${entry.id}:bytes`);
  let table;
  try { table = JSON.parse(bytes.toString('utf8')); } catch { fail('MECHANISM_PRIOR_TABLE_INVALID', entry.id); }
  need(isObject(table) && table.schema === mech.TABLE_SCHEMA && isObject(table.query) && Array.isArray(table.query.mechanism_ids) && isObject(table.register),
    'MECHANISM_PRIOR_TABLE_INVALID', entry.id);
  const market = marketOf(entry);
  need(sameSet([...table.query.mechanism_ids].sort(), want) && table.query.market === market, 'MECHANISM_PRIOR_TABLE_QUERY_MISMATCH',
    `${entry.id}:${table.query.mechanism_ids.join(',')}@${table.query.market}`);
  need(isoAt(table.as_of) && Date.parse(table.as_of) <= Date.parse(entry.k2_frozen_at), 'MECHANISM_PRIOR_TABLE_AFTER_FREEZE', `${entry.id}:${table.as_of}`);
  need(HEX40.test(table.register.commit || ''), 'MECHANISM_PRIOR_TABLE_NO_COMMIT', entry.id);
  if (ruledNotInK2) for (const word of [table.register.commit, table.as_of]) need(ruling.text.includes(word), 'MECHANISM_RULING_TEXT_DOES_NOT_STATE', `${entry.id}:${word}`);
  const registerBytes = registerAt(table.register.commit);
  need(registerBytes && sha256(registerBytes) === table.register.sha256, 'MECHANISM_PRIOR_TABLE_REGISTER_MISMATCH', `${entry.id}:${table.register.commit}`);
  const register = mech.parse(registerBytes);
  const known = new Set(register.mechanisms.map((m) => m.mechanism_id));
  for (const id of want) need(known.has(id), 'MECHANISM_ID_NOT_REGISTERED', `${entry.id}:${id}`);
  const again = mech.tableBytes(mech.query({ mechanism_ids: want, market, owner_named: table.query.owner_named === true },
    { registerBytes, registerCommit: table.register.commit, marks, asOf: table.as_of }));
  need(again.equals(bytes), 'MECHANISM_PRIOR_TABLE_NOT_REPRODUCIBLE', entry.id);
  return { mechanism_ids: want, prior_table_sha256: spec.sha256, register_commit: table.register.commit, register_sha256: table.register.sha256, route: table.route };
}

/** 记号边界（协调会话裁定 2）：编号前后一个字符都不是 A–Z a–z 0–9 _ : - 才算出现；所以 C042 不算出现在 XC042、C0421、C042-b、R:C042 里。 */
const TOKEN_CHAR = /[A-Za-z0-9_:-]/;
function mentions(text, id) {
  for (let i = text.indexOf(id); i >= 0; i = text.indexOf(id, i + 1)) {
    const before = i > 0 ? text[i - 1] : ''; const after = text[i + id.length] || '';
    if (!(before && TOKEN_CHAR.test(before)) && !(after && TOKEN_CHAR.test(after))) return true;
  }
  return false;
}
const defaultLibrary = () => require('../factor-library').LIBRARY;
const defaultMinedTrials = () => [...require('../trial-ledger').heads().values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining);

function checkAiInputs(entry, line4, { factorLibrary = defaultLibrary, minedTrials = defaultMinedTrials, text = line4 } = {}) {
  const items = entry.ai_inputs;
  need(Array.isArray(items), 'AI_ROLE_INPUTS_MISSING', entry.id);
  items.forEach((item, i) => {
    need(isObject(item) && isText(item.category), 'AI_ROLE_INPUT_INVALID', `${entry.id}[${i}]`);
    need(AI_CATEGORIES.includes(item.category), 'AI_ROLE_CATEGORY_NOT_ALLOWED', `${entry.id}[${i}]:${item.category}`);
    need(isText(item.ref) && isText(item.desc_zh), 'AI_ROLE_INPUT_INVALID', `${entry.id}[${i}]`);
    if (item.category === MINED) {
      need(isText(item.candidate_id) && isText(item.round_id), 'AI_ROLE_INPUT_INVALID', `${entry.id}[${i}]:AI_MINED_CANDIDATE needs candidate_id and round_id`);
      need(line4.includes(item.candidate_id) && line4.includes(item.round_id), 'AI_ROLE_K2_LINE_MISMATCH', `${entry.id}:K2 line 4 lacks ${item.candidate_id} / ${item.round_id}`);
    }
  });
  // 测挖掘因子的 K2：每个挖掘因子都要写 AI_MINED_CANDIDATE（RF1116 §8.3 第 10 条）
  if (Array.isArray(entry.factor_refs) && entry.factor_refs.length) {
    const lib = factorLibrary();
    for (const id of entry.factor_refs) {
      const f = (lib.factors || []).find((x) => x.factor_id === id);
      need(f, 'AI_ROLE_FACTOR_UNKNOWN', `${entry.id}:${id}`);
      if (!String(f.origin).startsWith('AI_MINED_')) continue;
      need(items.some((it) => it.category === MINED && it.candidate_id === f.mining.candidate_id && it.round_id === f.mining.round_id),
        'AI_ROLE_MINED_CANDIDATE_MISSING', `${entry.id}:${id}:${f.mining.candidate_id}@${f.mining.round_id}`);
    }
  }
  // 协调会话裁定 2：扫 K2 正文——出现挖掘因子编号（因子库 origin AI_MINED_*）、挖掘候选编号或轮次编号（试验台账 MINED_CANDIDATE 行），
  // 没有对应的 AI_MINED_CANDIDATE 项就拒绝，不管写没写 factor_refs
  const minedItems = items.filter((it) => it.category === MINED);
  for (const f of (factorLibrary().factors || []).filter((x) => String(x.origin).startsWith('AI_MINED_'))) {
    if (!mentions(text, f.factor_id)) continue;
    need(minedItems.some((it) => it.candidate_id === f.mining.candidate_id && it.round_id === f.mining.round_id),
      'AI_ROLE_MINED_CANDIDATE_MISSING', `${entry.id}:K2_TEXT:${f.factor_id}:${f.mining.candidate_id}@${f.mining.round_id}`);
  }
  for (const t of minedTrials()) {
    if (mentions(text, t.mining.candidate_id)) {
      need(minedItems.some((it) => it.candidate_id === t.mining.candidate_id && it.round_id === t.mining.round_id), 'AI_ROLE_MINED_CANDIDATE_MISSING', `${entry.id}:K2_TEXT:${t.mining.candidate_id}`);
    }
    if (mentions(text, t.mining.round_id)) need(minedItems.some((it) => it.round_id === t.mining.round_id), 'AI_ROLE_MINED_CANDIDATE_MISSING', `${entry.id}:K2_TEXT:${t.mining.round_id}`);
  }
  // 第 4 行里写出的候选编号与轮次（可能带 CN_A 这类大写片段）不当作类别记号
  const scan = items.filter((it) => it.category === MINED).reduce((t, it) => t.split(it.candidate_id).join(' ').split(it.round_id).join(' '), line4);
  const other = (scan.match(CATEGORY_TOKEN) || []).filter((token) => !AI_CATEGORIES.includes(token));
  need(!other.length, 'AI_ROLE_CATEGORY_NOT_ALLOWED', `${entry.id}:K2:${other.join(',')}`);
  const none = /^无[。.]?$/.test(line4);
  const listed = (line4.match(/EXTRACTED_FACT|AI_MINED_CANDIDATE/g) || []).length;
  need(items.length === 0 ? none : !none && listed === items.length, 'AI_ROLE_K2_LINE_MISMATCH', `${entry.id}:${items.length}≠${none ? '无' : listed}`);
  return items.length;
}

/**
 * 读门的裁定（没有时返回 null）。裁定页按 sha256 复验后（导入器做），原文必须写出 DEVIATION_ACCEPTED、每个偏差码与第 4 行原文。
 * entry.mechanism_ruling: { spec, deviations: RULING_DEVIATIONS 的非空子集, line4_text?（只在 AI_ROLE_K2_LINE4_READ_AS_NONE 时有，且不是单独的「无」） }
 */
function rulingOf(entry, rulingBytes) {
  const r = entry.mechanism_ruling;
  if (r === undefined || r === null) return null;
  need(isObject(r) && isObject(r.spec) && SHA64.test(r.spec.sha256 || '') && Array.isArray(r.deviations) && r.deviations.length
    && r.deviations.every((d) => RULING_DEVIATIONS.includes(d)) && new Set(r.deviations).size === r.deviations.length, 'MECHANISM_RULING_INVALID', entry.id);
  const asNone = r.deviations.includes(LINE4_AS_NONE);
  need(asNone ? isText(r.line4_text) && !NONE_LINE.test(r.line4_text.trim()) : r.line4_text === undefined, 'MECHANISM_RULING_INVALID', `${entry.id}:line4_text`);
  const bytes = rulingBytes();
  need(bytes, 'MECHANISM_RULING_FILE_MISSING', entry.id);
  const text = bytes.toString('utf8');
  for (const word of ['DEVIATION_ACCEPTED', ...r.deviations, ...(asNone ? [r.line4_text] : [])]) need(text.includes(word), 'MECHANISM_RULING_TEXT_DOES_NOT_STATE', `${entry.id}:${word}`);
  return { text, sha256: r.spec.sha256, ref: r.spec.ref || null, deviations: [...r.deviations], line4Text: asNone ? r.line4_text : null };
}

/** AI_ROLE_K2_LINE4_READ_AS_NONE：事实成立时第 4 行按「无」交给 AI 输入检查，否则拒绝。 */
function line4Read(entry, line4, ruling) {
  if (!ruling || ruling.line4Text === null) return line4;
  need(line4 === ruling.line4Text, 'MECHANISM_RULING_FACT_NOT_HOLD', `${entry.id}:line4:${line4}`);
  need(line4.startsWith('无') && !NONE_LINE.test(line4), 'MECHANISM_RULING_FACT_NOT_HOLD', `${entry.id}:line4_not_none_prefixed`);
  need(!(line4.match(CATEGORY_TOKEN) || []).length, 'MECHANISM_RULING_FACT_NOT_HOLD', `${entry.id}:line4_category_token`);
  need(Array.isArray(entry.ai_inputs) && entry.ai_inputs.length === 0, 'MECHANISM_RULING_FACT_NOT_HOLD', `${entry.id}:ai_inputs`);
  return '无';
}

/**
 * 导入器调用：已有校验与 G-TRIAL 之后。不过门的题返回 { applies: false, reason }，导入器照原样写锁。
 * @param {object} entry
 * @param {{k2Bytes: () => Buffer, priorTableBytes: () => Buffer|null}} files  按 sha256 复验后的 K2 与先前结论表字节（只在过门时才读）
 * @param {{effectiveFrom?: string|null, registerAt?: (commit: string) => Buffer|null, marks?: object[]|null, factorLibrary?: () => object, minedTrials?: () => object[]}} options  factorLibrary、minedTrials 只给测试用
 */
function check(entry, { k2Bytes, priorTableBytes = () => null, rulingBytes = () => null }, { effectiveFrom = EFFECTIVE_FROM, registerAt = gitRegisterAt, marks = null, factorLibrary, minedTrials } = {}) {
  const scope = applies(entry, effectiveFrom);
  if (!scope.applies) {
    need(entry.mechanism_ruling === undefined || entry.mechanism_ruling === null, 'MECHANISM_RULING_ON_UNGATED_ENTRY', entry.id);
    return { applies: false, reason: scope.reason };
  }
  const ruling = rulingOf(entry, rulingBytes);
  const text = k2Bytes().toString('utf8');
  const [line1, , , line4] = section0(text);
  const mechanism = checkMechanism(entry, text, line1, priorTableBytes, { registerAt, marks }, ruling);
  const aiInputs = checkAiInputs(entry, line4Read(entry, line4, ruling), { factorLibrary, minedTrials, text });
  const out = { applies: true, reason: scope.reason, effective_from: effectiveFrom, section0: 'PRESENT', ...mechanism, ai_inputs: aiInputs };
  if (!ruling) return out;
  return { ...out, state: 'DEVIATION_ACCEPTED', deviations: ruling.deviations, ...(ruling.line4Text !== null ? { line4_read_as: '无' } : {}),
    ruling_ref: ruling.ref, ruling_sha256: ruling.sha256 };
}

module.exports = { EFFECTIVE_FROM, LINE_LABELS, AI_CATEGORIES, RULING_DEVIATIONS, MechanismGateError, applies, section0, check, internals: { gitRegisterAt, marketOf, checkAiInputs, rulingOf, line4Read } };
