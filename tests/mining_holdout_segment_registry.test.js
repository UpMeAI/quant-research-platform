'use strict';
/**
 * RF1116 second CN_A holdout segment (R2) for the December rounds: the holdout segment is a parameterised REGISTRY (R1, R2), not a constant.
 * Spec: RF1116_HOLDOUT_CN_A_R2_FREEZE_1 section 4 (plan-coord; Owner signature 2026-11-23 11:56 CST, defaults a/a/a). Red first, synthetic data only.
 *
 *   1. The registry has one entry per segment: number, start rule, length in trading days, end (may be UNKNOWN / CALENDAR_NOT_PUBLISHED).
 *   2. A round that does not name a window selects its segment by the month it opens in (Beijing time): 2026-11 and earlier -> R1, 2026-12 onwards -> R2.
 *   3. The per-segment round limit (2) is counted per segment with the counting method of the extra-round amendment (section 1 item 2).
 *   4. Fail closed: no usable segment (full, or none selectable) -> no round opens; a round never borrows another segment.
 *   5. With R2's end UNKNOWN a round opens (generation and validation only); the holdout is never opened or scored.
 *   6. R1 is byte-identical: a registry-selected November round is the same ledger row as the explicit-window round, record_hash included.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH = 'TEST_HOLDOUT_SEGMENT_REGISTRY_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { R1 } = require('./_mining_manifest');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');
const trials = require('../services/trial-ledger');
const ledger = require('../packages/ledger');
const segs = require('../services/mining-sandbox/segments');
const runner = require('../services/mining-sandbox/round-runner');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
// Lazy: on the base commit the registry module does not exist, so each test fails on its own assertion.
const reg = () => require('../services/mining-rounds/holdout-segments');
const UNKNOWN = 'UNKNOWN / CALENDAR_NOT_PUBLISHED';
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-hseg-data-')); process.env.QRP_DATA_DIR = d; return d; };
const GP = Object.freeze({ mode: 'AI_MINED_GP', gp_seed: 1 });
const H1 = Object.freeze({ from: '2026-10-19', to: '2026-12-31' });
const R2_BLOCK = Object.freeze({ segment: 'R2', start_rule: 'FIRST_TRADING_DAY_AFTER', start_after: '2026-12-31', length_trading_days: 54, from: UNKNOWN, to: UNKNOWN });
const EVIDENCE = '3e3c70fcdc792e716c8fe09fc774c92427a636a8f3719b064fc95d4be89aa4f9';
const REASON = 'synthetic: every mining score null';
const sp = (n) => ({ space_ref: `MS-HSEG-${n}`, sha256: sha(`hseg-space-${n}`), freeze: { path: `f-${n}`, sha256: sha(`hseg-freeze-${n}`) } });
let spaceNo = 0;
/** Opens a round WITHOUT naming a window: the registry selects the segment from the month of openedAt. */
const openAuto = (at, market = 'CN_A', extra = {}) => { spaceNo += 1; return rounds.openRound({ market, space: sp(spaceNo), holding_periods: [5], generator: GP, openedAt: at, ...R1, ...extra }); };
/** The legacy path: an explicit window (what the production path did before the registry). */
const openWindow = (at, holdout, market = 'CN_A') => { spaceNo += 1; return rounds.openRound({ market, space: sp(spaceNo), holding_periods: [5], generator: GP, holdout, openedAt: at, ...R1 }); };
const failEval = (r) => rounds.failEvaluation(r.round_id, { reason: REASON, evidenceSha256: EVIDENCE });
const zeroSelection = (r) => rounds.recordSelection(r.round_id, { selection_sha256: sha(`sel-${r.round_id}`), selected: [], evaluated: 0 });
const seal = (r) => vault.seal({ round_id: r.round_id, segment: { ...r.holdout }, data_ref: 'synthetic', data_sha256: sha('h'), sealedBy: 'TEST' });
function forceHead(roundId, patch) {
  const head = rounds.roundHead(roundId);
  const { record_hash: _h, ...rest } = { ...head, ...patch };
  ledger.append(rounds.LEDGER(), { ...rest, record_hash: trials.recordHash(rest) });
}
const addCandidate = (r, n = 1) => {
  const id = `${r.round_id}:A00${n}`;
  rounds.recordCandidate(r.round_id, { candidate_id: id, formula_canonical: 'rank(ts_mean(pb,5))', formula_sha256: sha(`rank(ts_mean(pb,5))-${n}`), holding_period: 5, mining_score: 0.02 }, { registeredBy: AUTH });
  return id;
};

