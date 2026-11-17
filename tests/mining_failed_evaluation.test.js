'use strict';
/**
 * ★RF1116_ROUND1_STATE (a)（协调会话 2026-11-18）：新终态 FAILED_EVALUATION，只追加、不改任何一行。先红后绿，合成数据。
 *   - 只能从 OPEN / CAP_REACHED 进入，且留出段从未开启；要写原因与证据的 sha256；0 个通过；释放开轮名额；
 *   - 尝试留在 N（签字 §3.3「计入 N，从不按轮清零」）；按开轮月份计入每月 ≤ 2 轮；暂停规则按 0 个通过算；
 *   - 之后不能再记候选、开留出段或打分；命令行 fail-evaluation 与 run.sh 一条命令（只挂 out/）。
 * 第 1 轮（MR-CN_A-2026-11-e1ab63a27b）就是这样：CAP_REACHED、选择已记（0 个）、留出段已封存未开启。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const AUTH = 'TEST_ROUND_RUNNER_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');
const trials = require('../services/trial-ledger');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'services/mining-sandbox/round-runner/cli.js');
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fe-fx-')));
const HOLDOUT_SUMS_SHA = crypto.createHash('sha256').update(fs.readFileSync(path.join(fx.dirs.holdout, 'SHA256SUMS'))).digest('hex');
const EVIDENCE = '3e3c70fcdc792e716c8fe09fc774c92427a636a8f3719b064fc95d4be89aa4f9';
const REASON = 'RF1116 round 1: industry membership 0 rows, every mining score null';
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fe-data-')); process.env.QRP_DATA_DIR = d; return d; };
const ledgerBytes = () => fs.readFileSync(rounds.LEDGER(), 'utf8');
/** 与 runner.requestRound 同一份清单，换开轮时刻与留出段（给跨月、跨段的名额与暂停测试）。 */
function openLike(base, openedAt, holdout) {
  return rounds.openRound({ market: base.market, space: base.space, holding_periods: base.holding_periods, generator: { mode: 'AI_MINED_GP', gp_seed: 9 },
    holdout, openedAt, rulings: base.rulings, selection_rule: base.selection_rule });
}

/** 第 1 轮的样子：开轮、封存、两个尝试到上限（CAP_REACHED）、选择记了 0 个，留出段没开。 */
function roundLikeRound1(out) {
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, cap: 2, openedAt: '2026-11-18T05:49:16+08:00' });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: HOLDOUT_SUMS_SHA });
  const stub = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: () => ['sign(close_hfq)', 'sign(open_hfq)'] };
  runner.internals.withGenerator(stub, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: { min_names_per_day: 5 } }));
  runner.select({ roundId: r.round_id, sources: sources(), outDir: out });
  return rounds.roundHead(r.round_id);
}

test('FAILED_EVALUATION：CAP_REACHED、选择已记、留出段封存未开 → 追加一行终态，0 个通过，证据与裁定写进 gmine_basis；前面各行一字不改；N 不变', () => {
  const out = freshData();
  const r = roundLikeRound1(out);
  assert.equal(r.status, 'CAP_REACHED');
  assert.deepEqual(rounds.selectionOf(r.round_id).selected, []);
  const before = ledgerBytes(); const n = rounds.familyN('CN_A', 5);
  const row = rounds.failEvaluation(r.round_id, { reason: REASON, evidenceSha256: EVIDENCE, failedAt: '2026-11-18T09:30:00+08:00' });
  assert.equal(row.status, 'FAILED_EVALUATION');
  assert.equal(row.gmine_passes, 0);
  assert.deepEqual(row.gmine_basis, { holdout_open_hash: null, records: 0, record_hashes: [],
    failed_evaluation: { reason: REASON, evidence_sha256: EVIDENCE, ruling: '★RF1116_ROUND1_STATE (a)', attempts: 2, selected: 0, holdout_sealed: true } });
  assert.equal(row.closed_at, '2026-11-18T09:30:00+08:00');
  assert.ok(ledgerBytes().startsWith(before), 'append-only: every earlier row is unchanged');
  assert.equal(rounds.roundHead(r.round_id).status, 'FAILED_EVALUATION');
  assert.ok(rounds.TERMINAL.includes('FAILED_EVALUATION') && rounds.FAILED_TERMINAL.includes('FAILED_EVALUATION'));
  assert.equal(rounds.familyN('CN_A', 5), n, 'its attempts stay in N');
  assert.ok(rounds.selectionOf(r.round_id), 'the selection row stays');
  assert.equal(vault.openLog(r.round_id).length, 0);
});

test('FAILED_EVALUATION 之后：不能再记候选、开留出段、打分；再关一次被拒', () => {
  const out = freshData();
  const r = roundLikeRound1(out);
  rounds.failEvaluation(r.round_id, { reason: REASON, evidenceSha256: EVIDENCE });
  assert.throws(() => rounds.recordCandidate(r.round_id, { candidate_id: 'x', formula_canonical: 'rank(pb)', formula_sha256: 'f'.repeat(64), holding_period: 5, mining_score: 0.1 },
    { registeredBy: AUTH }), code(/MINE_ROUND_(NOT_OPEN|GENERATION_CLOSED)/));
  assert.throws(() => rounds.beginScoring(r.round_id, { holdoutOpens: { segment: { from: '2026-10-19', to: '2026-12-31' }, family_ids: ['MINE:CN_A:H5'], count: 1 } }), code(/MINE_ROUND_NOT_OPEN/));
  assert.throws(() => runner.scoreHoldout({ roundId: r.round_id, sources: sources(), holdoutDir: fx.dirs.holdout, outDir: out }), code(/MINE_RUNNER_ROUND_FAILED_EVALUATION/));
  assert.throws(() => rounds.failEvaluation(r.round_id, { reason: REASON, evidenceSha256: EVIDENCE }), code(/MINE_ROUND_FAILED_EVALUATION_NOT_ALLOWED:.*FAILED_EVALUATION/));
});

