'use strict';

/**
 * 机制登记与分诊查询（QRP_RESEARCH_MECHANISM_REGISTER_V1；研究框架修订 2026-11-12 §4，FREEZE_1 c9742ea0：冻结审阅 E1–E18 全取 (a)）。
 *
 * 事实来源是 `config/research_mechanism_register.v1.json`，格式照层登记（../research-layer-register）：require 时校验，缺字段就抛错。
 *   - mechanisms[]：一个机制 = 一个效应 + 所在的层 + 作用的决策点；参数、阈值、窗口长短都不算新机制（★6）。
 *     id 写 <前缀>.<主题>.<变体>，前缀与层一一对应（SEL / RISK / ACCT / EXEC，E16）；parent 可选，必须已登记、不成环。
 *   - entries[]：一题一市场一条（item_id + market 不重复，E8）。conclusion{} 可选：没有封存结论的题不写，查询里列为「在研」。
 *     结论块的事实（做 / 不做、功效、读过的窗口、封存 sha256、状态）由补登记从封存文件抄录，协调会话核对（E2）；
 *     写了 sealed_ref 的，crossCheck() 拿它对 QRP 已有的封存结论 ENTRIES 核对 sha256、封存日、做 / 不做。
 *
 * 分诊查询 query()（§4.3）：输入候选的机制 id 与市场，列出同 id、同市场的全部结论，给出路由读数。
 *   - 只有「最晚一条（E5）是不做、功效 ≥ 80%（读不到 = 不到，E3）、之后没有新数据（E4）」才得 NOT_DO_SETTLED；
 *     多个 id 时每个 id 都得 NOT_DO_SETTLED 才算（E6）；Owner 点名的题一律正常分诊（E10）；父子 id 只列为相关（E7）。
 *   - 新数据：同市场的有效 UNSEEN 段（trial-ledger segmentsFor 的读法）不完全落在先前窗口内，或 FORWARD_READ 晚于先前窗口，
 *     或同 id 同市场有更晚的结论；先前窗口没写 = UNKNOWN（不当作「没有新数据」）。
 *   - 「不做（已判）」只是分诊读数，不是研究结论；本模块只读，不写分诊台账，也不改任何封存文件（E11）。
 * 输出 MECHANISM_PRIOR_TABLE_V1：同样的输入（登记表字节、提交、as_of 之前登记的标签）得到逐字节相同的表，G-MECH 按它重算核对（./gate.js）。
 * production_effect: NONE。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { read } = require('../../packages/ledger');
const trials = require('../trial-ledger');
const { FREEZE } = require('../research-framework-amendment-20261112');

const FILE = path.join(__dirname, '..', '..', 'config', 'research_mechanism_register.v1.json');
const REGISTER_PATH = 'config/research_mechanism_register.v1.json';
const CONTRACT = 'QRP_RESEARCH_MECHANISM_REGISTER_V1';
const TABLE_SCHEMA = 'MECHANISM_PRIOR_TABLE_V1';
/** 绑定的修订文本（冻结审阅 E1 (a)）：冻结页 FREEZE_1（path + sha256 前缀），加上它冻结的两份文本（草稿修订 1、冻结审阅修订 3）。 */
const AMENDMENT = Object.freeze({
  path: FREEZE.path,
  sha_prefix: FREEZE.sha256.slice(0, 8),
  state: FREEZE.state,
  texts: Object.freeze(FREEZE.texts.map((t) => Object.freeze({ id: t.id, path: t.path, sha_prefix: t.sha256.slice(0, 8) }))),
});
/** 前缀 → 层（层代码同 research-layer-register；诊断、工程、待定不登记机制，E16）。 */
const PREFIX_LAYER = Object.freeze({ SEL: 'SELECTION_TIMING', RISK: 'RISK', ACCT: 'ACCOUNT', EXEC: 'NA_EXECUTION' });
const DECISION_POINTS = Object.freeze({ SELECT: '选标的', DIRECTION: '方向', ENTRY: '入场', EXIT: '出场', SIZING: '仓位', COST: '成本' });
/** 框架 §6.6 的三个市场；试验台账与查询输入的别名按这里归一（E8）。 */
const MARKETS = Object.freeze(['CN_A', 'US_EQUITY', 'CRYPTO']);
const MARKET_ALIAS = Object.freeze({ CN_A: 'CN_A', CN: 'CN_A', US_EQUITY: 'US_EQUITY', CRYPTO: 'CRYPTO', CRYPTO_USDM_PERP: 'CRYPTO' });
const VERDICTS = Object.freeze(['DONT', 'DO_INSUFFICIENT', 'DO_SUPPORTED']);
const SEALED_SOURCES = Object.freeze(['ASHARE_SEALED_VERDICTS', 'OVERSEAS_SEALED_VERDICTS']);
const POWER_THRESHOLD = 0.8;
const ID = /^(SEL|RISK|ACCT|EXEC)\.[A-Z0-9_]+\.[A-Z0-9_]+$/;
const SHA64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BEIJING = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?\+08:00$/;

