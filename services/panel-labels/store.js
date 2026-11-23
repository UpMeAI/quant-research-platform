'use strict';

/**
 * The label table (contract section 7.1 LB-2, LB-6): one append-only JSONL file `labels.jsonl` in a directory that is registered as a controlled data directory of
 * the existing W20 authority layer (see reader.js). Rows are only ever appended. A matured label is never rewritten; a label that matures later is a new row.
 * The label table is written by the host side label job (materialize in index.js), never by an agent: the authority layer refuses WRITE_FILE on a controlled directory
 * to every runtime principal, and the generator process lock refuses it as well.
 * The directory is created on the first append, not when the store object is made (a locked generator process must be able to build the object and be refused on read).
 */
const fs = require('fs');
const path = require('path');
const v = require('./vocab');
const { validateLabel } = require('./label');

const FILE = 'labels.jsonl';
const keyOf = (l) => `${l.candidateId}|${l.windowId}`;
const isNumber = (x) => typeof x === 'number';

/** Append `line` (one JSON object) to `file`, creating its directory. Shared with the read ledger. */
function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(obj)}\n`;
  fs.appendFileSync(file, text);
  return Buffer.byteLength(text);
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** What a new row may do to the latest row of the same (candidate, window): never turn a value back into a gap, never change a matured value. */
function checkAgainstHead(head, next) {
  if (!head) return;
  if (head.state === 'VALUE') {
    v.need(next.state === 'VALUE', 'LABEL_APPEND_REGRESSION', keyOf(next));
    const same = head.grossReturn === next.grossReturn && head.entryAt === next.entryAt && head.exitAt === next.exitAt;
    v.need(same, 'LABEL_MATURED_VALUE_CHANGED', keyOf(next));
    for (const k of ['benchmarkReturn', 'excessReturn']) if (isNumber(head[k])) v.need(head[k] === next[k], 'LABEL_MATURED_VALUE_CHANGED', `${keyOf(next)}:${k}`);
  }
}

/** @param {{dir: string}} o */
function createStore({ dir } = {}) {
  v.need(v.isText(dir), 'LABEL_STORE_DIR_REQUIRED');
  const file = path.join(dir, FILE);
  let cache = null; // { size, rows, heads }: valid while the file keeps the size this object last saw
  const load = () => {
    if (!fs.existsSync(file)) { cache = { size: 0, rows: [], heads: new Map() }; return cache; }
    const size = fs.statSync(file).size;
    if (cache && cache.size === size) return cache;
    const rows = readLines(file);
    cache = { size, rows, heads: new Map(rows.map((r) => [keyOf(r), r])) };
    return cache;
  };
  return {
    dir, file,
    /** All rows in append order. */
    rows: () => load().rows.slice(),
    /** The latest row per `candidateId|windowId`. */
    heads: () => new Map(load().heads),
    /**
     * Validate and append. A row identical to the latest row (same labelHash) is not written again.
     * @returns {object|null} the stored row, or null when it was a repeat
     */
    append(label) {
      validateLabel(label);
      const c = load();
      const head = c.heads.get(keyOf(label));
      if (head && head.labelHash === label.labelHash) return null;
      checkAgainstHead(head, label);
      const bytes = appendLine(file, label);
      c.rows.push(label); c.heads.set(keyOf(label), label); c.size += bytes;
      return label;
    },
  };
}

module.exports = { FILE, keyOf, appendLine, readLines, createStore };
