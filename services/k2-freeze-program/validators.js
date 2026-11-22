'use strict';

/**
 * K2_FREEZE_PROGRAM_V1 validators V1-V14 (RF1118 r2 section 2.1). Each one reuses an existing QRP service and maps its refusals to reason codes;
 * none calls a model or the network. A validator returns an array of reason codes (empty = PASS), or { state, reason } for PENDING / NOT_APPLICABLE.
 * Unknown (receipt field null), missing (receipt absent), not applicable (human author) and zero stay distinct codes or states.
 */
const trials = require('../trial-ledger');
const trialGates = require('../trial-ledger/gates');
const mech = require('../research-mechanism-register');
const mechGate = require('../research-mechanism-register/gate');
const causality = require('../causality-gate');
const parityGate = require('../parity-gate');
const costGate = require('../cost-gate');
const addendum1 = require('../research-framework-amendment-20261112-addendum-1');
const { LIBRARY: FACTOR_LIBRARY } = require('../factor-library');
const { codeOf, sha256, isObj, isCstStamp, SHA64 } = require('./common');
const templates = require('./templates');
const power = require('./power');
const rf1118 = require('./rf1118');
const bundleBuilder = require('./bundle');
const queueLine = require('./queue_line');

const NAMES = Object.freeze({
  V1: 'schema and required sections', V2: 'decision table from frozen templates only', V3: 'power tool match', V4: 'G-MECH routing', V5: 'G-CAUSAL', V6: 'G-PARITY check()', V7: 'no new formula (RF1116)',
  V8: 'data scope', V9: 'TRL rows before the freeze page', V10: 'isolation proof', V11: 'scope and caps', V12: 'frozen artifacts', V13: 'one queue line per freeze', V14: 'prompt and model pin',
});
const ORDER = Object.freeze(Object.keys(NAMES));
const ID_RE = /^[A-Z0-9][A-Za-z0-9_-]{2,60}$/;
const REFUSED_ROUTES = Object.freeze(['NOT_DO_SETTLED', 'ATTACH_TO_SHADOW', 'QUARTERLY_ABLATION']);
const MARKET_HOST = Object.freeze({ CN_A: 'LINUX', US_EQUITY: 'HK', CRYPTO: 'HK' });
const NO_NUMBER = Object.freeze([]);
const isAi = (d) => d.authored_by.kind === 'AI_PREREG_AGENT';
const countsInN = (arm) => trials.COUNTS_IN_N.has(arm.role);
const prefixOf = (id) => String(id).split('.')[0];

const ZERO = '0'.repeat(64);

// ── shared pre-computations ────────────────────────────────────────────────────────────────────────────

/** The prior-conclusion table (G-MECH) at as_of; computed once and also the input of the K2 text (its sha is written into the text). */
function priorTable(draft, ctx, asOf) {
  try {
    const table = mech.query({ mechanism_ids: draft.section0.mechanism_ids, market: draft.market, owner_named: false },
      { registerBytes: ctx.registerBytes, registerCommit: ctx.registerCommit || null, marks: ctx.marks || [], asOf });
    const bytes = mech.tableBytes(table);
    return { table, bytes, sha256: sha256(bytes), error: null };
  } catch (e) {
    return { table: null, bytes: null, sha256: ZERO, error: codeOf(e) };
  }
}

const factorIds = (ctx) => new Set(ctx.factorIds || (FACTOR_LIBRARY.factors || []).map((f) => f.factor_id));

/** CST week (Monday start) and month keys of a +08:00 stamp. */
function cstKeys(stamp) {
  const t = new Date(Date.parse(stamp) + 8 * 3600e3);
  const day = (t.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - day));
  return { week: monday.toISOString().slice(0, 10), month: t.toISOString().slice(0, 7) };
}

// ── validators ────────────────────────────────────────────────────────────────────────────────────────

const V = {};

V.V2 = ({ draft }) => templates.validate(draft.decision_table);

