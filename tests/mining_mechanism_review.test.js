'use strict';
/**
 * 协调会话裁定 R1.5（修订 5 f904e0fe…）「打分之前由协调会话复审这批机制」落到代码里：MECHANISM_REVIEW_V1（只追加；同一轮再复审是新的一行，最新的那一行算数）。
 *   - 复审行写：轮次编号、选择记录 hash、机制集合的 sha（本轮选择记录里每个候选、按编号排序、各自的机制登记行 hash，没登记的为 null）、
 *     每个候选的裁决 APPROVED / REJECTED、复审人（自由文本，不核身份）、reviewed_at；
 *   - 执行器打分（score / rescore）之前核：最新一行存在、选择记录里每个候选都有裁决、集合 sha 等于现在的登记、行没被改过、早于留出段开启；
 *     不满足 → MINE_RUNNER_MECHANISM_REVIEW_MISSING / _INCOMPLETE / _STALE / _HASH_MISMATCH / _AFTER_OPEN，留出段不开；
 *   - REJECTED 的候选照样打分、照样记 G-MINE，第 9 项不过（MINE_MECHANISM_REJECTED）；APPROVED 的第 9 项可以过。
 * 全部是合成数据。
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH = 'TEST_MECH_REVIEW_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const { reviewAll } = require('./_mining_manifest');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
require('./_frozen_v2_thresholds').installOn(runner); // V2 的轮的门槛文件冻结前是 PENDING：在合成的 FROZEN v2 下逐项看码
const rounds = require('../services/mining-rounds');
const mechanisms = require('../services/mining-rounds/mechanisms');
const vault = require('../services/holdout-vault');
const gateRecords = require('../services/mining-rounds/gate-records');
const trials = require('../services/trial-ledger');
const ledger = require('../packages/ledger');

const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-mrev-fx-')));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-mrev-data-')); process.env.QRP_DATA_DIR = d; return d; };
const HOLDOUT_SUMS_SHA = sha(fs.readFileSync(path.join(fx.dirs.holdout, 'SHA256SUMS')));
const COV = Object.freeze({ min_names_per_day: 5 });
const KNOWN = ['rank((-ret_1d))', 'zscore((-ret_1d))', 'rank((-ts_mean(ret_1d,5)))', 'rank(pb)', 'rank(ts_delta(close_hfq,1))', 'zscore(turnover_f)'];
const knownGen = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => KNOWN.slice(view.mining_scores.length, view.mining_scores.length + n) };
const M = { mechanism_id: 'SEL.MEANREV.SWING_BAND', economic_logic_zh: '前一日的过度反应在随后几日部分回吐（合成测试文本）', failure_mode_zh: '趋势行情里反转失效（合成测试文本）' };

function toSelection(out, openedAt) {
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, cap: KNOWN.length, openedAt });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: HOLDOUT_SUMS_SHA });
  runner.internals.withGenerator(knownGen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: COV }));
  const sel = runner.select({ roundId: r.round_id, sources: sources(), outDir: out });
  const args = { roundId: r.round_id, sources: sources(), holdoutDir: fx.dirs.holdout, outDir: out, scoredAt: '2027-01-06T10:00:00+08:00', holdoutFloor: COV };
  return { r, sel, args, id: r.round_id };
}
const register = (id, candidateId, writtenAt = '2026-11-17T09:00:00+08:00') => mechanisms.registerMechanism(id, { candidate_id: candidateId, ...M, written_at: writtenAt }, { writtenBy: AUTH });
const setSha = (id) => mechanisms.mechanismSetSha(id).sha256;
const review = (id, verdicts, extra = {}) => mechanisms.recordReview(id, { mechanism_set_sha256: setSha(id), reviewer: 'coordinator', verdicts, ...extra });
/** 改过的复审行直接追加进台账（模拟手改或时钟不对），hash 按改后的内容重算。 */
const appendForged = (row) => { const { record_hash: _h, ...body } = row; return ledger.append(mechanisms.REVIEWS(), { ...body, record_hash: trials.recordHash(body) }); };