const ROUTES = Object.freeze({
  NOT_DO_SETTLED: '不做（已判）：同机制、同市场最晚的结论是不做，功效 ≥ 80%，之后没有新数据；引用封存 sha256，不写新 K2。这是分诊读数，不是研究结论',
  NORMAL_CITE_PRIOR: '正常分诊；新 K2 §0 必须引用先前结论',
  NORMAL_STATE_DIFFERENCE: '正常分诊；新 K2 §0 写明这次有什么不同（样本更大、组合候选、新数据）',
  ATTACH_TO_SHADOW: '作为证据备注挂到现有前向影子上；不另立题，除非候选改变了机制本身',
  QUARTERLY_ABLATION: '进季度消融，不另立题；提议去掉这条规则的例外',
  NORMAL_NO_PRIOR: '同机制、同市场没有先前结论：正常分诊',
  NORMAL_OWNER_NAMED: 'Owner 点名的题：正常分诊，附先前结论列表',
  NORMAL_MIXED: '各机制去向不同：正常分诊，附每个机制的先前结论列表',
});

class MechanismRegisterError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new MechanismRegisterError(code, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const oneLine = (value) => isText(value) && !/[\r\n]/.test(value);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const text = (object, key, where) => { if (!isText(object[key])) fail('MECHANISM_REGISTER_FIELD', `${where}.${key}`); return object[key]; };
const keyOf = (itemId, market) => `${itemId}\u0000${market}`;
const normalizeMarket = (market) => (typeof market === 'string' && Object.prototype.hasOwnProperty.call(MARKET_ALIAS, market) ? MARKET_ALIAS[market] : null);

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

// ── 校验 ──────────────────────────────────────────────────────────────────────

function validateMechanisms(list) {
  need(Array.isArray(list), 'MECHANISM_REGISTER_FIELD', 'mechanisms');
  const ids = new Map();
  list.forEach((m, i) => {
    const where = `mechanisms[${i}]`;
    need(isObject(m), 'MECHANISM_REGISTER_FIELD', where);
    for (const key of ['mechanism_id', 'title_zh', 'layer', 'decision_point', 'description_zh']) text(m, key, where);
    need(ID.test(m.mechanism_id), 'MECHANISM_REGISTER_ID_FORMAT', `${where}:${m.mechanism_id}`);
    need(PREFIX_LAYER[m.mechanism_id.split('.')[0]] === m.layer, 'MECHANISM_REGISTER_LAYER_PREFIX', `${m.mechanism_id}:${m.layer}`);
    need(Object.prototype.hasOwnProperty.call(DECISION_POINTS, m.decision_point), 'MECHANISM_REGISTER_DECISION_POINT', `${m.mechanism_id}:${m.decision_point}`);
    need(oneLine(m.title_zh), 'MECHANISM_REGISTER_FIELD', `${where}.title_zh`);
    need(oneLine(m.description_zh), 'MECHANISM_REGISTER_FIELD', `${where}.description_zh`);
    need(m.parent === undefined || isText(m.parent), 'MECHANISM_REGISTER_PARENT', `${where}.parent`);
    need(!ids.has(m.mechanism_id), 'MECHANISM_REGISTER_DUPLICATE', m.mechanism_id);
    ids.set(m.mechanism_id, m);
  });
  for (const m of list) {
    if (m.parent === undefined) continue;
    need(ids.has(m.parent), 'MECHANISM_REGISTER_PARENT', `${m.mechanism_id}→${m.parent}`);
    const seen = new Set([m.mechanism_id]);
    for (let at = m.parent; at !== undefined; at = ids.get(at).parent) {
      need(!seen.has(at), 'MECHANISM_REGISTER_PARENT_CYCLE', m.mechanism_id);
      seen.add(at);
    }
  }
  return ids;
}

function validateConclusion(c, where) {
  need(isObject(c), 'MECHANISM_REGISTER_FIELD', where);
  need(VERDICTS.includes(c.verdict), 'MECHANISM_REGISTER_VERDICT', `${where}:${c.verdict}`);
  text(c, 'strength_zh', where);
  const p = c.power;
  const value = isObject(p) ? p.value : undefined;
  need(isObject(p) && (value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1))
    && (p.ge_80 === null || typeof p.ge_80 === 'boolean') && (value === null || p.ge_80 === (value >= POWER_THRESHOLD))
    && isText(p.effect_zh) && isText(p.source_zh), 'MECHANISM_REGISTER_POWER', where);
  text(c, 'family_id', where);
  need(DATE.test(c.sealed_on || ''), 'MECHANISM_REGISTER_FIELD', `${where}.sealed_on`);
  need(SHA64.test(c.seal_sha256 || ''), 'MECHANISM_REGISTER_FIELD', `${where}.seal_sha256`);
  // 窗口必须写；读不到写 null（新数据记 UNKNOWN）
  need(Object.prototype.hasOwnProperty.call(c, 'data_window'), 'MECHANISM_REGISTER_WINDOW', `${where}.data_window`);
  if (c.data_window !== null) {
    const w = c.data_window;
    need(isObject(w) && DATE.test(w.from || '') && DATE.test(w.to || '') && w.from <= w.to && w.to <= c.sealed_on, 'MECHANISM_REGISTER_WINDOW', where);
  }
  if (c.sealed_ref !== undefined) {
    const sealedRef = new RegExp(`^(${SEALED_SOURCES.join('|')}):\\S+$`);
    need(typeof c.sealed_ref === 'string' && sealedRef.test(c.sealed_ref), 'MECHANISM_REGISTER_SEALED_REF', `${where}:${c.sealed_ref}`);
  }
  // 「做」的状态会变（E9）：证据不足写影子在不在跑，有支持证据写上没上线；不做不写状态
  const s = c.state;
  if (c.verdict === 'DONT') need(s === undefined || s === null, 'MECHANISM_REGISTER_STATE', where);
  else {
    const flag = c.verdict === 'DO_INSUFFICIENT' ? 'shadow_running' : 'live';
    const other = c.verdict === 'DO_INSUFFICIENT' ? 'live' : 'shadow_running';
    need(isObject(s) && typeof s[flag] === 'boolean' && s[other] === undefined && DATE.test(s.as_of || ''), 'MECHANISM_REGISTER_STATE', `${where}:${c.verdict}`);
  }
}

