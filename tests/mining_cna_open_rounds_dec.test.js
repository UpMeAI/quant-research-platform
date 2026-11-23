'use strict';
/**
 * RF1116 amendment 2026-12 (plan-coord ruling (a), RF1116_AMENDMENT_2026_12_CN_A_OPEN_ROUNDS_FREEZE_1, FROZEN 2026-11-23 12:12 CST): a narrow exception to the unclosed-round limit.
 * For 2026-12 only, CN_A may hold 4 unclosed rounds, and the two extra places go ONLY to rounds assigned to R2 (the second holdout segment). Everything else stays at 2:
 * November rounds, rounds assigned to R1, 2027-01, other markets. Red first; synthetic data; the red tests (a) to (e) are section 1 item 5 of the page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_CNA_OPEN_ROUNDS_DEC_AUTHORITY';
const { R1 } = require('./_mining_manifest');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');
const trials = require('../services/trial-ledger');
const ledger = require('../packages/ledger');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-opendec-data-')); process.env.QRP_DATA_DIR = d; return d; };
const GP = Object.freeze({ mode: 'AI_MINED_GP', gp_seed: 1 });
const H0 = Object.freeze({ from: '2026-06-01', to: '2026-09-30' });
const H1 = Object.freeze({ from: '2026-10-19', to: '2026-12-31' });
const EVIDENCE = '3e3c70fcdc792e716c8fe09fc774c92427a636a8f3719b064fc95d4be89aa4f9';
const sp = (n) => ({ space_ref: `MS-OPD-${n}`, sha256: sha(`opd-space-${n}`), freeze: { path: `f-${n}`, sha256: sha(`opd-freeze-${n}`) } });
let spaceNo = 0;
const openAuto = (at, market = 'CN_A') => { spaceNo += 1; return rounds.openRound({ market, space: sp(spaceNo), holding_periods: [5], generator: GP, openedAt: at, ...R1 }); };
const openWindow = (at, holdout, market = 'CN_A') => { spaceNo += 1; return rounds.openRound({ market, space: sp(spaceNo), holding_periods: [5], generator: GP, holdout, openedAt: at, ...R1 }); };
const seal = (r) => vault.seal({ round_id: r.round_id, segment: { ...r.holdout }, data_ref: 'synthetic', data_sha256: sha('h'), sealedBy: 'TEST' });
const zeroSelection = (r) => rounds.recordSelection(r.round_id, { selection_sha256: sha(`sel-${r.round_id}`), selected: [], evaluated: 0 });
const failEval = (r) => rounds.failEvaluation(r.round_id, { reason: 'synthetic: every mining score null', evidenceSha256: EVIDENCE });
/** A hand-built unclosed row (a copy of an existing head under a new id), for ledger shapes the API cannot reach without tripping an earlier check. */
function forge(from, roundId) {
  const { record_hash: _h, ...rest } = { ...rounds.roundHead(from.round_id), round_id: roundId };
  ledger.append(rounds.LEDGER(), { ...rest, record_hash: trials.recordHash(rest) });
}
/** The real lane ledger on 2026-11-23: round 1 FAILED_EVALUATION (selected 0), rounds 2 and 3 CAP_REACHED (unclosed until the R1 holdout is scored). */
function realLedgerShape() {
  const r1 = openWindow('2026-11-18T05:49:16+08:00', H1); seal(r1); zeroSelection(r1); failEval(r1);
  const r2 = openWindow('2026-11-18T09:23:54+08:00', H1); seal(r2);
  const r3 = openWindow('2026-11-23T08:30:00+08:00', H1); seal(r3);
  return [r1, r2, r3];
}

test('O0 constant: one exception (CN_A, 2026-12, 4 unclosed, R2 only) citing the frozen page with a byte-identical repo copy; LIMITS stays 2; the lookup', () => {
  assert.equal(rounds.LIMITS.open_rounds_per_market, 2);
  assert.equal(rounds.OPEN_ROUNDS_EXCEPTIONS.length, 1);
  const [x] = rounds.OPEN_ROUNDS_EXCEPTIONS;
  assert.deepEqual([x.market, x.month, x.open_rounds_per_market, x.segment], ['CN_A', '2026-12', 4, 'R2']);
  assert.equal(path.basename(x.amendment.path), 'RF1116_AMENDMENT_2026_12_CN_A_OPEN_ROUNDS_FREEZE_1.md');
  assert.equal(x.amendment.sha256, '884fd0f8fb65ef1735cfa5a623d3476780dc915f1e3d534cc0da91fb7da453ca');
  assert.equal(sha(fs.readFileSync(path.join(ROOT, x.amendment.repo_copy))), x.amendment.sha256, 'the repo copy is the cited page');
  assert.ok(Object.isFrozen(rounds.OPEN_ROUNDS_EXCEPTIONS) && Object.isFrozen(x) && Object.isFrozen(x.amendment));
  const lim = rounds.openRoundsLimitOf;
  assert.equal(lim('CN_A', '2026-12', 'R2'), 4);
  for (const [m, mo, seg] of [['CN_A', '2026-12', 'R1'], ['CN_A', '2026-12', null], ['CN_A', '2026-11', 'R2'], ['CN_A', '2027-01', 'R2'], ['US', '2026-12', 'R2'], ['CRYPTO', '2026-12', 'R2']]) assert.equal(lim(m, mo, seg), 2, `${m} ${mo} ${seg}`);
});

