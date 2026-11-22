'use strict';

/**
 * K2_DECISION_TABLE_TEMPLATES_V1 (RF1118 star P5 (a): decision tables only from frozen templates). The library is data
 * (config/k2_decision_table_templates.v1.json); its canonical sha256 is pinned in this file as well as written in the file, so editing a range
 * means editing two places and a coordinator merge (RF1118 section 2.2: code and templates are merged by the coordinator only).
 * A template fixes the outcome rules in words (PASS / FAIL / INSUFFICIENT); a draft only picks a template and numbers inside the ranges.
 * "INSUFFICIENT is not a rejection" stays with the template (rule text), not with the program.
 */
const fs = require('fs');
const path = require('path');
const { fail, canonicalJson, sha256, isObj } = require('./common');

const FILE = path.join(__dirname, '..', '..', 'config', 'k2_decision_table_templates.v1.json');
const PINNED_LIBRARY_SHA256 = '1ba53c0f18c6c16a287dec5b93997428d8a3ed90e2c02d19deba366a0b94f1de';

const librarySha256 = (lib) => { const { library_sha256: _omit, ...rest } = lib; return sha256(canonicalJson(rest)); };

function assertPinned(lib) {
  if (!isObj(lib) || lib.schema !== 'K2_DECISION_TABLE_TEMPLATES_V1') fail('PREREG_DECISION_TABLE_LIBRARY_INVALID');
  const actual = librarySha256(lib);
  if (actual !== lib.library_sha256 || actual !== PINNED_LIBRARY_SHA256) fail('PREREG_DECISION_TABLE_LIBRARY_PIN_MISMATCH', actual.slice(0, 12));
  return lib;
}

const LIBRARY = assertPinned(JSON.parse(fs.readFileSync(FILE, 'utf8')));

/** @returns {string[]} reason codes; empty = the table is a frozen template with parameters inside the registered ranges. */
function validate(table, lib = LIBRARY) {
  if (!isObj(table)) return ['PREREG_DECISION_TABLE_FREE_TEXT:not_an_object'];
  const codes = [];
  for (const k of Object.keys(table)) if (k !== 'template_id' && k !== 'params') codes.push(`PREREG_DECISION_TABLE_FREE_TEXT:${k}`);
  const t = lib.templates.find((x) => x.template_id === table.template_id);
  if (!t) return [...codes, 'PREREG_DECISION_TABLE_UNKNOWN_TEMPLATE'];
  if (!isObj(table.params)) return [...codes, 'PREREG_DECISION_TABLE_PARAM_MISSING:params'];
  for (const [name, spec] of Object.entries(t.params)) {
    const v = table.params[name];
    if (v === undefined) { codes.push(`PREREG_DECISION_TABLE_PARAM_MISSING:${name}`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { codes.push(`PREREG_DECISION_TABLE_PARAM_TYPE:${name}`); continue; }
    if (spec.type === 'integer' && !Number.isInteger(v)) { codes.push(`PREREG_DECISION_TABLE_PARAM_TYPE:${name}`); continue; }
    const inRange = spec.type === 'enum' ? spec.values.includes(v) : v >= spec.min && v <= spec.max;
    if (!inRange) codes.push(`PREREG_DECISION_TABLE_PARAM_RANGE:${name}`);
  }
  for (const name of Object.keys(table.params)) if (!(name in t.params)) codes.push(`PREREG_DECISION_TABLE_PARAM_UNKNOWN:${name}`);
  return codes;
}

module.exports = { FILE, LIBRARY, PINNED_LIBRARY_SHA256, librarySha256, assertPinned, validate };
