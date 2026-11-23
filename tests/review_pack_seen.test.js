'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const K = require('./_k2_freeze_fixture');
const fx = require('./_verifier_fixture');
const verifier = require('../services/independent-verifier');
const prog = require('../services/k2-freeze-program');
const trials = require('../services/trial-ledger');
const reviewSeen = require('../services/trial-ledger/review_pack_seen');
const { read } = require('../packages/ledger');

/**
 * W05 ruling (plan-coord 11-23, W05_REVIEWED_IS_SEEN_RULING_V1 sections 1-3): a delivered review fact pack (the human weekly compile or the AI review card pack) writes ONE
 * DATA_SEGMENT_MARK_V1 SEEN row into the trial ledger; the readers of SEEN / UNSEEN read the ledger marks only. One test per acceptance item (AC1-AC10).
 */
const AUTH = K.AUTH;
const T0 = '2026-11-01T00:00:00+08:00';
const T1 = '2026-11-23T10:30:00+08:00';
const FAM = 'AIP_CNA_REVIEWED';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function freshLedger() { process.env.QRP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-w05-')); }
const rowsOnDisk = () => read(trials.SEGMENTS());
const labelsOf = (res) => [...new Set(res.pieces.map((p) => p.label))];
const unseen = (family, from, to, market = 'CN_A') => trials.markSegments({ family_id: family, market, from, to, label: 'UNSEEN', reason: 'sealed segment' }, { registeredBy: AUTH, registeredAt: T0 });

/** An AI review fact pack in the desk's REVIEW_AI_FACT_PACK_V1 shape; `window` (optional) is stated on every fact. */
function aiPack({ market = 'CN_A', week = '2026-W46', at = '2026-11-13', window = null, n = 2, extra = {} } = {}) {
  const facts = Array.from({ length: n }, (_, i) => ({ id: `F-${String(i + 1).padStart(3, '0')}`, kind: 'FINDING', source: { path: 'docs/review-loop/REVIEW_LOOP_WEEK.json', sha256: sha(`src${i}${week}`), pointer: `$.findings[${i}]` },
    at: `${at}T18:00:00+08:00`, value: { k: i }, ...(window ? { window } : {}) }));
  return { schema: 'REVIEW_AI_FACT_PACK_V1', market, week, facts, ...extra };
}
/** The human weekly compile (REVIEW_LOOP_WEEK_V1): three market periods, no per-fact windows. */
const weeklyCompile = ({ weekId = '2026-W46', generatedAt = '2026-11-16T02:30:29.237Z', revision = 0 } = {}) => ({ schemaVersion: 1, contract: 'REVIEW_LOOP_WEEK_V1', producer: 'COORDINATOR', weekId, generatedAt, revision,
  periods: { CN: { from: '2026-11-09', to: '2026-11-13', clock: 'SSE_SESSIONS' }, US: { from: '2026-11-09', to: '2026-11-13', clock: 'NYSE_SESSIONS' }, CRYPTO: { from: '2026-11-09', to: '2026-11-15', clock: 'UTC_DAYS' } },
  findings: [], candidates: [], register: [], hash: sha(weekId + revision) });
const W46_WINDOW = { from: '2026-10-19', to: '2026-11-13' };
const mark = (pack, over = {}) => reviewSeen.markPack(pack, { registeredBy: AUTH, registeredAt: T1, ...over });

test('AC1: after a pack covering [a, b] is delivered, segmentsFor is SEEN on [a, b] (a sealed UNSEEN mark no longer holds there) and still UNSEEN after b', () => {
  freshLedger();
  unseen(FAM, '2026-10-19', '2026-12-31');
  assert.deepEqual(labelsOf(trials.segmentsFor(FAM, '2026-10-19', '2026-11-13')), ['UNSEEN'], 'precondition: sealed UNSEEN');
  const rows = mark(aiPack({ window: W46_WINDOW }));
  assert.equal(rows.length, 1, 'one row per pack');
  assert.deepEqual([rows[0].schema, rows[0].label, rows[0].market, rows[0].from, rows[0].to], ['DATA_SEGMENT_MARK_V1', 'SEEN', 'CN_A', '2026-10-19', '2026-11-13']);
  assert.deepEqual(labelsOf(trials.segmentsFor(FAM, '2026-10-19', '2026-11-13')), ['SEEN']);
  assert.deepEqual(labelsOf(trials.segmentsFor(FAM, '2026-11-14', '2026-12-31')), ['UNSEEN'], 'the dates after the cutoff stay UNSEEN');
  assert.equal(rows[0].source_refs[0].sha256, reviewSeen.packSha256(aiPack({ window: W46_WINDOW })), 'the source reference is the pack sha256');
});

test('AC1 (scope): the mark is for the pack market only, and a later UNSEEN mark cannot un-see what the review read', () => {
  freshLedger();
  unseen(FAM, '2026-10-19', '2026-12-31');
  unseen('US_FAM', '2026-10-19', '2026-12-31', 'US_EQUITY');
  unseen('C17_LIKE', '2026-10-19', '2026-12-31', 'CRYPTO_USDM_PERP');
  mark(aiPack({ window: W46_WINDOW }));
  assert.deepEqual(labelsOf(trials.segmentsFor('US_FAM', '2026-10-19', '2026-11-13')), ['UNSEEN'], 'a CN_A pack does not touch a US family');
  mark(aiPack({ market: 'CRYPTO', window: W46_WINDOW, week: '2026-W46' }));
  assert.deepEqual(labelsOf(trials.segmentsFor('C17_LIKE', '2026-10-19', '2026-11-13')), ['SEEN'], 'CRYPTO_USDM_PERP is the CRYPTO market');
  unseen(FAM, '2026-10-01', '2026-12-31'); // written after the pack: the review already read these days
  assert.deepEqual(labelsOf(trials.segmentsFor(FAM, '2026-10-19', '2026-11-13')), ['SEEN']);
  assert.deepEqual(labelsOf(trials.segmentsFor(FAM, '2026-10-01', '2026-10-18')), ['UNSEEN']);
});

test('AC2: K2 freeze program V8 reads the ledger marks: a data range that holds the reviewed interval is no longer an UNSEEN first read, an UNSEEN claim over it is refused, and a range that runs past the cutoff still is the UNSEEN first read', () => {
  const v8Codes = ({ pack = false, label = 'SEEN', range = null } = {}) => {
    freshLedger();
    const d = K.baseDraft();
    d.data_inputs[0].segment_label = label;
    if (range) { d.data_inputs[0].range = range; d.sample = { ...d.sample, ...range }; }
    unseen(d.family_id, '2025-06-01', '2026-06-30');
    if (pack) mark(aiPack({ at: '2025-12-31', window: { from: '2025-06-01', to: '2025-12-31' } }));
    return K.codesOf(prog.prepare(d, K.baseCtx({ marks: rowsOnDisk() })), 'V8');
  };
  const before = v8Codes();
  assert.ok(before.some((c) => c.startsWith('PREREG_DATA_UNSEEN_FIRST_READ')), `before the pack the sealed UNSEEN range is an UNSEEN first read: ${before}`);
  assert.deepEqual(v8Codes({ pack: true }), [], 'after the pack the reviewed interval is SEEN: reading it as SEEN is allowed');
  const claim = v8Codes({ pack: true, label: 'UNSEEN' });
  assert.ok(claim.some((c) => c.startsWith('PREREG_DATA_LABEL_MISMATCH')), `an UNSEEN claim over the reviewed interval is refused: ${claim}`);
  const past = v8Codes({ pack: true, range: { from: '2024-01-02', to: '2026-03-31' } });
  assert.ok(past.some((c) => c.startsWith('PREREG_DATA_UNSEEN_FIRST_READ')), `past the cutoff the UNSEEN days remain an UNSEEN first read: ${past}`);
});

const verify = (o) => { const { bundle, ctx } = fx.build(o); return verifier.verify(bundle, ctx); };

test('AC3: independent verifier V-2 refuses the reviewed interval as an unseen sample (UNSEEN_CLAIM_NOT_UNSEEN)', () => {
  freshLedger();
  unseen('CN_A_H5', '2026-10-19', '2026-12-31');
  mark(aiPack({ window: W46_WINDOW }));
  const claim = (from, to) => (v2) => { v2.unseenClaim = { from, to }; v2.segmentMarks = rowsOnDisk(); };
  const bad = verify({ v2: claim('2026-11-01', '2026-11-10') });
  assert.equal(bad.generator.verdict, 'fail');
  assert.equal(bad.internal.failedStage, 'V2');
  assert.ok(bad.generator.reasonCodes.includes('V2_UNSEEN_CLAIM_NOT_UNSEEN'), bad.generator.reasonCodes.join(','));
  const straddle = verify({ v2: claim('2026-11-10', '2026-11-20') });
  assert.ok(straddle.generator.reasonCodes.includes('V2_UNSEEN_CLAIM_NOT_UNSEEN'), 'a claim that starts inside the reviewed interval fails');
});

test('AC4 (positive): dates after the cutoff can still be UNSEEN, and claiming them passes V-2', () => {
  freshLedger();
  unseen('CN_A_H5', '2026-10-19', '2026-12-31');
  assert.equal(mark(aiPack({ window: W46_WINDOW })).length, 1, 'the pack is delivered and marked');
  assert.deepEqual(labelsOf(trials.segmentsFor('CN_A_H5', '2026-11-01', '2026-11-13')), ['SEEN'], 'inside the cutoff it is SEEN');
  assert.deepEqual(labelsOf(trials.segmentsFor('CN_A_H5', '2026-11-14', '2026-12-31')), ['UNSEEN']);
  const claim = (v2) => { v2.unseenClaim = { from: '2026-11-14', to: '2026-12-31' }; v2.segmentMarks = rowsOnDisk(); };
  const ok = verify({ v2: claim });
  assert.equal(ok.generator.verdict, 'pass', ok.generator.reasonCodes.join(','));
});

test('AC5: delivering the same pack twice (also re-serialised, or from its file bytes) writes one mark', () => {
  freshLedger();
  const pack = aiPack({ window: W46_WINDOW });
  const first = mark(pack);
  const bytes = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`);
  const reordered = JSON.parse(JSON.stringify({ facts: pack.facts, week: pack.week, market: pack.market, schema: pack.schema }));
  const second = mark(reordered, { fileBytes: bytes, registeredAt: '2026-11-24T10:00:00+08:00' });
  assert.equal(rowsOnDisk().length, 1, 'one mark row in the ledger');
  assert.equal(first[0].replayHit, undefined);
  assert.equal(second[0].replayHit, true);
  assert.equal(second[0].mark_id, first[0].mark_id);
  assert.equal(mark(aiPack({ window: W46_WINDOW, week: '2026-W46', at: '2026-11-12' })).length, 1, 'a different pack is a different mark');
  assert.equal(rowsOnDisk().length, 2);
});

test('AC6: a fact that states no window widens the range to the market data start; all windows stated keeps the earliest stated start', () => {
  freshLedger();
  const stated = mark(aiPack({ window: { from: '2026-11-02', to: '2026-11-13' } }))[0];
  assert.deepEqual([stated.from, stated.to], ['2026-11-02', '2026-11-13']);
  const mixed = aiPack({ week: '2026-W45', at: '2026-11-06', window: { from: '2026-11-02', to: '2026-11-06' } });
  delete mixed.facts[1].window;
  const wide = mark(mixed)[0];
  assert.deepEqual([wide.from, wide.to], [reviewSeen.dataStart('CN_A'), '2026-11-06']);
  assert.equal(reviewSeen.dataStart('CN_A'), '2020-06-01');
  const none = mark(aiPack({ week: '2026-W44', at: '2026-10-30' }))[0];
  assert.deepEqual([none.from, none.to], ['2020-06-01', '2026-10-30'], 'no windows at all: widest');
  const earliest = mark(aiPack({ week: '2026-W43', at: '2026-10-23', window: { from: '2026-10-19', to: '2026-10-23' } }))[0];
  assert.deepEqual([earliest.from, earliest.to], ['2026-10-19', '2026-10-23']);
});

test('AC6 (cutoff): the range ends at the decision cutoff; a pack with no date at all is refused, never guessed', () => {
  freshLedger();
  const p = aiPack({ at: '2026-11-13' });
  p.facts[1].at = '2026-11-12T10:00:00+08:00';
  assert.equal(mark(p)[0].to, '2026-11-13', 'the latest fact date');
  const dated = aiPack({ week: '2026-W45', at: '2026-11-06', extra: { decision_cutoff: '2026-11-08' } });
  assert.equal(mark(dated)[0].to, '2026-11-08', 'a stated decision cutoff later than the facts');
  const undated = aiPack({ week: '2026-W42' });
  undated.facts.forEach((f) => { f.at = 'unknown'; });
  assert.throws(() => mark(undated), /REVIEW_PACK_SEEN_NO_CUTOFF/);
  assert.throws(() => mark(aiPack({ market: 'X' })), /REVIEW_PACK_SEEN_MARKET_UNKNOWN/);
  assert.throws(() => mark({ schema: 'SOMETHING_ELSE', market: 'CN_A', facts: [] }), /REVIEW_PACK_SEEN_KIND_UNKNOWN/);
  assert.equal(rowsOnDisk().length, 2, 'refused packs wrote nothing');
});

test('AC7: the human weekly compile and the AI review card pack each produce marks; reviewed-through is derived from the marks, not stored', () => {
  freshLedger();
  const weekly = mark(weeklyCompile());
  assert.deepEqual(weekly.map((r) => [r.market, r.from, r.to]).sort(), [['CN_A', '2020-06-01', '2026-11-16'], ['CRYPTO', '2020-01-01', '2026-11-16'], ['US_EQUITY', '2010-01-01', '2026-11-16']],
    'one SEEN row per market of the compile; the cutoff is the later of the period end and the compile date (CST); no fact windows: widest');
  assert.ok(weekly.every((r) => r.source_refs[0].sha256 === reviewSeen.packSha256(weeklyCompile())));
  freshLedger();
  const desk = { contract: 'REVIEW_AI_FACT_PACK_V1', market: 'US_EQUITY', weekId: '2026-W46', period: { from: '2026-11-09', to: '2026-11-13', clock: 'NYSE_SESSIONS' }, facts: aiPack({ at: '2026-11-13' }).facts };
  const ai = mark(desk);
  assert.equal(ai.length, 1);
  assert.deepEqual([ai[0].market, ai[0].to], ['US_EQUITY', '2026-11-13']);
  assert.equal(reviewSeen.reviewedThrough('US_EQUITY'), '2026-11-13');
  assert.equal(reviewSeen.reviewedThrough('CN_A'), null, 'no pack for this market: no value, not a guess');
  mark(aiPack({ market: 'US_EQUITY', week: '2026-W47', at: '2026-11-20' }));
  assert.equal(reviewSeen.reviewedThrough('US_EQUITY'), '2026-11-20');
  assert.equal(reviewSeen.reviewedThrough('US_EQUITY', { asOf: '2026-11-22T00:00:00+08:00' }), null, 'both marks were registered after this as-of');
  assert.equal(reviewSeen.reviewedThrough('US_EQUITY', { asOf: '2026-11-24T00:00:00+08:00' }), '2026-11-20');
  assert.ok(rowsOnDisk().every((r) => !('reviewed_through' in r)), 'no reviewed_through field is stored');
});

test('AC8: backfill from the archived packs marks them (SEEN on their ranges); packs with no archive are listed, not guessed', () => {
  freshLedger();
  unseen(FAM, '2026-10-19', '2026-12-31');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-w05-archive-'));
  fs.writeFileSync(path.join(dir, 'REVIEW_LOOP_WEEK_2026-W46.json'), `${JSON.stringify(weeklyCompile(), null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'REVIEW_LOOP_WEEK_2026-W46_R1.json'), `${JSON.stringify(weeklyCompile({ revision: 1, generatedAt: '2026-11-17T01:00:00.000Z' }), null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'REVIEW_AI_FACT_PACK_CN_A_2026-W47.json'), `${JSON.stringify(aiPack({ week: '2026-W47', at: '2026-11-20', window: { from: '2026-11-16', to: '2026-11-20' } }))}\n`);
  fs.writeFileSync(path.join(dir, 'REVIEW_LOOP_WEEK_2026-W45.json'), '{ not json');
  const expected = [{ kind: 'WEEKLY_COMPILE', week_id: '2026-W46', revision: 0 }, { kind: 'WEEKLY_COMPILE', week_id: '2026-W46', revision: 1 }, { kind: 'WEEKLY_COMPILE', week_id: '2026-W47', revision: 0 },
    { kind: 'AI_FACT_PACK', week_id: '2026-W47', market: 'CN_A' }, { kind: 'AI_FACT_PACK', week_id: '2026-W47', market: 'US_EQUITY' }];
  const dry = reviewSeen.backfill({ archives: [dir], expected, registeredBy: AUTH, registeredAt: T1, dryRun: true });
  assert.equal(rowsOnDisk().filter((r) => r.label === 'SEEN').length, 0, 'a dry run writes nothing');
  assert.ok(dry.marked.length >= 5);
  const out = reviewSeen.backfill({ archives: [dir], expected, registeredBy: AUTH, registeredAt: T1 });
  assert.deepEqual(out.missing.map((m) => [m.kind, m.week_id, m.market || null, m.revision === undefined ? null : m.revision]).sort(),
    [['AI_FACT_PACK', '2026-W47', 'US_EQUITY', null], ['WEEKLY_COMPILE', '2026-W47', null, 0]], 'W47 (weekly) and W47 US_EQUITY have no archive');
  assert.deepEqual(out.invalid.map((x) => [x.file, x.code]), [['REVIEW_LOOP_WEEK_2026-W45.json', 'REVIEW_PACK_SEEN_NOT_JSON']]);
  assert.deepEqual(labelsOf(trials.segmentsFor(FAM, '2026-10-19', '2026-11-16')), ['SEEN'], 'the W46 compile range is SEEN');
  assert.deepEqual(labelsOf(trials.segmentsFor(FAM, '2026-11-16', '2026-11-20')), ['SEEN'], 'the W47 CN_A pack range is SEEN');
  assert.deepEqual(labelsOf(trials.segmentsFor(FAM, '2026-11-21', '2026-12-31')), ['UNSEEN']);
  const n = rowsOnDisk().length;
  const again = reviewSeen.backfill({ archives: [dir], expected, registeredBy: AUTH, registeredAt: '2026-11-24T10:00:00+08:00' });
  assert.equal(rowsOnDisk().length, n, 'backfill is idempotent by pack sha256');
  assert.ok(again.marked.every((m) => m.replayHit === true));
});

test('AC9: the readers of SEEN / UNSEEN keep no range algorithm of their own; the lab seen.js reads the ledger marks', () => {
  const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const seenSrc = src('services/research-lab-e2e/seen.js');
  assert.match(seenSrc, /require\('\.\.\/trial-ledger/, 'seen.js goes through the trial ledger');
  for (const forbidden of [/op\s*[!=]==?\s*'READ'/, /Date\.parse|864e5|86400000/, /\.from\s*===\s*\w+\.from/, /const\s+overlaps\s*=/, /const\s+addDay\s*=/]) assert.doesNotMatch(seenSrc, forbidden, String(forbidden));
  assert.match(src('services/independent-verifier/stages.js'), /trials\.segmentsFor\(/);
  assert.match(src('services/k2-freeze-program/validators.js'), /trials\.segmentLabels\(/);
  assert.match(src('services/research-mechanism-register/index.js'), /trials\.segmentsFor\(/);
  assert.equal(require('../services/research-mechanism-register').MARKET_ALIAS, trials.MARKET_ALIAS, 'one market alias table');
  const lab = require('../services/research-lab-e2e');
  assert.equal(typeof lab.seen.seenRangesOf, 'function');
  freshLedger();
  mark(aiPack({ window: W46_WINDOW }));
  assert.deepEqual(lab.seen.seenRangesOf({ market: 'CN_A', asOf: '2026-12-01T00:00:00+08:00' }), [{ from: '2026-10-19', to: '2026-11-13', source: 'REVIEW_CARD' }], 'the ranges are the ledger marks');
  assert.deepEqual(lab.seen.seenRangesOf({ market: 'US_EQUITY', asOf: '2026-12-01T00:00:00+08:00' }), []);
  assert.deepEqual(lab.seen.seenRangesOf({ market: 'CN_A', asOf: '2026-11-01T00:00:00+08:00' }), [], 'a mark registered after as_of is not part of that run');
});

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------
 * Review fixes (plan-coord 11-23 14:00, W05_REVIEW_20261123 P2-1, P2-2, P2-3): read-back after the write, a cutoff far in the future is refused, a present but unparsable cutoff is refused.
 * ---------------------------------------------------------------------------------------------------------------------------------------------------------------- */
const NOW = () => Date.parse('2026-11-23T12:00:00+08:00'); // the injectable host clock: now + 36 h = 2026-11-25T00:00+08:00
const tear = () => { const file = trials.SEGMENTS(); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{"schema":"DATA_SEGMENT_MARK_V1","mark_id":"SEG-torn","family_id":"X","mar'); };

test('P2-1 read-back: a torn ledger tail makes the mark unreadable, so the write is refused (REVIEW_PACK_SEEN_NOT_READBACK), never reported as a mark; the retry then succeeds', () => {
  freshLedger();
  tear();
  assert.throws(() => mark(aiPack({ window: W46_WINDOW }), { now: NOW }), /REVIEW_PACK_SEEN_NOT_READBACK/);
  assert.equal(reviewSeen.packMarks({ market: 'CN_A' }).length, 0, 'the readers do not see a mark');
  assert.equal(reviewSeen.reviewedThrough('CN_A'), null);
  const retry = mark(aiPack({ window: W46_WINDOW }), { now: NOW });
  assert.equal(retry.length, 1);
  assert.equal(retry[0].replayHit, undefined, 'a real write, readable this time');
  assert.equal(reviewSeen.reviewedThrough('CN_A'), '2026-11-13');
  assert.equal(reviewSeen.packMarks({ market: 'CN_A' }).length, 1);
  assert.equal(mark(aiPack({ window: W46_WINDOW }), { now: NOW })[0].replayHit, true, 'and idempotent as before');
});

test('P2-1 read-back (all markets): a weekly compile writes three rows, and if any of them cannot be read back the whole call is refused', () => {
  freshLedger();
  tear();
  assert.throws(() => mark(weeklyCompile(), { now: NOW }), /REVIEW_PACK_SEEN_NOT_READBACK/);
  assert.equal(reviewSeen.packMarks({ market: 'CN_A' }).length, 0, 'the row glued to the torn fragment is not readable');
  const retry = mark(weeklyCompile(), { now: NOW });
  assert.deepEqual(retry.map((r) => [r.market, r.replayHit === true]).sort(), [['CN_A', false], ['CRYPTO', true], ['US_EQUITY', true]], 'the retry writes the missing row and replays the two that were readable');
  assert.equal(reviewSeen.packMarks({}).length, 3);
});

test('P2-1 read-back: a dry run writes nothing and so reads nothing back', () => {
  freshLedger();
  tear();
  assert.equal(mark(aiPack({ window: W46_WINDOW }), { now: NOW, dryRun: true })[0].dryRun, true);
});

test('P2-2 far-future cutoff: a cutoff or fact date later than now + 36 hours (host clock, injectable) is refused (REVIEW_PACK_SEEN_CUTOFF_IN_FUTURE), whatever date source carries it', () => {
  freshLedger();
  const refused = (pack, label) => assert.throws(() => mark(pack, { now: NOW }), /REVIEW_PACK_SEEN_CUTOFF_IN_FUTURE/, label);
  refused(aiPack({ at: '2099-01-01' }), 'a fact date');
  refused(aiPack({ week: '2026-W45', extra: { decision_cutoff: '2099-01-01' } }), 'a stated decision cutoff');
  refused(aiPack({ week: '2026-W44', window: { from: '2026-11-01', to: '2099-01-01' } }), 'a window end');
  refused({ contract: 'REVIEW_AI_FACT_PACK_V1', market: 'CN_A', weekId: '2026-W43', period: { from: '2026-11-09', to: '2099-01-01' }, facts: aiPack({ week: '2026-W43' }).facts }, 'the period end');
  const weekly = weeklyCompile(); weekly.periods.CN.to = '2099-01-01';
  refused(weekly, 'a weekly period end');
  refused(weeklyCompile({ generatedAt: '2099-01-01T00:00:00Z' }), 'a weekly compile time');
  refused(aiPack({ week: '2026-W42', at: '2026-11-26' }), 'one day past the limit day');
  assert.equal(mark(aiPack({ week: '2026-W41', at: '2026-11-25' }), { now: NOW }).length, 1, 'the limit day itself (now + 36 h) is fine');
  assert.equal(mark(aiPack({ week: '2026-W40', at: '2026-11-13' }), { now: '2026-11-23T12:00:00+08:00' }).length, 1, 'now as an ISO stamp');
  assert.equal(rowsOnDisk().length, 2, 'refused packs wrote nothing');
});

test('P2-2 far-future cutoff: the clock is injectable (a 2031 pack marks when the clock is after it) and backfill applies the same limit', () => {
  freshLedger();
  const later = () => Date.parse('2031-03-01T00:00:00+08:00');
  assert.equal(mark(aiPack({ week: '2031-W07', at: '2031-02-14' }), { now: later })[0].to, '2031-02-14');
  assert.throws(() => mark(aiPack({ week: '2031-W08', at: '2031-02-21' })), /REVIEW_PACK_SEEN_CUTOFF_IN_FUTURE/, 'the default clock is the host clock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-w05-archive-'));
  fs.writeFileSync(path.join(dir, 'REVIEW_LOOP_WEEK_2099-W01.json'), `${JSON.stringify(weeklyCompile({ weekId: '2099-W01', generatedAt: '2099-01-05T00:00:00Z' }))}\n`);
  const out = reviewSeen.backfill({ archives: [dir], registeredBy: AUTH, registeredAt: T1, now: NOW });
  assert.deepEqual(out.invalid.map((x) => [x.file, x.code]), [['REVIEW_LOOP_WEEK_2099-W01.json', 'REVIEW_PACK_SEEN_CUTOFF_IN_FUTURE']]);
  assert.equal(out.marked.length, 0);
});

test('P2-3 an explicit decision cutoff that is present but unparsable is refused (REVIEW_PACK_SEEN_CUTOFF_INVALID); only an absent one falls back to the other date sources', () => {
  freshLedger();
  for (const key of ['decision_cutoff', 'decisionCutoff', 'cutoff']) {
    for (const bad of ['2026/11/30', 12345, null, '', 'tomorrow', '2026-02-31']) {
      assert.throws(() => mark(aiPack({ week: '2026-W45', extra: { [key]: bad } }), { now: NOW }), /REVIEW_PACK_SEEN_CUTOFF_INVALID/, `${key}=${JSON.stringify(bad)}`);
    }
  }
  assert.equal(mark(aiPack({ week: '2026-W45', extra: { decision_cutoff: '2026-11-15' } }), { now: NOW })[0].to, '2026-11-15', 'a valid stated cutoff is used');
  assert.equal(mark(aiPack({ week: '2026-W44' }), { now: NOW })[0].to, '2026-11-13', 'absent: the facts date, as before');
  const weekly = weeklyCompile(); weekly.generatedAt = '2026/11/16';
  assert.throws(() => mark(weekly, { now: NOW }), /REVIEW_PACK_SEEN_CUTOFF_INVALID/, 'the weekly compile time, present but unparsable');
  const numeric = weeklyCompile(); numeric.generatedAt = 12345;
  assert.throws(() => mark(numeric, { now: NOW }), /REVIEW_PACK_SEEN_CUTOFF_INVALID/);
  const absent = weeklyCompile(); delete absent.generatedAt;
  assert.deepEqual(mark(absent, { now: NOW }).map((r) => [r.market, r.to]).sort(), [['CN_A', '2026-11-13'], ['CRYPTO', '2026-11-15'], ['US_EQUITY', '2026-11-13']], 'absent compile time: the period ends, as before');
  assert.equal(rowsOnDisk().length, 5, 'refused packs wrote nothing');
});

test('a real desk pack shape (contract / weekId / period, COUNT facts, plain-date at, no decision_cutoff, no window) still marks under the new checks, on the host clock too', () => {
  freshLedger();
  const src = { path: 'docs/review-loop/REVIEW_LOOP_WEEK_2026-W46.json', sha256: 'c'.repeat(64) };
  const desk = { schemaVersion: 1, contract: 'REVIEW_AI_FACT_PACK_V1', producer: 'DESK_REVIEW_LOOP', market: 'CN_A', weekId: '2026-W46', revision: 0, period: { from: '2026-11-09', to: '2026-11-13', clock: 'SSE_SESSIONS' },
    sourceWeek: { file: 'REVIEW_LOOP_WEEK_2026-W46.json', sha256: 'c'.repeat(64), hash: 'd'.repeat(64) }, routes: 'REVIEW_LOOP_DEFAULT_ROUTES@v2',
    facts: [{ id: 'F-001', kind: 'PERIOD', source: { ...src, pointer: '$.periods.CN' }, at: '2026-11-13', value: { from: '2026-11-09', to: '2026-11-13', clock: 'SSE_SESSIONS' } },
      { id: 'F-002', kind: 'FINDING', source: { ...src, pointer: '$.findings[0]' }, at: '2026-11-13', value: { findingId: 'F-1' } },
      { id: 'F-003', kind: 'COUNT', source: { ...src, pointer: '$.findings' }, at: '2026-11-13', value: { subject: 'FINDINGS_BY_TRIGGER', total: 1, counts: { F08: 1 }, derivedBy: 'ai-review-facts@1' } }],
    refused: [], excludedSections: [], noFindingsReason: null, interpretation: 'REVIEW_AI_FACTS_NOT_ADVICE', realOrder: 0, brokerWrite: false, hash: 'e'.repeat(64) };
  const first = mark(desk, { now: NOW })[0];
  assert.deepEqual([first.market, first.from, first.to], ['CN_A', '2020-06-01', '2026-11-13']);
  const hostClock = mark({ ...desk, weekId: '2026-W45', period: { ...desk.period, to: '2026-11-06' }, facts: desk.facts.map((f) => ({ ...f, at: '2026-11-06' })) })[0];
  assert.equal(hostClock.to, '2026-11-06');
});
