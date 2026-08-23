'use strict';
/**
 * Shadow Control(L5,§11)—— 同 PIT 并行影子 + Virtual Ledger + disagreement 台账。
 * 迁移自 Ashare-V5 services/phase2/shadow_runner,按新设计扩展:
 *   - Virtual Ledger:Challenger 输出只写虚拟账本,零 Runtime 影响;
 *   - Forward minimum evidence 由 ExperimentSpec 预注册(min_forward_evidence),
 *     不全局一刀切(§11 末条);
 *   - Operational failure 与 Economic failure 分开归因(停止条件枚举)。
 *
 * Shadow Contract(硬约束):
 *   - Champion 与 Challenger 消费同一 PIT 输入、同一 bar cutoff、同一成本模型;
 *   - Shadow 不修改生产 Candidate / TradePlan / Position / Order / Runtime state;
 *   - 每个 disagreement 记 reason codes、输入 refs、版本、数据质量、后续 outcome;
 *   - 幂等:同 (shadow_id, key) 重复提交 = 跳过;
 *   - 样本不足只能描述(DESCRIBE_ONLY),不允许宣称有效。
 */
const path = require('path');
const { dataDir, hash, now, uid, append, read } = require('../../packages/ledger');
const experiments = require('../../services/experiment-orchestrator');
const { getAdapter } = require('../../adapters/registry');

const DIR = () => dataDir('shadow');
const SHADOW_LEDGER = () => path.join(DIR(), 'shadow_runs.jsonl');
const DISAGREEMENT_LEDGER = () => path.join(DIR(), 'shadow_observations.jsonl');
const VIRTUAL_LEDGER = () => path.join(DIR(), 'virtual_ledger.jsonl');

const STOP_CONDITIONS = Object.freeze([
  'LOOKAHEAD_OR_DATA_CONTAMINATION', 'GUARDRAIL_DETERIORATION', 'OPERATIONAL_ERROR_OR_DUPLICATE',
  'OVERFIT_SINGLE_SUBSAMPLE', 'MECHANISM_CONTRADICTED',
]);
const DEFAULT_MIN_FORWARD_SAMPLE = 20; // 实验未预注册时的保守默认

function openShadowRun(o = {}) {
  for (const k of ['champion_ref', 'challenger_ref', 'race_ref', 'experiment_ref']) {
    if (!o[k]) throw new Error(`SHADOW_MISSING_FIELD:${k}`);
  }
  const v = experiments.verifyFreeze(o.experiment_ref);
  if (!v.ok) throw new Error(`SHADOW_REJECTED_EXPERIMENT:${v.reason}`);
  const shadowId = o.shadow_id || `SHD-${hash({ c: o.challenger_ref, t: uid() })}`;
  const rec = {
    schema: 'SHADOW_RUN_V1',
    shadow_id: shadowId,
    market: v.spec.market,
    experiment_ref: o.experiment_ref,
    champion_release_ref: o.champion_ref,
    challenger_release_ref: o.challenger_ref,
    race_ref: o.race_ref,
    virtual_ledger_ref: `VL-${shadowId}`,
    min_forward_evidence: Number(v.spec.min_forward_evidence ?? DEFAULT_MIN_FORWARD_SAMPLE),
    pit_contractCn: '同 PIT snapshot/候选/成本/bar cutoff;影子零 Active 影响(不触碰 TradePlan/Position/Paper 账本)',
    status: 'RUNNING',
    halted_reason: null,
    openedAt: now(),
  };
  return append(SHADOW_LEDGER(), rec);
}