test('R1.5 复审：没有复审、只复审了一部分、复审之后登记又变了 → 打分拒绝、留出段不开；APPROVED 的第 9 项可以过，REJECTED 的照样打分、记录，第 9 项不过；再复审是新的一行、最新的算数', () => {
  freshData();
  const { sel, args, id } = toSelection(process.env.QRP_DATA_DIR, '2026-11-26T02:00:00Z');
  const [first, second, ...rest] = sel.selected;
  assert.ok(first && second, `need two survivors (${sel.selected.length})`);
  register(id, first);
  // 没有复审
  assert.throws(() => runner.scoreHoldout(args), code(/MINE_RUNNER_MECHANISM_REVIEW_MISSING/));
  // 只复审了一部分
  const partial = review(id, [{ candidate_id: first, verdict: 'APPROVED' }]);
  assert.equal(partial.schema, 'MECHANISM_REVIEW_V1');
  assert.equal(partial.supersedes, null);
  assert.throws(() => runner.scoreHoldout(args), code(/MINE_RUNNER_MECHANISM_REVIEW_INCOMPLETE/));
  // 全部复审，之后又登记了一条 → 集合 sha 变了
  const full = reviewAll(id);
  assert.equal(full.supersedes, partial.record_hash, 'a second review is a new row that names the one it replaces');
  register(id, second);
  assert.notEqual(setSha(id), full.mechanism_set_sha256);
  assert.throws(() => runner.scoreHoldout(args), code(/MINE_RUNNER_MECHANISM_REVIEW_STALE/));
  assert.equal(vault.openLog(id).length, 0, 'no refused check spends the open');
  // 写复审行时的核对
  assert.throws(() => mechanisms.recordReview(id, { mechanism_set_sha256: full.mechanism_set_sha256, reviewer: 'coordinator', verdicts: [{ candidate_id: first, verdict: 'APPROVED' }] }),
    code(/MINE_MECHANISM_REVIEW_SET_CHANGED/), 'the reviewer must have seen the current set');
  assert.throws(() => review(id, [{ candidate_id: first, verdict: 'MAYBE' }]), code(/MINE_MECHANISM_REVIEW_INVALID/));
  assert.throws(() => review(id, [{ candidate_id: first, verdict: 'APPROVED' }, { candidate_id: first, verdict: 'REJECTED' }]), code(/MINE_MECHANISM_REVIEW_INVALID/));
  assert.throws(() => review(id, [{ candidate_id: `${id}:NOT_SELECTED`, verdict: 'REJECTED' }]), code(/MINE_MECHANISM_REVIEW_INVALID/));
  assert.throws(() => review(id, []), code(/MINE_MECHANISM_REVIEW_INVALID/));
  assert.throws(() => review(id, [{ candidate_id: first, verdict: 'APPROVED' }], { reviewer: ' ' }), code(/MINE_MECHANISM_REVIEW_REVIEWER_REQUIRED/));
  assert.throws(() => mechanisms.recordReview(id, { mechanism_set_sha256: setSha(id), reviewer: 'coordinator', verdicts: [{ candidate_id: first, verdict: 'APPROVED' }] },
    { reviewedAt: new Date(Date.now() + 3600e3).toISOString() }), code(/MINE_MECHANISM_REVIEW_AT/), 'reviewed_at is never in the future');
  if (rest.length) assert.throws(() => review(id, [{ candidate_id: rest[0], verdict: 'APPROVED' }]), code(/MINE_MECHANISM_REVIEW_APPROVED_UNREGISTERED/));
  // 最新的复审：first APPROVED，second REJECTED，其余（没登记）REJECTED
  const final = reviewAll(id, { [second]: 'REJECTED' });
  assert.equal(final.supersedes, full.record_hash);
  assert.deepEqual(mechanisms.reviewsOf(id).map((x) => x.record_hash), [partial.record_hash, full.record_hash, final.record_hash]);
  assert.equal(mechanisms.latestReview(id).record_hash, final.record_hash, 'the latest row wins');
  assert.deepEqual(final.verdicts.map((v) => v.candidate_id), [...sel.selected].sort(), 'verdicts in canonical order');
  assert.deepEqual(final.items.map((x) => [x.candidate_id, x.registration_hash]), [...sel.selected].sort().map((cid) => [cid, mechanisms.mechanismOf(id, cid) ? mechanisms.mechanismOf(id, cid).record_hash : null]));
  // 打分
  const s = runner.scoreHoldout(args);
  assert.equal(s.opened, true);
  assert.equal(s.records.length, sel.selected.length, 'REJECTED candidates are still scored and recorded');
  const recs = new Map(gateRecords.recordsOf(id).map((x) => [x.candidate_id, x]));
  const item9 = (cid) => recs.get(cid).items.find((i) => i.item === 9);
  assert.equal(item9(first).pass, true, `APPROVED: item 9 can pass (${recs.get(first).codes.join(',')})`);
  assert.equal(item9(second).pass, false);
  assert.ok(recs.get(second).codes.includes('MINE_MECHANISM_REJECTED'), recs.get(second).codes.join(','));
  assert.ok(!recs.get(first).codes.includes('MINE_MECHANISM_REJECTED') && !recs.get(first).codes.includes('MINE_MECHANISM_REVIEW_MISSING'));
  const score = JSON.parse(fs.readFileSync(path.join(process.env.QRP_DATA_DIR, 'rounds', id.replace(/[^A-Za-z0-9_-]/g, '_'), 'score.json'), 'utf8'));
  const res = new Map(score.results.map((x) => [x.candidate_id, x]));
  assert.deepEqual(res.get(first).mechanism.review, { verdict: 'APPROVED', review_hash: final.record_hash, reviewed_at: final.reviewed_at });
  assert.equal(res.get(second).mechanism.review.verdict, 'REJECTED');
  assert.equal(score.mechanism_review.record_hash, final.record_hash);
  // 开启之后不能再复审
  assert.throws(() => reviewAll(id), code(/MINE_MECHANISM_REVIEW_AFTER_HOLDOUT_OPEN/));
  process.env.QRP_DATA_DIR = dataRoot;
});

