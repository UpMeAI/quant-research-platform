'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const routing = require('../services/desk-review-routing');
const { contentHash } = require('../services/desk-review-routing/canonical');
const trials = require('../services/trial-ledger');
const reviewSeen = require('../services/trial-ledger/review_pack_seen');
const { read } = require('../packages/ledger');

/**
 * W05 ruling section 2: every entry point that takes a review fact pack into the research side writes the SEEN mark. Entry points covered here:
 *   - the QRP front door CLI apps/research-cli/review_pack_seen.js `mark` (the Mac relay and the host producer call it as a child process);
 *   - the human weekly compile through desk-review-routing importQueue (REVIEW_LOOP_WEEK_V1 is the queue's sourceWeek) and its CLI import_desk_research_queue.js.
 * The relay and producer hooks are in tests/research_queue/test_relay_seen_mark.py; the lab card step is in tests/research_lab_review_seen.test.js.
 */
const AUTH = 'TEST_W05_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const freshLedger = () => { process.env.QRP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-w05-entries-')); return process.env.QRP_DATA_DIR; };
const packMarks = () => read(trials.SEGMENTS()).filter((r) => r.label === 'SEEN' && Array.isArray(r.source_refs) && r.source_refs.some((x) => x && x.kind === reviewSeen.KIND));

const AI_PACK = { schema: 'REVIEW_AI_FACT_PACK_V1', week: '2026-W47', market: 'CN_A',
  facts: [{ id: 'F-001', source: { path: 'docs/review-loop/w.json', sha256: 'b'.repeat(64), pointer: '/' }, at: '2026-11-20T18:00:00+08:00', value: { k: 1 }, window: { from: '2026-11-16', to: '2026-11-20' } }] };

function cli(args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'apps/research-cli/review_pack_seen.js'), ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });
}

test('entry: the front door CLI marks a pack from stdin (what the relay and the producer call), idempotent, and fails with the error code as the first stderr token', () => {
  const dir = freshLedger();
  const bytes = `${JSON.stringify(AI_PACK, null, 2)}\n`;
  const one = cli(['mark', '--file', '-'], { input: bytes });
  assert.equal(one.status, 0, one.stderr);
  const out = JSON.parse(one.stdout);
  assert.deepEqual(out.marks.map((m) => [m.market, m.from, m.to, m.replayHit === true]), [['CN_A', '2026-11-16', '2026-11-20', false]]);
  assert.equal(out.marks[0].file_sha256, sha(bytes), 'the delivered file bytes are recorded next to the content sha');
  const two = cli(['mark', '--file', '-'], { input: bytes });
  assert.equal(JSON.parse(two.stdout).marks[0].replayHit, true);
  assert.equal(packMarks().length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'research', 'data_segments.jsonl')));
  const bad = cli(['mark', '--file', '-'], { input: JSON.stringify({ ...AI_PACK, market: 'X' }) });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^REVIEW_PACK_SEEN_MARKET_UNKNOWN/);
  const noAuth = cli(['mark', '--file', '-'], { input: bytes, env: { QRP_PRODUCT_MILESTONE_AUTHORITY: '' } });
  assert.equal(noAuth.status, 1);
  assert.match(noAuth.stderr, /^TRIAL_LEDGER_AUTHORITY_NOT_CONFIGURED/);
  assert.equal(packMarks().length, 1, 'failures wrote nothing');
});

