'use strict';
/**
 * RF1116 修订 2026-11「A 股 11 月加一轮 LLM 挖掘」（RF1116_AMENDMENT_2026_11_CN_A_EXTRA_ROUND，plan-coord）§1 在 QRP 里的落地。先红后绿，全是合成数据。
 *   1. 每月轮数上限：只有 (CN_A, 2026-11) 是 3；12 月起、别的市场仍是 2（LIMITS.rounds_per_month 不动）；
 *   2. R1.6「一段留出段最多 2 轮用」的计数：以 FAILED_EVALUATION 关闭、留出段从未开启、选择记录明确写了 0 个候选的轮不计；
 *      其余一律照旧计数（开启过留出段的、没有选择记录的、选出过候选的）；MINE_ROUND_HOLDOUT_SEGMENT_OPENED 一字不动。
 * 页的引用：常量里带页路径与 sha256，仓库 docs/freeze/ 有逐字节副本（同 R1.2 对 rulings 的做法）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH = 'TEST_CNA_EXTRA_ROUND_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { R1 } = require('./_mining_manifest');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');
const trials = require('../services/trial-ledger');
const ledger = require('../packages/ledger');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-cna3-data-')); process.env.QRP_DATA_DIR = d; return d; };
const GP = Object.freeze({ mode: 'AI_MINED_GP', gp_seed: 1 });
const H1 = Object.freeze({ from: '2026-10-19', to: '2026-12-31' });
const H2 = Object.freeze({ from: '2027-01-04', to: '2027-03-31' });
const H3 = Object.freeze({ from: '2027-04-01', to: '2027-06-30' });
const H4 = Object.freeze({ from: '2027-07-01', to: '2027-09-30' });
const EVIDENCE = '3e3c70fcdc792e716c8fe09fc774c92427a636a8f3719b064fc95d4be89aa4f9';
const REASON = 'synthetic: every mining score null';
const sp = (n) => ({ space_ref: `MS-CNA3-${n}`, sha256: sha(`cna3-space-${n}`), freeze: { path: `f-${n}`, sha256: sha(`cna3-freeze-${n}`) } });
let spaceNo = 0;
const open = (market, at, holdout = H1) => { spaceNo += 1; return rounds.openRound({ market, space: sp(spaceNo), holding_periods: [5], generator: GP, holdout, openedAt: at, ...R1 }); };
const failEval = (r) => rounds.failEvaluation(r.round_id, { reason: REASON, evidenceSha256: EVIDENCE });
const seal = (r, segment = H1) => vault.seal({ round_id: r.round_id, segment, data_ref: 'synthetic', data_sha256: sha('h'), sealedBy: 'TEST' });
const zeroSelection = (r) => rounds.recordSelection(r.round_id, { selection_sha256: sha(`sel-${r.round_id}`), selected: [], evaluated: 0 });
/** 手写一行轮次头（只给「API 造不出来」的状态用：比如 FAILED_EVALUATION 却带着开启记录）。 */
function forceHead(roundId, patch) {
  const head = rounds.roundHead(roundId);
  const { record_hash: _h, ...rest } = { ...head, ...patch };
  ledger.append(rounds.LEDGER(), { ...rest, record_hash: trials.recordHash(rest) });
}

test('E0 常量：每月上限的例外只有一条 (CN_A, 2026-11) = 3，带修订页路径与 sha256，仓库 docs/freeze/ 有逐字节副本；LIMITS 本身不动', () => {
  assert.equal(rounds.LIMITS.rounds_per_month, 2);
  assert.equal(rounds.LIMITS.rounds_per_holdout, 2);
  assert.equal(rounds.LIMITS.open_rounds_per_market, 2);
  assert.equal(rounds.MONTHLY_CAP_EXCEPTIONS.length, 1);
  const [x] = rounds.MONTHLY_CAP_EXCEPTIONS;
  assert.deepEqual([x.market, x.month, x.rounds_per_month], ['CN_A', '2026-11', 3]);
  assert.match(x.amendment.path, /RF1116_AMENDMENT_2026_11_CN_A_EXTRA_ROUND/);
  assert.match(x.amendment.sha256, /^[0-9a-f]{64}$/);
  const copy = fs.readFileSync(path.join(ROOT, 'docs/freeze', path.basename(x.amendment.path)));
  assert.equal(sha(copy), x.amendment.sha256, 'docs/freeze copy is byte-identical to the cited page');
  assert.ok(Object.isFrozen(rounds.MONTHLY_CAP_EXCEPTIONS) && Object.isFrozen(x) && Object.isFrozen(x.amendment));
  assert.equal(rounds.monthlyCapOf('CN_A', '2026-11'), 3);
  for (const [m, mo] of [['CN_A', '2026-10'], ['CN_A', '2026-12'], ['CN_A', '2027-11'], ['US', '2026-11'], ['CRYPTO', '2026-11']]) assert.equal(rounds.monthlyCapOf(m, mo), 2, `${m} ${mo}`);
});

