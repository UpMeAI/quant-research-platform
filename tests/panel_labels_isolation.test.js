'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const authority = require('../services/independent-verifier/authority');
const accessLog = require('../services/independent-verifier/access-log');
const panel = require('../services/panel-labels');
const fx = require('./_panel_labels_fixture');

/**
 * W18 part 2, acceptance R-1 (contract section 7.1 LB-3, section 10 condition 3): only the evaluator can read the label table. No new permission system:
 * the label directory is registered as a controlled data directory of the existing W20 authority layer (services/independent-verifier/authority.js,
 * the same registration the holdout data dirs use), its read ledger is the W24 access log, and generator processes take the existing process lock.
 * Every refusal below comes from that layer, called with the real roles; none of them is an `if` in the label code.
 */
const ROOT = path.join(__dirname, '..');
const AUTH = 'W18_TEST_AUTHORITY';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const refusal = (fn, code) => assert.throws(fn, (e) => e instanceof authority.VerifierAuthorityError && e.code === code, code);
const EVALUATOR = authority.loadConfig().holdoutScorerPrincipal;
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;

function world() {
  const work = tmp('w18-iso-');
  const labelsDir = path.join(work, 'labels');
  const store = panel.createStore({ dir: labelsDir });
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: '600000.SH' }] });
  const provider = fx.cnProvider();
  fx.setCnW1(provider, '600000.SH', 10, 10.5);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  const ctx = { store, holdoutDirs: [labelsDir], accessLogFile: path.join(work, 'logs', 'access.jsonl'), readLedgerFile: path.join(work, 'logs', 'reads.jsonl'), registeredBy: AUTH };
  const request = (principal, extra = {}) => ({ principal, k2Ref: { id: 'K2-W18', sha256: 'a'.repeat(64) }, stage: 'SEEN', market: 'CN', families: ['W18_ISO_FAMILY'], from: '2026-11-01', to: '2026-11-30',
    windows: ['W1S'], readAt: '2026-11-05T00:00:00.000Z', panelRecords: [record], ...extra });
  return { work, labelsDir, store, record, ctx, request };
}

test('R-1 the existing authority layer refuses the generator roles and an unregistered K2 drafter on the label table, and allows the evaluator', () => {
  const w = world();
  const target = w.store.file;
  for (const principal of ['mining-generator', 'review-agent']) refusal(() => authority.authorize({ principal, action: 'READ_FILE', target }, w.ctx), 'HOLDOUT_DIR_READ_REFUSED');
  refusal(() => authority.authorize({ principal: 'k2-drafter', action: 'READ_FILE', target }, w.ctx), 'VERIFIER_PRINCIPAL_UNKNOWN');
  refusal(() => authority.authorize({ principal: 'verifier', action: 'READ_FILE', target: w.labelsDir }, w.ctx), 'HOLDOUT_DIR_READ_REFUSED');
  assert.equal(authority.authorize({ principal: EVALUATOR, action: 'READ_FILE', target }, w.ctx).allowed, true);
  // no runtime role can write the label directory either (the labels are appended by the host side label job, never by an agent)
  for (const principal of [EVALUATOR, 'mining-generator', 'review-agent', 'verifier']) refusal(() => authority.authorize({ principal, action: 'WRITE_FILE', target }, w.ctx), 'VERIFIER_WRITE_REFUSED');
});