function desk(weekId = '2026-W46') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-w05-desk-'));
  fs.mkdirSync(path.join(root, routing.QUEUE_DIR), { recursive: true });
  const week = { schemaVersion: 1, contract: 'REVIEW_LOOP_WEEK_V1', producer: 'COORDINATOR', weekId, revision: 0, generatedAt: '2026-11-16T02:30:29.237Z',
    periods: { CN: { from: '2026-11-09', to: '2026-11-13', clock: 'SSE_SESSIONS' }, US: { from: '2026-11-09', to: '2026-11-13', clock: 'NYSE_SESSIONS' }, CRYPTO: { from: '2026-11-09', to: '2026-11-15', clock: 'UTC_DAYS' } }, fixture: true };
  week.hash = contentHash(week);
  const weekFile = `REVIEW_LOOP_WEEK_${weekId}.json`;
  fs.writeFileSync(path.join(root, routing.WEEK_DIR, weekFile), `${JSON.stringify(week, null, 2)}\n`);
  const weekBytes = fs.readFileSync(path.join(root, routing.WEEK_DIR, weekFile));
  const queue = { schemaVersion: 1, contract: 'REVIEW_LOOP_RESEARCH_QUEUE_V1', producer: 'COORDINATOR', weekId, revision: 0, generatedAt: '2026-11-16T02:30:00Z',
    sourceWeek: { file: weekFile, sha256: sha(weekBytes), hash: week.hash }, routes: 'REVIEW_LOOP_DEFAULT_ROUTES@v2', entries: [], interpretation: 'RESEARCH_INTAKE_FACTS_NOT_ORDERS', realOrder: 0, brokerWrite: false };
  queue.hash = contentHash(queue);
  fs.writeFileSync(path.join(root, routing.QUEUE_DIR, `REVIEW_LOOP_RESEARCH_QUEUE_${weekId}.json`), `${JSON.stringify(queue, null, 2)}\n`);
  return { root, week, weekBytes };
}

test('entry: importing the weekly research queue marks its source week (the human weekly compile) once per market; no mark option, no change; a failed mark imports nothing', () => {
  freshLedger();
  const d = desk();
  routing.importQueue({ deskRoot: d.root });
  assert.equal(packMarks().length, 0, 'the existing behaviour without the option is unchanged');
  assert.throws(() => routing.importQueue({ deskRoot: d.root, seenMark: { registeredBy: 'NOT_THE_AUTHORITY', registeredAt: '2026-11-23T10:30:00+08:00' } }), /TRIAL_LEDGER_REGISTERED_BY_NOT_AUTHORIZED/);
  assert.equal(packMarks().length, 0);
  const out = routing.importQueue({ deskRoot: d.root, seenMark: { registeredBy: AUTH, registeredAt: '2026-11-23T10:30:00+08:00' } });
  assert.deepEqual(packMarks().map((m) => [m.market, m.to]).sort(), [['CN_A', '2026-11-16'], ['CRYPTO', '2026-11-16'], ['US_EQUITY', '2026-11-16']]);
  assert.ok(packMarks().every((m) => m.source_refs[0].file_sha256 === sha(d.weekBytes) && m.source_refs[0].pack_kind === 'WEEKLY_COMPILE'));
  assert.deepEqual(out.review_pack_seen.map((m) => m.market).sort(), ['CN_A', 'CRYPTO', 'US_EQUITY']);
  routing.importQueue({ deskRoot: d.root, seenMark: { registeredBy: AUTH, registeredAt: '2026-11-24T10:30:00+08:00' } });
  assert.equal(packMarks().length, 3, 'idempotent by the week file sha256');
});

test('entry: the queue import CLI passes the ledger authority and refuses to run without it (nothing is imported unmarked)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/research-cli/import_desk_research_queue.js'), 'utf8');
  assert.match(src, /seenMark/);
  assert.match(src, /QRP_PRODUCT_MILESTONE_AUTHORITY/);
  freshLedger();
  const d = desk();
  const run = (env) => spawnSync(process.execPath, [path.join(ROOT, 'apps/research-cli/import_desk_research_queue.js'), '--desk-root', d.root], { encoding: 'utf8', env: { ...process.env, ...env } });
  const noAuth = run({ QRP_PRODUCT_MILESTONE_AUTHORITY: '' });
  assert.equal(noAuth.status, 1);
  assert.match(noAuth.stderr, /TRIAL_LEDGER_AUTHORITY_NOT_CONFIGURED|REVIEW_PACK_SEEN_AUTHORITY/);
  assert.equal(packMarks().length, 0);
  const ok = run({});
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(packMarks().length, 3);
});
