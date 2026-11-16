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
 *     否则 AI_ROLE_MINED_CANDIDATE_MISSING；没有 factor_refs 的题照旧。
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

function checkMechanism(entry, text, line1, priorTableBytes, { registerAt, marks }) {
  const ids = entry.mechanism_ids;
  need(Array.isArray(ids) && ids.length && ids.every(isText), 'MECHANISM_IDS_MISSING', entry.id);
  const want = [...new Set(ids)].sort();
  const named = [...new Set(line1.match(ID_IN_LINE) || [])].sort();
  need(sameSet(want, named), 'MECHANISM_K2_IDS_MISMATCH', `${entry.id}:${named.join(',') || '—'}≠${want.join(',')}`);
  const spec = entry.mechanism_prior_table;
  need(isObject(spec) && SHA64.test(spec.sha256 || ''), 'MECHANISM_PRIOR_TABLE_MISSING', entry.id);
  need(text.includes(spec.sha256), 'MECHANISM_PRIOR_TABLE_NOT_IN_K2', entry.id);
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

function checkAiInputs(entry, line4, factorLibrary = () => require('../factor-library').LIBRARY) {
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
 * 导入器调用：已有校验与 G-TRIAL 之后。不过门的题返回 { applies: false, reason }，导入器照原样写锁。
 * @param {object} entry
 * @param {{k2Bytes: () => Buffer, priorTableBytes: () => Buffer|null}} files  按 sha256 复验后的 K2 与先前结论表字节（只在过门时才读）
 * @param {{effectiveFrom?: string|null, registerAt?: (commit: string) => Buffer|null, marks?: object[]|null, factorLibrary?: () => object}} options  factorLibrary 只给测试用
 */
function check(entry, { k2Bytes, priorTableBytes = () => null }, { effectiveFrom = EFFECTIVE_FROM, registerAt = gitRegisterAt, marks = null, factorLibrary } = {}) {
  const scope = applies(entry, effectiveFrom);
  if (!scope.applies) return { applies: false, reason: scope.reason };
  const text = k2Bytes().toString('utf8');
  const [line1, , , line4] = section0(text);
  const mechanism = checkMechanism(entry, text, line1, priorTableBytes, { registerAt, marks });
  const aiInputs = checkAiInputs(entry, line4, factorLibrary);
  return { applies: true, reason: scope.reason, effective_from: effectiveFrom, section0: 'PRESENT', ...mechanism, ai_inputs: aiInputs };
}

module.exports = { EFFECTIVE_FROM, LINE_LABELS, AI_CATEGORIES, MechanismGateError, applies, section0, check, internals: { gitRegisterAt, marketOf, checkAiInputs } };
