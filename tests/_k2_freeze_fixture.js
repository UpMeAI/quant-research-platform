'use strict';
/**
 * Fixtures for the K2_FREEZE_PROGRAM_V1 tests (AUTONOMOUS_RESEARCH_QUEUE_V1 Q3). Synthetic drafts only; real QRP gates, real registers.
 * Must be required after ./_env (isolated QRP_DATA_DIR).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mech = require('../services/research-mechanism-register');
const datasetRegistry = require('../services/dataset-registry');
const trials = require('../services/trial-ledger');

const AUTH = 'TEST_K2_PROGRAM_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
process.env.QRP_TEST_K2_PROGRAM_MUTANT = '1';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p = 'k2prog-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const REGISTER_BYTES = fs.readFileSync(mech.FILE);
const REGISTER_COMMIT = 'e'.repeat(40);
const NOW_PREPARE = '2026-11-24T10:00:00+08:00';
const NOW_FREEZE = '2026-11-24T10:05:00+08:00';
const REGISTERED_AT = '2026-11-24T10:02:00+08:00';
const PROMPT = 'a'.repeat(64);
const SCHEMA = require('../services/k2-freeze-program/schema').SCHEMA_SHA256;
const MECH_OK = 'ACCT.CONCURRENCY.NON_MAJOR_CAP'; // CN_A: NORMAL_NO_PRIOR in the checked-in register
const MECH_SHADOW = 'SEL.EXIT.NO_PROGRESS_EXIT'; // CN_A: ATTACH_TO_SHADOW
const MECH_LIVE = 'ACCT.DERISK.DRAWDOWN_LOOKBACK'; // US_EQUITY: QUARTERLY_ABLATION
const FACTOR = 'CN_A.MOM.RS60_MARKET_PCT';
const FACTOR2 = 'CN_A.MOM.RS20_UNIT_PCT';
const DATASET = 'ALL_A_CROSS_SECTION';
let counter = 0;

/** Registered promotion-terms values for tests (the real ones come from the deterministic bundle, like margin_sd from the risk rules). */
const POLICY = { horizon_months: 12, p_threshold: 0.5, budget_share_max: 0.2, resume_sample_fraction: 0.5, max_failed_rechecks: 3 };
const TH = { s3: { cost_multiple: 2, max_growth_sacrifice: 0.01 }, s4: { max_overlap: 0.8 } };
const TERMS_STAR = { insufficient_policy: POLICY, by_layer: {
  ALPHA: { min_economic_value: { metric: 'DELTA_G_PER_YEAR', value: 0.02 }, thresholds: TH }, EXECUTION: { min_economic_value: { metric: 'DELTA_G_PER_YEAR', value: 0.01 }, thresholds: TH },
  RISK: { min_economic_value: { metrics: ['NON_INFERIORITY_D8', 'TOUCH_PROBABILITY_DIFF_X06'], value: 0 }, thresholds: TH, gate: 'NON_INFERIORITY_FALLBACK' } } };

const clone = (o) => JSON.parse(JSON.stringify(o));
const pinned = datasetRegistry.pinned();

function baseDraft(over = {}) {
  counter += 1;
  const n = String(counter).padStart(3, '0');
  const draft = {
    schema: 'K2_DRAFT_V1', draft_id: `AIP-CNA-${n}`, market: 'CN_A', family_id: `AIP_CNA_F${n}`, study_ref: `AIP-CNA-${n}-K2-V1`, title_zh: '合成预登记草稿', revision: 0,
    authored_by: { kind: 'AI_PREREG_AGENT', model: 'deepseek-flash', prompt_sha256: PROMPT, schema_sha256: SCHEMA, host: 'LINUX' },
    section0: { mechanism_ids: [MECH_OK], mechanism_text_zh: '并发上限随账户状态收紧', failure_mode_zh: '上限收得过紧时错过行情', explained_by_zh: '可能被现行并发上限规则解释', ai_inputs: [] },
    data_inputs: [{ dataset_id: DATASET, registry_version: pinned.registry_version, registry_sha256: pinned.registry_sha256, pit: 'OBSERVED_AT', vendor: 'Tushare',
      range: { from: '2024-01-02', to: '2025-12-31' }, segment_label: 'SEEN' }],
    causality: { not_applicable_code: 'RISK_K_OR_ACCOUNT_LAYER' },
    desk_items: { candidate_ref: 'RLC-CNA-2026W47-1', rule_ref: 'CN_A.RULE.CONCURRENCY', change_and_window_zh: '把并发上限从固定值改为随回撤收紧，窗口 2024-01-02 至 2025-12-31，不带方向。',
      decision_criteria_zh: 'PASS：差值区间下界大于 0 且样本不少于 32；FAIL：区间上界小于 0；其余为 INSUFFICIENT。功效 0.8，显著性 0.05，95% 区间。',
      data_limits_zh: '只用本机已有的全 A 截面，没有弱数据。', round2_plan_zh: '第二轮仍 INSUFFICIENT 时转 paper 前瞻验证。', lease_ref: 'LEASE-D7-001',
      measurement_plan_zh: '对照取基线账本，首次看点 2026-12-15。', paper_stop_zh: '连续两周回撤超过预签线即停。' },
    arms: [
      { config_label: 'BASELINE', role: 'BASELINE', stage: 'BOOK', rule_config: { components: [{ kind: 'FACTOR', id: FACTOR }], params: { cap: 5 } } },
      { config_label: 'ARM_A', role: 'VERDICT_ARM', stage: 'BOOK', rule_config: { components: [{ kind: 'FACTOR', id: FACTOR }, { kind: 'FACTOR', id: FACTOR2 }], params: { cap: 4 } } },
    ],
    comparison: { kind: 'BASELINE_ARM', baseline_label: 'BASELINE' },
    sample: { from: '2024-01-02', to: '2025-12-31', n_obs_planned: 60 },
    decision_table: { template_id: 'DT-DELTA-VS-BASELINE-V1', params: { alpha: 0.05, power_target: 0.8, min_sample_n: 32, min_effect_sd: 0.5, ci_level: 0.95 } },
    power: { effect_size_sd: 0.5, alpha: 0.05, power_target: 0.8, n_required: 32 },
    scope: { live_class: 'NONE', research_only: true, new_data_fetch: false, unseal: false, production_config_touch: false },
    deviation_codes: [],
    // Q3b: what the K2 freezes for the promotion engine and for W20 V-5 (values are the registered ones in TERMS_STAR below)
    promotion_terms: { layer: 'ALPHA', min_economic_value: TERMS_STAR.by_layer.ALPHA.min_economic_value, thresholds: TERMS_STAR.by_layer.ALPHA.thresholds, insufficient_policy: TERMS_STAR.insufficient_policy,
      review_endpoint: { kind: 'DATE', value: '2026-12-31' } },
    robustness_declaration: { tests: [
      { id: 'COST_X2', kind: 'COST_MULTIPLIER', metric: 'delta_g_ci_lower', op: '>', threshold: 0, multiplier: 2 },
      { id: 'PARAM_PERTURB', kind: 'PARAM_PERTURBATION', metric: 'delta_g_ci_lower', op: '>', threshold: 0 },
      { id: 'SUB_PERIOD', kind: 'SUB_PERIOD', metric: 'delta_g_ci_lower', op: '>=', threshold: 0 },
    ] },
  };
  return merge(draft, over);
}
function merge(base, over) {
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = v;
  return out;
}

