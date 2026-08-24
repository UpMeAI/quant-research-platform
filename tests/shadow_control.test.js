'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const shadow = require('../services/shadow-control');
const experiments = require('../services/experiment-orchestrator');
const { setupExperiment } = require('./_fixture');

async function openRun(min = 3) {
  const fx = await setupExperiment({ min_forward_evidence: min });
  const run = shadow.openShadowRun({
    champion_ref: fx.champRef, challenger_ref: fx.chalRef,
    race_ref: 'RACE-T', experiment_ref: fx.exp.experiment_id,
  });
  return { fx, run };
}

test('Shadow:开启需要冻结完好的实验;min_forward_evidence 来自实验预注册', async () => {
  const { run } = await openRun(7);
  assert.equal(run.min_forward_evidence_default, 7);
  assert.equal(run.min_forward_evidence.default, 7);
  assert.equal(run.virtual_ledger_ref, `VL-${run.shadow_id}`);
  assert.throws(() => shadow.openShadowRun({
    champion_ref: 'a', challenger_ref: 'b', race_ref: 'c', experiment_ref: 'EXP-NOPE',
  }), /SHADOW_REJECTED_EXPERIMENT/);
});

test('Shadow:观察幂等(同 key 跳过);agree 也计入前向样本;Virtual Ledger 独立记账', async () => {
  const { run } = await openRun(3);
  const obs = { key: '2026-06-01', business_date: '2026-06-01', champion_output: ['600001.SH'], challenger_output: ['600001.SH'] };
  const r1 = shadow.recordObservation(run.shadow_id, obs);
  assert.equal(r1.agree, true);
  const r2 = shadow.recordObservation(run.shadow_id, obs);
  assert.equal(r2.idempotent_skip, true);
  assert.equal((await shadow.sufficiency(run.shadow_id)).forward_sample_count, 1);
  assert.equal(shadow.virtualLedger(run.shadow_id).length, 1);
});

test('Shadow:样本不足 DESCRIBE_ONLY,足量 CLAIM_ELIGIBLE', async () => {
  const { run } = await openRun(3);
  shadow.recordObservation(run.shadow_id, { key: 'd1', business_date: 'd1', champion_output: [], challenger_output: [] });
  shadow.recordObservation(run.shadow_id, { key: 'd2', business_date: 'd2', champion_output: [], challenger_output: ['600001.SH'] });
  assert.equal((await shadow.sufficiency(run.shadow_id)).claim_status, 'DESCRIBE_ONLY');
  shadow.recordObservation(run.shadow_id, { key: 'd3', business_date: 'd3', champion_output: [], challenger_output: [] });
  const s = await shadow.sufficiency(run.shadow_id);
  assert.equal(s.claim_status, 'CLAIM_ELIGIBLE');
  assert.equal(s.disagreement_count, 1);
});

test('Shadow:经 adapter 的同 PIT 观察可入账;halt 后拒绝新观察;停止条件枚举', async () => {
  const { fx, run } = await openRun(3);
  const artifact = await experiments.runBacktest(fx.exp.experiment_id);
  const evalDate = artifact.dates[artifact.dates.length - 1];
  const obs = await shadow.observeViaAdapter(run.shadow_id, evalDate);
  assert.equal(obs.business_date, evalDate);
  assert.throws(() => shadow.haltShadowRun(run.shadow_id, 'BECAUSE'), /BAD_STOP_CONDITION/);
  shadow.haltShadowRun(run.shadow_id, 'OPERATIONAL_ERROR_OR_DUPLICATE', '测试停机');
  assert.throws(() => shadow.recordObservation(run.shadow_id, { key: 'x', business_date: 'x', champion_output: [], challenger_output: [] }), /SHADOW_NOT_RUNNING/);
});

test('§11 前向最低样本按 Regime 预注册:总量够但某 Regime 缺口 → 仍 DESCRIBE_ONLY', async () => {
  const fx = await setupExperiment({
    spec: { min_forward_evidence: { default: 4, by_regime: { UPTREND: 1, DOWNTREND: 1, RANGE: 1, HIGH_VOL: 99 } } },
  });
  const run = shadow.openShadowRun({
    champion_ref: fx.champRef, challenger_ref: fx.chalRef, race_ref: 'R', experiment_ref: fx.exp.experiment_id,
  });
  assert.equal(run.min_forward_evidence.default, 4);
  assert.equal(run.min_forward_evidence.by_regime.HIGH_VOL, 99);
  assert.deepEqual(run.min_forward_evidence.holding_period, fx.exp.holding_period ?? null);

  const artifact = await experiments.runBacktest(fx.exp.experiment_id);
  for (const d of artifact.dates.slice(-12)) await shadow.observeViaAdapter(run.shadow_id, d);

  const s = await shadow.sufficiency(run.shadow_id);
  assert.ok(s.forward_sample_count >= 4, '总量应已达 default');
  assert.equal(s.claim_status, 'DESCRIBE_ONLY', '某 Regime 未达预注册最低样本时不得放行');
  assert.equal(s.by_regime.HIGH_VOL.met, false);
  assert.match(s.claimCn, /Regime 缺口/);

  // 可达成的分 Regime 预注册 → CLAIM_ELIGIBLE
  const fx2 = await setupExperiment({ spec: { min_forward_evidence: { default: 3, by_regime: {} } } });
  const run2 = shadow.openShadowRun({
    champion_ref: fx2.champRef, challenger_ref: fx2.chalRef, race_ref: 'R', experiment_ref: fx2.exp.experiment_id,
  });
  const a2 = await experiments.runBacktest(fx2.exp.experiment_id);
  for (const d of a2.dates.slice(-4)) await shadow.observeViaAdapter(run2.shadow_id, d);
  assert.equal((await shadow.sufficiency(run2.shadow_id)).claim_status, 'CLAIM_ELIGIBLE');
});

test('§11 分 Regime 预注册但 adapter 无 regime_labels → 无法核验即 DESCRIBE_ONLY(不因总数够放行)', async () => {
  const local = require('../adapters/ashare-local');
  const { registerAdapter } = require('../adapters/registry');
  const noRegime = { ...local, manifest: { ...local.manifest, market_id: 'CN_A_NOREGIME' } };
  delete noRegime.regime_labels;
  registerAdapter(noRegime);

  const fx = await setupExperiment({ spec: { market: 'CN_A_NOREGIME', min_forward_evidence: { default: 1, by_regime: { UPTREND: 1 } } } });
  const run = shadow.openShadowRun({
    champion_ref: fx.champRef, challenger_ref: fx.chalRef, race_ref: 'R', experiment_ref: fx.exp.experiment_id,
  });
  shadow.recordObservation(run.shadow_id, { key: 'k1', business_date: 'd1', champion_output: [], challenger_output: [] });
  shadow.recordObservation(run.shadow_id, { key: 'k2', business_date: 'd2', champion_output: [], challenger_output: [] });
  const s = await shadow.sufficiency(run.shadow_id);
  assert.ok(s.forward_sample_count >= s.min_required);
  assert.equal(s.by_regime, 'UNVERIFIABLE');
  assert.equal(s.claim_status, 'DESCRIBE_ONLY');
});
