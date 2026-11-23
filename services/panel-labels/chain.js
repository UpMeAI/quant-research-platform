'use strict';

/**
 * The hash chain of the label table (independent review P2 (b), NOTE_1 item 6), the same construction as the W24 access log: every stored line is
 * {seq, prev, label, hash}, seq counts from 1, prev is the previous line's hash (64 zeros for the first), hash = sha256(canonicalJson({seq, prev, label})).
 * Pure functions over text and objects: no file access here, so this module is no read path.
 */
const v = require('./vocab');
const { labelHashOf } = require('./label');

const ZERO = '0'.repeat(64);
const KEYS = Object.freeze(['hash', 'label', 'prev', 'seq']);
const entryHash = (seq, prev, label) => v.sha256(v.canonicalJson({ seq, prev, label }));

/** The next line of the chain after `last` (null for the first). */
function link(last, label) {
  const seq = last ? last.seq + 1 : 1;
  const prev = last ? last.hash : ZERO;
  return { seq, prev, label, hash: entryHash(seq, prev, label) };
}

/** @returns {object[]} the entries of a table text; any break (parse, keys, seq, prev, hash, label hash) is LABEL_STORE_CHAIN_BROKEN, never a partial result */
function verify(text) {
  const entries = [];
  let prev = ZERO;
  for (const line of String(text).split('\n').filter(Boolean)) {
    const broken = (why) => v.fail('LABEL_STORE_CHAIN_BROKEN', `line ${entries.length + 1}: ${why}`);
    let e;
    try { e = JSON.parse(line); } catch { return broken('not JSON'); }
    if (!v.isObj(e) || Object.keys(e).sort().join() !== KEYS.join()) return broken('keys');
    if (e.seq !== entries.length + 1) return broken('seq');
    if (e.prev !== prev) return broken('prev');
    if (!v.isObj(e.label) || e.hash !== entryHash(e.seq, e.prev, e.label)) return broken('hash');
    if (e.label.labelHash !== labelHashOf(e.label)) return broken('label hash');
    entries.push(e);
    prev = e.hash;
  }
  return entries;
}

module.exports = { ZERO, entryHash, link, verify };