function shadowHead(shadowId) {
  const rows = read(SHADOW_LEDGER()).filter((r) => r.shadow_id === shadowId);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * 由 adapter 在同一 PIT cutoff 下生成一次 Champion/Challenger 双边观察并入账。
 * agree=true 也入账(前向样本数要真实累计);Challenger 输出同步写 Virtual Ledger。
 */
function observeViaAdapter(shadowId, evalDate) {
  const head = shadowHead(shadowId);
  if (!head) throw new Error('SHADOW_NOT_FOUND');
  const v = experiments.verifyFreeze(head.experiment_ref);
  if (!v.ok) throw new Error(`SHADOW_OBSERVE_REJECTED:${v.reason}`);
  const obs = getAdapter(head.market).run_shadow_observation(v.spec, evalDate);
  return recordObservation(shadowId, obs);
}

/** 记录一次对比观察(幂等键 = shadow_id + key)。 */
function recordObservation(shadowId, obs = {}) {
  const head = shadowHead(shadowId);
  if (!head) throw new Error('SHADOW_NOT_FOUND');
  if (head.status !== 'RUNNING') throw new Error(`SHADOW_NOT_RUNNING:${head.status}`);
  for (const k of ['key', 'business_date', 'champion_output', 'challenger_output']) {
    if (obs[k] === undefined || obs[k] === null) throw new Error(`OBSERVATION_MISSING:${k}`);
  }
  const dup = read(DISAGREEMENT_LEDGER()).some((r) => r.shadow_id === shadowId && r.key === obs.key);
  const agree = JSON.stringify(obs.champion_output) === JSON.stringify(obs.challenger_output);
  const rec = {
    schema: 'SHADOW_OBSERVATION_V1',
    shadow_id: shadowId,
    key: obs.key,
    business_date: obs.business_date,
    agree,
    champion_output: obs.champion_output,
    challenger_output: obs.challenger_output,
    reason_codes: agree ? [] : (obs.reason_codes || ['UNCLASSIFIED_DISAGREEMENT']),
    input_refs: obs.input_refs || [],
    versions: { champion: head.champion_release_ref, challenger: head.challenger_release_ref },
    data_quality: obs.data_quality || 'UNKNOWN',
    outcome: obs.outcome || null,
    idempotent_skip: dup,
    recordedAt: now(),
  };
  if (dup) return rec; // 幂等:不重复入账
  append(DISAGREEMENT_LEDGER(), rec);
  // Virtual Ledger:Challenger 侧输出独立记账(只虚拟,不碰 Runtime)
  append(VIRTUAL_LEDGER(), {
    schema: 'SHADOW_VIRTUAL_LEDGER_V1',
    virtual_ledger_ref: head.virtual_ledger_ref,
    shadow_id: shadowId,
    business_date: obs.business_date,
    challenger_signals: obs.challenger_output,
    champion_signals: obs.champion_output,
    recordedAt: now(),
  });
  return rec;
}

/** 给已有观察补充后续 outcome(append 修正,不改历史行)。 */
function recordOutcome(shadowId, key, outcome) {
  const rows = read(DISAGREEMENT_LEDGER()).filter((r) => r.shadow_id === shadowId && r.key === key);
  if (!rows.length) throw new Error('OBSERVATION_NOT_FOUND');
  return append(DISAGREEMENT_LEDGER(), { ...rows[rows.length - 1], outcome, outcomeRecordedAt: now() });
}

/** 停止条件:命中即 halt(reason 必须在枚举内;Operational 与 Economic 分开归因)。 */
function haltShadowRun(shadowId, stopCondition, detailCn) {
  if (!STOP_CONDITIONS.includes(stopCondition)) throw new Error(`BAD_STOP_CONDITION:${stopCondition}`);
  const head = shadowHead(shadowId);
  if (!head) throw new Error('SHADOW_NOT_FOUND');
  return append(SHADOW_LEDGER(), { ...head, status: 'HALTED', halted_reason: stopCondition, halted_detailCn: detailCn || null, haltedAt: now() });
}

/**
 * 样本充分性(阈值 = 该实验预注册 min_forward_evidence):
 * 不足 → DESCRIBE_ONLY(禁止宣称有效);足量 → CLAIM_ELIGIBLE。
 */
function sufficiency(shadowId) {
  const head = shadowHead(shadowId);
  const minRequired = head ? head.min_forward_evidence : DEFAULT_MIN_FORWARD_SAMPLE;
  const m = new Map();
  for (const r of read(DISAGREEMENT_LEDGER()).filter((r) => r.shadow_id === shadowId)) m.set(r.key, r);
  const n = m.size;
  const disagreements = [...m.values()].filter((r) => !r.agree).length;
  return {
    shadow_id: shadowId, forward_sample_count: n, disagreement_count: disagreements,
    min_required: minRequired,
    claim_status: n >= minRequired ? 'CLAIM_ELIGIBLE' : 'DESCRIBE_ONLY',
    claimCn: n >= minRequired ? '样本足量,可进入有效性主张评审' : `样本 ${n}/${minRequired} 不足 —— 只能描述,不得宣称策略有效`,
  };
}

function listShadowRuns() {
  const m = new Map();
  for (const r of read(SHADOW_LEDGER())) m.set(r.shadow_id, r);
  return [...m.values()];
}
function listObservations(shadowId) {
  const m = new Map();
  for (const r of read(DISAGREEMENT_LEDGER()).filter((r) => r.shadow_id === shadowId)) m.set(r.key, r);
  return [...m.values()];
}
function virtualLedger(shadowId) {
  return read(VIRTUAL_LEDGER()).filter((r) => r.shadow_id === shadowId);
}

module.exports = {
  STOP_CONDITIONS, DEFAULT_MIN_FORWARD_SAMPLE,
  openShadowRun, shadowHead, observeViaAdapter, recordObservation, recordOutcome,
  haltShadowRun, sufficiency, listShadowRuns, listObservations, virtualLedger,
  SHADOW_LEDGER, DISAGREEMENT_LEDGER, VIRTUAL_LEDGER,
};
