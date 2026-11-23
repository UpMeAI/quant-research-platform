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
  const bad = verify({ asOf: '2027-01-10', v2: claim('2026-11-01', '2026-11-10') });
  assert.equal(bad.generator.verdict, 'fail');
  assert.equal(bad.internal.failedStage, 'V2');
  assert.ok(bad.generator.reasonCodes.includes('V2_UNSEEN_CLAIM_NOT_UNSEEN'), bad.generator.reasonCodes.join(','));
  const straddle = verify({ asOf: '2027-01-10', v2: claim('2026-11-10', '2026-11-20') });
  assert.ok(straddle.generator.reasonCodes.includes('V2_UNSEEN_CLAIM_NOT_UNSEEN'), 'a claim that starts inside the reviewed interval fails');
});

test('AC4 (positive): dates after the cutoff can still be UNSEEN, and claiming them passes V-2', () => {
  freshLedger();
  unseen('CN_A_H5', '2026-10-19', '2026-12-31');
  assert.equal(mark(aiPack({ window: W46_WINDOW })).length, 1, 'the pack is delivered and marked');
  assert.deepEqual(labelsOf(trials.segmentsFor('CN_A_H5', '2026-11-01', '2026-11-13')), ['SEEN'], 'inside the cutoff it is SEEN');
  assert.deepEqual(labelsOf(trials.segmentsFor('CN_A_H5', '2026-11-14', '2026-12-31')), ['UNSEEN']);
  const claim = (v2) => { v2.unseenClaim = { from: '2026-11-14', to: '2026-12-31' }; v2.segmentMarks = rowsOnDisk(); };
  const ok = verify({ asOf: '2027-01-10', v2: claim });
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
  const lab = require('../services/research-lab-e2e');
  assert.equal(typeof lab.seen.seenRangesOf, 'function');
  freshLedger();
  mark(aiPack({ window: W46_WINDOW }));
  assert.deepEqual(lab.seen.seenRangesOf({ market: 'CN_A', asOf: '2026-12-01T00:00:00+08:00' }), [{ from: '2026-10-19', to: '2026-11-13', source: 'REVIEW_CARD' }], 'the ranges are the ledger marks');
  assert.deepEqual(lab.seen.seenRangesOf({ market: 'US_EQUITY', asOf: '2026-12-01T00:00:00+08:00' }), []);
  assert.deepEqual(lab.seen.seenRangesOf({ market: 'CN_A', asOf: '2026-11-01T00:00:00+08:00' }), [], 'a mark registered after as_of is not part of that run');
});