function validateEntries(list, ids) {
  need(Array.isArray(list), 'MECHANISM_REGISTER_FIELD', 'entries');
  const seen = new Set();
  list.forEach((e, i) => {
    const where = `entries[${i}]`;
    need(isObject(e), 'MECHANISM_REGISTER_FIELD', where);
    for (const key of ['item_id', 'strategy_ref', 'market', 'classified_by', 'reason_zh']) text(e, key, where);
    need(MARKETS.includes(e.market), 'MECHANISM_REGISTER_MARKET', `${where}:${e.market}`);
    need(Array.isArray(e.mechanism_ids) && e.mechanism_ids.length && e.mechanism_ids.every(isText) && new Set(e.mechanism_ids).size === e.mechanism_ids.length,
      'MECHANISM_REGISTER_FIELD', `${where}.mechanism_ids`);
    for (const id of e.mechanism_ids) need(ids.has(id), 'MECHANISM_REGISTER_UNKNOWN_ID', `${where}:${id}`);
    // 一行，并写明节号（同层登记）
    need(oneLine(e.reason_zh) && /§\d/.test(e.reason_zh), 'MECHANISM_REGISTER_FIELD', `${where}.reason_zh`);
    const key = keyOf(e.item_id, e.market);
    need(!seen.has(key), 'MECHANISM_REGISTER_DUPLICATE', `${e.item_id}/${e.market}`);
    seen.add(key);
    if (e.conclusion !== undefined) validateConclusion(e.conclusion, `${where}.conclusion`);
  });
}

