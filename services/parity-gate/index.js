'use strict';

/**
 * G-PARITY 研究与实盘一致门 —— RESEARCH_LIVE_PARITY_V1 §3（签字页 f0fe8e5c，签字文本 ceb35505）。合同 docs/contracts/G_PARITY_V1.md。
 *
 * 接进海外与 A 股封存结论导入器共用的 checkEntry（一处调用），在 G-TRIAL、G-MECH、G-CAUSAL、G-COST 之后。
 * 门只会拒绝导入（失败即关，错误码 PARITY_*），从不改写结论。
 *
 *   过门的题：封存导入 RESULT / READING，entry.k2_frozen_at ≥ EFFECTIVE_FROM（签字页，../research-live-parity-v1；★3 (a) 只管以后）；
 *     封存日期在生效日及以后、却没写 k2_frozen_at → 拒绝。
 *   K2「数据输入」（§1 第 2 条）：从 K2 正文（导入器按 sha256 复验后的字节）里抽 `DATA:<登记表 id>@<登记表版本>#<登记表 sha256>|PIT=<语义>|VENDOR=<供应方>`，
 *     写法同 G-CAUSAL 的 `CF:`。一个都没有 → PARITY_DATA_INPUTS_MISSING；写法不对 → PARITY_DATA_INPUT_INVALID。
 *     K2 冻结时还没有 DATA: 写法的，记号写在冻结附注里：entry.k2_notes（按 sha256 绑定，导入器同样复验）按列出的顺序和 K2 一起读，取并集；
 *     同一个数据集在不同文件里写得不一样 → PARITY_DATA_INPUTS_CONFLICT；列了附注却没读到 → PARITY_K2_NOTES_UNREAD。
 *     每个数据集：在 QRP 钉住的 KG 登记表（../dataset-registry，= 生产两端钉的）里 → 否则 PARITY_DATASET_UNREGISTERED；
 *     版本与 sha256 等于 QRP 钉的 → 否则 PARITY_PIN_MISMATCH；PIT 语义在枚举里（或登记表登记过的新语义）→ 否则 PARITY_PIT_SEMANTICS_MISMATCH；
 *     登记表的数据集写了 PIT 语义（字段 pitSemantics，字符串或列表）时必须是其中之一 → 否则 PARITY_PIT_SEMANTICS_MISMATCH；
 *     可选的 |BASIS=<PRICE|TOTAL_RETURN>/<RAW|SPLIT_ADJ|FULL_ADJ>（登记表的 priceBasisVocabulary）：数据集写了 priceBasis（字符串或列表）时记号必须带 BASIS
 *     （否则 PARITY_PRICE_BASIS_MISSING）且是其中之一（否则 PARITY_PRICE_BASIS_MISMATCH）；VENDOR 必须是数据集 vendor 按逗号拆开、去空白后的一项
 *     （VENDOR_ENFORCED 为 false：只记 MATCH / MISMATCH，不拒，等 KG 加规范的 vendorIds）。登记表字段没有或为 null 的，记 PENDING_REGISTRY_FIELD（只报，不拒）。
 *   登记表的历史（协调会话 2026-11-17 01:2x 裁定）：记号钉的是 QRP 现在钉的版本 → 照旧；钉的是更早的版本 → 那一版要在 history 里
 *     （否则 PARITY_PIN_MISMATCH「VERSION_NOT_IN_HISTORY」），且这个数据集的一致性字段从那一版到现在没变（否则 PARITY_PIN_MISMATCH「DATASET_CHANGED:<字段>」）。
 *     BASIS 与 VENDOR 只对钉在有这两个字段的版本上的记号核（版本里的数据集带 priceBasis / vendor 键）；更早的记号只核登记与 PIT，两项记 NOT_APPLICABLE_PRE_FIELD。
 *   AI 输入（§2）：entry.ai_inputs 每一项带 ai_logic_pin（AI_LOGIC_PIN_V1）与 production_archive{ref, sha256, ai_logic_pin}（实盘存档输出的钉值）；
 *     缺钉值、钉值不完整、没有存档可核、与存档的钉值不同 → PARITY_AI_LOGIC_MISMATCH。
 *   不过门的题：照原样导入，锁行不加字段。
 */
