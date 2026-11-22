'use strict';
/** File contract of the promotion engine: terms and stage evidence named by sha256, byte-identical result files. */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../services/promotion-engine');
const fx = require('./_promotion_fixture');

function stage(dir, name, verdict, extra = {}) {
  const t = fx.terms();
  const ev = fx.evidence(name, verdict, { terms: t, insufficient: verdict === 'INSUFFICIENT' ? fx.insuff() : null });
  const bytes = Buffer.from(JSON.stringify(ev));
  fs.writeFileSync(path.join(dir, `${name}.json`), bytes);
  return { path: `${name}.json`, sha256: fx.sha(bytes), ...extra };
}

function setup(verdict = 'PASS', name = 'S2') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-'));
  const ref = stage(dir, name, verdict);
  const t = fx.terms({ stage_evidence: { [name]: ref } });
  fs.writeFileSync(path.join(dir, 'terms.json'), JSON.stringify(t));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(fx.historyBefore(name)));
  return { dir, termsPath: path.join(dir, 'terms.json'), historyPath: path.join(dir, 'history.json'), t };
}

test('evaluateFromFiles reads the evidence the K2 terms name and verifies each sha256', () => {
  const s = setup();
  const out = engine.evaluateFromFiles({ termsPath: s.termsPath, stage: 'S2', historyPath: s.historyPath, asOf: fx.AS_OF });
  assert.equal(out.verdict, 'PASS');
  assert.match(out.inputs.terms_sha256, /^[0-9a-f]{64}$/);
  assert.match(out.inputs.evidence_sha256, /^[0-9a-f]{64}$/);
});

test('a tampered evidence file is INVALID_INPUT', () => {
  const s = setup();
  fs.appendFileSync(path.join(s.dir, 'S2.json'), ' ');
  const out = engine.evaluateFromFiles({ termsPath: s.termsPath, stage: 'S2', historyPath: s.historyPath, asOf: fx.AS_OF });
  assert.equal(out.verdict, 'INVALID_INPUT');
  assert.ok(out.reasonCodes.includes('PROMOTION_EVIDENCE_SHA_MISMATCH:S2'));
});

test('a stage the K2 does not name, a missing file and a path escape are INVALID_INPUT', () => {
  const s = setup();
  assert.ok(engine.evaluateFromFiles({ termsPath: s.termsPath, stage: 'S3', historyPath: s.historyPath, asOf: fx.AS_OF }).reasonCodes.includes('PROMOTION_EVIDENCE_NOT_NAMED:S3'));
  fs.unlinkSync(path.join(s.dir, 'S2.json'));
  assert.ok(engine.evaluateFromFiles({ termsPath: s.termsPath, stage: 'S2', historyPath: s.historyPath, asOf: fx.AS_OF }).reasonCodes.includes('PROMOTION_EVIDENCE_UNREADABLE:S2'));
  const t = JSON.parse(fs.readFileSync(s.termsPath)); t.stage_evidence.S2.path = '../escape.json';
  fs.writeFileSync(s.termsPath, JSON.stringify(t));
  assert.ok(engine.evaluateFromFiles({ termsPath: s.termsPath, stage: 'S2', historyPath: s.historyPath, asOf: fx.AS_OF }).reasonCodes.includes('PROMOTION_EVIDENCE_PATH_INVALID:S2'));
});

test('result file bytes are identical across runs and the output sha is over the body', () => {
  const s = setup();
  const a = engine.render(engine.evaluateFromFiles({ termsPath: s.termsPath, stage: 'S2', historyPath: s.historyPath, asOf: fx.AS_OF }));
  const b = engine.render(engine.evaluateFromFiles({ termsPath: s.termsPath, stage: 'S2', historyPath: s.historyPath, asOf: fx.AS_OF }));
  assert.equal(a.compare(b), 0);
  const parsed = JSON.parse(a);
  const { output_sha256: sha, ...body } = parsed;
  assert.equal(sha, engine.outputSha256(body));
});

test('missing or non-CST as_of is INVALID_INPUT: the engine reads no clock', () => {
  const s = setup();
  for (const asOf of [undefined, '2026-12-01', '2026-12-01T10:00:00Z']) {
    const out = engine.evaluateFromFiles({ termsPath: s.termsPath, stage: 'S2', historyPath: s.historyPath, asOf });
    assert.equal(out.verdict, 'INVALID_INPUT');
    assert.ok(out.reasonCodes.includes('PROMOTION_AS_OF_INVALID'));
  }
});

test('terms structure is validated: unknown market, layer and extra keys', () => {
  const r = (over) => engine.evaluate(fx.request('S2', 'PASS', { terms: fx.terms(over) }));
  assert.ok(r({ market: 'MARS' }).reasonCodes.includes('PROMOTION_TERMS_ENUM:market'));
  assert.ok(r({ layer: 'VIBES' }).reasonCodes.includes('PROMOTION_TERMS_ENUM:layer'));
  assert.ok(r({ surprise: 1 }).reasonCodes.includes('PROMOTION_TERMS_EXTRA_KEY:surprise'));
  assert.equal(r({ market: 'US_EQUITY' }).verdict, 'PASS');
});

test('the engine reads no clock and no network: source has no Date.now / new Date() / http', () => {
  const dir = path.join(__dirname, '..', 'services', 'promotion-engine');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/Date\.now\(|new Date\(\)|require\('(https?|net|child_process)'\)/.test(src), f);
  }
});

test('terms must be bound to their K2 and frozen with it: PROMOTION_TERMS_NOT_BOUND (ruling 11-23 (1))', () => {
  const run = (t) => engine.evaluate(fx.request('S2', 'PASS', { terms: t }));
  assert.equal(run(fx.terms()).verdict, 'PASS'); // same instant as the K2: bound
  assert.equal(run(fx.terms({ terms_frozen_at: '2026-11-24T09:59:59+08:00' })).verdict, 'PASS'); // before the K2
  const after = run(fx.terms({ terms_frozen_at: '2026-11-24T10:00:01+08:00' })); // one second after the K2
  assert.equal(after.verdict, 'INVALID_INPUT');
  assert.deepEqual(after.reasonCodes, ['PROMOTION_TERMS_NOT_BOUND']);
  const noSha = fx.terms(); delete noSha.k2_sha256;
  assert.ok(run(noSha).reasonCodes.includes('PROMOTION_TERMS_NOT_BOUND'));
  const noStamp = fx.terms(); delete noStamp.terms_frozen_at;
  assert.ok(run(noStamp).reasonCodes.includes('PROMOTION_TERMS_NOT_BOUND'));
  assert.ok(run(fx.terms({ k2_sha256: 'xyz' })).reasonCodes.includes('PROMOTION_TERMS_NOT_BOUND'));
});