/** 校验一份登记表（对象），返回冻结的副本；不合规就抛 MECHANISM_REGISTER_*。 */
function validate(doc) {
  need(isObject(doc) && doc.contract === CONTRACT, 'MECHANISM_REGISTER_CONTRACT_INVALID', doc && doc.contract);
  const ref = doc.contract_ref;
  need(isObject(ref) && ref.path === AMENDMENT.path, 'MECHANISM_REGISTER_FIELD', 'contract_ref.path');
  need(SHA64.test(ref.sha256 || '') && ref.sha256.startsWith(AMENDMENT.sha_prefix), 'MECHANISM_REGISTER_FIELD', 'contract_ref.sha256');
  need(ref.state === AMENDMENT.state, 'MECHANISM_REGISTER_FIELD', 'contract_ref.state');
  need(Array.isArray(ref.texts) && ref.texts.length === AMENDMENT.texts.length, 'MECHANISM_REGISTER_FIELD', 'contract_ref.texts');
  for (const want of AMENDMENT.texts) {
    const got = ref.texts.find((t) => isObject(t) && t.id === want.id);
    need(got && got.path === want.path && SHA64.test(got.sha256 || '') && got.sha256.startsWith(want.sha_prefix), 'MECHANISM_REGISTER_FIELD', `contract_ref.texts.${want.id}`);
  }
  text(doc, 'registered_at', 'register');
  text(doc, 'registered_by', 'register');
  const ids = validateMechanisms(doc.mechanisms);
  validateEntries(doc.entries, ids);
  return deepFreeze(JSON.parse(JSON.stringify(doc)));
}

/** 字节 → 校验过的登记表。 */
function parse(bytes) {
  let doc;
  try { doc = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)); } catch { fail('MECHANISM_REGISTER_JSON_INVALID'); }
  return validate(doc);
}

const REGISTER = parse(fs.readFileSync(FILE));

/**
 * 封存结论 ENTRIES 里一题的做 / 不做（resolve 的读法同导入器 readVerdict）。登记的结论常带限定语（「不做（无候选）」「做（证据不足）」），
 * 按开头归类；开头既不是「不做」也不是「做」的返回 null（交叉核对判不一致）。
 */
function sealedDecision(s) {
  const read = String((s.resolve && s.resolve[s.expect] && s.resolve[s.expect].decision) || s.expect || '');
  // 一份文件多个单元时，登记写成「<单元>:不做」：按冒号后的结论读，单元前缀另交给交叉核对比对 entry 的 #单元
  const m = /^([A-Z0-9_]+):/.exec(read);
  const raw = m ? read.slice(m[0].length) : read;
  const decision = raw.startsWith('不做') ? '不做' : raw.startsWith('做') ? '做' : null;
  return { decision, unit: m ? m[1] : null };
}
/** 单元名比较：大小写、- 与 _ 不计（登记写 V2_SPY，entry 写 X08#V2-SPY）。 */
const unitKey = (unit) => String(unit).toUpperCase().replace(/[^A-Z0-9]/g, '_');

/**
 * 写了 sealed_ref 的结论，与 QRP 已有的封存结论 ENTRIES 交叉核对（E2）：sha256、封存日、做 / 不做三项一致。
 * sources 默认读 A 股与海外的封存结论登记（按需 require，避免载入顺序依赖）。
 */
function crossCheck(register = REGISTER, sources = null) {
  const src = sources || {
    ASHARE_SEALED_VERDICTS: require('../ashare-sealed-verdicts').ENTRIES,
    OVERSEAS_SEALED_VERDICTS: require('../overseas-sealed-verdicts').ENTRIES,
  };
  let checked = 0;
  for (const e of register.entries) {
    const c = e.conclusion;
    if (!c || c.sealed_ref === undefined) continue;
    const at = c.sealed_ref.indexOf(':');
    const source = c.sealed_ref.slice(0, at);
    const id = c.sealed_ref.slice(at + 1);
    const where = `${e.item_id}/${e.market}`;
    const sealed = (src[source] || []).find((s) => s.id === id);
    need(sealed, 'MECHANISM_REGISTER_SEALED_REF_NOT_FOUND', `${where}:${c.sealed_ref}`);
    need(sealed.kind === 'RESULT', 'MECHANISM_REGISTER_SEALED_REF_NOT_RESULT', `${where}:${c.sealed_ref}:${sealed.kind}`);
    need(sealed.file && sealed.file.sha256 === c.seal_sha256, 'MECHANISM_REGISTER_SEALED_REF_MISMATCH', `${where}:seal_sha256`);
    need(sealed.sealed_on === c.sealed_on, 'MECHANISM_REGISTER_SEALED_REF_MISMATCH', `${where}:sealed_on`);
    const read = sealedDecision(sealed);
    need(read.decision === (c.verdict === 'DONT' ? '不做' : '做'), 'MECHANISM_REGISTER_SEALED_REF_MISMATCH', `${where}:decision`);
    if (read.unit) {
      const unit = e.item_id.includes('#') ? e.item_id.slice(e.item_id.indexOf('#') + 1) : null;
      need(unit !== null && unitKey(unit) === unitKey(read.unit), 'MECHANISM_REGISTER_SEALED_REF_MISMATCH', `${where}:unit`);
    }
    checked += 1;
  }
  return { checked };
}