const crypto = require('crypto');
const parity = require('../research-live-parity-v1');
const datasetRegistry = require('../dataset-registry');
const { canonicalJson } = require('../trial-ledger');

const EFFECTIVE_FROM = parity.EFFECTIVE_FROM;
/** §1 第 2 条的 PIT 语义枚举；新的语义先进登记表（登记表级的 pitSemantics 清单）。 */
const PIT_SEMANTICS = Object.freeze(['OBSERVED_AT', 'ANNOUNCEMENT_NEXT_OPEN', 'ACCEPTANCE_TIME', 'BAR_CLOSE', 'NEXT_OPEN_SESSION_CLOSE']);
/** 登记表数据集上的字段（KG 1.13.0 起有；没有或为 null 时只记「待登记表字段」）。 */
const REGISTRY_PIT_FIELD = 'pitSemantics';
const REGISTRY_BASIS_FIELD = 'priceBasis';
const REGISTRY_VENDOR_FIELD = 'vendor';
/** 登记表级的价格口径说明（KG 1.13.0：对象，format = '<PRICE|TOTAL_RETURN>/<RAW|SPLIT_ADJ|FULL_ADJ>; …'）；没有时用同样的默认两组。 */
const REGISTRY_BASIS_VOCAB_FIELD = 'priceBasisVocabulary';
const DEFAULT_BASIS_GROUPS = Object.freeze([Object.freeze(['PRICE', 'TOTAL_RETURN']), Object.freeze(['RAW', 'SPLIT_ADJ', 'FULL_ADJ'])]);
const PENDING = 'PENDING_REGISTRY_FIELD';
const CHECKED = 'CHECKED';
const PRE_FIELD = 'NOT_APPLICABLE_PRE_FIELD';
/** 裁定第 3 条：VENDOR 只记不拒，直到 KG 加上规范的 vendorIds；代码路径保留。 */
const VENDOR_ENFORCED = false;
const AI_PIN_SCHEMA = 'AI_LOGIC_PIN_V1';
const DATA_TOKEN = /`DATA:([^`]*)`/g;
const DATA_HEAD = /^([A-Z0-9][A-Z0-9_]*)@(\d+\.\d+\.\d+)#([0-9a-f]{64})((?:\|[A-Z]+=[^|]*)+)$/;
const DATA_FIELDS = Object.freeze({ PIT: true, VENDOR: true, BASIS: false }); // 键 → 是否必填
const PIT_VALUE = /^[A-Z][A-Z0-9_]*$/;
const SHA64 = /^[0-9a-f]{64}$/;

class ParityGateError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new ParityGateError(`PARITY_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isoAt = (v) => typeof v === 'string' && /[zZ]|[+-]\d{2}:\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** 登记表字段：没有或为 null 都当「没写」。 */
const absent = (v) => v === undefined || v === null;
const listOf = (v) => (Array.isArray(v) ? v : [v]);
/** 价格口径的两组可选值：取登记表 priceBasisVocabulary.format 的 <A|B>/<C|D|E>，读不出时用默认两组。 */
function basisGroups(reg) {
  const vocab = reg && reg.registry ? reg.registry[REGISTRY_BASIS_VOCAB_FIELD] : undefined;
  const m = vocab && typeof vocab.format === 'string' ? /^<([A-Z_|]+)>\/<([A-Z_|]+)>/.exec(vocab.format) : null;
  return m ? [m[1].split('|'), m[2].split('|')] : DEFAULT_BASIS_GROUPS;
}

/** AI_LOGIC_PIN_V1（§2 第 1 条）：供应方、模型名、模型版本、提示词或代码 sha256（至少一个）、输出结构版本、调用参数。 */
function validPin(p) {
  return isObj(p) && p.schema === AI_PIN_SCHEMA && isText(p.provider) && isText(p.model) && isText(p.model_version) && isText(p.output_schema_version) && isObj(p.call_params)
    && (p.prompt_sha256 === undefined || SHA64.test(p.prompt_sha256)) && (p.code_sha256 === undefined || SHA64.test(p.code_sha256))
    && (SHA64.test(p.prompt_sha256 || '') || SHA64.test(p.code_sha256 || ''));
}
const pinHash = (p) => sha256(canonicalJson(p));

