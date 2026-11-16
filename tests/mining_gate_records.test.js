'use strict';
/**
 * G-MINE 逐候选记录与关轮（协调会话 2026-11-17 裁定 3）：closeRound 不再收调用方给的过数，从本轮逐候选的 G-MINE 记录数出来
 * （过 = 九项全过）；开过留出段的候选只要有一个没记录 → 不许关。记录只追加，挂本轮的试验台账行与留出段开启记录，由 G-MINE 求值这条路写。
 * 暂停规则因此只看记录：连续 3 轮记录里 0 个过 → 暂停；有 1 个过 → 不暂停。先红后绿，全部是合成数据。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const AUTH = 'TEST_MINING_GATE_RECORDS_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const trials = require('../services/trial-ledger');
const rounds = require('../services/mining-rounds');
const records = require('../services/mining-rounds/gate-records');
const vault = require('../services/holdout-vault');
const { validateRecord } = require('../schemas');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const LLM = { mode: 'AI_MINED_LLM', model: 'synthetic-model', model_knowledge_cutoff: '2026-06-30' };
const HOLDOUT = { from: '2026-07-01', to: '2026-10-31' };
let n = 0;
/** 合成的 G-MINE 结果：九项，passing 为真则全过。 */
const fakeGate = (c) => ({ schema: 'MINING_GATE_RESULT_V1', candidate_id: c.candidate_id, factor_id: null, thresholds: { state: 'FROZEN', frozen_ref: { path: 'synthetic', sha256: 'a'.repeat(64) } },
  production_effect: 'NONE', pass: c.passing === true, eligible_status: c.passing === true ? 'RESEARCH' : null, codes: c.passing === true ? [] : ['MINE_IC_BELOW_MIN'],
  items: Array.from({ length: 9 }, (_, i) => ({ item: i + 1, key: `K${i + 1}`, pass: c.passing === true || i !== 2, codes: [], detail: {} })) });

/** 一轮：k 个候选，全部开留出段；返回轮次与候选编号。 */
function scoredRound(market, openedAt, k = 2) {
  n += 1;
  const r = rounds.openRound({ market, space: { space_ref: `MS-${n}`, sha256: sha(`s-${n}`), freeze: { path: `f-${n}`, sha256: sha(`f-${n}`) } }, holding_periods: [5], generator: LLM, holdout: HOLDOUT, openedAt });
  const ids = [];
  for (let i = 1; i <= k; i += 1) {
    const id = `${r.round_id}:C${String(i).padStart(3, '0')}`; const f = `rank(ts_mean(close,${n * 10 + i}))`;
    rounds.recordCandidate(r.round_id, { candidate_id: id, formula_canonical: f, formula_sha256: sha(f), holding_period: 5, mining_score: 0 }, { registeredBy: AUTH, registeredAt: openedAt });
    ids.push(id);
  }
  vault.seal({ round_id: r.round_id, segment: HOLDOUT, data_ref: `lane:/holdout/${market}`, data_sha256: sha(`h-${n}`), sealedBy: 'VAULT' });
  vault.open({ round_id: r.round_id, candidate_ids: ids, openedBy: 'SELECTOR' });
  return { r, ids };
}

test('关轮没有「过了几个」这个参数：传了就拒绝；过数只从逐候选的 G-MINE 记录数出来，记录挂试验台账行与留出段开启记录', () => {
  const { r, ids } = scoredRound('CN_A', '2027-01-02T02:00:00Z');
  assert.throws(() => rounds.closeRound(r.round_id, { gmine_passes: 1 }), code(/MINE_ROUND_GMINE_PASSES_NOT_A_PARAMETER/));
  records.internals.withGate(fakeGate, () => {
    const rec = records.recordGateResult({ round_id: r.round_id, candidate_id: ids[0], candidate: { candidate_id: ids[0], passing: true } });
    records.recordGateResult({ round_id: r.round_id, candidate_id: ids[1], candidate: { candidate_id: ids[1], passing: false } });
    const trial = [...trials.heads().values()].find((t) => t.mining && t.mining.candidate_id === ids[0]);
    assert.deepEqual([rec.pass, rec.trial_id, rec.trial_record_hash, rec.holdout_open_hash], [true, trial.trial_id, trial.record_hash, vault.openLog(r.round_id)[0].record_hash]);
    assert.ok(validateRecord(rec, 'MINING_GATE_RECORD_V1').ok);
    assert.throws(() => records.recordGateResult({ round_id: r.round_id, candidate_id: ids[0], candidate: { passing: false } }), code(/MINE_GATE_RECORD_DUPLICATE/));
  });
  const closed = rounds.closeRound(r.round_id);
  assert.deepEqual([closed.status, closed.gmine_passes, closed.gmine_basis.records], ['CLOSED', 1, 2]);
});