V.V3 = ({ draft }) => {
  const codes = [];
  const p = draft.power;
  let n = null;
  try { n = power.requiredN(p); } catch (e) { return [codeOf(e)]; }
  if (p.n_required !== n) codes.push(`PREREG_POWER_MISMATCH:n_required:${p.n_required}!=${n}`);
  const t = isObj(draft.decision_table) && isObj(draft.decision_table.params) ? draft.decision_table.params : {};
  const num = (x) => typeof x === 'number';
  if (num(t.alpha) && t.alpha !== p.alpha) codes.push('PREREG_POWER_MISMATCH:alpha');
  if (num(t.power_target) && t.power_target !== p.power_target) codes.push('PREREG_POWER_MISMATCH:power_target');
  if (num(t.min_effect_sd) && t.min_effect_sd !== p.effect_size_sd) codes.push('PREREG_POWER_MISMATCH:effect_size_sd');
  if (num(t.min_sample_n) && t.min_sample_n < n) codes.push(`PREREG_POWER_MISMATCH:min_sample_n:${t.min_sample_n}<${n}`);
  // numbers written in the criteria text must be numbers the tool or the table produced
  const allowed = new Set([0, n, p.n_required, p.alpha, p.power_target, p.effect_size_sd, t.min_sample_n, t.ci_level, num(t.ci_level) ? Math.round(t.ci_level * 100) : null].filter((x) => x !== null && x !== undefined));
  for (const tok of draft.desk_items.decision_criteria_zh.match(/\d+(?:\.\d+)?/g) || NO_NUMBER) if (!allowed.has(Number(tok))) codes.push(`PREREG_POWER_MISMATCH:text_number:${tok}`);
  return codes;
};

V.V4 = ({ draft, ctx, text, k2Sha, table, asOf }) => {
  if (table.error) return [table.error];
  const codes = [];
  for (const row of table.table.by_id) if (REFUSED_ROUTES.includes(row.route)) codes.push(`PREREG_ROUTED_${row.route}:${row.mechanism_id}`);
  if (codes.length) return codes;
  const factors = factorIds(ctx);
  const entry = { id: draft.draft_id, kind: 'READING', market: draft.market, k2: { sha256: k2Sha }, k2_frozen_at: ctx.now, mechanism_ids: draft.section0.mechanism_ids,
    mechanism_prior_table: { sha256: table.sha256 }, ai_inputs: draft.section0.ai_inputs,
    factor_refs: componentsOf(draft).filter((c) => c.kind === 'FACTOR' && factors.has(c.id)).map((c) => c.id) };
  try {
    mechGate.check(entry, { k2Bytes: () => Buffer.from(text), priorTableBytes: () => table.bytes }, { registerAt: ctx.registerAt || undefined, marks: ctx.marks || [] });
  } catch (e) { codes.push(codeOf(e)); }
  return codes;
};