/** 门的默认读法（导入器那处调用不带选项）；只在测试里经 internals.setDefaults 临时替换。 */
let DEFAULTS = Object.freeze({ effectiveFrom: EFFECTIVE_FROM });

/** 这一题是否过门。 */
function applies(entry, effectiveFrom = DEFAULTS.effectiveFrom) {
  if (!entry.k2 || entry.kind === 'DRAFT') return { applies: false, reason: entry.k2 ? 'DRAFT_NOT_FROZEN' : 'NO_K2' };
  if (entry.kind !== 'RESULT' && entry.kind !== 'READING') return { applies: false, reason: 'NOT_A_SEAL' };
  need(isoAt(effectiveFrom), 'EFFECTIVE_FROM_INVALID', String(effectiveFrom));
  const eff = Date.parse(effectiveFrom);
  if (entry.k2_frozen_at !== undefined && entry.k2_frozen_at !== null) {
    need(isoAt(entry.k2_frozen_at), 'K2_FROZEN_AT_INVALID', `${entry.id}:${entry.k2_frozen_at}`);
    const after = Date.parse(entry.k2_frozen_at) >= eff;
    return { applies: after, reason: after ? 'FROZEN_AFTER_EFFECTIVE' : 'FROZEN_BEFORE_EFFECTIVE' };
  }
  const effDate = new Date(eff + 8 * 3600e3).toISOString().slice(0, 10); // 生效日（CST）
  need(!(typeof entry.sealed_on === 'string' && entry.sealed_on >= effDate), 'K2_FROZEN_AT_MISSING', entry.id);
  return { applies: false, reason: 'SEALED_BEFORE_EFFECTIVE' };
}

/** K2 正文里的数据输入：每个 `DATA:…` 都要写对；同一个数据集只写一次。 */
function dataInputs(entry, text) {
  const out = [];
  for (const m of text.matchAll(DATA_TOKEN)) {
    const hit = DATA_HEAD.exec(m[1]);
    need(hit, 'DATA_INPUT_INVALID', `${entry.id}:${m[1]}`);
    const [, dataset_id, registry_version, registry_sha256, tail] = hit;
    const fields = {};
    for (const part of tail.slice(1).split('|')) {
      const eq = part.indexOf('=');
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1).trim();
      need(key in DATA_FIELDS && !(key in fields) && value, 'DATA_INPUT_INVALID', `${entry.id}:${dataset_id}:${key}`);
      fields[key] = value;
    }
    for (const [key, required] of Object.entries(DATA_FIELDS)) need(!required || key in fields, 'DATA_INPUT_INVALID', `${entry.id}:${dataset_id}:${key} missing`);
    need(PIT_VALUE.test(fields.PIT), 'DATA_INPUT_INVALID', `${entry.id}:${dataset_id}:PIT`);
    need(!out.some((d) => d.dataset_id === dataset_id), 'DATA_INPUT_INVALID', `${entry.id}:${dataset_id}:duplicate`);
    out.push({ dataset_id, registry_version, registry_sha256, pit_semantics: fields.PIT, vendor: fields.VENDOR, ...(fields.BASIS ? { price_basis: fields.BASIS } : {}) });
  }
  return out;
}

function checkAi(entry) {
  const items = Array.isArray(entry.ai_inputs) ? entry.ai_inputs : [];
  return items.map((item, i) => {
    const at = `${entry.id}:ai_inputs[${i}]`;
    need(isObj(item) && validPin(item.ai_logic_pin), 'AI_LOGIC_MISMATCH', `${at}:PIN_MISSING_OR_INVALID`);
    const arc = item.production_archive;
    need(isObj(arc) && isText(arc.ref) && SHA64.test(arc.sha256 || '') && validPin(arc.ai_logic_pin), 'AI_LOGIC_MISMATCH', `${at}:NO_PRODUCTION_ARCHIVE`);
    need(canonicalJson(item.ai_logic_pin) === canonicalJson(arc.ai_logic_pin), 'AI_LOGIC_MISMATCH', `${at}:PIN_DIFFERS_FROM_PRODUCTION`);
    return { ref: item.ref, archive_ref: arc.ref, archive_sha256: arc.sha256, ai_logic_pin_sha256: pinHash(item.ai_logic_pin) };
  });
}