test('E1 CN_A 2026-11：第 3 轮开得了，第 4 轮 MINE_ROUND_MONTHLY_CAP（已关的 FAILED_EVALUATION 照样计入当月）', () => {
  freshData();
  const a = open('CN_A', '2026-11-18T05:49:16+08:00', H1); const b = open('CN_A', '2026-11-18T09:23:54+08:00', H2);
  failEval(a); failEval(b); // 名额放出来，只剩当月上限在起作用
  const c = open('CN_A', '2026-11-23T08:30:00+08:00', H3);
  assert.deepEqual([c.status, c.month], ['OPEN', '2026-11']);
  assert.throws(() => open('CN_A', '2026-11-23T09:00:00+08:00', H4), code(/MINE_ROUND_MONTHLY_CAP:CN_A:2026-11/), 'a fourth round in November');
});

test('E2 12 月仍是 2 轮；11-30 24:00 CST 之前算 11 月、之后算 12 月（月份按北京时间）', () => {
  freshData();
  const a = open('CN_A', '2026-12-01T09:00:00+08:00', H1); const b = open('CN_A', '2026-12-01T10:00:00+08:00', H2);
  failEval(a); failEval(b);
  assert.throws(() => open('CN_A', '2026-12-02T09:00:00+08:00', H3), code(/MINE_ROUND_MONTHLY_CAP:CN_A:2026-12/), 'December keeps 2');
  freshData();
  const n1 = open('CN_A', '2026-11-30T23:59:59+08:00', H1); // 11 月
  assert.equal(n1.month, '2026-11');
  assert.equal(open('CN_A', '2026-12-01T00:00:01+08:00', H2).month, '2026-12'); // 12 月：不吃 11 月的第 3 个名额
  assert.equal(rounds.monthlyCapOf('CN_A', rounds.roundHead(n1.round_id).month), 3);
});

test('E3 别的市场 2026-11 仍是 2 轮', () => {
  for (const market of ['US', 'CRYPTO']) {
    freshData();
    const a = open(market, '2026-11-18T05:49:16+08:00', H1); const b = open(market, '2026-11-19T05:49:16+08:00', H2);
    failEval(a); failEval(b);
    assert.throws(() => open(market, '2026-11-23T08:30:00+08:00', H3), code(new RegExp(`MINE_ROUND_MONTHLY_CAP:${market}:2026-11`)), market);
  }
});

