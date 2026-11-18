'use strict';
/**
 * 独立复审（2026-11-18，evidence/rf1116-qrp122-123-review-20261118/REVIEW.md 12a23861）M-1、M-2、M-3 与 L-1，先红后绿，合成数据：
 *   - M-1：金丝雀逐个打分日（1 ≤ t ≤ 日数 − H − 1）核中性化后有限值的名字数（候选同一条路径 scoring.neutralizedValues）：
 *     ≥ 覆盖下限，且 ≥ 0.9 × 当天的覆盖数（池里且后复权收盘价有数）；有效 IC 日 ≥ 0.95 × 打分日数。行业只剩一部分名字、或只缺前一段日子，都拒；
 *   - M-2：门槛的每一项都钉住（份额、0.9、名字数下限、0.95）；命令行 --resume 也先过金丝雀，续跑记录不动；
 *   - M-3：直接调 generate() 也自己跑金丝雀（不信调用方给的结果），坏面板一个尝试都不记；
 *   - L-1（入口）：recordCandidate 只收两种：没有 attempt 标记的必须是有限分数；有标记的（PARSE_REFUSED / DEDUPED / UNSCORABLE）分数必须是 null。
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

const CLI = path.join(__dirname, '..', 'services/mining-sandbox/round-runner/cli.js');
const COV = Object.freeze({ min_names_per_day: 5 });
const good = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-cs-good-')));
const broken = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-cs-broken-')), { industryQuality: 'CONFLICT' });
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const sourcesOf = (fx) => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const miningPanel = (fx) => adapter.buildPanel({ sources: sourcesOf(fx), space: runner.loadFrozenSpace().space, segment: 'MINING', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.MINING.to });
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-cs-data-')); process.env.QRP_DATA_DIR = d; return d; };
const P = miningPanel(good);
const H = runner.loadFrozenSpace().holdingPeriod;
const SCORED_DAYS = P.dates.length - H - 1;
/** 面板副本：行业只留 keep(t, j) 为真的格子。 */
const withIndustry = (keep) => ({ ...P, industry: P.industry.map((row, t) => row.map((g, j) => (keep(t, j) ? g : null))) });
/** 面板副本：前 share 的日子没有开盘价标签（前推收益算不出，中性化后的值照常有）。 */
const withoutLabels = (share) => { const cut = Math.floor(share * P.dates.length); return { ...P, labels: { ...P.labels, exec_open: P.labels.exec_open.map((row, t) => (t < cut ? row.map(() => NaN) : row)) } }; };

test('M-1 好面板：逐日中性化后的名字数够、份额够，IC 日 ≥ 0.95 × 打分日；记录里有 min_named / min_share 与门槛', () => {
  const c = runner.checkCanary(P, COV);
  assert.equal(c.scored_days, SCORED_DAYS);
  assert.equal(c.min_ic_days, Math.ceil(0.95 * SCORED_DAYS));
  assert.deepEqual([c.min_names_per_day, c.min_coverage_share, c.min_day_share], [5, 0.9, 0.95]);
  const k = c.formulas[0];
  assert.ok(Number.isFinite(k.score) && k.ic_days >= c.min_ic_days, JSON.stringify(k));
  assert.ok(k.min_named >= 5 && k.min_share >= 0.9 && /^\d{4}-\d{2}-\d{2}$/.test(k.min_named_date) && /^\d{4}-\d{2}-\d{2}$/.test(k.min_share_date), JSON.stringify(k));
});

test('M-1 行业只剩一部分名字：6 / 15（复审 P1）拒；少 2 个名字（13 / 15 < 0.9）也拒', () => {
  const codes = P.codes;
  assert.throws(() => runner.checkCanary(withIndustry((t, j) => j < 6), COV), code(/^MINE_RUNNER_CANARY_UNSCORABLE:\(-close_hfq\):\d{4}-\d{2}-\d{2}:neutralized=/));
  const drop = new Set(codes.slice(0, 2));
  assert.throws(() => runner.checkCanary(withIndustry((t, j) => !drop.has(codes[j])), COV), code(/MINE_RUNNER_CANARY_UNSCORABLE:.*neutralized=/));
});

test('M-1 行业只缺前一段日子（复审 P2，前 49%）拒：逐日核，不看总数', () => {
  const cut = Math.floor(0.49 * P.dates.length);
  assert.throws(() => runner.checkCanary(withIndustry((t) => t >= cut), COV), code(/MINE_RUNNER_CANARY_UNSCORABLE:\(-close_hfq\):2020-06-02:neutralized=0</));
});

test('M-2 份额 0.95 钉住：前 20% 的日子没有前推收益（IC 日约 80%）拒；前 2% 没有（约 98%）过', () => {
  assert.throws(() => runner.checkCanary(withoutLabels(0.2), COV), code(/MINE_RUNNER_CANARY_UNSCORABLE:\(-close_hfq\):ic_days=\d+</));
  const ok = runner.checkCanary(withoutLabels(0.02), COV);
  assert.ok(ok.formulas[0].ic_days >= ok.min_ic_days && ok.formulas[0].ic_days < SCORED_DAYS);
});