/** K2 与冻结附注里的数据输入：每个文件内照旧（重复即 INVALID）；跨文件同一数据集写法相同取一次，不同即 CONFLICT。顺序：K2 在前，附注按列出的顺序。 */
function mergedInputs(entry, sources) {
  const out = [];
  const from = new Map();
  for (const { source, text } of sources) {
    for (const d of dataInputs(entry, text)) {
      const prior = out.find((x) => x.dataset_id === d.dataset_id);
      if (prior) {
        need(canonicalJson(prior) === canonicalJson(d), 'DATA_INPUTS_CONFLICT', `${entry.id}:${d.dataset_id}:${from.get(d.dataset_id)}≠${source}`);
        continue;
      }
      out.push(d);
      from.set(d.dataset_id, source);
    }
  }
  return out;
}

/**
 * 导入器调用：原有校验与 G-TRIAL、G-MECH、G-CAUSAL、G-COST 都通过之后。
 * @param {object} entry 登记表一题
 * @param {{k2Bytes: () => Buffer, noteBytes?: () => Buffer[]}} files 按 sha256 复验后的 K2 字节与冻结附注字节（entry.k2_notes 的顺序；只在过门时才读）
 * @param {{effectiveFrom?: string, registry?: object, history?: Map}} [opts] 只给测试用；导入器不传，取签字页的生效时刻、QRP 钉住的登记表与它的历史
 */