// ── 查询 ──────────────────────────────────────────────────────────────────────

/** 先前结论之后有没有新数据（E4）。marks 已按市场与 as_of 过滤。 */
function newDataFromMarks(c, marks) {
  if (!c.data_window) return { state: 'UNKNOWN', reasons: [] };
  const w = c.data_window;
  const reasons = [];
  const base = marks.filter((m) => m.label === 'SEEN' || m.label === 'UNSEEN');
  for (const family of [...new Set(base.map((m) => m.family_id))].sort()) {
    const own = base.filter((m) => m.family_id === family);
    const from = own.map((m) => m.from).sort()[0];
    const to = own.map((m) => m.to).sort().pop();
    for (const piece of trials.segmentsFor(family, from, to, { marks }).pieces) {
      if (piece.label === 'UNSEEN' && (piece.from < w.from || piece.to > w.to)) reasons.push({ kind: 'UNSEEN', family_id: family, from: piece.from, to: piece.to, mark_id: piece.source });
    }
  }
  for (const m of marks) {
    if (m.label === 'FORWARD_READ' && m.to > w.to) reasons.push({ kind: 'FORWARD_READ', family_id: m.family_id, from: m.from, to: m.to, mark_id: m.mark_id });
  }
  return { state: reasons.length ? 'YES' : 'NO', reasons };
}

function conclusionRow(e, marks) {
  const c = e.conclusion;
  return {
    item_id: e.item_id, strategy_ref: e.strategy_ref, family_id: c.family_id, verdict: c.verdict, strength_zh: c.strength_zh,
    power: { value: c.power.value, ge_80: c.power.ge_80 }, data_window: c.data_window,
    segments_read: c.data_window ? trials.segmentLabels(c.family_id, c.data_window.from, c.data_window.to, { marks }) : null,
    sealed_on: c.sealed_on, seal_sha256: c.seal_sha256, sealed_ref: c.sealed_ref === undefined ? null : c.sealed_ref,
    state: c.state === undefined ? null : c.state,
  };
}

/** 一个 id 的去向（§4.3 的表加 E9 的两种落空情况）。 */
function routeOf(prior, ownerNamed) {
  if (ownerNamed) return 'NORMAL_OWNER_NAMED';
  if (!prior) return 'NORMAL_NO_PRIOR';
  if (prior.verdict === 'DO_INSUFFICIENT') return prior.state.shadow_running ? 'ATTACH_TO_SHADOW' : 'NORMAL_CITE_PRIOR';
  if (prior.verdict === 'DO_SUPPORTED') return prior.state.live ? 'QUARTERLY_ABLATION' : 'NORMAL_CITE_PRIOR';
  if (prior.power.ge_80 !== true) return 'NORMAL_STATE_DIFFERENCE';
  return prior.new_data.state === 'NO' ? 'NOT_DO_SETTLED' : 'NORMAL_CITE_PRIOR';
}

/** 一个 id 的祖先与后代（不含自己）。 */
function relatives(id, register) {
  const parent = new Map(register.mechanisms.map((m) => [m.mechanism_id, m.parent]));
  const out = new Set();
  for (let at = parent.get(id); at !== undefined; at = parent.get(at)) out.add(at);
  const below = (of) => { for (const [child, p] of parent) if (p === of && !out.has(child)) { out.add(child); below(child); } };
  below(id);
  return out;
}

function forId(id, market, register, marks, ownerNamed) {
  const same = register.entries.map((e, index) => ({ e, index })).filter(({ e }) => e.market === market && e.mechanism_ids.includes(id));
  const concluded = same.filter(({ e }) => e.conclusion !== undefined)
    .sort((a, b) => (a.e.conclusion.sealed_on < b.e.conclusion.sealed_on ? -1 : a.e.conclusion.sealed_on > b.e.conclusion.sealed_on ? 1 : a.index - b.index));
  const conclusions = concluded.map(({ e }, i) => {
    const row = conclusionRow(e, marks);
    const later = concluded[i + 1];
    row.new_data = later ? { state: 'YES', reasons: [{ kind: 'LATER_CONCLUSION', item_id: later.e.item_id }] } : newDataFromMarks(e.conclusion, marks);
    return row;
  });
  const prior = conclusions.length ? conclusions[conclusions.length - 1] : null;
  const rel = relatives(id, register);
  return {
    mechanism_id: id,
    route: routeOf(prior, ownerNamed),
    prior,
    conclusions,
    in_progress: same.filter(({ e }) => e.conclusion === undefined).map(({ e }) => ({ item_id: e.item_id, strategy_ref: e.strategy_ref })),
    related: register.entries.filter((e) => e.market === market && !e.mechanism_ids.includes(id) && e.mechanism_ids.some((m) => rel.has(m)))
      .map((e) => ({ item_id: e.item_id, strategy_ref: e.strategy_ref, mechanism_ids: [...e.mechanism_ids], verdict: e.conclusion ? e.conclusion.verdict : null })),
  };
}