test('E4 留出段计数：以 FAILED_EVALUATION 关闭、留出段未开启、选择记录写 0 个的轮不计 → 第 3 轮可以和第 2 轮共用同一段；一段仍然只评价两轮', () => {
  freshData();
  const r1 = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(r1); zeroSelection(r1); // 第 1 轮的样子
  const r2 = open('CN_A', '2026-11-18T09:23:54+08:00'); seal(r2);
  assert.throws(() => open('CN_A', '2026-11-23T08:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:2026-10-19\.\.2026-12-31/), 'today: round 1 still counts');
  failEval(r1);
  const r3 = open('CN_A', '2026-11-23T08:30:00+08:00');
  assert.deepEqual([r3.status, r3.holdout], ['OPEN', { ...H1 }], 'round 3 shares 10-19..12-31 with round 2');
  assert.throws(() => open('CN_A', '2026-11-23T09:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), 'a fourth round on the segment: rounds 2 and 3 are the two evaluating rounds');
  assert.throws(() => open('CN_A', '2026-11-23T09:30:00+08:00', H2), code(/MINE_ROUND_ALREADY_OPEN:CN_A:2/), 'a new segment does not get a fourth round past the open-round cap either');
});

test('E5 这条同样适用于 12 月那一轮：第 1 轮不计时，12-01 能和第 2 轮共用这一段', () => {
  freshData();
  const r1 = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(r1); zeroSelection(r1); failEval(r1);
  const r2 = open('CN_A', '2026-11-18T09:23:54+08:00'); seal(r2);
  const dec = open('CN_A', '2026-12-01T09:00:00+08:00');
  assert.deepEqual([dec.status, dec.month, dec.holdout], ['OPEN', '2026-12', { ...H1 }]);
  assert.ok(r2);
});

test('E6 反例：没有选择记录的 FAILED_EVALUATION 照旧计数（缺失 ≠ 0）；选择记录写了候选的照旧计数', () => {
  freshData();
  const r1 = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(r1); failEval(r1); // 没有选择记录
  assert.equal(rounds.selectionOf(r1.round_id), null);
  open('CN_A', '2026-11-18T09:23:54+08:00');
  assert.throws(() => open('CN_A', '2026-11-23T08:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), 'no selection row: round 1 still counts');
  freshData();
  const a = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(a);
  rounds.recordCandidate(a.round_id, { candidate_id: `${a.round_id}:A001`, formula_canonical: 'rank(ts_mean(pb,5))', formula_sha256: sha('rank(ts_mean(pb,5))'), holding_period: 5, mining_score: 0.02 }, { registeredBy: AUTH });
  rounds.recordSelection(a.round_id, { selection_sha256: sha('sel-a'), selected: [`${a.round_id}:A001`], evaluated: 1 });
  forceHead(a.round_id, { status: 'FAILED_EVALUATION', gmine_passes: 0, closed_at: '2026-11-18T09:00:00+08:00' }); // API 造不出这一行（failEvaluation 拒有分数的轮），手写
  open('CN_A', '2026-11-18T09:23:54+08:00');
  assert.throws(() => open('CN_A', '2026-11-23T08:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), 'a round that selected candidates still counts');
});

test('E7 反例：开启过留出段的轮照旧计数（轮次行有 holdout_opens，或留出段保管里有开启记录，哪怕轮次行没记）', () => {
  freshData();
  const a = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(a); zeroSelection(a);
  forceHead(a.round_id, { status: 'FAILED_EVALUATION', gmine_passes: 0, holdout_opens: { segment: { ...H1 }, family_ids: ['MINE:CN_A:H5'], count: 1 }, closed_at: '2026-11-18T09:00:00+08:00' });
  open('CN_A', '2026-11-18T09:23:54+08:00');
  assert.throws(() => open('CN_A', '2026-11-23T08:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), 'holdout_opens on the row');
  freshData();
  const b = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(b);
  rounds.recordCandidate(b.round_id, { candidate_id: `${b.round_id}:A001`, formula_canonical: 'rank(ts_mean(pb,5))', formula_sha256: sha('rank(ts_mean(pb,5))'), holding_period: 5, mining_score: 0.02 }, { registeredBy: AUTH });
  zeroSelection(b);
  vault.open({ round_id: b.round_id, candidate_ids: [`${b.round_id}:A001`], openedBy: 'TEST' });
  assert.equal(vault.openLog(b.round_id).length, 1);
  forceHead(b.round_id, { status: 'FAILED_EVALUATION', gmine_passes: 0, holdout_opens: null, closed_at: '2026-11-18T09:00:00+08:00' });
  open('CN_A', '2026-11-18T09:23:54+08:00');
  assert.throws(() => open('CN_A', '2026-11-23T08:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), 'vault open log only');
});

test('E8 反例：只有 FAILED_EVALUATION 不计；正常 CLOSED（没开留出段、选择 0 个）、FAILED_PARTIAL、FAILED_RESCORE 照旧计数', () => {
  freshData();
  const a = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(a); zeroSelection(a); rounds.closeRound(a.round_id);
  assert.equal(rounds.roundHead(a.round_id).status, 'CLOSED');
  open('CN_A', '2026-11-18T09:23:54+08:00');
  assert.throws(() => open('CN_A', '2026-11-23T08:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), 'CLOSED');
  for (const status of ['FAILED_PARTIAL', 'FAILED_RESCORE']) {
    freshData();
    const f = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(f); zeroSelection(f);
    forceHead(f.round_id, { status, gmine_passes: 0, closed_at: '2026-11-18T09:00:00+08:00' });
    open('CN_A', '2026-11-18T09:23:54+08:00');
    assert.throws(() => open('CN_A', '2026-11-23T08:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), status);
  }
});

test('E9 MINE_ROUND_HOLDOUT_SEGMENT_OPENED 不变：这一段被任何一轮开启过，就不再开新轮（被排除的轮不改变它）', () => {
  freshData();
  const a = open('CN_A', '2026-11-17T09:00:00+08:00'); seal(a);
  rounds.recordCandidate(a.round_id, { candidate_id: `${a.round_id}:A001`, formula_canonical: 'rank(ts_mean(pb,5))', formula_sha256: sha('rank(ts_mean(pb,5))'), holding_period: 5, mining_score: 0.02 }, { registeredBy: AUTH });
  vault.open({ round_id: a.round_id, candidate_ids: [`${a.round_id}:A001`], openedBy: 'TEST' }); // 第一轮开启了这一段
  const b = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(b); zeroSelection(b); failEval(b); // 被排除的轮
  assert.throws(() => open('CN_A', '2026-11-23T08:30:00+08:00'), code(/MINE_ROUND_HOLDOUT_SEGMENT_OPENED:CN_A:2026-10-19\.\.2026-12-31/));
});

test('E10 重放真实台账的形状：第 1 轮 FAILED_EVALUATION（选 0、未开启），第 2 轮 CAP_REACHED → 11-23 开第 3 轮；第 3 轮开了之后 12-01 的轮被 HOLDOUT_EXHAUSTED（第 2、3 轮占满这一段）', () => {
  freshData();
  const r1 = open('CN_A', '2026-11-18T05:49:16+08:00'); seal(r1); zeroSelection(r1); failEval(r1);
  const r2 = open('CN_A', '2026-11-18T09:23:54+08:00'); seal(r2);
  const r3 = open('CN_A', '2026-11-23T08:30:00+08:00');
  assert.equal(r3.month, '2026-11');
  assert.throws(() => open('CN_A', '2026-12-01T09:00:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED/), 'rounds 2 and 3 fill the segment');
  assert.ok(r2);
});