function check(entry, { k2Bytes, noteBytes = () => [] } = {}, { effectiveFrom = DEFAULTS.effectiveFrom, registry = null, history = null } = {}) {
  const scope = applies(entry, effectiveFrom);
  if (!scope.applies) return { applies: false, reason: scope.reason };
  need(parity.isBound(), 'SIGNATURE_UNBOUND', parity.SIGNATURE.path);
  const reg = registry || datasetRegistry.pinned();
  const listed = Array.isArray(entry.k2_notes) ? entry.k2_notes : [];
  const notes = listed.length ? noteBytes() : [];
  need(Array.isArray(notes) && notes.length === listed.length && notes.every(Boolean), 'K2_NOTES_UNREAD', `${entry.id}:${listed.length}`);
  const inputs = mergedInputs(entry, [{ source: 'K2', text: k2Bytes().toString('utf8') },
    ...notes.map((b, i) => ({ source: `K2_NOTE[${i}]:${listed[i].path}`, text: b.toString('utf8') }))]);
  need(inputs.length, 'DATA_INPUTS_MISSING', entry.id);
  const allowed = new Set([...PIT_SEMANTICS, ...(reg.pit_semantics || [])]);
  const [basisA, basisB] = basisGroups(reg);
  let hist = history;
  const rows = inputs.map((d) => {
    const at = `${entry.id}:${d.dataset_id}`;
    const ds = reg.datasets.get(d.dataset_id);
    need(ds, 'DATASET_UNREGISTERED', at);
    // 记号钉的版本：现在钉的，或历史里的一份（那一版里这个数据集的一致性字段到现在没变）
    let pinnedReg = reg;
    let pinCheck = 'CURRENT';
    if (!(d.registry_version === reg.registry_version && d.registry_sha256 === reg.registry_sha256)) {
      if (!hist) hist = datasetRegistry.history();
      const older = hist.get(`${d.registry_version}#${d.registry_sha256}`);
      need(older, 'PIN_MISMATCH', `${at}:VERSION_NOT_IN_HISTORY:${d.registry_version}#${d.registry_sha256.slice(0, 8)}`);
      const then = older.datasets.get(d.dataset_id);
      need(then, 'PIN_MISMATCH', `${at}:DATASET_NOT_IN_PINNED_VERSION:${d.registry_version}`);
      const changed = datasetRegistry.changedFields(then, ds);
      need(!changed.length, 'PIN_MISMATCH', `${at}:DATASET_CHANGED:${changed.join(',')}`);
      pinnedReg = older;
      pinCheck = 'HISTORY_UNCHANGED';
    }
    need(allowed.has(d.pit_semantics), 'PIT_SEMANTICS_MISMATCH', `${at}:${d.pit_semantics}:NOT_IN_ENUM_OR_REGISTRY`);
    const pit = ds[REGISTRY_PIT_FIELD];
    if (!absent(pit)) need(listOf(pit).includes(d.pit_semantics), 'PIT_SEMANTICS_MISMATCH', `${at}:${d.pit_semantics}≠${listOf(pit).join(',')}`);
    if (d.price_basis !== undefined) {
      const [a, b, extra] = d.price_basis.split('/');
      need(extra === undefined && basisA.includes(a) && basisB.includes(b), 'DATA_INPUT_INVALID', `${at}:BASIS=${d.price_basis}`);
    }
    // BASIS：只对钉在有 priceBasis 字段的版本上的记号核
    const basis = ds[REGISTRY_BASIS_FIELD];
    let basisCheck = PRE_FIELD;
    if (datasetRegistry.hasField(pinnedReg, REGISTRY_BASIS_FIELD)) {
      basisCheck = absent(basis) ? PENDING : CHECKED;
      if (!absent(basis)) {
        need(d.price_basis !== undefined, 'PRICE_BASIS_MISSING', `${at}:registry ${listOf(basis).join(',')}`);
        need(listOf(basis).includes(d.price_basis), 'PRICE_BASIS_MISMATCH', `${at}:${d.price_basis}≠${listOf(basis).join(',')}`);
      }
    }
    // VENDOR：只对钉在有 vendor 字段的版本上的记号比；只记 MATCH / MISMATCH，VENDOR_ENFORCED 为 false 时不拒
    const vendor = ds[REGISTRY_VENDOR_FIELD];
    let vendorCheck = PRE_FIELD;
    let registryVendors = null;
    if (datasetRegistry.hasField(pinnedReg, REGISTRY_VENDOR_FIELD)) {
      vendorCheck = PENDING;
      if (!absent(vendor)) {
        registryVendors = listOf(vendor).flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
        vendorCheck = registryVendors.includes(d.vendor) ? 'MATCH' : 'MISMATCH';
        if (VENDOR_ENFORCED) need(vendorCheck === 'MATCH', 'VENDOR_MISMATCH', `${at}:${d.vendor}≠${registryVendors.join(',')}`);
      }
    }
    return { ...d, pin_check: pinCheck, pit_check: absent(pit) ? PENDING : CHECKED, basis_check: basisCheck, vendor_check: vendorCheck,
      ...(vendorCheck === 'MISMATCH' ? { registry_vendor: registryVendors } : {}) };
  });
  const ai = checkAi(entry);
  return { applies: true, state: 'PASS', effective_from: effectiveFrom, signature: { path: parity.SIGNATURE.path, sha256: parity.SIGNATURE.sha256 },
    registry: { commit: reg.commit, registry_version: reg.registry_version, registry_sha256: reg.registry_sha256 }, data_inputs: rows, ai_inputs: ai,
    ...(listed.length ? { k2_notes: listed.map((n) => ({ path: n.path, sha256: n.sha256 })) } : {}) };
}

/** 测试用：临时替换门的默认读法（导入器那处调用不带选项），返回还原函数。 */
function setDefaults(patch) {
  const prior = DEFAULTS;
  DEFAULTS = Object.freeze({ ...prior, ...patch });
  return () => { DEFAULTS = prior; };
}
function withDefaults(patch, fn) {
  const restore = setDefaults(patch);
  try { return fn(); } finally { restore(); }
}

module.exports = { EFFECTIVE_FROM, VENDOR_ENFORCED, PIT_SEMANTICS, REGISTRY_PIT_FIELD, REGISTRY_BASIS_FIELD, REGISTRY_VENDOR_FIELD, REGISTRY_BASIS_VOCAB_FIELD, DEFAULT_BASIS_GROUPS, AI_PIN_SCHEMA, ParityGateError, applies, check, validPin, pinHash,
  internals: { dataInputs, mergedInputs, checkAi, setDefaults, withDefaults } };
