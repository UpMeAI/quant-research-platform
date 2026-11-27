'use strict';
/**
 * Legacy round rows (finding of 2026-11-23, approved by plan-coord): MINING_ROUND_V1 rows of rounds 1 and 2 (opened 2026-11-18, before RF1116 SIZE_V2 added
 * scoring_neutralization) have no such key. validateRecord treats an absent field as MISSING, so every NEW row for round 2 (SCORING, close, failures) was refused:
 * on a copy of the lane ledger beginScoring(round 2) gave MINE_ROUND_SCHEMA_INVALID:MISSING:scoring_neutralization. Rewriting the row is no way out (manifestSha and the
 * candidates' k2_sha256 hash it). The key may be ABSENT only for the rounds of the frozen legacy list (a constant, never data); for every other round an absent key stays
 * MISSING and neutralizationOf keeps failing closed (MINE_RUNNER_NEUTRALIZATION_UNKNOWN). Not a general optional field. Red first, synthetic data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH = 'TEST_LEGACY_ROUND_ROWS_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const { R1 } = require('./_mining_manifest');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');
const trials = require('../services/trial-ledger');
const neutralization = require('../services/mining-rounds/neutralization');
const { validateRecord } = require('../schemas');

const ROUND_1 = 'MR-CN_A-2026-11-e1ab63a27b';
const ROUND_2 = 'MR-CN_A-2026-11-2a1d2c9c82';
const ROUND_3 = 'MR-CN_A-2026-11-a6cb823f86';
const H1 = Object.freeze({ from: '2026-10-19', to: '2026-12-31' });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const freshData = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-legacyrow-data-')); process.env.QRP_DATA_DIR = d; return d; };
const sp = (n) => ({ space_ref: `MS-LEG-${n}`, sha256: sha(`leg-space-${n}`), freeze: { path: `f-${n}`, sha256: sha(`leg-freeze-${n}`) } });
let spaceNo = 0;
const openWindow = (at) => { spaceNo += 1; return rounds.openRound({ market: 'CN_A', space: sp(spaceNo), holding_periods: [5], generator: { mode: 'AI_MINED_GP', gp_seed: 1 }, holdout: H1, openedAt: at, ...R1 }); };
/**
 * A round row as history left it: the row of a normal round under another id, WITHOUT the scoring_neutralization key, appended raw (as the old code did, before the field
 * existed and before the validator knew it). Returns the id.
 */
function historicalRow(roundId, at) {
  const target = process.env.QRP_DATA_DIR;
  freshData(); const base = openWindow(at); // the template row comes from a throw-away ledger, so the target ledger holds only the historical row
  process.env.QRP_DATA_DIR = target;
  const { record_hash: _h, round_id: _id, scoring_neutralization: _n, ...rest } = base;
  const body = { ...rest, round_id: roundId };
  fs.mkdirSync(path.dirname(rounds.LEDGER()), { recursive: true });
  fs.appendFileSync(rounds.LEDGER(), `${JSON.stringify({ ...body, record_hash: trials.recordHash(body) })}\n`);
  return roundId;
}
const cand = (roundId, n) => `${roundId}:A00${n}`;
const addCandidate = (roundId) => rounds.recordCandidate(roundId, { candidate_id: cand(roundId, 1), formula_canonical: 'rank(ts_mean(pb,5))', formula_sha256: sha('rank(ts_mean(pb,5))'), holding_period: 5, mining_score: 0.02 }, { registeredBy: AUTH });

test('L0 the legacy list is a frozen constant (rounds 1 and 2), one list for the validator and for neutralizationOf', () => {
  const { LEGACY_ABSENT_FIELDS } = require('../schemas');
  const list = LEGACY_ABSENT_FIELDS.MINING_ROUND_V1.scoring_neutralization;
  assert.deepEqual([...list], [ROUND_1, ROUND_2]);
  assert.ok(Object.isFrozen(LEGACY_ABSENT_FIELDS) && Object.isFrozen(LEGACY_ABSENT_FIELDS.MINING_ROUND_V1) && Object.isFrozen(list));
  assert.equal(neutralization.LEGACY_LINEAR_RAW_V1_ROUNDS, list, 'the same array: one source of truth');
  assert.throws(() => { 'use strict'; list.push(ROUND_3); }, TypeError, 'cannot be extended at run time');
  assert.deepEqual(Object.keys(LEGACY_ABSENT_FIELDS), ['MINING_ROUND_V1']);
  assert.deepEqual(Object.keys(LEGACY_ABSENT_FIELDS.MINING_ROUND_V1), ['scoring_neutralization'], 'one field, no general optionality');
});

test('L1 validateRecord: the key may be absent for rounds 1 and 2 only; round 3, any other id and every other missing field stay MISSING', () => {
  freshData();
  const base = openWindow('2026-11-18T05:49:16+08:00');
  const { scoring_neutralization: _n, record_hash: _h, ...noKey } = base;
  const row = (id, patch = {}) => { const { record_hash: _x, ...r } = { ...noKey, round_id: id, ...patch }; return { ...r, record_hash: trials.recordHash(r) }; };
  for (const id of [ROUND_1, ROUND_2]) assert.deepEqual(validateRecord(row(id)), { ok: true, problems: [] }, id);
  for (const id of [ROUND_3, 'MR-CN_A-2026-12-0123456789', 'MR-CN_A-2026-11-2a1d2c9c83', '']) assert.ok(validateRecord(row(id)).problems.includes('MISSING:scoring_neutralization'), id || '(empty id)');
  const { holdout_opens: _o, ...noOpens } = noKey;
  assert.ok(validateRecord({ ...noOpens, round_id: ROUND_2, record_hash: sha('x') }).problems.includes('MISSING:holdout_opens'), 'another missing field on a legacy round is still MISSING');
  assert.ok(validateRecord({ ...noKey, round_id: ROUND_2, scoring_neutralization: 5, record_hash: sha('x') }).problems.some((p) => p.startsWith('TYPE:scoring_neutralization')), 'a present key is still type-checked');
  assert.deepEqual(validateRecord({ ...base, round_id: ROUND_2 }), { ok: true, problems: [] }, 'a legacy round that does carry the key is fine too');
});

