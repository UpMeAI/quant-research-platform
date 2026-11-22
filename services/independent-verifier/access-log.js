'use strict';

/**
 * Access-log writer (W24, PLAN_V1_1_AMENDMENT_1 section 3; contract docs/contracts/INDEPENDENT_VERIFIER_V1.md "Access log").
 * JSONL, one row per read: { seq, principal, op: READ|HOLDOUT_READ, dataset, from, to, candidateSha256?, prev, hash }, hash = sha256(canonicalJson(row without hash)),
 * prev = the previous row's hash (first row all zeros), seq from 1. The verifier's V-2 parses it (stages.js parseAccessLog); verifyBytes reuses that parser.
 * The extra key `code` of a HOLDOUT_READ_REFUSED row is inside the hash. No clock: a row says what was read, not when.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('../trial-ledger');

const ZERO = '0'.repeat(64);
/** HOLDOUT_READ_REFUSED (plan-coord ruling 11-23): a read the lock refused. Unknown, refused and read stay distinct; a refused attempt is an incident, not a read. */
const OPS = Object.freeze(['READ', 'HOLDOUT_READ', 'HOLDOUT_READ_REFUSED']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class AccessLogError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const bad = (detail) => { throw new AccessLogError('ACCESS_LOG_ROW_INVALID', detail); };

function checkRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) bad('not an object');
  if (typeof row.principal !== 'string' || !row.principal) bad('principal');
  if (!OPS.includes(row.op)) bad(`op:${row.op}`);
  if (typeof row.dataset !== 'string' || !row.dataset) bad('dataset');
  if (!DATE.test(row.from || '') || !DATE.test(row.to || '') || row.from > row.to) bad(`range:${row.from}..${row.to}`);
  if ('candidateSha256' in row && !SHA64.test(row.candidateSha256 || '')) bad('candidateSha256');
  for (const k of ['seq', 'prev', 'hash']) if (k in row) bad(`reserved key ${k}`);
  return row;
}

function lastRow(file) {
  if (!fs.existsSync(file)) return null;
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return rows.length ? JSON.parse(rows[rows.length - 1]) : null;
}

/** Append one row to `file`, continuing the chain already there. */
function appendRow(file, row) {
  checkRow(row);
  const last = lastRow(file);
  const body = { seq: last ? last.seq + 1 : 1, ...row, prev: last ? last.hash : ZERO };
  const out = { ...body, hash: sha(canonicalJson(body)) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(out)}\n`);
  return out;
}

const writer = (file) => ({ file, record: (row) => appendRow(file, row) });

/** A writer whose file is not known yet (the round id comes after the first panel read): rows are validated and buffered, then flushed in order by bind(). */
function deferred() {
  const buffer = []; let bound = null;
  return {
    get file() { return bound; },
    record(row) { if (bound) return appendRow(bound, row); checkRow(row); buffer.push({ ...row }); return null; },
    bind(file) {
      if (bound) throw new AccessLogError('ACCESS_LOG_ALREADY_BOUND', bound);
      bound = file;
      for (const r of buffer.splice(0)) appendRow(file, r);
      return file;
    },
  };
}

/** The frozen candidate's identity in the holdout grant ledger and the access log: a pure function of round, candidate and canonical formula. */
const candidateSha256Of = ({ roundId, candidateId, formula }) => sha(canonicalJson({ schema: 'LAB_CANDIDATE_V1', round_id: roundId, candidate_id: candidateId, formula }));

/** Chain check by the verifier's own parser (loaded lazily: it pulls every gate V-1..V-6). */
function verifyBytes(bytes) {
  try { return { ok: true, rows: require('./stages').internals.parseAccessLog(bytes) }; } catch (e) { return { ok: false, code: e.code || 'ACCESS_LOG_INVALID' }; }
}

module.exports = { ZERO, OPS, AccessLogError, appendRow, writer, deferred, candidateSha256Of, verifyBytes };