V.V5 = ({ draft, ctx, text }) => {
  const c = draft.causality;
  const decl = causality.declaration(text);
  const hasCf = decl.cf.length > 0;
  const hasNa = decl.na.length > 0;
  if (hasCf && hasNa) return ['CAUSAL_SCOPE_CONFLICT'];
  if (!hasCf && !hasNa) return ['CAUSAL_SCOPE_MISSING'];
  // Addendum 1 (A1): when the arms will be cost-gated runs (cost-gate roles and stages), fill functions join the causality gate and only RISK_K_OR_ACCOUNT_LAYER may be N/A.
  const a1 = draft.arms.some((a) => costGate.IN_SCOPE_ROLES.includes(a.role) && costGate.IN_SCOPE_STAGES.includes(a.stage)) && addendum1.isBound() && Date.parse(ctx.now) >= Date.parse(addendum1.EFFECTIVE_FROM);
  if (hasNa) {
    if (!causality.NOT_APPLICABLE_CODES.includes(decl.na[0])) return [`CAUSAL_SCOPE_CODE_INVALID:${decl.na[0]}`];
    if (c.evidence_sha256 !== undefined) return ['CAUSAL_SCOPE_CONFLICT:N/A_WITH_EVIDENCE'];
    if (a1 && decl.na[0] !== causality.FILL_EXEMPT_NA) return [`CAUSAL_SCOPE_FILL_NOT_EXEMPT:${decl.na[0]}`];
    return [];
  }
  const codes = [];
  for (const id of decl.cf) if (!causality.FUNCTION_ID.test(id)) codes.push(`CAUSAL_K2_FUNCTION_ID_INVALID:${id}`);
  if (codes.length) return codes;
  if (c.evidence_sha256 === undefined) return ['CAUSAL_EVIDENCE_MISSING'];
  const bytes = typeof ctx.evidenceBytes === 'function' ? ctx.evidenceBytes(c.evidence_sha256) : null;
  if (!bytes) return ['CAUSAL_EVIDENCE_MISSING:file'];
  if (sha256(bytes) !== c.evidence_sha256) return ['CAUSAL_EVIDENCE_SHA256_MISMATCH'];
  let doc;
  try { doc = causality.parseEvidence(bytes, draft.draft_id); } catch (e) { return [codeOf(e).replace(/^CAUSALITY_/, 'CAUSAL_')]; }
  // Function-level evidence from a harness run at the pinned code sha. Its k2_sha256 may name an earlier K2: the K2-bound re-run is checked at seal import by the existing gate.
  if (doc.contract_ref !== causality.CONTRACT_REF) codes.push('CAUSAL_EVIDENCE_CONTRACT_MISMATCH');
  if (doc.seed !== causality.SEED || doc.cut_points_per_function !== causality.CUT_POINTS) codes.push('CAUSAL_EVIDENCE_PARAMS_NOT_FROZEN');
  if (!causality.HARNESS_VERSIONS.includes(doc.harness_version)) codes.push(`CAUSAL_HARNESS_VERSION_UNKNOWN:${doc.harness_version}`);
  if (Object.keys(doc.unknown).length) codes.push(`CAUSAL_EVIDENCE_UNKNOWN:${Object.keys(doc.unknown).sort().join(',')}`);
  const pinned = ctx.pinnedCodeShas && ctx.pinnedCodeShas[doc.code_repo];
  if (!pinned) codes.push(`CAUSAL_CODE_SHA_UNKNOWN:${doc.code_repo}`);
  else if (pinned !== doc.code_sha) codes.push(`CAUSAL_CODE_SHA_NOT_PINNED:${doc.code_repo}`);
  const ids = doc.functions.map((f) => f.function_id);
  for (const id of decl.cf) if (!ids.includes(id)) codes.push(`CAUSAL_FUNCTION_NOT_IN_EVIDENCE:${id}`);
  for (const id of ids) if (!decl.cf.includes(id)) codes.push(`CAUSAL_FUNCTION_NOT_IN_K2:${id}`);
  for (const fn of doc.functions) for (const t of causality.TESTS) if (fn[t] !== 'PASS') codes.push(`CAUSAL_FUNCTION_NOT_PASS:${fn.function_id}:${causality.TEST_LABEL[t]}`);
  if (a1 && !doc.functions.some((f) => f.role === causality.FILL_ROLE)) codes.push('CAUSAL_FILL_FUNCTIONS_MISSING');
  return codes;
};

V.V6 = ({ draft, ctx, text, k2Sha }) => {
  const entry = { id: draft.draft_id, kind: 'READING', k2: { sha256: k2Sha }, k2_frozen_at: ctx.now, ai_inputs: draft.section0.ai_inputs };
  try {
    const out = parityGate.check(entry, { k2Bytes: () => Buffer.from(text) }, { registry: ctx.registry || null, history: ctx.registryHistory || null });
    return out.applies ? [] : [`PARITY_NOT_IN_SCOPE:${out.reason}`];
  } catch (e) { return [codeOf(e)]; }
};

