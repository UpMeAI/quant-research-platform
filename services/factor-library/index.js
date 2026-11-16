'use strict';

/**
 * 因子库 FACTOR_LIBRARY_V1 —— 研究框架修订 2026-11-16（因子库与 AI 自动挖掘因子）草稿 ddeb2eea §2；P0（协调会话 11-16 批准，不含挖掘）。
 * 合同 docs/contracts/FACTOR_LIBRARY_V1.md。
 *
 * 一个生产者：config/research_factor_library.v1.json 只由本模块写出（build.js --write），不手改；测试核对提交的字节等于 build() 的输出。
 * 本模块：结构校验（validate / parse）、按 legacy.js 构建（build / bytes）、源文件核对（bindingsOf / verifyBinding，只读 git show）。
 * 相关性与去重的纯函数在 ./correlation.js。
 *
 *   - 层只开 SELECTION_CROSS_SECTION；class 取八类，OTHER 必须写理由；origin、status 取枚举；
 *   - formula 只收代码引用 CF:<repo>:<path>#<entry>；DSL 文本留给 P1（MINING_SPACE_V1），P0 一律拒绝（FACTOR_LIBRARY_FORMULA_DSL_RESERVED）；
 *   - mechanism_id 写了就必须在机制登记表里（research-mechanism-register isRegistered）；
 *   - LEGACY_RULE 必须绑定源文件（repo、40 位 commit、path、sha256、extract），dedupe 只能是 LEGACY_BASELINE、evidence 只能是 NOT_REJUDGED（不重新判定）；
 *   - 合成分的分量必须已登记，分量自己写的 weight_in_rule 必须与合成分一致；
 *   - 读不到的事实写进 unverified[]，不填 0、不猜。
 * production_effect: NONE。不读行情，不写任何生产路径；不调用任何模型接口。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateRecord } = require('../../schemas');
const mech = require('../research-mechanism-register');
const legacy = require('./legacy');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'config', 'research_factor_library.v1.json');
const LIBRARY_PATH = 'config/research_factor_library.v1.json';
const SCHEMA = 'FACTOR_LIBRARY_V1';
const ENTRY_SCHEMA = 'FACTOR_LIBRARY_ENTRY_V1';
const PRODUCER = 'services/factor-library';

/** 绑定的修订文本：草稿 ddeb2eea（同字节副本），未签字；P0 由协调会话批准（不含挖掘）。 */
const CONTRACT_REF = Object.freeze({
  path: 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261116_FACTOR_LIBRARY_AI_MINING.draft.ddeb2eea.md',
  sha256: 'ddeb2eeae4f2dada67c46128317910bdff6ed0dd2ccb6f8d23ef8d7b6f891447',
  state: 'DRAFT_UNSIGNED_P0_APPROVED_BY_COORDINATOR',
  sections: Object.freeze(['§2', '§4', '§7']),
  ref_zh: '协调会话目录的文件，不在 git 里，按 sha256 绑定；Owner 未签字，P0 不含挖掘，协调会话 2026-11-16 23:1x 批准',
});

const LAYERS = Object.freeze(['SELECTION_CROSS_SECTION']);
const CLASSES = Object.freeze(['VALUE', 'QUALITY', 'MOMENTUM', 'LOW_VOL', 'LIQUIDITY', 'SENTIMENT', 'VOLUME_PRICE', 'OTHER']);
const ORIGINS = Object.freeze(['LEGACY_RULE', 'HUMAN', 'AI_MINED_LLM', 'AI_MINED_GP']);
const STATUSES = Object.freeze(['LIVE_IN_RULE', 'RESEARCH', 'CANDIDATE', 'RETIRED']);
const MARKETS = Object.freeze(['CN_A', 'US_EQUITY']);
const HORIZON_STATES = Object.freeze(['DEFINED', 'NOT_DEFINED_BY_SOURCE']);
const CORRELATION_STATES = Object.freeze(['NOT_COMPUTED', 'COMPUTED']);
const DEDUPE_DECISIONS = Object.freeze(['LEGACY_BASELINE', 'NOT_EVALUATED', 'NO_CONFLICT', 'KEEP_NEW', 'KEEP_EXISTING', 'ORTHOGONALISED']);
const BINDING_ROLES = Object.freeze(['RULE_RECORD', 'CODE', 'RETIREMENT', 'PARAMETER_RECORD']);
const EXTRACT_KINDS = Object.freeze(['JSON_POINTER', 'TEXT']);
/** 兄弟仓的本机位置：环境变量优先，否则取 QRP 仓的同级目录。 */
const REPO_ROOTS = Object.freeze({
  'ashare-v6': Object.freeze({ env: 'QRP_V6_ROOT', sibling: 'Ashare-V6' }),
  smartflow: Object.freeze({ env: 'QRP_SMARTFLOW_ROOT', sibling: 'smartflow' }),
});

