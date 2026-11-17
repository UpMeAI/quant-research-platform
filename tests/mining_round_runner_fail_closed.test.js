'use strict';
/**
 * 第 1 轮缺陷（MR-CN_A-2026-11-e1ab63a27b，2026-11-18）之后的两道关，先红后绿，合成数据：
 *   - 金丝雀：开轮之前，固定公式 (-close_hfq) 在挖掘段面板上必须算得出分（有效 IC 日 ≥ 半个面板），否则 MINE_RUNNER_CANARY_UNSCORABLE，
 *     不开轮、不封存、不记尝试（第 1 轮：行业成员全被滤掉 → 中性化把每个值都变成 NaN → 200 个候选的 IC 日都是 0）；
 *   - 算不出分（mining_score 不是有限数）的尝试记成 UNSCORABLE（计入 N，不进选择），永远不记成 SCORED。
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
const segs = require('../services/mining-sandbox/segments');
const rounds = require('../services/mining-rounds');
const trials = require('../services/trial-ledger');

const CLI = path.join(__dirname, '..', 'services/mining-sandbox/round-runner/cli.js');
const good = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fc-good-')));
// CONFLICT 永远不收：行业成员一行都用不上，与第 1 轮同一个后果（不论以后收不收 DEGRADED）
const broken = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fc-broken-')), { industryQuality: 'CONFLICT' });
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const sourcesOf = (fx) => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const miningPanel = (fx) => adapter.buildPanel({ sources: sourcesOf(fx), space: runner.loadFrozenSpace().space, segment: 'MINING', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.MINING.to });
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fc-data-')); process.env.QRP_DATA_DIR = d; return d; };
const COV = Object.freeze({ min_names_per_day: 5 });

test('金丝雀：好面板上 (-close_hfq) 算得出分；行业成员一行都用不上的面板被拒 MINE_RUNNER_CANARY_UNSCORABLE（第 1 轮的样子）', () => {
  const ok = runner.checkCanary(miningPanel(good));
  assert.equal(ok.formulas.length, 1);
  assert.equal(ok.formulas[0].formula, '(-close_hfq)');
  assert.ok(Number.isFinite(ok.formulas[0].score) && ok.formulas[0].ic_days >= ok.min_ic_days, JSON.stringify(ok));
  const panel = miningPanel(broken);
  assert.equal(panel.manifest.counts.industry.rows, 0, 'the broken fixture really has no usable industry row');
  assert.throws(() => runner.checkCanary(panel), code(/^MINE_RUNNER_CANARY_UNSCORABLE:\(-close_hfq\):ic_days=0</));
});

test('金丝雀在开轮之前：命令行 generate 在坏数据上退出 2，没有轮被开、没有封存、试验台账一行都没有', () => {
  const out = freshData();
  const sums = crypto.createHash('sha256').update(fs.readFileSync(path.join(broken.dirs.holdout, 'SHA256SUMS'))).digest('hex');
  const r = spawnSync(process.execPath, [CLI, 'generate', '--out', out, '--lane', broken.dirs.lane, '--tail', broken.dirs.tail, '--seed', '1',
    '--holdout-ref', 'synthetic:holdout', '--holdout-sha256', sums, '--min-names-per-day', '5'], { env: { ...process.env, QRP_DATA_DIR: out }, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stderr).error, 'MINE_RUNNER_CANARY_UNSCORABLE');
  assert.ok(!fs.existsSync(path.join(out, 'research', 'mining_rounds.jsonl')), 'no round opened');
  assert.ok(!fs.existsSync(path.join(out, 'research', 'trials.jsonl')), 'nothing entered N');
});

test('算不出分的尝试记 UNSCORABLE（计入 N、不进选择、GP 不当它有分），永远不记 SCORED；generate.json 记金丝雀', () => {
  const out = freshData();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, openedAt: '2026-11-20T02:00:00Z' });
  // sign(close_hfq) 恒为 1：中性化后每天都是常数，Spearman 算不出 → 没有一个有效 IC 日
  const texts = ['sign(close_hfq)', 'rank(pb)'];
  const stub = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => Array.from({ length: n }, (_, i) => texts[(view.mining_scores.length + i) % 2]) };
  const panel = miningPanel(good);
  const canary = runner.checkCanary(panel);
  const g = runner.internals.withGenerator(stub, () => runner.generate({ roundId: r.round_id, sources: sourcesOf(good), outDir: out, registeredBy: AUTH, coverageFloor: COV, panel, canary }));
  assert.deepEqual(g.attempts, { scored: 1, unscorable: 1, parse_refused: 0, deduped: 198 });
  assert.deepEqual(g.canary, canary);
  const rows = [...trials.heads().values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === r.round_id);
  assert.equal(rows.length, 200);
  assert.equal(rounds.familyN('CN_A', 5), 200, 'UNSCORABLE counts in N like every attempt');
  const scored = rows.filter((t) => t.rule_config.attempt === undefined);
  assert.equal(scored.length, 1);
  assert.ok(scored.every((t) => typeof t.metrics.mining_segment_score === 'number' && Number.isFinite(t.metrics.mining_segment_score)), 'a SCORED row always has a finite score');
  const un = rows.filter((t) => t.rule_config.attempt === 'UNSCORABLE');
  assert.equal(un.length, 1);
  assert.equal(un[0].rule_config.formula, 'sign(close_hfq)');
  assert.equal(un[0].metrics.mining_segment_score, null);
  assert.equal(un[0].rule_config.ic_days, 0);
  const log = fs.readFileSync(path.join(out, 'rounds', r.round_id.replace(/[^A-Za-z0-9_-]/g, '_'), 'attempts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(log.filter((x) => x.mining_score === null && x.status === 'SCORED'), [], 'attempts.jsonl never says SCORED with a null score');
  assert.equal(log.filter((x) => x.status === 'UNSCORABLE').length, 1);
  assert.deepEqual(runner.internals.scoredAttempts(r.round_id).map((c) => c.formula), ['rank(pb)'], 'only the scored attempt reaches the selection');
});