test('S0 registry: R1 and R2 entries, frozen; R1 values are the existing frozen constants; R2 carries the signed rule and an UNKNOWN end', () => {
  const g = reg();
  assert.deepEqual(g.REGISTRY.map((e) => e.id), ['R1', 'R2']);
  assert.deepEqual(g.REGISTRY.map((e) => e.number), [1, 2]);
  assert.ok(Object.isFrozen(g.REGISTRY) && g.REGISTRY.every((e) => Object.isFrozen(e)));
  assert.equal(g.UNKNOWN, UNKNOWN);
  const [r1, r2] = g.REGISTRY;
  assert.deepEqual(g.holdoutOf(r1), { ...segs.SEGMENTS.HOLDOUT }, 'R1 is segments.js HOLDOUT, unchanged');
  assert.deepEqual(g.holdoutOf(r1), H1);
  assert.equal(r1.length_trading_days, 54);
  assert.deepEqual(r1.freeze, segs.FREEZE_PAGE, 'R1 cites its frozen page');
  assert.deepEqual([r2.start.rule, r2.start.after, r2.length_trading_days], ['FIRST_TRADING_DAY_AFTER', '2026-12-31', 54]);
  assert.deepEqual(g.holdoutOf(r2), R2_BLOCK);
  assert.ok(g.holdoutOf(r2).start_after > g.holdoutOf(r1).to || g.holdoutOf(r2).start_after === g.holdoutOf(r1).to, 'R2 starts strictly after R1 ends (no overlap, no gap)');
  assert.notEqual(r2.sealed_dir, r1.sealed_dir);
  assert.equal(r1.sealed_dir, 'rf1116-cn-a-daily-holdout-from-20261019', 'the directory name run.sh has always used');
});

test('S1 month rule: 2026-11 and earlier -> R1; 2026-12 onwards -> R2; anything else -> no segment', () => {
  const g = reg();
  for (const m of ['2026-11', '2026-10', '2026-01', '2025-12']) assert.equal(g.entryForMonth(m, 'CN_A').id, 'R1', m);
  for (const m of ['2026-12', '2027-01', '2027-12']) assert.equal(g.entryForMonth(m, 'CN_A').id, 'R2', m);
  for (const m of ['', '2026-1', '2026-13', 'x', null, undefined, 202612]) assert.equal(g.entryForMonth(m, 'CN_A'), null, String(m));
  for (const mk of ['US', 'CRYPTO', 'cn_a', undefined]) assert.equal(g.entryForMonth('2026-12', mk), null, `no registry segment for market ${mk}`);
});

test('S2 end resolution (pure): R2 end is UNKNOWN until the SSE calendar covers 54 open days after the start; R1 is always resolved', () => {
  const g = reg();
  const [r1, r2] = g.REGISTRY;
  const days = (from, n) => { const out = []; let t = Date.parse(`${from}T00:00:00Z`); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; };
  const before = days('2026-11-02', 40); // ends before 2026-12-31
  const all = [...before, ...days('2027-01-04', 80)];
  assert.deepEqual(g.resolveWindow(r1, []), { status: 'RESOLVED', from: '2026-10-19', to: '2026-12-31' });
  assert.deepEqual(g.resolveWindow(r2, undefined), { status: UNKNOWN, from: UNKNOWN, to: UNKNOWN }, 'no calendar');
  assert.deepEqual(g.resolveWindow(r2, before), { status: UNKNOWN, from: UNKNOWN, to: UNKNOWN }, 'calendar ends before the start');
  const first = days('2027-01-04', 80);
  assert.deepEqual(g.resolveWindow(r2, [...before, ...first.slice(0, 53)]), { status: UNKNOWN, from: '2027-01-04', to: UNKNOWN }, '53 days: the 54th is not published, so the end is not guessed');
  assert.deepEqual(g.resolveWindow(r2, all), { status: 'RESOLVED', from: first[0], to: first[53] }, 'the 54th open day counting the start as day 1');
  assert.equal(g.resolveWindow(r2, all.filter((d) => d !== '2027-01-04')).from, '2027-01-05', 'an unlisted day is not an open day: the start is the first LISTED day after 12-31');
  assert.deepEqual(g.resolveWindow(r2, ['2026-12-31', ...first]).from, first[0], 'the day 12-31 itself is not the start');
});