test('M-2 名字数下限钉住：同一个好面板，下限 20 只（合成数据只有十几只）拒', () => {
  assert.throws(() => runner.checkCanary(P, { min_names_per_day: 20 }), code(/MINE_RUNNER_CANARY_UNSCORABLE:.*neutralized=\d+<max\(20,/));
});

test('M-2 命令行 --resume 也先过金丝雀：坏数据上续跑退出 2，轮次的续跑记录不动', () => {
  const out = freshData();
  const sums = crypto.createHash('sha256').update(fs.readFileSync(path.join(good.dirs.holdout, 'SHA256SUMS'))).digest('hex');
  const env = { ...process.env, QRP_DATA_DIR: out };
  const first = spawnSync(process.execPath, [CLI, 'generate', '--out', out, '--lane', good.dirs.lane, '--tail', good.dirs.tail, '--seed', '3', '--cap', '2',
    '--holdout-ref', 'synthetic:holdout', '--holdout-sha256', sums, '--min-names-per-day', '5'], { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const roundId = JSON.parse(first.stdout).round_id;
  const before = fs.readFileSync(path.join(out, 'research', 'mining_rounds.jsonl'), 'utf8');
  const res = spawnSync(process.execPath, [CLI, 'generate', '--out', out, '--lane', broken.dirs.lane, '--tail', broken.dirs.tail, '--resume', roundId, '--min-names-per-day', '5'],
    { env, encoding: 'utf8' });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stderr).error, 'MINE_RUNNER_CANARY_UNSCORABLE');
  assert.equal(fs.readFileSync(path.join(out, 'research', 'mining_rounds.jsonl'), 'utf8'), before, 'no resume row, nothing appended');
});

test('M-3 直接调 generate()：坏面板上自己跑金丝雀，拒，一个尝试都不记；好面板上 generate.json 的 canary 是它自己算的', () => {
  freshData();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, cap: 4, openedAt: '2026-11-20T02:00:00Z' });
  const stub = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => ['rank(pb)', 'zscore(pb)', 'rank(turnover_f)', 'zscore(turnover_f)'].slice(view.mining_scores.length, view.mining_scores.length + n) };
  const out = process.env.QRP_DATA_DIR;
  assert.throws(() => runner.internals.withGenerator(stub, () => runner.generate({ roundId: r.round_id, sources: sourcesOf(broken), outDir: out, registeredBy: AUTH, coverageFloor: COV })),
    code(/MINE_RUNNER_CANARY_UNSCORABLE/));
  assert.equal(rounds.familyN('CN_A', 5), 0, 'nothing entered N');
  const fake = { formulas: [{ formula: 'fake', score: 1, ic_days: 999 }] };
  const g = runner.internals.withGenerator(stub, () => runner.generate({ roundId: r.round_id, sources: sourcesOf(good), outDir: out, registeredBy: AUTH, coverageFloor: COV, canary: fake }));
  assert.deepEqual(g.canary, runner.checkCanary(P, COV), 'its own canary, not the caller\'s');
});

test('L-1 入口 recordCandidate：没有标记的 null 分数、带标记的有限分数、认不出的标记，一律拒', () => {
  freshData();
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, openedAt: '2026-11-20T02:00:00Z' });
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const cand = (k, extra) => ({ candidate_id: `${r.round_id}:A00${k}`, formula_canonical: 'rank(pb)', formula_sha256: sha('rank(pb)'), holding_period: 5, ...extra });
  assert.throws(() => rounds.recordCandidate(r.round_id, cand(1, { mining_score: null }), { registeredBy: AUTH }), code(/MINE_ROUND_SCORE_NOT_FINITE/));
  assert.throws(() => rounds.recordCandidate(r.round_id, cand(1, { mining_score: undefined }), { registeredBy: AUTH }), code(/MINE_ROUND_SCORE_NOT_FINITE/));
  assert.throws(() => rounds.recordCandidate(r.round_id, cand(1, { mining_score: 0.1, rule_config: { formula: 'rank(pb)', attempt: 'UNSCORABLE' } }), { registeredBy: AUTH }), code(/MINE_ROUND_ATTEMPT_HAS_SCORE/));
  assert.throws(() => rounds.recordCandidate(r.round_id, cand(1, { mining_score: null, rule_config: { formula: 'rank(pb)', attempt: 'MAYBE' } }), { registeredBy: AUTH }), code(/MINE_ROUND_ATTEMPT_UNKNOWN/));
  assert.equal(rounds.familyN('CN_A', 5), 0);
  rounds.recordCandidate(r.round_id, cand(1, { mining_score: 0.1 }), { registeredBy: AUTH });
  rounds.recordCandidate(r.round_id, cand(2, { mining_score: null, rule_config: { formula: 'rank(pb)', attempt: 'UNSCORABLE', ic_days: 0 } }), { registeredBy: AUTH });
  assert.equal(rounds.familyN('CN_A', 5), 2);
});
