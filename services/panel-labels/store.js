'use strict';

/**
 * The label table (contract section 7.1 LB-2, LB-6): one append-only JSONL file `labels.jsonl` in a directory that is registered as a controlled data directory of
 * the existing W20 authority layer (see reader.js). Every line is a link of a hash chain (chain.js); rows are only ever appended. A matured label is never rewritten;
 * a label that matures later is a new row. The file is created 0600 in a directory created 0700.
 * The store object offers `append` and nothing that reads: the table is read only through readLabels (reader.js), after the authority call. `append` has to look at
 * the table to continue the chain and to check a new row against the latest row of its (candidate, window); that look is private to this module and verifies the chain.
 * This version has no label writing job (no real price source, no schedule): the store is the validated, chained write side for it. The directory is created on the first
 * append, not when the store object is made (a locked generator process can build the object and is refused on any read or write).
 */
const fs = require('fs');
const path = require('path');
const v = require('./vocab');
const chain = require('./chain');
const { validateLabel } = require('./label');

const FILE = 'labels.jsonl';
const keyOf = (l) => `${l.candidateId}|${l.windowId}`;
const isNumber = (x) => typeof x === 'number';

/** Append one JSON line to `file`: a new file is 0600, a new directory 0700. Shared with the read ledger. @returns {number} bytes written */
function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(obj)}\n`;
  fs.appendFileSync(file, text, { mode: 0o600 });
  return Buffer.byteLength(text);
}

/** What a new row may do to the latest row of the same (candidate, window): never turn a value back into a gap, never change a matured value. */
function checkAgainstHead(head, next) {
  if (!head || head.state !== 'VALUE') return;
  v.need(next.state === 'VALUE', 'LABEL_APPEND_REGRESSION', keyOf(next));
  v.need(head.grossReturn === next.grossReturn && head.entryAt === next.entryAt && head.exitAt === next.exitAt, 'LABEL_MATURED_VALUE_CHANGED', keyOf(next));
  for (const k of ['benchmarkReturn', 'excessReturn']) if (isNumber(head[k])) v.need(head[k] === next[k], 'LABEL_MATURED_VALUE_CHANGED', `${keyOf(next)}:${k}`);
}

/** @param {{dir: string}} o */
function createStore({ dir } = {}) {
  v.need(v.isText(dir), 'LABEL_STORE_DIR_REQUIRED');
  const file = path.join(dir, FILE);
  let cache = null; // { size, last, heads }: valid while the file keeps the size this object last saw
  const state = () => {
    if (!fs.existsSync(file)) { cache = { size: 0, last: null, heads: new Map() }; return cache; }
    const size = fs.statSync(file).size;
    if (cache && cache.size === size) return cache;
    const entries = chain.verify(fs.readFileSync(file, 'utf8'));
    cache = { size, last: entries[entries.length - 1] || null, heads: new Map(entries.map((e) => [keyOf(e.label), e.label])) };
    return cache;
  };
  return {
    dir, file,
    /**
     * Validate and append. A row identical to the latest row (same labelHash) is not written again.
     * @returns {object|null} the stored label, or null when it was a repeat
     */
    append(label) {
      validateLabel(label);
      const c = state();
      const head = c.heads.get(keyOf(label));
      if (head && head.labelHash === label.labelHash) return null;
      checkAgainstHead(head, label);
      const entry = chain.link(c.last, label);
      const bytes = appendLine(file, entry);
      c.size += bytes; c.last = entry; c.heads.set(keyOf(label), label);
      return label;
    },
  };
}

module.exports = { FILE, appendLine, createStore };