/**
 * 分诊查询（§4.3）。只读：不写任何文件、台账。
 * @param {{mechanism_ids: string[], market: string, owner_named?: boolean}} input
 * @param {{registerBytes?: Buffer, registerCommit?: string|null, marks?: object[]|null, asOf: string}} options
 *   marks 默认读本机试验台账的 DATA_SEGMENT_MARK_V1；只取同市场、registered_at ≤ asOf 的行。
 * @returns {object} MECHANISM_PRIOR_TABLE_V1
 */
function query(input, { registerBytes = null, registerCommit = null, marks = null, asOf } = {}) {
  need(typeof asOf === 'string' && BEIJING.test(asOf) && Number.isFinite(Date.parse(asOf)), 'MECHANISM_QUERY_AS_OF', asOf);
  const bytes = registerBytes || fs.readFileSync(FILE);
  const register = parse(bytes);
  need(isObject(input), 'MECHANISM_QUERY_INVALID');
  const market = normalizeMarket(input.market);
  need(market, 'MECHANISM_QUERY_MARKET', input.market);
  need(Array.isArray(input.mechanism_ids) && input.mechanism_ids.length && input.mechanism_ids.every(isText), 'MECHANISM_QUERY_IDS');
  const ids = [...new Set(input.mechanism_ids)].sort();
  const known = new Set(register.mechanisms.map((m) => m.mechanism_id));
  for (const id of ids) need(known.has(id), 'MECHANISM_ID_NOT_REGISTERED', id);
  need(input.owner_named === undefined || typeof input.owner_named === 'boolean', 'MECHANISM_QUERY_INVALID', 'owner_named');
  const ownerNamed = input.owner_named === true;
  const cutoff = Date.parse(asOf);
  const used = (marks || read(trials.SEGMENTS())).filter((m) => m && m.schema === 'DATA_SEGMENT_MARK_V1' && normalizeMarket(m.market) === market
    && Number.isFinite(Date.parse(m.registered_at)) && Date.parse(m.registered_at) <= cutoff);
  const byId = ids.map((id) => forId(id, market, register, used, ownerNamed));
  const routes = [...new Set(byId.map((x) => x.route))];
  const route = ownerNamed ? 'NORMAL_OWNER_NAMED' : routes.length === 1 ? routes[0] : 'NORMAL_MIXED';
  return {
    schema: TABLE_SCHEMA,
    query: { mechanism_ids: ids, market, owner_named: ownerNamed },
    as_of: asOf,
    register: { contract: CONTRACT, path: REGISTER_PATH, sha256: sha256(bytes), commit: registerCommit || null,
      amendment: { path: register.contract_ref.path, sha256: register.contract_ref.sha256, state: register.contract_ref.state } },
    marks_used: used.map((m) => ({ mark_id: m.mark_id, record_hash: m.record_hash })),
    by_id: byId,
    route,
    route_zh: ROUTES[route],
    cite_seal_sha256: route === 'NOT_DO_SETTLED' ? [...new Set(byId.map((x) => x.prior.seal_sha256))].sort() : [],
    production_effect: 'NONE',
  };
}

/** 表的规范字节（键排序的 JSON 加换行）：命令行写出、K2 绑定、G-MECH 重算比较都用它。 */
const tableBytes = (table) => Buffer.from(`${trials.canonicalJson(table)}\n`);

module.exports = {
  FILE, REGISTER_PATH, CONTRACT, TABLE_SCHEMA, AMENDMENT, PREFIX_LAYER, DECISION_POINTS, MARKETS, MARKET_ALIAS, VERDICTS, POWER_THRESHOLD, ROUTES, ID, REGISTER,
  MechanismRegisterError, validate, parse, crossCheck, normalizeMarket, query, tableBytes,
};