/**
 * §2.3 相关性去重的门槛：|ρ| > 0.7（截面值相关或因子收益相关取较大者）。0.7 是协调会话在评论串里答复 Owner 的数（「约 0.7」），
 * 草稿写「冻结时写定」，所以标 PENDING_FREEZE；G-MINE 第 8 项读这里，冻结前 G-MINE 整体失败即关。
 */
const DEDUPE = Object.freeze({ RHO_MAX: 0.7, rule: 'ABS_RHO_GT_THRESHOLD_CONFLICTS', state: 'PENDING_FREEZE', source: '草稿 ddeb2eea §2.3' });

const FACTOR_ID = /^(CN_A|US_EQUITY)(_[A-Z0-9]+)?\.[A-Z0-9_]+\.[A-Z0-9_]+$/;
const CODE_REF = /^CF:([a-z0-9][a-z0-9-]*):([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)#([A-Za-z_$][A-Za-z0-9_$.]*)$/;
const INPUT = /^[A-Z][A-Z0-9_]*:[A-Za-z0-9_.]+$/;
const SHA64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const BEIJING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+08:00$/;

class FactorLibraryError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new FactorLibraryError(code, detail); };
const need = (ok, code, detail) => { if (!ok) fail(code, detail); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const oneLine = (v) => isText(v) && !/[\r\n]/.test(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 键排序的 JSON（比较 extract 值时不受键序影响）。 */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

// ── 校验 ──────────────────────────────────────────────────────────────────────

function validateExtract(list, where) {
  need(Array.isArray(list), 'FACTOR_LIBRARY_SOURCE', `${where}.extract`);
  list.forEach((x, i) => {
    need(isObject(x) && EXTRACT_KINDS.includes(x.kind), 'FACTOR_LIBRARY_SOURCE', `${where}.extract[${i}].kind`);
    if (x.kind === 'JSON_POINTER') need(typeof x.pointer === 'string' && (x.pointer === '' || x.pointer.startsWith('/')) && x.value !== undefined, 'FACTOR_LIBRARY_SOURCE', `${where}.extract[${i}]`);
    else need(isText(x.contains), 'FACTOR_LIBRARY_SOURCE', `${where}.extract[${i}].contains`);
  });
}

function validateBinding(b, where) {
  need(isObject(b), 'FACTOR_LIBRARY_SOURCE', where);
  need(Object.prototype.hasOwnProperty.call(REPO_ROOTS, b.repo), 'FACTOR_LIBRARY_SOURCE', `${where}.repo:${b.repo}`);
  need(SHA40.test(b.commit || ''), 'FACTOR_LIBRARY_SOURCE', `${where}.commit`);
  need(isText(b.path) && !b.path.startsWith('/') && !b.path.includes('..'), 'FACTOR_LIBRARY_SOURCE', `${where}.path`);
  need(SHA64.test(b.sha256 || ''), 'FACTOR_LIBRARY_SOURCE', `${where}.sha256`);
  need(BINDING_ROLES.includes(b.role), 'FACTOR_LIBRARY_SOURCE', `${where}.role:${b.role}`);
  need(b.entry === null || isText(b.entry), 'FACTOR_LIBRARY_SOURCE', `${where}.entry`);
  validateExtract(b.extract, where);
}

function validateEntry(f, where, known) {
  need(isObject(f), 'FACTOR_LIBRARY_FIELD', where);
  const structural = validateRecord(f, ENTRY_SCHEMA);
  for (const p of structural.problems) {
    const [kind, rest] = p.split(':');
    const field = String(rest || '').split(' ')[0];
    if (kind === 'MISSING') fail('FACTOR_LIBRARY_MISSING', `${where}.${field}`);
  }
  if (!structural.ok) fail('FACTOR_LIBRARY_FIELD', `${where}:${structural.problems.join(',')}`);

  need(FACTOR_ID.test(f.factor_id), 'FACTOR_LIBRARY_ID_FORMAT', `${where}:${f.factor_id}`);
  need(MARKETS.includes(f.market), 'FACTOR_LIBRARY_MARKET', `${where}:${f.market}`);
  need(LAYERS.includes(f.layer), 'FACTOR_LIBRARY_LAYER', `${where}:${f.layer}`);
  need(isObject(f.universe) && isText(f.universe.id) && isText(f.universe.version) && oneLine(f.universe.definition_zh), 'FACTOR_LIBRARY_FIELD', `${where}.universe`);
  need(CLASSES.includes(f.class), 'FACTOR_LIBRARY_CLASS_UNKNOWN', `${where}:${f.class}`);
  need(f.class === 'OTHER' ? oneLine(f.class_reason_zh) : f.class_reason_zh === null, 'FACTOR_LIBRARY_CLASS_OTHER_REASON', `${where}:${f.class}`);
  for (const key of ['definition_zh', 'pit_available_at', 'economic_logic_zh']) need(oneLine(f[key]), 'FACTOR_LIBRARY_FIELD', `${where}.${key}`);

  // 公式：P0 只收代码引用；其余文本都当作 DSL，留给 P1
  if (!f.formula.startsWith('CF:')) fail('FACTOR_LIBRARY_FORMULA_DSL_RESERVED', `${where}:P0 只收 CF:<repo>:<path>#<entry>`);
  need(CODE_REF.test(f.formula), 'FACTOR_LIBRARY_FORMULA', `${where}:${f.formula}`);

  need(f.inputs.length > 0 && f.inputs.every(isText), 'FACTOR_LIBRARY_FIELD', `${where}.inputs`);
  for (const input of f.inputs) need(INPUT.test(input), 'FACTOR_LIBRARY_INPUT', `${where}:${input}`);

  const h = f.horizon;
  need(HORIZON_STATES.includes(h.state) && oneLine(h.note_zh), 'FACTOR_LIBRARY_HORIZON', where);
  if (h.state === 'DEFINED') need(Number.isInteger(h.trading_days) && h.trading_days > 0, 'FACTOR_LIBRARY_HORIZON', `${where}.trading_days`);
  else need(h.trading_days === null, 'FACTOR_LIBRARY_HORIZON', `${where}.trading_days`);

  need(ORIGINS.includes(f.origin), 'FACTOR_LIBRARY_ORIGIN_UNKNOWN', `${where}:${f.origin}`);
  if (f.origin.startsWith('AI_MINED_')) {
    need(isObject(f.mining) && isText(f.mining.round_id) && isText(f.mining.candidate_id), 'FACTOR_LIBRARY_MINING', `${where}:挖掘因子要写轮次与候选编号`);
  } else need(f.mining === null, 'FACTOR_LIBRARY_MINING', `${where}:非挖掘因子不写 mining`);
  need(STATUSES.includes(f.status), 'FACTOR_LIBRARY_STATUS', `${where}:${f.status}`);

  if (f.mechanism_id !== null) need(mech.isRegistered(f.mechanism_id), 'FACTOR_LIBRARY_MECHANISM_UNKNOWN', `${where}:${f.mechanism_id}`);

  const c = f.correlation;
  need(CORRELATION_STATES.includes(c.state), 'FACTOR_LIBRARY_CORRELATION', `${where}.state`);
  if (c.state === 'NOT_COMPUTED') need(oneLine(c.reason_zh), 'FACTOR_LIBRARY_CORRELATION', `${where}.reason_zh`);
  else {
    need(isObject(c.reference_window) && isText(c.reference_window.from) && isText(c.reference_window.to) && SHA64.test(c.code_sha256 || '') && Array.isArray(c.pairs),
      'FACTOR_LIBRARY_CORRELATION', where);
    for (const p of c.pairs) {
      need(isObject(p) && known.has(p.factor_id) && [p.rho_cross_section, p.rho_returns].every((r) => r === 'UNKNOWN' || (isNum(r) && Math.abs(r) <= 1)), 'FACTOR_LIBRARY_CORRELATION', `${where}.pairs`);
    }
  }
  need(DEDUPE_DECISIONS.includes(f.dedupe.decision), 'FACTOR_LIBRARY_DEDUPE', `${where}:${f.dedupe.decision}`);
  need(isText(f.evidence.state) && Array.isArray(f.evidence.refs), 'FACTOR_LIBRARY_FIELD', `${where}.evidence`);

  if (f.origin === 'LEGACY_RULE') {
    need(isObject(f.source), 'FACTOR_LIBRARY_SOURCE', `${where}:旧规则因子必须绑定源文件`);
    validateBinding(f.source, `${where}.source`);
    need(f.source.extract.length > 0, 'FACTOR_LIBRARY_SOURCE', `${where}.source.extract`);
    need(f.formula.split(':')[1] === f.source.repo || f.code_refs.some((b) => b.repo === f.formula.split(':')[1]), 'FACTOR_LIBRARY_FORMULA', `${where}:公式的仓要和绑定的源文件一致`);
    need(f.dedupe.decision === 'LEGACY_BASELINE' && f.evidence.state === 'NOT_REJUDGED', 'FACTOR_LIBRARY_LEGACY_REJUDGED', where);
    need(f.status === 'LIVE_IN_RULE' || f.status === 'RETIRED', 'FACTOR_LIBRARY_STATUS', `${where}:旧规则因子只能是 LIVE_IN_RULE 或 RETIRED`);
  } else {
    need(f.source === null || isObject(f.source), 'FACTOR_LIBRARY_SOURCE', where);
    if (f.source !== null) validateBinding(f.source, `${where}.source`);
    need(f.dedupe.decision !== 'LEGACY_BASELINE' && f.evidence.state !== 'NOT_REJUDGED', 'FACTOR_LIBRARY_DEDUPE', `${where}:只有旧规则因子是基准`);
    need(f.status !== 'LIVE_IN_RULE', 'FACTOR_LIBRARY_STATUS', `${where}:只有补登记的旧规则因子是 LIVE_IN_RULE（新因子上线照旧走 K2、封存、签字）`);
  }
  f.code_refs.forEach((b, i) => validateBinding(b, `${where}.code_refs[${i}]`));
  need(f.rule_ref === null || (isObject(f.rule_ref) && isText(f.rule_ref.key) && isText(f.rule_ref.version) && isText(f.rule_ref.authority_state)), 'FACTOR_LIBRARY_FIELD', `${where}.rule_ref`);
  f.unverified.forEach((u, i) => need(isObject(u) && isText(u.field) && oneLine(u.reason_zh), 'FACTOR_LIBRARY_FIELD', `${where}.unverified[${i}]`));
}

/** 合成分与分量的一致性：分量已登记、权重是有限数；分量写的 weight_in_rule 指向的合成分里有它，权重与分量名一致。 */
function validateComposites(factors) {
  const byId = new Map(factors.map((f) => [f.factor_id, f]));
  for (const f of factors) {
    if (f.composite !== null) {
      const c = f.composite;
      need(isObject(c) && Array.isArray(c.components) && c.components.length > 0 && oneLine(c.aggregation_zh) && isText(c.missing_rule), 'FACTOR_LIBRARY_COMPOSITE', f.factor_id);
      for (const part of c.components) {
        need(isObject(part) && byId.has(part.factor_id) && part.factor_id !== f.factor_id && isNum(part.weight) && isText(part.rule_component), 'FACTOR_LIBRARY_COMPOSITE', `${f.factor_id}→${part && part.factor_id}`);
        const w = byId.get(part.factor_id).weight_in_rule;
        need(w && w.composite_factor_id === f.factor_id && w.weight === part.weight && w.rule_component === part.rule_component, 'FACTOR_LIBRARY_COMPOSITE', `${f.factor_id}→${part.factor_id}:weight_in_rule`);
      }
    }
    if (f.weight_in_rule !== null) {
      const w = f.weight_in_rule;
      need(isObject(w) && byId.has(w.composite_factor_id) && isNum(w.weight) && isText(w.rule_component), 'FACTOR_LIBRARY_COMPOSITE', `${f.factor_id}.weight_in_rule`);
      const comp = byId.get(w.composite_factor_id).composite;
      const part = comp && comp.components.find((p) => p.factor_id === f.factor_id);
      need(part && part.weight === w.weight && part.rule_component === w.rule_component, 'FACTOR_LIBRARY_COMPOSITE', `${f.factor_id}.weight_in_rule`);
    }
  }
}

/** 校验一份因子库（对象），返回深冻结的副本；不合规就抛 FACTOR_LIBRARY_*。 */
function validate(doc) {
  need(isObject(doc) && doc.schema === SCHEMA, 'FACTOR_LIBRARY_CONTRACT_INVALID', doc && doc.schema);
  const top = validateRecord(doc, SCHEMA);
  if (!top.ok) fail('FACTOR_LIBRARY_FIELD', top.problems.join(','));
  const ref = doc.contract_ref;
  need(isObject(ref) && ref.path === CONTRACT_REF.path && ref.sha256 === CONTRACT_REF.sha256 && ref.state === CONTRACT_REF.state, 'FACTOR_LIBRARY_FIELD', 'contract_ref');
  need(doc.producer === PRODUCER, 'FACTOR_LIBRARY_FIELD', 'producer');
  need(doc.production_effect === 'NONE', 'FACTOR_LIBRARY_FIELD', 'production_effect');
  need(BEIJING.test(doc.registered_at) && isText(doc.registered_by), 'FACTOR_LIBRARY_FIELD', 'registered_at');
  const seen = new Set(doc.factors.map((f) => (isObject(f) ? f.factor_id : null)));
  const ids = new Set();
  doc.factors.forEach((f, i) => {
    validateEntry(f, `factors[${i}]`, seen);
    need(!ids.has(f.factor_id), 'FACTOR_LIBRARY_DUPLICATE', f.factor_id);
    ids.add(f.factor_id);
  });
  validateComposites(doc.factors);
  doc.not_registered.forEach((n, i) => need(isObject(n) && Object.prototype.hasOwnProperty.call(REPO_ROOTS, n.repo) && SHA40.test(n.commit || '') && isText(n.path)
    && isText(n.field) && oneLine(n.reason_zh), 'FACTOR_LIBRARY_FIELD', `not_registered[${i}]`));
  return deepFreeze(clone(doc));
}

function parse(bytes) {
  let doc;
  try { doc = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)); } catch { fail('FACTOR_LIBRARY_JSON_INVALID'); }
  return validate(doc);
}