test('FAILED_EVALUATION 的前提：留出段开过（SCORING）不行；没有原因、证据不是 sha256 不行；OPEN 的轮也可以', () => {
  freshData();
  const a = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, openedAt: '2026-11-18T05:49:16+08:00' });
  assert.throws(() => rounds.failEvaluation(a.round_id, { reason: '', evidenceSha256: EVIDENCE }), code(/MINE_ROUND_FAILED_EVALUATION_REASON/));
  assert.throws(() => rounds.failEvaluation(a.round_id, { reason: REASON, evidenceSha256: 'abc' }), code(/MINE_ROUND_FAILED_EVALUATION_EVIDENCE/));
  rounds.beginScoring(a.round_id, { holdoutOpens: { segment: { from: '2026-10-19', to: '2026-12-31' }, family_ids: ['MINE:CN_A:H5'], count: 1 } });
  assert.throws(() => rounds.failEvaluation(a.round_id, { reason: REASON, evidenceSha256: EVIDENCE }), code(/MINE_ROUND_FAILED_EVALUATION_NOT_ALLOWED:.*SCORING/));
  const b = openLike(rounds.roundHead(a.round_id), '2026-12-01T10:00:00+08:00', { from: '2027-01-04', to: '2027-03-31' });
  assert.equal(rounds.failEvaluation(b.round_id, { reason: REASON, evidenceSha256: EVIDENCE }).status, 'FAILED_EVALUATION', 'from OPEN too');
});

test('名额与上限：FAILED_EVALUATION 释放开轮名额；仍计入当月 2 轮；暂停规则按 0 个通过算', () => {
  freshData();
  const base = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, openedAt: '2026-11-18T05:49:16+08:00' }); // 11 月第 1 轮
  const second = openLike(base, '2026-11-20T10:00:00+08:00', { from: '2027-01-04', to: '2027-03-31' }); // 11 月第 2 轮，两个名额都占了
  assert.throws(() => openLike(base, '2026-12-01T10:00:00+08:00', { from: '2027-04-01', to: '2027-06-30' }), code(/MINE_ROUND_ALREADY_OPEN/));
  rounds.failEvaluation(base.round_id, { reason: REASON, evidenceSha256: EVIDENCE });
  assert.throws(() => openLike(base, '2026-11-25T10:00:00+08:00', { from: '2027-04-01', to: '2027-06-30' }), code(/MINE_ROUND_MONTHLY_CAP/), 'it still counts in November');
  const dec = openLike(base, '2026-12-01T10:00:00+08:00', { from: '2027-04-01', to: '2027-06-30' }); // 名额放出来了
  assert.equal(dec.status, 'OPEN');
  assert.equal(rounds.pauseState('CN_A').paused, false);
  rounds.failEvaluation(second.round_id, { reason: REASON, evidenceSha256: EVIDENCE });
  rounds.failEvaluation(dec.round_id, { reason: REASON, evidenceSha256: EVIDENCE });
  const p = rounds.pauseState('CN_A');
  assert.equal(p.paused, true, 'three FAILED_EVALUATION rounds in a row count as three rounds without a G-MINE pass');
  assert.deepEqual(p.failed_rounds, [base.round_id, second.round_id, dec.round_id]);
});

test('命令行 fail-evaluation 与 run.sh：只挂 out/，同一套容器限制；输出一行 JSON', () => {
  const out = freshData();
  const r = roundLikeRound1(out);
  const env = { ...process.env, QRP_DATA_DIR: process.env.QRP_DATA_DIR };
  const bad = spawnSync(process.execPath, [CLI, 'fail-evaluation', '--out', out, '--round', r.round_id, '--reason', REASON], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stderr).error, 'MINE_RUNNER_OPTION_REQUIRED');
  const ok = spawnSync(process.execPath, [CLI, 'fail-evaluation', '--out', out, '--round', r.round_id, '--reason', REASON, '--evidence-sha256', EVIDENCE], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const res = JSON.parse(ok.stdout);
  assert.deepEqual([res.command, res.round_id, res.status, res.gmine_passes, res.evidence_sha256], ['fail-evaluation', r.round_id, 'FAILED_EVALUATION', 0, EVIDENCE]);
  assert.ok(/^[0-9a-f]{64}$/.test(res.record_hash));
  const sh = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  const line = sh.split('\n').find((l) => /^\s*docker run /.test(l) && / fail-evaluation /.test(l));
  assert.ok(line, 'run.sh has a fail-evaluation docker run');
  for (const flag of ['--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 1000:1000', '-e QRP_DATA_DIR=/out/qrp-data']) assert.ok(line.includes(flag), flag);
  assert.deepEqual([...line.matchAll(/-v "([^"]+)"/g)].map((m) => m[1]), ['$OUT:/out:rw'], 'only out/ is mounted');
  assert.ok(line.includes('--round "$round" --reason "$reason" --evidence-sha256 "$evidence"'));
  const deploy = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/DEPLOY.md'), 'utf8');
  assert.ok(deploy.includes(`run.sh fail-evaluation MR-CN_A-2026-11-e1ab63a27b`) && deploy.includes(EVIDENCE), 'DEPLOY.md has the exact command for round 1');
});
