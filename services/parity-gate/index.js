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
 *     每个数据集：在 QRP 钉住的 KG 登记表（../dataset-registry，= 生产两端钉的）里 → 否则 PARITY_DATASET_UNREGISTERED；
 *     版本与 sha256 等于 QRP 钉的 → 否则 PARITY_PIN_MISMATCH；PIT 语义在枚举里（或登记表登记过的新语义）→ 否则 PARITY_PIT_SEMANTICS_MISMATCH；
 *     登记表的数据集写了 PIT 语义（字段 pitSemantics）时必须相同 → 否则 PARITY_PIT_SEMANTICS_MISMATCH；还没写时记 PENDING_REGISTRY_FIELD（只报）。
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
/** 登记表数据集上的 PIT 语义字段（KG 还没有；有了以后按它核）。 */
const REGISTRY_PIT_FIELD = 'pitSemantics';
const AI_PIN_SCHEMA = 'AI_LOGIC_PIN_V1';
const DATA_TOKEN = /`DATA:([^`]*)`/g;
const DATA_BODY = /^([A-Z0-9][A-Z0-9_]*)@(\d+\.\d+\.\d+)#([0-9a-f]{64})\|PIT=([A-Z][A-Z0-9_]*)\|VENDOR=([^|]*[^|\s][^|]*)$/;
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
    const hit = DATA_BODY.exec(m[1]);
    need(hit, 'DATA_INPUT_INVALID', `${entry.id}:${m[1]}`);
    const [, dataset_id, registry_version, registry_sha256, pit_semantics, vendor] = hit;
    need(!out.some((d) => d.dataset_id === dataset_id), 'DATA_INPUT_INVALID', `${entry.id}:${dataset_id}:duplicate`);
    out.push({ dataset_id, registry_version, registry_sha256, pit_semantics, vendor: vendor.trim() });
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

/**
 * 导入器调用：原有校验与 G-TRIAL、G-MECH、G-CAUSAL、G-COST 都通过之后。
 * @param {object} entry 登记表一题
 * @param {{k2Bytes: () => Buffer}} files 按 sha256 复验后的 K2 字节（只在过门时才读）
 * @param {{effectiveFrom?: string, registry?: object}} [opts] 只给测试用；导入器不传，取签字页的生效时刻与 QRP 钉住的登记表
 */
function check(entry, { k2Bytes } = {}, { effectiveFrom = DEFAULTS.effectiveFrom, registry = null } = {}) {
  const scope = applies(entry, effectiveFrom);
  if (!scope.applies) return { applies: false, reason: scope.reason };
  need(parity.isBound(), 'SIGNATURE_UNBOUND', parity.SIGNATURE.path);
  const reg = registry || datasetRegistry.pinned();
  const inputs = dataInputs(entry, k2Bytes().toString('utf8'));
  need(inputs.length, 'DATA_INPUTS_MISSING', entry.id);
  const allowed = new Set([...PIT_SEMANTICS, ...(reg.pit_semantics || [])]);
  const rows = inputs.map((d) => {
    const at = `${entry.id}:${d.dataset_id}`;
    const ds = reg.datasets.get(d.dataset_id);
    need(ds, 'DATASET_UNREGISTERED', at);
    need(d.registry_version === reg.registry_version && d.registry_sha256 === reg.registry_sha256, 'PIN_MISMATCH',
      `${at}:${d.registry_version}#${d.registry_sha256.slice(0, 8)}≠${reg.registry_version}#${reg.registry_sha256.slice(0, 8)}`);
    need(allowed.has(d.pit_semantics), 'PIT_SEMANTICS_MISMATCH', `${at}:${d.pit_semantics}:NOT_IN_ENUM_OR_REGISTRY`);
    const registered = ds[REGISTRY_PIT_FIELD];
    if (registered !== undefined) need(d.pit_semantics === registered, 'PIT_SEMANTICS_MISMATCH', `${at}:${d.pit_semantics}≠${registered}`);
    return { ...d, pit_check: registered !== undefined ? 'CHECKED' : 'PENDING_REGISTRY_FIELD' };
  });
  const ai = checkAi(entry);
  return { applies: true, state: 'PASS', effective_from: effectiveFrom, signature: { path: parity.SIGNATURE.path, sha256: parity.SIGNATURE.sha256 },
    registry: { commit: reg.commit, registry_version: reg.registry_version, registry_sha256: reg.registry_sha256 }, data_inputs: rows, ai_inputs: ai };
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

module.exports = { EFFECTIVE_FROM, PIT_SEMANTICS, REGISTRY_PIT_FIELD, AI_PIN_SCHEMA, ParityGateError, applies, check, validPin, pinHash,
  internals: { dataInputs, checkAi, setDefaults, withDefaults } };