test('开过留出段的候选只要有一个没有 G-MINE 记录 → 不许关（MINE_ROUND_GMINE_RESULT_MISSING）；不在开启记录里的候选、没开留出段的轮不能记', () => {
  const { r, ids } = scoredRound('CN_A', '2027-02-02T02:00:00Z', 3);
  records.internals.withGate(fakeGate, () => {
    records.recordGateResult({ round_id: r.round_id, candidate_id: ids[0], candidate: { passing: false } });
    assert.throws(() => rounds.closeRound(r.round_id), code(new RegExp(`MINE_ROUND_GMINE_RESULT_MISSING:${r.round_id}:2`)));
    assert.throws(() => records.recordGateResult({ round_id: r.round_id, candidate_id: `${r.round_id}:C999`, candidate: {} }), code(/MINE_GATE_RECORD_NOT_OPENED/));
    records.recordGateResult({ round_id: r.round_id, candidate_id: ids[1], candidate: { passing: false } });
    records.recordGateResult({ round_id: r.round_id, candidate_id: ids[2], candidate: { passing: false } });
  });
  assert.equal(rounds.closeRound(r.round_id).gmine_passes, 0);
  assert.throws(() => records.recordGateResult({ round_id: r.round_id, candidate_id: ids[0], candidate: {} }), code(/MINE_GATE_RECORD_ROUND_NOT_SCORING/));
  // 真门（门槛没冻结）：记录写进来，不过
  const s = scoredRound('US', '2027-02-02T02:00:00Z', 1);
  const real = records.recordGateResult({ round_id: s.r.round_id, candidate_id: s.ids[0], candidate: {} });
  assert.deepEqual([real.pass, real.codes], [false, ['MINE_THRESHOLDS_UNFROZEN']]);
});

test('暂停只看记录：连续 3 轮记录里 0 个过 → 暂停；同样 3 轮里有 1 个记录过 → 不暂停', () => {
  records.internals.withGate(fakeGate, () => {
    for (const [i, m] of ['2027-03', '2027-04', '2027-05'].entries()) {
      const { r, ids } = scoredRound('CRYPTO', `${m}-02T02:00:00Z`);
      for (const id of ids) records.recordGateResult({ round_id: r.round_id, candidate_id: id, candidate: { passing: false } });
      rounds.closeRound(r.round_id);
      assert.equal(rounds.pauseState('CRYPTO').paused, i === 2);
    }
    // US：第二个 US 轮（上一条测试里开的）先记完、关掉；再两轮，其中一轮有 1 个过
    const prior = rounds.roundsOf('US').at(-1);
    rounds.closeRound(prior.round_id);
    for (const [i, m] of ['2027-03', '2027-04'].entries()) {
      const { r, ids } = scoredRound('US', `${m}-02T02:00:00Z`);
      ids.forEach((id, j) => records.recordGateResult({ round_id: r.round_id, candidate_id: id, candidate: { passing: i === 1 && j === 0 } }));
      rounds.closeRound(r.round_id);
    }
  });
  assert.deepEqual(rounds.roundsOf('US').filter((r) => r.status === 'CLOSED').map((r) => r.gmine_passes), [0, 0, 1]);
  assert.equal(rounds.pauseState('US').paused, false);
  assert.equal(rounds.pauseState('CRYPTO').paused, true);
});