function componentsOf(draft) {
  return draft.arms.flatMap((a) => (Array.isArray(a.rule_config.components) ? a.rule_config.components : [])).filter(isObj);
}
const IDENT = /^[A-Za-z0-9_.:-]+$/;
V.V7 = ({ draft, ctx }) => {
  const codes = [];
  const reg = ctx.registeredComponents || {};
  const sets = { FACTOR: factorIds(ctx), READING: new Set(reg.readings || []), RULE_PART: new Set(reg.ruleParts || []) };
  for (const a of draft.arms) {
    const rc = a.rule_config;
    for (const k of Object.keys(rc)) if (k !== 'components' && k !== 'params') codes.push(`PREREG_FORMULA_FORBIDDEN:RULE_CONFIG_KEY:${a.config_label}.${k}`);
    if (!Array.isArray(rc.components) || !rc.components.length) { codes.push(`PREREG_FORMULA_FORBIDDEN:NO_COMPONENTS:${a.config_label}`); continue; }
    for (const c of rc.components) {
      if (!isObj(c)) { codes.push(`PREREG_FORMULA_FORBIDDEN:COMPONENT_SHAPE:${a.config_label}`); continue; }
      for (const k of Object.keys(c)) if (k !== 'kind' && k !== 'id') codes.push(`PREREG_FORMULA_FORBIDDEN:COMPONENT_KEY:${a.config_label}.${k}`);
      if (!sets[c.kind]) codes.push(`PREREG_FORMULA_FORBIDDEN:COMPONENT_KIND:${a.config_label}:${String(c.kind)}`);
      else if (!sets[c.kind].has(c.id)) codes.push(`PREREG_FORMULA_FORBIDDEN:UNREGISTERED_COMPONENT:${c.kind}:${String(c.id)}`);
    }
    if (rc.params !== undefined) {
      if (!isObj(rc.params)) { codes.push(`PREREG_FORMULA_FORBIDDEN:PARAMS_SHAPE:${a.config_label}`); continue; }
      for (const [k, v] of Object.entries(rc.params)) {
        const scalar = typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean' || (typeof v === 'string' && IDENT.test(v));
        if (!IDENT.test(k) || !scalar) codes.push(`PREREG_FORMULA_FORBIDDEN:PARAM_EXPRESSION:${a.config_label}.${k}`);
      }
    }
  }
  return codes;
};

V.V8 = ({ draft, ctx }) => {
  const codes = [];
  const s = draft.scope;
  if (s.new_data_fetch) codes.push('PREREG_DATA_NEW_FETCH');
  if (s.unseal) codes.push('PREREG_DATA_UNSEAL');
  if (s.production_config_touch) codes.push('PREREG_DATA_PRODUCTION_CONFIG');
  const inv = ctx.inventory || new Set();
  for (const d of draft.data_inputs) {
    const key = d.series ? `${d.dataset_id}#series=${d.series}` : d.dataset_id;
    if (!inv.has(key)) codes.push(`PREREG_DATA_NOT_LOCAL:${key}`);
    if (d.range.from > d.range.to) codes.push(`PREREG_DATA_RANGE_INVALID:${key}`);
    if (draft.sample.from < d.range.from || draft.sample.to > d.range.to) codes.push(`PREREG_DATA_SAMPLE_OUTSIDE_RANGE:${key}`);
    let labels = [];
    try { labels = trials.segmentLabels(draft.family_id, d.range.from, d.range.to, { marks: ctx.marks || [] }); } catch (e) { codes.push(codeOf(e)); continue; }
    if (labels.includes('UNSEEN')) codes.push(`PREREG_DATA_UNSEEN_FIRST_READ:${key}`); // RF1118 star P3 (a)
    else if (d.segment_label !== 'SEEN') codes.push(`PREREG_DATA_LABEL_MISMATCH:${key}`);
  }
  return codes;
};