// ── 构建（唯一生产者） ────────────────────────────────────────────────────────

const ENTRY_KEYS = Object.freeze(['factor_id', 'market', 'universe', 'layer', 'class', 'class_reason_zh', 'definition_zh', 'formula', 'inputs', 'pit_available_at',
  'horizon', 'economic_logic_zh', 'origin', 'mining', 'status', 'mechanism_id', 'rule_ref', 'weight_in_rule', 'composite', 'correlation', 'dedupe', 'evidence',
  'source', 'code_refs', 'unverified']);
const ordered = (entry) => Object.fromEntries(ENTRY_KEYS.map((k) => [k, entry[k] === undefined ? null : entry[k]]));

/** 按 legacy.js 构建因子库对象（确定的：同样的代码给同样的对象）。 */
function build() {
  const factors = legacy.FACTORS.map((f) => ordered(clone(f)));
  const repos = [legacy.V6, legacy.SF].map((r) => ({ repo: r.repo, commit: r.commit, root_env: REPO_ROOTS[r.repo].env }));
  return validate({
    schema: SCHEMA,
    _comment: '由 services/factor-library 写出（node services/factor-library/build.js --write），不要手改；改动写在 services/factor-library/legacy.js',
    contract_ref: clone(CONTRACT_REF),
    producer: PRODUCER,
    registered_at: legacy.REGISTERED_AT,
    registered_by: legacy.REGISTERED_BY,
    sources: repos,
    dedupe: clone(DEDUPE),
    factors,
    not_registered: clone(legacy.NOT_REGISTERED),
    production_effect: 'NONE',
  });
}