test('L2 a legacy round (no key in its row) can take every kind of new row: candidates, selection, scoring, close; the key stays absent and the version is still LINEAR_RAW_V1', () => {
  freshData();
  historicalRow(ROUND_2, '2026-11-18T09:23:54+08:00');
  assert.equal(rounds.roundHead(ROUND_2).scoring_neutralization, undefined);
  addCandidate(ROUND_2); // a head row for the round: this was the write the old code never needed after the field was added
  assert.equal(rounds.roundHead(ROUND_2).candidates_scored, 1);
  rounds.recordSelection(ROUND_2, { selection_sha256: sha('sel-2'), selected: [cand(ROUND_2, 1)], evaluated: 1 });
  vault.seal({ round_id: ROUND_2, segment: { ...H1 }, data_ref: 'synthetic', data_sha256: sha('h'), sealedBy: 'TEST' });
  vault.open({ round_id: ROUND_2, candidate_ids: [cand(ROUND_2, 1)], openedBy: 'TEST' }); // beginScoring: status SCORING
  assert.equal(rounds.roundHead(ROUND_2).status, 'SCORING');
  assert.equal(rounds.roundHead(ROUND_2).scoring_neutralization, undefined);
  assert.equal(neutralization.neutralizationOf(rounds.roundHead(ROUND_2)), 'LINEAR_RAW_V1');
  freshData();
  historicalRow(ROUND_1, '2026-11-18T05:49:16+08:00');
  rounds.recordSelection(ROUND_1, { selection_sha256: sha('sel-1'), selected: [], evaluated: 0 });
  rounds.failEvaluation(ROUND_1, { reason: 'synthetic: every mining score null', evidenceSha256: '3e3c70fcdc792e716c8fe09fc774c92427a636a8f3719b064fc95d4be89aa4f9' });
  assert.equal(rounds.roundHead(ROUND_1).status, 'FAILED_EVALUATION');
  freshData();
  historicalRow(ROUND_2, '2026-11-18T09:23:54+08:00');
  rounds.recordSelection(ROUND_2, { selection_sha256: sha('sel-2b'), selected: [], evaluated: 0 });
  assert.equal(rounds.closeRound(ROUND_2).status, 'CLOSED');
});

test('L3 every other round without the key is still refused (round 3 and a new id): new rows MISSING, neutralizationOf fails closed', () => {
  freshData();
  historicalRow(ROUND_3, '2026-11-23T08:30:00+08:00');
  assert.throws(() => addCandidate(ROUND_3), code(/MINE_ROUND_SCHEMA_INVALID:MISSING:scoring_neutralization/));
  assert.throws(() => rounds.beginScoring(ROUND_3, { holdoutOpens: { segment: { ...H1 }, family_ids: ['MINE:CN_A:H5'], count: 1 } }), code(/MISSING:scoring_neutralization/));
  assert.throws(() => neutralization.neutralizationOf(rounds.roundHead(ROUND_3)), code(/MINE_RUNNER_NEUTRALIZATION_UNKNOWN/));
  const other = 'MR-CN_A-2026-12-0123456789';
  historicalRow(other, '2026-12-01T20:50:00+08:00');
  assert.throws(() => addCandidate(other), code(/MISSING:scoring_neutralization/));
  assert.throws(() => neutralization.neutralizationOf(rounds.roundHead(other)), code(/MINE_RUNNER_NEUTRALIZATION_UNKNOWN/));
});

test('L4 a new round always carries the key (openRound writes it); no data on a row can make a round "legacy"', () => {
  freshData();
  const r = openWindow('2026-11-24T10:00:00+08:00');
  assert.equal(r.scoring_neutralization, 'LINEAR_RAW_V1', 'tests/_mining_manifest.js opts into the legacy version for synthetic rounds; production writes RANK_GAUSS_V2');
  const { LEGACY_ABSENT_FIELDS } = require('../schemas');
  const { record_hash: _h, scoring_neutralization: _n, ...rest } = r;
  for (const claim of [{ legacy: true }, { legacy_round: true }, { scoring_neutralization_legacy: true }]) {
    assert.ok(validateRecord({ ...rest, ...claim, record_hash: sha('x') }).problems.includes('MISSING:scoring_neutralization'), JSON.stringify(claim));
  }
  assert.equal(LEGACY_ABSENT_FIELDS.MINING_ROUND_V1.scoring_neutralization.length, 2);
});

test('L5 the relaxation has exactly one user: no schema other than MINING_ROUND_V1 has the field, so the per-schema table lookup cannot relax anything else (premise of the equivalent mutant K05)', () => {
  const { SCHEMAS } = require('../schemas');
  const holders = Object.entries(SCHEMAS).filter(([, def]) => Object.prototype.hasOwnProperty.call(def, 'scoring_neutralization')).map(([name]) => name);
  assert.deepEqual(holders, ['MINING_ROUND_V1']);
  assert.ok(Object.isFrozen(SCHEMAS) || !Object.prototype.hasOwnProperty.call(SCHEMAS, 'TEST_OTHER_V1'));
});
