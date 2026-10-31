'use strict';

// metric-conformance-harness -- the same file in all four repositories (portfolio-desk, Ashare-V6, smartflow,
// quant-research-platform). Each repository's test pins the sha256 of this file, of metric-reference.js and of the
// fixture, so the three cannot drift apart without a test saying so.
//
// A repository registers the implementations it already has. Each adapter takes one fixture case and returns the metrics
// that implementation can state for it, under the contract's names. The harness compares them with the fixture's
// `expected` block and sorts every comparison into one of three places:
//
//   CONFORMS    the same number (relative 1e-9 by default);
//   KNOWN       a different number that the repository's `KNOWN_DIFFERENCES` records, with a defect id and the value
//               observed -- a defect to report, not a failure of the build, and not to be fixed in this task;
//   UNEXPECTED  anything else: a new difference, a changed difference, or a recorded difference that has since been
//               fixed (the record is stale and must go).
//
// Only UNEXPECTED fails a test. Production code is never changed to make a comparison pass.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Pinned hashes of the vendored files; returns the mismatches (empty when all three match). */
function pinProblems(pins) {
  return Object.entries(pins).filter(([file, sha]) => !fs.existsSync(file) || sha256File(file) !== sha)
    .map(([file, sha]) => `${path.basename(file)} expected ${sha.slice(0, 12)}...`);
}

function same(actual, expected, tolerance) {
  if (typeof expected === 'boolean' || typeof expected === 'string') return actual === expected;
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (!finite(actual) || !finite(expected)) return false;
  return Math.abs(actual - expected) <= Math.max(tolerance.absolute, tolerance.relative * Math.max(Math.abs(actual), Math.abs(expected)));
}

/** Flatten the expected block of a case into { metric: scalar }, ci95 into ci95_lo / ci95_hi, costTotals into costTotal*. */
function expectedOf(c) {
  const e = c.expected;
  const out = {};
  for (const [key, value] of Object.entries(e)) {
    if (key === 'drawdownSeries') continue;
    if (key === 'ci95') { out.ci95_lo = value ? value[0] : null; out.ci95_hi = value ? value[1] : null; continue; }
    if (key === 'costTotals') { out.costKnownSum = value.knownSum; out.costUnknownDays = value.unknownDays; out.costTotal = value.total; out.costState = value.state; continue; }
    out[key] = value;
  }
  return out;
}

/**
 * @param fixture    the parsed fixture
 * @param impls      [{ id, source, series?: (case) => metrics|null, paired?: (case) => metrics|null }]
 * @returns rows [{ impl, caseId, metric, expected, actual, equal }]
 */
function compareAll(fixture, impls) {
  const tolerance = fixture.tolerance;
  const rows = [];
  const push = (impl, c, produced) => {
    if (!produced) return;
    const expected = expectedOf(c);
    for (const [metric, actual] of Object.entries(produced)) {
      if (metric === '__threw') { rows.push({ impl: impl.id, caseId: c.id, metric: 'threw', expected: 'a value', actual, equal: false }); continue; }
      if (!(metric in expected)) throw new Error(`${impl.id} returned ${metric}, which the contract does not define for ${c.id}`);
      rows.push({ impl: impl.id, caseId: c.id, metric, expected: expected[metric], actual, equal: same(actual, expected[metric], tolerance) });
    }
  };
  for (const impl of impls) {
    for (const c of fixture.series) push(impl, c, safely(impl, 'series', c));
    for (const c of fixture.paired) push(impl, c, safely(impl, 'paired', c));
  }
  return rows;
}

function safely(impl, kind, c) {
  if (typeof impl[kind] !== 'function') return null;
  try {
    return impl[kind](c);
  } catch (error) {
    return { __threw: `THROWS:${String(error && error.message).slice(0, 80)}` };
  }
}

const keyOf = (row) => `${row.impl}|${row.caseId}|${row.metric}`;

/** The observed value in the form a record keeps it: numbers to 9 significant digits, everything else as is. */
const recordable = (v) => (finite(v) ? Number(v.toPrecision(9)) : v);

/**
 * @param rows   from compareAll
 * @param known  { 'impl|case|metric': { id: 'D-xxx', actual: <observed> } }
 */
function classify(rows, known) {
  const conforms = []; const knownRows = []; const unexpected = [];
  const seen = new Set();
  for (const row of rows) handle(row);
  function handle(row) {
    const key = keyOf(row);
    seen.add(key);
    const record = known[key];
    if (row.equal) {
      (record ? unexpected : conforms).push(record ? { ...row, why: 'STALE_KNOWN_DIFFERENCE', record } : row);
      return;
    }
    if (!record) { unexpected.push({ ...row, why: 'NEW_DIFFERENCE' }); return; }
    const matches = typeof row.actual === 'number' && finite(record.actual)
      ? same(row.actual, record.actual, { relative: 1e-6, absolute: 1e-9 }) : row.actual === record.actual;
    (matches ? knownRows : unexpected).push(matches ? { ...row, record } : { ...row, why: 'CHANGED_DIFFERENCE', record });
  }
  for (const [key, record] of Object.entries(known)) {
    if (!seen.has(key)) unexpected.push({ impl: key.split('|')[0], caseId: key.split('|')[1], metric: key.split('|')[2], why: 'KNOWN_DIFFERENCE_NOT_EXERCISED', record });
  }
  return { conforms, known: knownRows, unexpected };
}

/** What a new KNOWN_DIFFERENCES entry for each unexpected NEW_DIFFERENCE row would look like (to paste, then give an id). */
function draftKnown(unexpected) {
  const out = {};
  for (const row of unexpected.filter((r) => r.why === 'NEW_DIFFERENCE' || r.why === 'CHANGED_DIFFERENCE')) {
    out[keyOf(row)] = { id: 'D-TODO', actual: recordable(row.actual) };
  }
  return out;
}

function summary(result) {
  const byImpl = {};
  for (const [bucket, rows] of Object.entries({ conforms: result.conforms, known: result.known, unexpected: result.unexpected })) {
    for (const row of rows) {
      byImpl[row.impl] ||= { conforms: 0, known: 0, unexpected: 0 };
      byImpl[row.impl][bucket] += 1;
    }
  }
  return byImpl;
}

/** The report a repository keeps as evidence: every comparison, nothing recomputed later. */
function report(rows, result, meta) {
  return {
    ...meta,
    summary: summary(result),
    comparisons: rows.map((row) => ({ impl: row.impl, case: row.caseId, metric: row.metric, expected: recordable(row.expected), actual: recordable(row.actual),
      status: row.equal ? 'CONFORMS' : 'DIFFERS' })),
  };
}

/**
 * METRIC_CONFORMANCE_REPORT=<file>  writes every comparison (the evidence a repository keeps);
 * METRIC_CONFORMANCE_DRAFT=<file>   writes KNOWN_DIFFERENCES entries for the unexpected rows, ids to be assigned by hand.
 */
function writeArtifacts(rows, result, meta) {
  if (process.env.METRIC_CONFORMANCE_REPORT) fs.writeFileSync(process.env.METRIC_CONFORMANCE_REPORT, `${JSON.stringify(report(rows, result, meta), null, 1)}\n`);
  if (process.env.METRIC_CONFORMANCE_DRAFT) fs.writeFileSync(process.env.METRIC_CONFORMANCE_DRAFT, `${JSON.stringify(draftKnown(result.unexpected), null, 1)}\n`);
}

module.exports = { writeArtifacts, sha256File, loadFixture, pinProblems, same, expectedOf, compareAll, classify, draftKnown, summary, report, recordable };