test('S3 R1 byte-identical: a registry-selected November round is the same ledger row (record_hash included) as the explicit-window round', () => {
  const at = '2026-11-18T05:49:16+08:00';
  freshData(); spaceNo = 100; const explicit = openWindow(at, H1);
  freshData(); spaceNo = 100; const auto = openAuto(at);
  assert.deepEqual(auto, explicit);
  assert.equal(auto.record_hash, explicit.record_hash);
  assert.deepEqual(auto.holdout, H1);
  assert.deepEqual(Object.keys(auto.holdout), ['from', 'to'], 'no segment id, no extra key in an R1 manifest');
});

test('S4 November rounds select R1 (also at 23:59 CST on 11-30); December rounds select R2 (also at 00:00 CST on 12-01)', () => {
  freshData();
  const nov = openAuto('2026-11-30T15:59:00Z'); // 2026-11-30 23:59 CST
  assert.equal(nov.month, '2026-11');
  assert.deepEqual(nov.holdout, H1);
  const dec = openAuto('2026-11-30T16:00:00Z'); // 2026-12-01 00:00 CST
  assert.equal(dec.month, '2026-12');
  assert.deepEqual(dec.holdout, R2_BLOCK);
});

test('S5 December rounds 1 and 2 select R2 and share it; a 3rd December round is refused and never borrows R1', () => {
  freshData();
  const d1 = openAuto('2026-12-01T02:00:00Z');
  const d2 = openAuto('2026-12-02T02:00:00Z');
  assert.deepEqual([d1.holdout, d2.holdout], [R2_BLOCK, R2_BLOCK]);
  assert.deepEqual([d1.status, d2.status], ['OPEN', 'OPEN']);
  assert.throws(() => openAuto('2026-12-03T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/));
  assert.equal(rounds.roundsOf('CN_A').length, 2, 'nothing was written for the refused round');
  assert.ok(rounds.roundsOf('CN_A').every((r) => r.holdout.segment === 'R2'), 'no round on the R1 window');
});

/** The real lane ledger on 2026-11-23: round 1 FAILED_EVALUATION (selected 0, holdout never opened), rounds 2 and 3 CAP_REACHED (explicit windows, no segment id). */
function realLedgerShape() {
  const r1 = openWindow('2026-11-18T05:49:16+08:00', H1); seal(r1); zeroSelection(r1); failEval(r1);
  const r2 = openWindow('2026-11-18T09:23:54+08:00', H1); seal(r2);
  const r3 = openWindow('2026-11-23T08:30:00+08:00', H1); seal(r3);
  return [r1, r2, r3];
}

test('S6 replay of the real ledger shape: December selects R2 (the segment check passes); what refuses it today is the unclosed-round limit (R1.6: 2 per market), not the segment', () => {
  freshData();
  const [r1, r2, r3] = realLedgerShape();
  assert.throws(() => openAuto('2026-11-24T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R1/), 'R1 is full: rounds 2 and 3 count, round 1 does not');
  // FINDING (plan-coord told 2026-11-23): rounds 2 and 3 stay unclosed until the R1 holdout is scored (after 12-31), so with LIMITS.open_rounds_per_market = 2
  // a December round on a perfectly good R2 is refused here. The segment checks come first and pass: the refusal is ALREADY_OPEN, not a segment code.
  assert.throws(() => openAuto('2026-12-01T02:00:00Z'), code(/MINE_ROUND_ALREADY_OPEN:CN_A:2/));
  for (const r of [r1, r2, r3]) assert.deepEqual(rounds.roundHead(r.round_id).holdout, H1, 'R1 rows untouched');
});

test('S6b same ledger with rounds 2 and 3 terminal: December rounds 1 and 2 open on R2, the 3rd is refused EXHAUSTED:R2; R1 rows untouched', () => {
  freshData();
  const [r1, r2, r3] = realLedgerShape();
  for (const r of [r2, r3]) { zeroSelection(r); rounds.closeRound(r.round_id); }
  const d1 = openAuto('2026-12-01T02:00:00Z'); const d2 = openAuto('2026-12-01T10:00:00Z');
  assert.deepEqual([d1.holdout, d2.holdout], [R2_BLOCK, R2_BLOCK]);
  assert.throws(() => openAuto('2026-12-02T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/));
  for (const r of [r1, r2, r3]) assert.deepEqual(rounds.roundHead(r.round_id).holdout, H1, 'R1 rows untouched');
});

test('S7 fail closed: no segment for the market; unregistered window already in the ledger; a backdated November round after R2 rounds exist', () => {
  freshData();
  for (const mk of ['US', 'CRYPTO']) assert.throws(() => openAuto('2026-12-01T02:00:00Z', mk), code(/MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE/), mk);
  assert.equal(rounds.roundsOf('US').length + rounds.roundsOf('CRYPTO').length, 0);
  freshData();
  openWindow('2026-06-02T02:00:00Z', { from: '2026-03-01', to: '2026-05-29' }); // a window the registry does not know
  assert.throws(() => openAuto('2026-12-01T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE/), 'ambiguous ledger: fail closed, count nothing');
  freshData();
  openAuto('2026-12-01T02:00:00Z');
  assert.throws(() => openAuto('2026-11-20T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_MOVED/), 'R1 after R2 would move the segment backwards');
  assert.throws(() => openWindow('2026-12-02T02:00:00Z', H1), code(/MINE_ROUND_HOLDOUT_SEGMENT_UNSELECTABLE/), 'once registry rounds exist an explicit window is refused');
});

test('S8 never borrow: R1 full -> a November round is refused (R2 is free but is not its segment); R2 full -> a January round is refused (no R3 is invented)', () => {
  freshData();
  openAuto('2026-11-01T02:00:00Z'); openAuto('2026-11-02T02:00:00Z');
  assert.throws(() => openAuto('2026-11-03T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R1/));
  assert.deepEqual(rounds.roundsOf('CN_A').map((r) => r.holdout), [H1, H1], 'no round on R2');
  freshData();
  openAuto('2026-12-01T02:00:00Z'); openAuto('2026-12-02T02:00:00Z');
  assert.throws(() => openAuto('2027-01-05T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/));
  assert.deepEqual(rounds.roundsOf('CN_A').map((r) => r.holdout.segment), ['R2', 'R2']);
});

test('S9 counting method on R2 (extra-round amendment section 1.2): an unevaluated FAILED_EVALUATION round does not count; every counter-case still counts', () => {
  freshData();
  const a = openAuto('2026-12-01T02:00:00Z'); seal(a); zeroSelection(a); failEval(a);
  const b = openAuto('2026-12-02T02:00:00Z');
  const c = openAuto('2027-01-05T02:00:00Z'); // counted: b only before this; a is left out
  assert.deepEqual([b.holdout.segment, c.holdout.segment], ['R2', 'R2']);
  assert.throws(() => openAuto('2027-01-06T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/), 'b and c are the two evaluating rounds');
  // counter-cases: with a counted, the same third round is refused
  freshData();
  const x = openAuto('2026-12-01T02:00:00Z'); seal(x); failEval(x); // no selection row: unknown, not 0
  openAuto('2026-12-02T02:00:00Z');
  assert.throws(() => openAuto('2027-01-05T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/), 'no selection row still counts');
  freshData();
  const y = openAuto('2026-12-01T02:00:00Z'); seal(y); const id = addCandidate(y);
  rounds.recordSelection(y.round_id, { selection_sha256: sha('sel-y'), selected: [id], evaluated: 1 });
  forceHead(y.round_id, { status: 'FAILED_EVALUATION', gmine_passes: 0, closed_at: '2026-12-01T09:00:00+08:00' });
  openAuto('2026-12-02T02:00:00Z');
  assert.throws(() => openAuto('2027-01-05T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/), 'a round that selected candidates still counts');
  for (const status of ['CLOSED', 'FAILED_PARTIAL', 'FAILED_RESCORE']) {
    freshData();
    const z = openAuto('2026-12-01T02:00:00Z'); seal(z); zeroSelection(z);
    if (status === 'CLOSED') rounds.closeRound(z.round_id); else forceHead(z.round_id, { status, gmine_passes: 0, closed_at: '2026-12-01T09:00:00+08:00' });
    openAuto('2026-12-02T02:00:00Z');
    assert.throws(() => openAuto('2027-01-05T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/), status);
  }
});

test('S10 MINE_ROUND_HOLDOUT_SEGMENT_OPENED holds per segment: an opened R2 stops new R2 rounds; an opened R1 does not touch R2', () => {
  freshData();
  const a = openAuto('2026-12-01T02:00:00Z');
  forceHead(a.round_id, { holdout_opens: { segment: { ...R2_BLOCK }, family_ids: ['MINE:CN_A:H5'], count: 1 } });
  assert.throws(() => openAuto('2026-12-02T02:00:00Z'), code(/MINE_ROUND_HOLDOUT_SEGMENT_OPENED:CN_A:R2/));
  freshData();
  const r1 = openAuto('2026-11-18T02:00:00Z'); seal(r1);
  forceHead(r1.round_id, { holdout_opens: { segment: { ...H1 }, family_ids: ['MINE:CN_A:H5'], count: 1 } });
  const d = openAuto('2026-12-01T02:00:00Z');
  assert.deepEqual(d.holdout, R2_BLOCK, 'R1 being opened says nothing about R2');
});

test('S11 R2 end UNKNOWN: the round opens, seals and selects (generation and validation) but the holdout cannot be opened or scored', () => {
  freshData();
  const d = openAuto('2026-12-01T02:00:00Z');
  const s = seal(d);
  assert.equal(s.segment.segment, 'R2', 'the seal row records which segment was sealed');
  assert.equal(s.segment.to, UNKNOWN);
  const id = addCandidate(d);
  rounds.recordSelection(d.round_id, { selection_sha256: sha('sel-d'), selected: [id], evaluated: 1 });
  assert.throws(() => vault.open({ round_id: d.round_id, candidate_ids: [id], openedBy: 'TEST' }), code(/MINE_HOLDOUT_SEGMENT_END_UNKNOWN/));
  assert.equal(vault.openLog(d.round_id).length, 0, 'nothing was opened');
  assert.ok(['OPEN', 'CAP_REACHED'].includes(rounds.roundHead(d.round_id).status), 'the round did not move to SCORING');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-hseg-out-'));
  assert.throws(() => runner.scoreHoldout({ roundId: d.round_id, sources: [], holdoutDir: path.join(out, 'no-such-holdout'), outDir: out }), code(/MINE_RUNNER_HOLDOUT_SEGMENT_END_UNKNOWN/));
  assert.throws(() => runner.rescore({ roundId: d.round_id, sources: [], holdoutDir: path.join(out, 'no-such-holdout'), outDir: out, reason: 'x' }), code(/MINE_RUNNER_HOLDOUT_SEGMENT_END_UNKNOWN/));
});

test('S12 seal: a round of one segment cannot be sealed with the other segment\'s window or a missing segment id', () => {
  freshData();
  const r1 = openAuto('2026-11-18T02:00:00Z');
  const d = openAuto('2026-12-01T02:00:00Z');
  assert.throws(() => vault.seal({ round_id: d.round_id, segment: { ...H1 }, data_ref: 'x', data_sha256: sha('h'), sealedBy: 'TEST' }), code(/MINE_HOLDOUT_SEGMENT_MISMATCH/));
  assert.throws(() => vault.seal({ round_id: d.round_id, segment: { from: UNKNOWN, to: UNKNOWN }, data_ref: 'x', data_sha256: sha('h'), sealedBy: 'TEST' }), code(/MINE_HOLDOUT_SEGMENT_MISMATCH/), 'same tokens but no segment id');
  assert.throws(() => vault.seal({ round_id: r1.round_id, segment: { ...R2_BLOCK }, data_ref: 'x', data_sha256: sha('h'), sealedBy: 'TEST' }), code(/MINE_HOLDOUT_SEGMENT_MISMATCH/));
  assert.deepEqual(seal(r1).segment, H1, 'an R1 seal row is exactly {from, to}, as before');
});

test('S13 runner: requestRound selects by month (GP and LLM); the LLM cutoff rule uses the R2 start rule', () => {
  freshData();
  const nov = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, openedAt: '2026-11-20T02:00:00Z' });
  assert.deepEqual(nov.holdout, H1);
  freshData();
  const dec = runner.requestRound({ generator: { mode: 'AI_MINED_LLM' }, openedAt: '2026-12-01T02:00:00Z' });
  assert.deepEqual(dec.holdout, R2_BLOCK);
  assert.ok(dec.holdout.start_after > dec.generator.model_knowledge_cutoff, 'R2 starts after the model cutoff');
  const dec2 = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 2 }, openedAt: '2026-12-02T02:00:00Z' });
  assert.deepEqual(dec2.holdout, R2_BLOCK);
  assert.throws(() => runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 3 }, openedAt: '2026-12-03T02:00:00Z' }), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/));
});

test('S14 holdout ref: the other segment\'s sealed directory is refused before any round is opened; legacy synthetic refs are untouched', () => {
  const g = reg();
  const R1REF = `lane:rf1116-mining/holdout-sealed/${g.REGISTRY[0].sealed_dir}`;
  const R2REF = `lane:rf1116-mining/holdout-sealed/${g.REGISTRY[1].sealed_dir}`;
  freshData();
  assert.doesNotThrow(() => runner.assertHoldoutRef({ openedAt: '2026-11-20T02:00:00Z', dataRef: R1REF }));
  assert.doesNotThrow(() => runner.assertHoldoutRef({ openedAt: '2026-12-01T02:00:00Z', dataRef: R2REF }));
  assert.doesNotThrow(() => runner.assertHoldoutRef({ openedAt: '2026-12-01T02:00:00Z', dataRef: 'synthetic:holdout' }), 'tests and fixtures name no segment directory');
  assert.throws(() => runner.assertHoldoutRef({ openedAt: '2026-12-01T02:00:00Z', dataRef: R1REF }), code(/MINE_RUNNER_HOLDOUT_REF_MISMATCH/), 'a December round must not seal the R1 directory');
  assert.throws(() => runner.assertHoldoutRef({ openedAt: '2026-11-20T02:00:00Z', dataRef: R2REF }), code(/MINE_RUNNER_HOLDOUT_REF_MISMATCH/), 'a November round must not seal the R2 directory');
});

test('S15 run.sh: the segment directory is chosen by RF1116_HOLDOUT_SEGMENT (default R1, the old strings unchanged); an unknown segment exits 64', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'deploy/research-lane/round-runner/run.sh'), 'utf8');
  const g = reg();
  assert.match(sh, /RF1116_HOLDOUT_SEGMENT:-R1/);
  assert.ok(sh.includes(`holdout-sealed/${g.REGISTRY[0].sealed_dir}"`), 'R1 directory string unchanged');
  assert.ok(sh.includes(`holdout-sealed/${g.REGISTRY[1].sealed_dir}`), 'R2 directory');
  assert.ok(sh.includes('HOLDOUT_REF="lane:rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019"'), 'R1 ref string unchanged');
  assert.match(sh, /\*\)[^\n]*RF1116_HOLDOUT_SEGMENT[^\n]*exit 64/);
});

test('S16 the R2 freeze page is cited with its sha256 and a byte-identical repo copy', () => {
  const g = reg();
  const f = g.REGISTRY[1].freeze;
  assert.match(f.sha256, /^[0-9a-f]{64}$/);
  assert.match(f.path, /RF1116_HOLDOUT_CN_A_R2_FREEZE_1/);
  assert.equal(path.basename(f.repo_copy), path.basename(f.path));
  assert.equal(sha(fs.readFileSync(path.join(ROOT, f.repo_copy))), f.sha256, 'the repo copy is the cited page');
});
