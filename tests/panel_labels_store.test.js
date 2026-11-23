'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const panel = require('../services/panel-labels');
const fx = require('./_panel_labels_fixture');

/**
 * W18 part 2, independent review fix round, P2 (b) (NOTE_1 item 6): the label table has no writer job in this version, so the write side ships validation and a hash chain.
 * Every stored line is {seq, prev, label, hash} with hash = sha256(canonicalJson({seq, prev, label})), the first prev is 64 zeros (the access log's chain); a broken chain
 * makes the controlled read refuse (LABEL_STORE_CHAIN_BROKEN) before anything is recorded or returned. The file is created 0600 in a directory created 0700.
 */
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, code);
const ZERO = '0'.repeat(64);
let n = 0;

function world() {
  const record = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T07:30:00.000Z', candidates: [{ securityId: '600001.SH' }, { securityId: '600002.SH' }, { securityId: '600003.SH' }] });
  const provider = fx.cnProvider();
  for (const s of ['600001.SH', '600002.SH', '600003.SH']) fx.setCnW1(provider, s, 10, 10.5);
  fx.setCnW1(provider, 'CSI300', 4000, 4040);
  const store = panel.createStore({ dir: path.join(fx.tmp('w18-store-'), 'labels') });
  panel.materialize({ records: [record], windows: ['W1S'], provider, store, now: '2026-11-04T00:00:00.000Z' });
  n += 1;
  const family = `W18_STORE_FAMILY_${process.pid}_${n}`;
  fx.bind(family);
  const ctx = fx.ctxFor(store);
  return { record, store, ctx, read: () => panel.readLabels(fx.request(family, [record]), ctx) };
}
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

test('every stored line is a link of the hash chain: seq from 1, prev is the previous hash (zeros first), hash covers seq, prev and the label', () => {
  const w = world();
  const entries = lines(w.store.file).map((l) => JSON.parse(l));
  assert.equal(entries.length, 3);
  let prev = ZERO;
  entries.forEach((e, i) => {
    assert.deepEqual(Object.keys(e).sort(), ['hash', 'label', 'prev', 'seq']);
    assert.equal(e.seq, i + 1);
    assert.equal(e.prev, prev);
    assert.equal(e.hash, fx.sha(panel.vocab.canonicalJson({ seq: e.seq, prev: e.prev, label: e.label })));
    prev = e.hash;
  });
  assert.equal(w.read().rows.length, 3, 'an intact chain reads');
  // a second store object on the same directory continues the chain
  const again = panel.createStore({ dir: w.store.dir });
  const rec2 = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T08:00:00.000Z', candidates: [{ securityId: '600001.SH' }] });
  const p2 = fx.cnProvider(); fx.setCnW1(p2, '600001.SH', 10, 10.5); fx.setCnW1(p2, 'CSI300', 4000, 4040);
  panel.materialize({ records: [rec2], windows: ['W1S'], provider: p2, store: again, now: '2026-11-04T00:00:00.000Z' });
  const all = lines(w.store.file).map((l) => JSON.parse(l));
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(all[3].prev, all[2].hash);
});

test('a broken chain refuses the read before anything is recorded: an edited label, a removed or swapped line, a partial line, a consistent rewrite of one line', () => {
  const cases = {
    'edited label under its hash': (ls) => { const e = JSON.parse(ls[1]); e.label.grossReturn = 0.5; ls[1] = JSON.stringify(e); return ls; },
    'first line removed': (ls) => ls.slice(1),
    'middle line removed': (ls) => [ls[0], ls[2]],
    'two lines swapped': (ls) => [ls[1], ls[0], ls[2]],
    'partial last line': (ls) => [...ls, '{"seq":4,"prev":"'],
    'one line rewritten with its own hash recomputed': (ls) => {
      const e = JSON.parse(ls[0]); e.label.grossReturn = 0.5; e.hash = fx.sha(panel.vocab.canonicalJson({ seq: e.seq, prev: e.prev, label: e.label })); ls[0] = JSON.stringify(e); return ls;
    },
    'line with a foreign key': (ls) => { const e = JSON.parse(ls[2]); e.extra = 1; ls[2] = JSON.stringify(e); return ls; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const w = world();
    fs.writeFileSync(w.store.file, `${mutate(lines(w.store.file)).join('\n')}\n`);
    refuses(() => w.read(), 'LABEL_STORE_CHAIN_BROKEN');
    assert.equal(fs.existsSync(w.ctx.readLedgerFile), false, `${name}: no read record for a read that was refused`);
  }
});

test('the label file is created 0600 in a directory created 0700; the read ledger is 0600', () => {
  const w = world();
  assert.equal(fs.statSync(w.store.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(w.store.dir).mode & 0o777, 0o700);
  w.read();
  assert.equal(fs.statSync(w.ctx.readLedgerFile).mode & 0o777, 0o600);
});

test('a store that finds a broken chain refuses to append (it will not extend a table it cannot verify)', () => {
  const w = world();
  const ls = lines(w.store.file);
  fs.writeFileSync(w.store.file, `${[ls[0], ls[2]].join('\n')}\n`);
  const again = panel.createStore({ dir: w.store.dir });
  const rec2 = fx.panelRecord({ sessionDate: '2026-11-02', evaluatedAt: '2026-11-02T08:00:00.000Z', candidates: [{ securityId: '600001.SH' }] });
  const p2 = fx.cnProvider(); fx.setCnW1(p2, '600001.SH', 10, 10.5);
  refuses(() => panel.materialize({ records: [rec2], windows: ['W1S'], provider: p2, store: again, now: '2026-11-04T00:00:00.000Z' }), 'LABEL_STORE_CHAIN_BROKEN');
  assert.equal(lines(w.store.file).length, 2);
});