test('R-1 readLabels goes through that layer: generator, review-agent and K2-drafter reads throw the layer error, return nothing and are logged as refused; the evaluator read returns rows and leaves one access-log row and one read-ledger row', () => {
  const w = world();
  for (const [principal, code] of [['mining-generator', 'HOLDOUT_DIR_READ_REFUSED'], ['review-agent', 'HOLDOUT_DIR_READ_REFUSED'], ['k2-drafter', 'VERIFIER_PRINCIPAL_UNKNOWN']]) {
    refusal(() => panel.readLabels(w.request(principal), w.ctx), code);
  }
  assert.equal(lines(w.ctx.readLedgerFile).length, 0, 'a refused attempt is not a read: no read record');
  const refused = lines(w.ctx.accessLogFile);
  assert.deepEqual(refused.map((r) => [r.principal, r.op, r.dataset, r.code]), [
    ['mining-generator', 'HOLDOUT_READ_REFUSED', 'PANEL_LABELS_V1', 'HOLDOUT_DIR_READ_REFUSED'],
    ['review-agent', 'HOLDOUT_READ_REFUSED', 'PANEL_LABELS_V1', 'HOLDOUT_DIR_READ_REFUSED'],
    ['k2-drafter', 'HOLDOUT_READ_REFUSED', 'PANEL_LABELS_V1', 'VERIFIER_PRINCIPAL_UNKNOWN'],
  ]);
  const out = panel.readLabels(w.request(EVALUATOR), w.ctx);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].label.state, 'VALUE');
  const log = lines(w.ctx.accessLogFile);
  assert.equal(log.length, 4);
  assert.deepEqual([log[3].principal, log[3].op, log[3].dataset, log[3].from, log[3].to], [EVALUATOR, 'READ', 'PANEL_LABELS_V1', '2026-11-01', '2026-11-30']);
  assert.equal(accessLog.verifyBytes(fs.readFileSync(w.ctx.accessLogFile)).ok, true, 'the existing hash chained access log accepts the rows');
  const reads = lines(w.ctx.readLedgerFile);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].readerRole, EVALUATOR);
  assert.equal(reads[0].rowsReturned, 1);
  panel.readLabels(w.request(EVALUATOR, { readAt: '2026-11-06T00:00:00.000Z' }), w.ctx);
  assert.equal(lines(w.ctx.readLedgerFile).length, 2, 'every read appends a read record');
});

test('R-1 fail closed: a label directory that is not registered as a controlled directory is not readable by anyone, the evaluator included', () => {
  const w = world();
  const bare = { ...w.ctx, holdoutDirs: [] };
  assert.throws(() => panel.readLabels(w.request(EVALUATOR), bare), (e) => e.code === 'LABEL_STORE_NOT_PROTECTED');
  assert.throws(() => panel.readLabels(w.request('mining-generator'), bare), (e) => e.code === 'LABEL_STORE_NOT_PROTECTED');
  assert.equal(lines(w.ctx.readLedgerFile).length, 0);
});

test('R-1 process layer: a generator launcher process cannot open the label table or write into the label directory (existing process lock, child process), and the refusal is logged', () => {
  const w = world();
  const out = path.join(w.work, 'out'); fs.mkdirSync(out);
  const logFile = path.join(out, 'access.jsonl');
  const script = `
    const fs = require('fs');
    const launcher = require('./services/independent-verifier/launcher');
    launcher.lockGenerator({ principal: 'mining-generator', allowWriteRoot: ${JSON.stringify(out)}, accessLogFile: ${JSON.stringify(logFile)}, holdoutDirs: [${JSON.stringify(w.labelsDir)}] });
    const panel = require('./services/panel-labels');
    const code = (f) => { try { f(); return 'NOT_REFUSED'; } catch (e) { return e.code || e.message; } };
    process.stdout.write(JSON.stringify({
      readFile: code(() => fs.readFileSync(${JSON.stringify(w.store.file)})),
      readdir: code(() => fs.readdirSync(${JSON.stringify(w.labelsDir)})),
      storeRows: code(() => panel.createStore({ dir: ${JSON.stringify(w.labelsDir)} }).rows()),
      append: code(() => fs.appendFileSync(${JSON.stringify(w.store.file)}, 'x')),
      writeOwn: code(() => fs.writeFileSync(${JSON.stringify(path.join(out, 'ok.json'))}, '{}')),
    }));`;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, QRP_DATA_DIR: path.join(out, 'data') }, encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { readFile: 'VERIFIER_HOLDOUT_READ_REFUSED', readdir: 'VERIFIER_HOLDOUT_READ_REFUSED', storeRows: 'VERIFIER_HOLDOUT_READ_REFUSED',
    append: 'MINE_SANDBOX_WRITE_REFUSED', writeOwn: 'NOT_REFUSED' });
  const rows = lines(logFile);
  assert.equal(rows.length >= 3 && rows.every((x) => x.op === 'HOLDOUT_READ_REFUSED'), true);
  assert.equal(fs.readFileSync(w.store.file, 'utf8').split('\n').filter(Boolean).length, 1, 'the label table is unchanged');
});