test('O1 (b) 2026-12: December rounds 1 and 2 open while two November rounds are unclosed (R2 gets the two extra places)', () => {
  freshData();
  const [r1, r2, r3] = realLedgerShape();
  assert.equal(rounds.roundsOf('CN_A').filter((r) => !rounds.TERMINAL.includes(r.status)).length, 2, 'rounds 2 and 3 are unclosed');
  const d1 = openAuto('2026-12-01T20:50:00+08:00');
  const d2 = openAuto('2026-12-02T20:50:00+08:00');
  assert.deepEqual([d1.holdout.segment, d2.holdout.segment, d1.status, d2.status], ['R2', 'R2', 'OPEN', 'OPEN']);
  assert.equal(rounds.roundsOf('CN_A').filter((r) => !rounds.TERMINAL.includes(r.status)).length, 4);
  assert.throws(() => openAuto('2026-12-03T20:50:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R2/), 'a 3rd R2 round: the segment is full');
  for (const r of [r1, r2, r3]) assert.deepEqual(rounds.roundHead(r.round_id).holdout, H1, 'R1 rows untouched');
});

test('O2 (a) 2026-12: a 5th unclosed round is refused (the limit is 4)', () => {
  freshData();
  const [, , r3] = realLedgerShape();
  openAuto('2026-12-01T20:50:00+08:00'); // unclosed: r2, r3, d1 = 3
  forge(r3, 'MR-CN_A-2026-11-forged0001'); // a 4th unclosed round (assigned to R1)
  assert.throws(() => openAuto('2026-12-02T20:50:00+08:00'), code(/MINE_ROUND_ALREADY_OPEN:CN_A:4/), 'R2 has room (1 of 2 counted) but 4 rounds are unclosed');
});

test('O3 (c) a round assigned to R1 in December still gets only 2 unclosed places', () => {
  freshData();
  openWindow('2026-10-20T10:00:00+08:00', H0); // unclosed, on an earlier window
  openWindow('2026-11-18T10:00:00+08:00', H1); // unclosed, R1
  assert.throws(() => openWindow('2026-12-01T20:50:00+08:00', H1), code(/MINE_ROUND_ALREADY_OPEN:CN_A:2/), 'the extra places are for rounds assigned to R2');
});

test('O4 (d) 2027-01: the limit is back to 2 (the exception does not roll over)', () => {
  freshData();
  const [, r2, r3] = realLedgerShape(); assert.ok(r2 && r3);
  const d1 = openAuto('2026-12-01T20:50:00+08:00'); seal(d1); zeroSelection(d1); failEval(d1); // terminal and not counted against R2
  openAuto('2026-12-02T20:50:00+08:00'); // unclosed: r2, r3, d2 = 3
  assert.throws(() => openAuto('2027-01-05T20:50:00+08:00'), code(/MINE_ROUND_ALREADY_OPEN:CN_A:3/), 'R2 has room (1 of 2 counted); the January limit is 2');
});

test('O5 (e) other markets are not affected: the 3rd unclosed US / CRYPTO round in 2026-12 is refused at 2', () => {
  for (const market of ['US', 'CRYPTO']) {
    freshData();
    openWindow('2026-12-01T10:00:00+08:00', { from: '2026-06-01', to: '2026-08-31' }, market);
    openWindow('2026-12-02T10:00:00+08:00', { from: '2026-09-01', to: '2026-11-30' }, market);
    assert.throws(() => openWindow('2026-12-03T10:00:00+08:00', { from: '2026-12-01', to: '2027-02-28' }, market), code(new RegExp(`MINE_ROUND_ALREADY_OPEN:${market}:2`)), market);
  }
});

test('O6 November rounds are unchanged: the 3rd unclosed November round on R1 is refused at 2 (and by the full segment first)', () => {
  freshData();
  openAuto('2026-11-01T10:00:00+08:00'); openAuto('2026-11-02T10:00:00+08:00');
  assert.throws(() => openAuto('2026-11-03T10:00:00+08:00'), code(/MINE_ROUND_HOLDOUT_EXHAUSTED:R1/));
  freshData();
  openWindow('2026-10-20T10:00:00+08:00', H0); openWindow('2026-11-18T10:00:00+08:00', H1);
  assert.throws(() => openWindow('2026-11-19T10:00:00+08:00', H1), code(/MINE_ROUND_ALREADY_OPEN:CN_A:2/));
});