/** V9 runs at finalize, with the receipt and the ledger snapshot the program was handed. */
V.V9 = ({ draft, ctx, text, k2Sha, receipts, prepared }) => {
  const codes = [];
  if (receipts.request_sha256 !== prepared.request_sha256) return ['TRIAL_LEDGER_RECEIPT_MISMATCH'];
  const rows = Array.isArray(ctx.ledgerRows) ? ctx.ledgerRows : [];
  const entry = { id: draft.draft_id, strategy_ref: draft.family_id, k2: { sha256: k2Sha }, k2_frozen_at: ctx.now };
  try { trialGates.internals.checkPre(entry, Buffer.from(text), rows); } catch (e) { codes.push(codeOf(e)); return codes; }
  const frozen = Date.parse(ctx.now);
  for (const arm of draft.arms) {
    const id = trials.trialIdOf({ family_id: draft.family_id, study_ref: draft.study_ref, config_label: arm.config_label });
    const reg = rows.find((r) => r.trial_id === id && r.row_kind === 'REGISTRATION');
    if (!reg) { codes.push(`TRIAL_LEDGER_PRE_NOT_REGISTERED:${id}`); continue; }
    if (!(Date.parse(reg.registered_at) < frozen)) codes.push(`TRIAL_LEDGER_PRE_REGISTERED_AFTER_FREEZE:${id}:NOT_BEFORE_FREEZE`);
    if (!receipts.rows.some((r) => r.trial_id === id && r.record_hash === reg.record_hash)) codes.push(`TRIAL_LEDGER_RECEIPT_MISMATCH:${id}`);
  }
  return codes;
};

V.V10 = ({ draft, ctx }) => {
  if (!isAi(draft)) return { state: 'NOT_APPLICABLE', reason: 'HUMAN_AUTHORED' };
  const r = ctx.receipt;
  if (r === null || r === undefined) return ['PREREG_ISOLATION_RECEIPT_MISSING'];
  const codes = [];
  const unknown = (what) => codes.push(`PREREG_ISOLATION_UNKNOWN:${what}`);
  if (!isObj(r) || r.schema !== 'RUN_RECEIPT_V1') return ['PREREG_ISOLATION_RECEIPT_INVALID'];
  if (r.host !== draft.authored_by.host) codes.push('PREREG_ISOLATION_HOST');
  if (!Array.isArray(r.mounts)) unknown('mounts');
  else {
    const bad = r.mounts.filter((m) => !(isObj(m) && ((m.kind === 'BUNDLE' && m.mode === 'ro') || (m.kind === 'OUTPUT' && m.mode === 'rw'))));
    if (bad.length || !r.mounts.some((m) => m.kind === 'BUNDLE')) codes.push('PREREG_ISOLATION_MOUNT');
  }
  if (!isObj(r.network)) unknown('network');
  else if (r.network.egress !== 'NONE') codes.push(r.network.egress === undefined || r.network.egress === null ? 'PREREG_ISOLATION_UNKNOWN:network.egress' : 'PREREG_ISOLATION_NETWORK');
  if (!Array.isArray(r.model_calls)) unknown('model_calls');
  else if (r.model_calls.some((c) => !(isObj(c) && c.via === 'GATEWAY_SOCKET'))) codes.push('PREREG_ISOLATION_MODEL_PATH');
  const cn = r.canary;
  if (!isObj(cn) || !Array.isArray(cn.probes) || !cn.probes.length) unknown('canary');
  else if (cn.self_test !== 'PASS' || cn.probes.some((p) => p.readable === null || p.readable === undefined)) codes.push('PREREG_ISOLATION_CANARY_UNKNOWN');
  else if (cn.probes.some((p) => p.readable !== false)) codes.push('PREREG_ISOLATION_CANARY');
  const b = ctx.bundle;
  if (!isObj(b) || b.builder !== bundleBuilder.BUILDER || !SHA64.test(b.sha256 || '') || r.bundle_sha256 !== b.sha256) codes.push('PREREG_ISOLATION_BUNDLE');
  return codes;
};

