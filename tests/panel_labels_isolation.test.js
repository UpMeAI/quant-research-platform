'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const authority = require('../services/independent-verifier/authority');
const accessLog = require('../services/independent-verifier/access-log');
const panel = require('../services/panel-labels');
const fx = require('./_panel_labels_fixture');

/**
 * W18 part 2, acceptance R-1 (contract section 7.1 LB-3, section 10 condition 3): only the evaluator can read the label table. No new permission system:
 * the label directory is registered as a controlled data directory of the existing W20 authority layer (services/independent-verifier/authority.js) through the host
 * list QRP_HOLDOUT_DATA_DIRS, the same list the generator process lock reads; its read ledger is the W24 access log. Every refusal below comes from that layer,
 * called with the real roles; none of them is an `if` in the label code. Review fix round P2 (a): the caller's context cannot name the protected directories or the config.
 */
const ROOT = path.join(__dirname, '..');
const { EVALUATOR } = fx;
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const refusal = (fn, code) => assert.throws(fn, (e) => e instanceof authority.VerifierAuthorityError && e.code === code, code);
let n = 0;

function world() {
  const work = fx.tmp('w18-iso-');
  const labelsDir = path.join(work, 'labels');
  const store = panel.createStore({ dir: labelsDir });
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: '600000.SH' }] });
  const provider = fx.cnProvider();
  fx.setCnW1(provider, '600000.SH', 10, 10.5);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  n += 1;
  const family = `W18_ISO_FAMILY_${process.pid}_${n}`;
  fx.bind(family);
  const ctx = fx.ctxFor(store);
  return { work, labelsDir, store, record, family, ctx, request: (principal, extra = {}) => fx.request(family, [record], { principal, ...extra }) };
}

test('R-1 the existing authority layer refuses the generator roles and an unregistered K2 drafter on the label table, and allows the evaluator', () => {
  const w = world();
  const target = w.store.file;
  const layerCtx = { holdoutDirs: [w.labelsDir] };
  for (const principal of ['mining-generator', 'review-agent']) refusal(() => authority.authorize({ principal, action: 'READ_FILE', target }, layerCtx), 'HOLDOUT_DIR_READ_REFUSED');
  refusal(() => authority.authorize({ principal: 'k2-drafter', action: 'READ_FILE', target }, layerCtx), 'VERIFIER_PRINCIPAL_UNKNOWN');
  refusal(() => authority.authorize({ principal: 'verifier', action: 'READ_FILE', target: w.labelsDir }, layerCtx), 'HOLDOUT_DIR_READ_REFUSED');
  assert.equal(authority.authorize({ principal: EVALUATOR, action: 'READ_FILE', target }, layerCtx).allowed, true);
  // no runtime role can write the label directory either (the labels are appended by the host side label job, never by an agent)
  for (const principal of [EVALUATOR, 'mining-generator', 'review-agent', 'verifier']) refusal(() => authority.authorize({ principal, action: 'WRITE_FILE', target }, layerCtx), 'VERIFIER_WRITE_REFUSED');
});