const receipt = (bundleSha, over = {}) => {
  const { host, network, model_calls: modelCalls, canary, ...top } = over;
  return { receipt: 'RUN_RECEIPT_V1', task_id: 'T1', attempt_no: 1, mounts: [{ path: '/rq/in', mode: 'ro', kind: 'BUNDLE' }, { path: '/rq/out', mode: 'rw', kind: 'OUTPUT' }],
    isolation: { host: host || 'LINUX', bundle_sha256: bundleSha, network: network || { egress: 'NONE', gateway_socket: true }, model_calls: modelCalls || [{ via: 'GATEWAY_SOCKET', purpose: 'RQ_AGENT' }],
      canary: canary || { self_test: 'PASS', probes: [{ label: 'sealed-like-1', readable: false }] } }, ...top };
};

function baseCtx(over = {}) {
  const bundle = { sha256: 'c'.repeat(64), builder: 'K2_BUNDLE_BUILDER_V1' };
  return {
    now: NOW_PREPARE, host: 'LINUX', outDir: tmp(), bundle, receipt: receipt(bundle.sha256),
    admissions: [{ prompt_id: 'RQ_PROMPT_AI_PREREG_V1', kind: 'AI_PREREG', system_sha256: PROMPT, state: 'ADMITTED' }],
    registerBytes: REGISTER_BYTES, registerCommit: REGISTER_COMMIT, registerAt: (c) => (c === REGISTER_COMMIT ? REGISTER_BYTES : null),
    powerOutputs: require('../services/k2-freeze-program/power').outputs(0.5), riskRules: { 'CN_A.RULE.CONCURRENCY': { margin_sd: 0.2 } },
    promotionTermsStar: TERMS_STAR, marks: [], inventory: new Set([DATASET]), evidenceBytes: () => null, pinnedCodeShas: {}, ledgerRows: [], priorFreezes: [], queueLogText: '', ...over,
  };
}

/** What the Mac registrar does: front door of the ledger, then hand back the receipt. */
function registerAt(prepared, at = REGISTERED_AT) {
  const registrar = require('../services/k2-freeze-program/registrar');
  return registrar.register(prepared.trl_request, { registeredBy: AUTH, registeredAt: at });
}
const ledgerRows = () => trials.trialRows();

const armsOf = (n) => [{ config_label: 'BASE', role: 'BASELINE', stage: 'BOOK', rule_config: { components: [{ kind: 'FACTOR', id: FACTOR }], params: { cap: 99 } } },
  ...Array.from({ length: n }, (_, i) => ({ config_label: `A${i}`, role: 'VERDICT_ARM', stage: 'BOOK', rule_config: { components: [{ kind: 'FACTOR', id: FACTOR }], params: { cap: i + 1 } } }))];

/** The validators that refused in a result, e.g. ['V3']. */
const failing = (res) => (res.results || []).filter((r) => r.state === 'REFUSED').map((r) => r.v);
const codesOf = (res, v) => ((res.results || []).find((r) => r.v === v) || { codes: [] }).codes;

const niDraftMut = (margin, ruleRef = 'CN_A.RULE.CONCURRENCY') => (d) => { d.decision_table = { template_id: 'DT-NON-INFERIORITY-V1', params: { ...d.decision_table.params, margin_sd: margin } }; d.desk_items.rule_ref = ruleRef; };

module.exports = { TERMS_STAR, niDraftMut, armsOf, AUTH, sha, tmp, baseDraft, baseCtx, receipt, registerAt, ledgerRows, failing, codesOf, clone, pinned, trials, mech, datasetRegistry,
  NOW_PREPARE, NOW_FREEZE, REGISTERED_AT, PROMPT, SCHEMA, MECH_OK, MECH_SHADOW, MECH_LIVE, FACTOR, FACTOR2, DATASET, REGISTER_BYTES, REGISTER_COMMIT };