V.V11 = ({ draft, ctx }) => {
  const codes = [];
  if (isAi(draft) && draft.authored_by.host !== MARKET_HOST[draft.market]) codes.push(`PREREG_SCOPE_HOST_MISMATCH:${draft.market}@${draft.authored_by.host}`);
  if (draft.scope.live_class === 'NEEDS_SIGNATURE' && draft.scope.research_only !== true) codes.push('PREREG_SCOPE_LIVE_REQUIRES_SIGNATURE');
  const counted = draft.arms.filter(countsInN).length;
  if (counted > rf1118.CAPS.arms_per_freeze) codes.push(`PREREG_CAP_ARMS:${counted}>${rf1118.CAPS.arms_per_freeze}`);
  const now = cstKeys(ctx.now);
  const same = (ctx.priorFreezes || []).filter((f) => f.market === draft.market && isCstStamp(f.frozen_at));
  if (same.filter((f) => cstKeys(f.frozen_at).week === now.week).length >= rf1118.CAPS.per_week) codes.push(`PREREG_CAP_WEEK:${draft.market}:${now.week}`);
  if (same.filter((f) => cstKeys(f.frozen_at).month === now.month).length >= rf1118.CAPS.per_month) codes.push(`PREREG_CAP_MONTH:${draft.market}:${now.month}`);
  return codes;
};

/** The artifact id and the clock are checked at both phases; the existing-freeze check needs the K2 sha. */
V.V12 = ({ draft, ctx, k2Sha, existing, phase, preparedMismatch }) => {
  const codes = [];
  if (preparedMismatch) codes.push('PREREG_ARTIFACT_PREPARED_MISMATCH');
  if (!ID_RE.test(draft.draft_id)) codes.push(`PREREG_ARTIFACT_ID:${draft.draft_id}`);
  if (!isCstStamp(ctx.now)) codes.push('PREREG_ARTIFACT_CLOCK');
  if (existing && existing.k2_sha256 !== k2Sha) codes.push(`PREREG_ARTIFACT_EXISTS:${draft.draft_id}`);
  if (codes.length) return codes;
  return phase === 'FINALIZE' ? [] : { state: 'PENDING', reason: 'ARTIFACTS_WRITTEN_AT_FINALIZE' };
};

V.V13 = ({ draft, ctx, k2Sha, phase, existing }) => {
  if (phase !== 'FINALIZE') return { state: 'PENDING', reason: 'QUEUE_LINE_BUILT_AT_FINALIZE' };
  if (existing && existing.k2_sha256 === k2Sha) return []; // replay of a freeze the relay has already announced
  if (queueLine.count(ctx.queueLogText || '', k2Sha) >= 1) return [`PREREG_QUEUE_LINE_DUPLICATE:${draft.draft_id}`];
  return [];
};

V.V14 = ({ draft, ctx }) => {
  if (!isAi(draft)) return { state: 'NOT_APPLICABLE', reason: 'HUMAN_AUTHORED' };
  const a = draft.authored_by;
  const hit = (ctx.admissions || []).some((x) => x.mode === 'AI_PREREG' && x.prompt_sha256 === a.prompt_sha256 && x.schema_sha256 === a.schema_sha256 && x.model === a.model);
  return hit ? [] : [`PREREG_PROMPT_NOT_ADMITTED:${a.model}`];
};

/** Run one validator; a thrown error is a refusal with its code, never a pass. */
function runOne(id, st) {
  const mutant = process.env.QRP_TEST_K2_PROGRAM_MUTANT === '1' && Array.isArray(st.ctx.testDisableValidators) && st.ctx.testDisableValidators.includes(id);
  if (mutant) return { v: id, name: NAMES[id], state: 'PASS', codes: [], reason: 'MUTANT_DISABLED' };
  let out;
  try { out = V[id](st); } catch (e) { out = [codeOf(e)]; }
  if (Array.isArray(out)) return { v: id, name: NAMES[id], state: out.length ? 'REFUSED' : 'PASS', codes: out };
  return { v: id, name: NAMES[id], state: out.state, codes: [], reason: out.reason };
}

module.exports = { NAMES, ORDER, ID_RE, REFUSED_ROUTES, MARKET_HOST, V, runOne, priorTable, factorIds, cstKeys, componentsOf, prefixOf, ZERO };