/** 规范字节：两格缩进的 JSON 加换行（键序由 build 固定）。 */
const bytes = (doc) => Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);

// ── 源文件核对（只读 git show） ───────────────────────────────────────────────

/** 因子库里的每一条源文件绑定（source 与 code_refs），附所属因子。 */
function bindingsOf(doc = library()) {
  const out = [];
  for (const f of doc.factors) for (const b of [f.source, ...f.code_refs]) if (b) out.push({ factor_id: f.factor_id, ...b });
  return out;
}

function rootOf(repo, { roots = null, env = process.env } = {}) {
  if (roots && Object.prototype.hasOwnProperty.call(roots, repo)) return roots[repo];
  const spec = REPO_ROOTS[repo];
  if (!spec) return null;
  return env[spec.env] || path.resolve(ROOT, '..', spec.sibling);
}

/** 钉版提交上的源文件字节；读不到返回 { unavailable: 原因 }。 */
function gitShow({ repo, commit, path: file }, options = {}) {
  const root = rootOf(repo, options);
  if (!root || !fs.existsSync(root)) return { unavailable: 'REPO_ABSENT' };
  try { execFileSync('git', ['-C', root, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' }); } catch { return { unavailable: 'COMMIT_ABSENT' }; }
  try { return { bytes: execFileSync('git', ['-C', root, 'show', `${commit}:${file}`], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) }; } catch { return { unavailable: 'PATH_ABSENT_AT_COMMIT' }; }
}

function pointerGet(doc, pointer) {
  if (pointer === '') return { found: true, value: doc };
  let at = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (at === null || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, key)) return { found: false };
    at = at[key];
  }
  return { found: true, value: at };
}

/**
 * 核对一条绑定：sha256 与 extract。返回 { state: MATCH | MISMATCH | UNAVAILABLE, problems[] }。
 * options.reader(binding) 可替换读取（测试用）；默认 git show。
 */
function verifyBinding(binding, options = {}) {
  const head = { factor_id: binding.factor_id || null, repo: binding.repo, commit: binding.commit, path: binding.path };
  let got;
  if (options.reader) got = { bytes: options.reader(binding) };
  else got = gitShow(binding, options);
  if (got.unavailable) return { ...head, state: 'UNAVAILABLE', reason: got.unavailable, problems: [] };
  const problems = [];
  const actual = sha256(got.bytes);
  if (actual !== binding.sha256) problems.push({ kind: 'SHA256', expected: binding.sha256, actual });
  let json;
  for (const x of binding.extract || []) {
    if (x.kind === 'TEXT') {
      if (!got.bytes.toString('utf8').includes(x.contains)) problems.push({ kind: 'TEXT_NOT_FOUND', contains: x.contains });
      continue;
    }
    if (json === undefined) { try { json = JSON.parse(got.bytes.toString('utf8')); } catch { json = null; } }
    const hit = json === null ? { found: false } : pointerGet(json, x.pointer);
    if (!hit.found) problems.push({ kind: 'POINTER_NOT_FOUND', pointer: x.pointer });
    else if (canon(hit.value) !== canon(x.value)) problems.push({ kind: 'VALUE', pointer: x.pointer, expected: x.value, actual: hit.value });
  }
  return { ...head, state: problems.length ? 'MISMATCH' : 'MATCH', problems };
}

/** 核对全部绑定。 */
const verifySources = (doc = library(), options = {}) => bindingsOf(doc).map((b) => verifyBinding(b, options));

/** §4 第 7 项的「现有账本」：库里同市场、状态 LIVE_IN_RULE 的因子（P0 的读法，冻结时可改）。 */
const bookFactorIds = (doc, market) => doc.factors.filter((f) => f.market === market && f.status === 'LIVE_IN_RULE').map((f) => f.factor_id).sort();

/** 提交的因子库（首次读取时校验并缓存；文件不合规就抛错）。build.js 写文件之前不读它。 */
let cached = null;
function library() {
  if (!cached) cached = parse(fs.readFileSync(FILE));
  return cached;
}

module.exports = {
  FILE, LIBRARY_PATH, SCHEMA, ENTRY_SCHEMA, PRODUCER, CONTRACT_REF, LAYERS, CLASSES, ORIGINS, STATUSES, MARKETS, DEDUPE_DECISIONS, REPO_ROOTS, DEDUPE,
  FactorLibraryError, validate, parse, build, bytes, library, bindingsOf, rootOf, verifyBinding, verifySources, bookFactorIds,
};
Object.defineProperty(module.exports, 'LIBRARY', { enumerable: true, get: library });
