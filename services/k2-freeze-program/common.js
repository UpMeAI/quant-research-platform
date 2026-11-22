'use strict';

/**
 * Shared helpers of K2_FREEZE_PROGRAM_V1 (AUTONOMOUS_RESEARCH_QUEUE_V1 Q3). No clock, no network, no model call anywhere in this directory:
 * every decision is a function of the draft bytes and the context it is handed.
 */
const crypto = require('crypto');
const { canonicalJson } = require('../trial-ledger');

class ProgramError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new ProgramError(code, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const SHA64 = /^[0-9a-f]{64}$/;
const CST_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const isCstStamp = (v) => typeof v === 'string' && CST_STAMP.test(v) && Number.isFinite(Date.parse(v));

/** Canonical JSON with sorted keys, one space of indent, trailing newline: the byte form of every artifact the program writes. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObj(value)) return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, sortKeys(value[k])]));
  return value;
}
const prettyJson = (value) => Buffer.from(`${JSON.stringify(sortKeys(value), null, 1)}\n`);

/** Error -> reason code string ("CODE" or "CODE:detail"). */
const codeOf = (e) => (e && e.code && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code) ? (e.detail ? `${e.code}:${e.detail}` : e.code) : `PREREG_INTERNAL_ERROR:${String(e && e.message).slice(0, 120)}`);

module.exports = { ProgramError, fail, need, sha256, isObj, isText, SHA64, isCstStamp, canonicalJson, sortKeys, prettyJson, codeOf };