test('R1.5 复审：复审行晚于留出段开启（时刻在将来）、或被改过 → 打分与重打分都拒绝', () => {
  freshData();
  const { sel, args, id } = toSelection(process.env.QRP_DATA_DIR, '2026-11-27T02:00:00Z');
  register(id, sel.selected[0]);
  const ok = reviewAll(id);
  // 时刻在将来的复审行（留出段要在它之后才开）→ 拒绝，不开
  const later = new Date(Date.now() + 3600e3).toISOString();
  const forged = appendForged({ ...ok, reviewed_at: later, recorded_at: later, supersedes: ok.record_hash });
  assert.equal(mechanisms.latestReview(id).record_hash, forged.record_hash);
  assert.throws(() => runner.scoreHoldout(args), code(/MINE_RUNNER_MECHANISM_REVIEW_AFTER_OPEN/));
  assert.equal(vault.openLog(id).length, 0);
  // 被改过的行（裁决改了，hash 没跟着改）→ 拒绝
  const { record_hash: h, ...body } = ok;
  ledger.append(mechanisms.REVIEWS(), { ...body, verdicts: body.verdicts.map((v) => ({ ...v, verdict: 'APPROVED' })), supersedes: forged.record_hash, record_hash: h });
  assert.throws(() => runner.scoreHoldout(args), code(/MINE_RUNNER_MECHANISM_REVIEW_HASH_MISMATCH/));
  // 正常再复审一行 → 打分；开启之后崩溃，再追加一行晚于开启的复审 → 重打分拒绝
  const good = reviewAll(id);
  assert.throws(() => runner.internals.withFault('AFTER_OPEN', () => runner.scoreHoldout(args)), code(/MINE_RUNNER_TEST_FAULT/));
  const [open] = vault.openLog(id);
  assert.ok(Date.parse(good.recorded_at) < Date.parse(open.opened_at));
  // 开启之后补一行「倒填日期」的复审（裁决改了、时刻早于开启、hash 重算）→ 复审行进了 inputs_sha256，与开启时对不上，重打分拒绝
  const backdated = appendForged({ ...good, verdicts: good.verdicts.map((v) => ({ ...v, verdict: 'REJECTED' })), supersedes: good.record_hash });
  assert.throws(() => runner.rescore({ ...args, reason: 'crash (synthetic)', log: 'x' }), code(/MINE_HOLDOUT_RESCORE_INPUTS_CHANGED/));
  assert.equal(vault.rescoreLog(id).length, 0);
  const afterOpen = new Date(Date.parse(open.opened_at) + 1).toISOString(); // 1 ms after the open: already in the past by now
  appendForged({ ...good, reviewed_at: afterOpen, recorded_at: afterOpen, supersedes: backdated.record_hash });
  assert.throws(() => runner.rescore({ ...args, reason: 'crash (synthetic)', log: 'x' }), code(/MINE_RUNNER_MECHANISM_REVIEW_AFTER_OPEN/));
  assert.equal(vault.rescoreLog(id).length, 0, 'a refused rescore writes no event');
  process.env.QRP_DATA_DIR = dataRoot;
});

