'use strict';

/**
 * W10 proposed K2 v2 contract. These files are proposals, not coordinator freezes. The program may validate the proposed draft shape during the
 * RF1118 transition, while the v1 pin and v1 behaviour stay unchanged. The sidecars make the exact proposal bytes addressable for review.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isObj } = require('./common');
const layerRegister = require('../research-layer-register');

const ROOT = path.join(__dirname, '..', '..', 'config');
const SCHEMA_FILE = path.join(ROOT, 'k2_draft_v2.schema.proposed.json');
const TEMPLATE_FILE = path.join(ROOT, 'k2_draft_v2.template.proposed.json');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function loadProposed(file) {
  const bytes = fs.readFileSync(file);
  const sidecar = fs.readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/)[0];
  const actual = sha256(bytes);
  if (actual !== sidecar) throw new Error(`K2_PROPOSED_SHA256_MISMATCH:${path.basename(file)}:${actual}`);
  return { doc: JSON.parse(bytes), sha256: actual };
}

const schema = loadProposed(SCHEMA_FILE);
const template = loadProposed(TEMPLATE_FILE);
if (JSON.stringify(schema.doc.layer_codes) !== JSON.stringify(layerRegister.LAYER_CODES)) throw new Error('K2_PROPOSED_LAYER_CODES_NOT_REGISTERED');
const DRAFT_SCHEMA = schema.doc.draft_schema;
const NEW_KEYS = Object.freeze([...schema.doc.new_required_keys]);
const LAYER_CODES = layerRegister.LAYER_CODES;
const READING_CLASSES = Object.freeze([...schema.doc.reading_classes]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN_TEXT = /[`\r\n]|\*\*|TRL-|DATA:|CF:|G-CAUSAL|K2_PROGRAM_FROZEN|FREEZE_PROGRAM/;

const exactKeys = (value, required, at, codes) => {
  if (!isObj(value)) { codes.push(`PREREG_FIELDS_TYPE:${at}`); return false; }
  for (const key of required) if (!(key in value)) codes.push(`PREREG_FIELDS_MISSING:${at}.${key}`);
  for (const key of Object.keys(value)) if (!required.includes(key)) codes.push(`PREREG_FIELDS_EXTRA_KEY:${at}.${key}`);
  return true;
};
const text = (value, at, codes) => {
  if (typeof value !== 'string' || !value.trim() || FORBIDDEN_TEXT.test(value)) codes.push(`PREREG_FIELDS_TYPE:${at}`);
};

function validateFields(draft) {
  const codes = [];
  for (const key of NEW_KEYS) if (!(key in draft)) codes.push(`PREREG_FIELDS_MISSING:${key}`);
  if (codes.length) return codes;
  const specs = schema.doc.fields;
  for (const key of ['universe', 'holding_period', 'costs', 'drawdown']) {
    if (!exactKeys(draft[key], specs[key].required, key, codes)) continue;
    for (const field of specs[key].required) text(draft[key][field], `${key}.${field}`, codes);
  }
  if (exactKeys(draft.regime, specs.regime.required, 'regime', codes)) {
    text(draft.regime.applicability_zh, 'regime.applicability_zh', codes);
    if (!specs.regime.use_enum.includes(draft.regime.use)) codes.push(`PREREG_FIELDS_ENUM:regime.use:${String(draft.regime.use)}`);
  }
  const boundaries = draft.evaluation_boundaries;
  if (exactKeys(boundaries, specs.evaluation_boundaries.required, 'evaluation_boundaries', codes)) {
    for (const stage of specs.evaluation_boundaries.required) {
      const at = `evaluation_boundaries.${stage}`;
      const value = boundaries[stage];
      if (!exactKeys(value, specs.evaluation_boundaries.boundary_required, at, codes)) continue;
      for (const field of specs.evaluation_boundaries.boundary_required) if (typeof value[field] !== 'string' || !DATE.test(value[field])) codes.push(`PREREG_FIELDS_TYPE:${at}.${field}`);
      if (DATE.test(value.from || '') && DATE.test(value.to || '') && value.from > value.to) codes.push(`PREREG_FIELDS_RANGE:${at}`);
    }
  }
  return codes;
}

module.exports = {
  DRAFT_SCHEMA, NEW_KEYS, LAYER_CODES, READING_CLASSES, SCHEMA_FILE, TEMPLATE_FILE,
  SCHEMA_SHA256: schema.sha256, TEMPLATE_SHA256: template.sha256, SCHEMA: schema.doc, TEMPLATE: template.doc, validateFields,
};