test('R-1 readLabels goes through that layer: generator, review-agent and K2-drafter reads throw the layer error, return nothing and are logged as refused; the evaluator read returns rows and leaves one access-log row and one read-ledger row', () => {
  const w = world();
  for (const [principal, code] of [['mining-generator', 'HOLDOUT_DIR_READ_REFUSED'], ['review-agent', 'HOLDOUT_DIR_READ_REFUSED'], ['k2-drafter', 'VERIFIER_PRINCIPAL_UNKNOWN']]) {
    refusal(() => panel.readLabels(w.request(principal), w.ctx), code);
  }
  assert.equal(lines(w.ctx.readLedgerFile).length, 0, 'a refused attempt is not a read: no read record');
  assert.deepEqual(lines(w.ctx.accessLogFile).map((r) => [r.principal, r.op, r.dataset, r.code]), [
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
  panel.readLabels(w.request(EVALUATOR), { ...w.ctx, now: () => '2027-01-01T00:00:00.000Z' });
  assert.equal(lines(w.ctx.readLedgerFile).length, 2, 'every read appends a read record');
});

test('R-1 fail closed: a label directory that is not on the host list is not readable by anyone, the evaluator included, and the caller cannot list it in the context (holdoutDirs of "/" does not satisfy it)', () => {
  const w = world();
  const unlisted = panel.createStore({ dir: path.join(fx.tmp('w18-unlisted-'), 'labels') });
  fs.mkdirSync(unlisted.dir, { recursive: true });
  const base = { store: unlisted, accessLogFile: w.ctx.accessLogFile, readLedgerFile: w.ctx.readLedgerFile, registeredBy: fx.AUTH, k2Bytes: fx.k2Bytes, now: () => fx.NOW };
  for (const extra of [{}, { holdoutDirs: ['/'] }, { holdoutDirs: [unlisted.dir] }, { holdoutDirs: [path.dirname(unlisted.dir)] }]) {
    for (const principal of [EVALUATOR, 'mining-generator']) {
      assert.throws(() => panel.readLabels(w.request(principal), { ...base, ...extra }), (e) => e.code === 'LABEL_STORE_NOT_PROTECTED', JSON.stringify(extra));
    }
  }
  assert.equal(lines(w.ctx.readLedgerFile).length, 0);
});

test('R-1 the caller cannot swap the authority config: a forged ctx.config that makes the generator the trusted reader changes nothing', () => {
  const w = world();
  const forged = { ...authority.loadConfig(), holdoutScorerPrincipal: 'mining-generator', trustedPrincipals: ['mining-generator'], generatorPrincipals: [] };
  refusal(() => panel.readLabels(w.request('mining-generator'), { ...w.ctx, config: forged }), 'HOLDOUT_DIR_READ_REFUSED');
  refusal(() => panel.readLabels(w.request('mining-generator'), { ...w.ctx, repoRoot: '/', ledgerFile: '/dev/null' }), 'HOLDOUT_DIR_READ_REFUSED');
  assert.equal(panel.readLabels(w.request(EVALUATOR), { ...w.ctx, config: forged }).rows.length, 1, 'the evaluator is still the evaluator');
});

test('R-1 process layer: a generator launcher process (host list only, no directory argument) cannot open the label table, cannot write into the label directory, and cannot read it with the evaluator role either (existing process lock, child process); refusals are logged', () => {
  const w = world();
  const out = path.join(w.work, 'out'); fs.mkdirSync(out);
  const logFile = path.join(out, 'access.jsonl');
  const k2Text = fx.k2Bytes(fx.COORD).toString('utf8');
  const script = `
    const fs = require('fs');
    const launcher = require('./services/independent-verifier/launcher');
    launcher.lockGenerator({ principal: 'mining-generator', allowWriteRoot: ${JSON.stringify(out)}, accessLogFile: ${JSON.stringify(logFile)} });
    const panel = require('./services/panel-labels');
    const record = ${JSON.stringify(w.record)};
    const ctx = { store: panel.createStore({ dir: ${JSON.stringify(w.labelsDir)} }), accessLogFile: ${JSON.stringify(logFile)}, readLedgerFile: ${JSON.stringify(path.join(out, 'reads.jsonl'))},
      registeredBy: 'x', k2Bytes: () => Buffer.from(${JSON.stringify(k2Text)}), now: () => '2026-12-31T00:00:00.000Z' };
    const req = (principal) => ({ principal, k2Ref: { id: 'K2-COORD', sha256: ${JSON.stringify(fx.COORD.sha256)} }, stage: 'SEEN', market: 'CN', families: [${JSON.stringify(w.family)}],
      from: '2026-11-01', to: '2026-11-30', windows: ['W1S'], panelRecords: [record] });
    const code = (f) => { try { f(); return 'NOT_REFUSED'; } catch (e) { return e.code || e.message; } };
    process.stdout.write(JSON.stringify({
      readFile: code(() => fs.readFileSync(${JSON.stringify(w.store.file)})),
      readdir: code(() => fs.readdirSync(${JSON.stringify(w.labelsDir)})),
      generatorRead: code(() => panel.readLabels(req('mining-generator'), ctx)),
      evaluatorRoleInLockedProcess: code(() => panel.readLabels(req(${JSON.stringify(EVALUATOR)}), ctx)),
      append: code(() => fs.appendFileSync(${JSON.stringify(w.store.file)}, 'x')),
      writeOwn: code(() => fs.writeFileSync(${JSON.stringify(path.join(out, 'ok.json'))}, '{}')),
    }));`;
  const env = { ...process.env, QRP_DATA_DIR: process.env.QRP_DATA_DIR, QRP_HOLDOUT_DATA_DIRS: w.labelsDir };
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { readFile: 'VERIFIER_HOLDOUT_READ_REFUSED', readdir: 'VERIFIER_HOLDOUT_READ_REFUSED', generatorRead: 'HOLDOUT_DIR_READ_REFUSED',
    evaluatorRoleInLockedProcess: 'VERIFIER_HOLDOUT_READ_REFUSED', append: 'MINE_SANDBOX_WRITE_REFUSED', writeOwn: 'NOT_REFUSED' });
  const rows = lines(logFile);
  assert.equal(rows.length >= 4 && rows.every((x) => x.op === 'HOLDOUT_READ_REFUSED'), true);
  assert.equal(lines(w.store.file).length, 1, 'the label table is unchanged');
});

test('no ungated read path in the package: reading the table (fs read of the label file) happens only in reader.js, after the authority call; store.js exports nothing that reads', () => {
  const dir = path.join(ROOT, 'services', 'panel-labels');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !['reader.js', 'store.js', 'static-scan.js'].includes(x))) {
    assert.equal(/\bfs\.(readFile|readdir|openSync|createReadStream)/.test(fs.readFileSync(path.join(dir, f), 'utf8')), false, `${f} reads no file`);
  }
  assert.equal(Object.keys(require('../services/panel-labels/store')).some((k) => /read|rows|heads|load|entries/i.test(k)), false);
  const reader = fs.readFileSync(path.join(dir, 'reader.js'), 'utf8');
  const body = reader.slice(reader.indexOf('function readLabels('));
  assert.ok(body.indexOf('authority.authorize(') > 0 && body.indexOf('authority.authorize(') < body.indexOf('loadTable('), 'in readLabels the authority call comes before the table load');
  assert.equal(reader.split('readFileSync(').length - 1, 1, 'one file read in reader.js, inside loadTable');
});