test('R1.5 复审：先 APPROVED、后一次复审改成 REJECTED → 打分用最新那一行，第 9 项不过（MINE_MECHANISM_REJECTED）；选择记录还没有时不能复审（MINE_MECHANISM_REVIEW_NO_SELECTION）', () => {
  freshData();
  // 选择记录还没有：只开轮、封存
  const r0 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, cap: KNOWN.length, openedAt: '2026-11-28T02:00:00Z' });
  assert.throws(() => mechanisms.recordReview(r0.round_id, { mechanism_set_sha256: '0'.repeat(64), reviewer: 'coordinator', verdicts: [{ candidate_id: `${r0.round_id}:A001`, verdict: 'REJECTED' }] }),
    code(/MINE_MECHANISM_REVIEW_NO_SELECTION/));
  assert.throws(() => mechanisms.mechanismSetSha(r0.round_id), code(/MINE_MECHANISM_REVIEW_NO_SELECTION/));
  assert.deepEqual(mechanisms.reviewsOf(r0.round_id), []);
  rounds.closeRound(r0.round_id);
  // 先 APPROVED 再 REJECTED
  freshData();
  const { sel, args, id } = toSelection(process.env.QRP_DATA_DIR, '2026-11-29T02:00:00Z');
  const [first] = sel.selected;
  register(id, first);
  const approved = reviewAll(id);
  assert.equal(approved.verdicts.find((v) => v.candidate_id === first).verdict, 'APPROVED');
  const rejected = reviewAll(id, { [first]: 'REJECTED' });
  assert.equal(rejected.supersedes, approved.record_hash);
  runner.scoreHoldout(args);
  const rec = gateRecords.recordsOf(id).find((x) => x.candidate_id === first);
  assert.equal(rec.items.find((i) => i.item === 9).pass, false);
  assert.ok(rec.codes.includes('MINE_MECHANISM_REJECTED'), rec.codes.join(','));
  const score = JSON.parse(fs.readFileSync(path.join(process.env.QRP_DATA_DIR, 'rounds', id.replace(/[^A-Za-z0-9_-]/g, '_'), 'score.json'), 'utf8'));
  assert.deepEqual(score.results.find((x) => x.candidate_id === first).mechanism.review, { verdict: 'REJECTED', review_hash: rejected.record_hash, reviewed_at: rejected.reviewed_at });
  process.env.QRP_DATA_DIR = dataRoot;
});

test('R1.5 复审：合同、命令行与 run.sh 都有这一步（mechanisms → review → score）', () => {
  const ROOT = path.join(__dirname, '..');
  const cli = require('../services/mining-sandbox/round-runner/cli');
  assert.deepEqual(cli.OPTIONS.review, ['out', 'round', 'file']);
  const run = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  assert.match(run, /\n {2}review\)\n/);
  assert.match(run, /review --out \/out --round "\$round" --file \/data\/verdicts\.json/);
  const deploy = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/DEPLOY.md'), 'utf8');
  const at = (s) => deploy.indexOf(s);
  assert.ok(at('run.sh mechanisms <round_id> mech.jsonl') > 0 && at('run.sh review <round_id> verdicts.json') > at('run.sh mechanisms <round_id> mech.jsonl'), 'review comes after mechanisms');
  assert.ok(at('run.sh score <round_id>') > at('run.sh review <round_id> verdicts.json'), 'score comes after review');
  for (const f of ['docs/contracts/MINING_ROUNDS_V1.md', 'docs/contracts/MINING_SANDBOX_V1.md']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const k of ['MECHANISM_REVIEW_V1', 'MINE_RUNNER_MECHANISM_REVIEW_MISSING', 'MINE_MECHANISM_REJECTED']) assert.ok(t.includes(k), `${f}: ${k}`);
  }
});
