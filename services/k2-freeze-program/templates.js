'use strict';

/**
 * K2_DECISION_TABLE_TEMPLATES_V1 (RF1118 star P5 (a): decision tables only from frozen templates). The library is data
 * (config/k2_decision_table_templates.v1.json); its canonical sha256 is pinned in this file as well as written in the file, so editing a range
 * means editing two places and a coordinator merge (RF1118 section 2.2: code and templates are merged by the coordinator only).
 * A template fixes the outcome rules in words (PASS / FAIL / INSUFFICIENT) and every number: the drafter only picks the template.
 * "INSUFFICIENT is not a rejection" stays with the template (rule text), not with the program.
 */
const fs = require('fs');
const path = require('path');
const { fail, canonicalJson, sha256, isObj } = require('./common');

const FILE = path.join(__dirname, '..', '..', 'config', 'k2_decision_table_templates.v1.json');
const PINNED_LIBRARY_SHA256 = 'f6b8a859571e3877cf942a4bbaac80457fe10c46dbda0b5171f54d28264adacd';

const librarySha256 = (lib) => { const { library_sha256: _omit, ...rest } = lib; return sha256(canonicalJson(rest)); };

function assertPinned(lib) {
  if (!isObj(lib) || lib.schema !== 'K2_DECISION_TABLE_TEMPLATES_V1') fail('PREREG_DECISION_TABLE_LIBRARY_INVALID');
  const actual = librarySha256(lib);
  if (actual !== lib.library_sha256 || actual !== PINNED_LIBRARY_SHA256) fail('PREREG_DECISION_TABLE_LIBRARY_PIN_MISMATCH', actual.slice(0, 12));
  return lib;
}

const LIBRARY = assertPinned(JSON.parse(fs.readFileSync(FILE, 'utf8')));

/**
 * @param {object} table  the draft's decision_table { template_id, params }
 * @param {{lib?: object, riskRules?: object, ruleRef?: string}} [opts]  riskRules: registered risk rules by rule_ref, { margin_sd }; ruleRef: the rule the question cites
 * @returns {string[]} reason codes; empty = a frozen template whose fixed values are the fixed values and whose copied values are present and well-typed.
 * That the copied values equal the power tool's output is checked by V3 (it holds the POWER_OUTPUTS); margin_sd is checked here against the registered rule.
 */
function validate(table, { lib = LIBRARY, riskRules = null, ruleRef = null } = {}) {
  if (!isObj(table)) return ['PREREG_DECISION_TABLE_FREE_TEXT:not_an_object'];
  const codes = [];
  for (const k of Object.keys(table)) if (k !== 'template_id' && k !== 'params') codes.push(`PREREG_DECISION_TABLE_FREE_TEXT:${k}`);
  const t = lib.templates.find((x) => x.template_id === table.template_id);
  if (!t) return [...codes, 'PREREG_DECISION_TABLE_UNKNOWN_TEMPLATE'];
  if (!isObj(table.params)) return [...codes, 'PREREG_DECISION_TABLE_PARAM_MISSING:params'];
  for (const [name, spec] of Object.entries(t.params)) {
    const v = table.params[name];
    if (v === undefined) { codes.push(`PREREG_DECISION_TABLE_PARAM_MISSING:${name}`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || (spec.integer && !Number.isInteger(v))) { codes.push(`PREREG_DECISION_TABLE_PARAM_TYPE:${name}`); continue; }
    if (spec.type === 'fixed' && v !== spec.value) codes.push(`PREREG_DECISION_TABLE_PARAM_FIXED:${name}`);
    if (spec.type === 'risk_rule') {
      const rule = isObj(riskRules) && typeof ruleRef === 'string' && isObj(riskRules[ruleRef]) ? riskRules[ruleRef] : null;
      if (!rule || typeof rule[spec.field] !== 'number') codes.push(`PREREG_DECISION_TABLE_MARGIN_NOT_REGISTERED:${ruleRef}`);
      else if (rule[spec.field] !== v) codes.push(`PREREG_DECISION_TABLE_MARGIN_MISMATCH:${name}`);
    }
  }
  for (const name of Object.keys(table.params)) if (!(name in t.params)) codes.push(`PREREG_DECISION_TABLE_PARAM_UNKNOWN:${name}`);
  return codes;
}

module.exports = { FILE, LIBRARY, PINNED_LIBRARY_SHA256, librarySha256, assertPinned, validate };
