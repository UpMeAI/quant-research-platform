'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { contentHash } = require('../services/desk-review-routing/canonical');
const { executeDaily, parseArgs, cstDate } = require('../services/ai-review/daily-command');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q70-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const args = ['--inbox', path.join(dir, 'inbox'), '--desk-root', path.join(dir, 'desk'), '--output-root', path.join(dir, 'reports'), '--date', '2026-11-12'];
  return { dir, args };
}
test('daily CLI validates dates/arguments and uses CST date across UTC rollover', () => {
  assert.equal(cstDate(new Date('2026-11-12T16:01:00Z')), '2026-11-13');
  for (const args of [[], ['--unknown', 'x'], ['--inbox', 'relative', '--desk-root', '/desk'], ['--inbox', '/in', '--desk-root', '/desk', '--date', '2026-02-30'], ['--inbox', '/in', '--desk-root', '/desk', '--date', '2026-11-12', '--date', '2026-11-13']]) assert.throws(() => parseArgs(args), /DAILY_ARGUMENTS_INVALID/);
});
test('daily command delivers seven off reports, coverage manifest and no facts on stdout summary', async t => {
  const { args, dir } = setup(t); let calls = 0;
  const summary = await executeDaily({ argv: args, env: {}, fetchFn: async () => { calls++; throw Error('forbidden'); } });
  assert.equal(summary.completeDailyReady, false); assert.equal(summary.validatorState, 'UNAVAILABLE');
  assert.equal(summary.budgetConfigured, false); assert.equal(summary.ledgers.length, 7);
  assert.ok(summary.ledgers.every(r => r.status === 'DISABLED'));
  assert.equal(calls, 0); assert.equal(JSON.stringify(summary).includes('facts'), false);
  assert.equal(JSON.parse(fs.readFileSync(summary.manifestFile)).completeDailyReady, false);
  assert.equal(fs.existsSync(path.join(dir, 'reports', 'usage.jsonl')), false);
});
test('enabled CLI cannot call model for incomplete daily coverage, even with budget and synthetic validator', async t => {
  const { args, dir } = setup(t); let calls = 0;
  const ledgerId = 'US_V5_ETF_3000USD', period = '2026-11-12';
  const common = { market: 'US', currency: 'USD', sessionDate: period, schemaVersion: 1, producer: 'SMARTFLOW_US', ledgerId };
  const fixtures = [
    [`SMARTFLOW_US/trades/${ledgerId}/TRADE_LEDGER_${period}.json`, { ...common, events: [], unknown: null }],
    [`SMARTFLOW_US/ledger/${ledgerId}/BOOK_NAV_SERIES_${ledgerId}_${period}.json`, { ...common, contract: 'BOOK_NAV_SERIES_V1', partId: null }],
    [`SMARTFLOW_US/review/US/REVIEW_DECOMPOSITION_V2_${period}.json`, { ...common, schemaVersion: 2, producer: 'SMARTFLOW', lossAttribution: { plan: 'synthetic', accountBasis: 'synthetic', books: [{ ledgerId, ruleVersion: { state: 'UNKNOWN' } }] } }],
  ];
  for (const [relative, doc] of fixtures) {
    doc.hash = contentHash(doc); const file = path.join(dir, 'inbox', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc));
  }
  const summary = await executeDaily({ argv: args, env: { AI_REVIEW_ENABLED: '1', AI_REVIEW_TOKENS_PER_CALL: '10000', AI_REVIEW_TOKENS_PER_DAY: '50000', AI_REVIEW_TOKENS_PER_MONTH: '100000' }, validateContract: () => ({ ok: true }), fetchFn: async () => { calls++; throw Error('forbidden'); } });
  assert.equal(summary.budgetConfigured, true); assert.equal(summary.completeDailyReady, false);
  assert.equal(summary.ledgers.find(r => r.ledger === ledgerId).sliceInputState, 'READY');
  assert.ok(summary.ledgers.every(r => r.status === 'INPUT_MISSING'));
  assert.equal(calls, 0);
  const noBudget = await executeDaily({ argv: args, env: { AI_REVIEW_ENABLED: '1' }, validateContract: () => ({ ok: true }), fetchFn: async () => { calls++; throw Error('forbidden'); } });
  assert.equal(noBudget.budgetConfigured, false); assert.equal(calls, 0);
});
test('daily CLI subprocess emits JSON summary and masks provider/loader errors', t => {
  const { args } = setup(t);
  const cli = path.join(__dirname, '../apps/research-cli/ai_review_daily.js');
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, AI_REVIEW_ENABLED: '0' } });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).ledgers.length, 7); assert.equal(result.stderr, '');
  const invalid = spawnSync(process.execPath, [cli, '--date', 'secret-example'], { encoding: 'utf8' });
  assert.equal(invalid.status, 64); assert.equal(invalid.stderr.trim(), 'DAILY_ARGUMENTS_INVALID');
});
test('daily launchd template is disabled, has both DST twins and no installation or secrets', () => {
  const file = path.join(__dirname, '../ops/ai-review/com.upmeai.qrp-ai-review-daily.plist.example');
  const parsed = spawnSync('python3', ['-c', 'import plistlib,json,sys;print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', file], { encoding: 'utf8' });
  assert.equal(parsed.status, 0); const plist = JSON.parse(parsed.stdout);
  assert.equal(plist.Disabled, true); assert.equal(plist.RunAtLoad, false); assert.equal(plist.KeepAlive, undefined);
  assert.deepEqual(plist.StartCalendarInterval, [{ Hour: 6, Minute: 40 }, { Hour: 7, Minute: 40 }]);
  assert.ok(plist.ProgramArguments.includes('22:40')); assert.ok(plist.ProgramArguments.includes('60'));
  assert.deepEqual(plist.EnvironmentVariables, { AI_REVIEW_ENABLED: '0' });
  for (const stamp of ['2026-01-12T14:40:00Z', '2026-07-12T14:40:00Z']) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(stamp));
    assert.ok(['06:40', '07:40'].includes(parts));
  }
});
