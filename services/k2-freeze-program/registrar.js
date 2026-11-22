'use strict';

/**
 * TRL registrar (the Mac-side half of the V9 hand-off). Takes a TRIAL_REGISTRATION_REQUEST_V1 and registers every spec through the trial ledger's front
 * door as PREREGISTERED, then returns a TRIAL_REGISTRATION_RECEIPT_V1 (TRL ids, registered_at, family N). Idempotent: a replay returns the original rows.
 * The registrar never edits a row and never registers a role that is not a research arm.
 */
const ledger = require('../trial-ledger');
const { fail, need, sha256, canonicalJson, isObj, isText, SHA64 } = require('./common');

const ROLES = Object.freeze(['VERDICT_ARM', 'BASELINE', 'REPORT_ONLY_VARIANT', 'DIAGNOSTIC_ARM']);

const requestSha256 = (request) => sha256(canonicalJson(request));

function validateRequest(request) {
  need(isObj(request) && request.schema === 'TRIAL_REGISTRATION_REQUEST_V1', 'REGISTRAR_REQUEST_INVALID', 'schema');
  need(isText(request.draft_id) && isText(request.family_id) && isText(request.market) && SHA64.test(request.k2_sha256 || ''), 'REGISTRAR_REQUEST_INVALID', 'fields');
  need(Array.isArray(request.specs) && request.specs.length, 'REGISTRAR_REQUEST_INVALID', 'specs');
  for (const spec of request.specs) {
    need(isObj(spec), 'REGISTRAR_REQUEST_INVALID', 'spec');
    need(ROLES.includes(spec.role), 'REGISTRAR_ROLE_NOT_ALLOWED', String(spec.role));
    need(spec.k2_sha256 === request.k2_sha256, 'REGISTRAR_K2_SHA256_MISMATCH', String(spec.config_label));
    need(spec.family_id === request.family_id && spec.market === request.market, 'REGISTRAR_REQUEST_INVALID', `family/market:${spec.config_label}`);
  }
}

function register(request, { registeredBy, registeredAt = null } = {}) {
  validateRequest(request);
  const rows = ledger.register(request.specs, { registeredBy, registeredAt, mode: 'PREREGISTERED' });
  const n = ledger.count(request.family_id);
  return {
    schema: 'TRIAL_REGISTRATION_RECEIPT_V1', request_sha256: requestSha256(request), draft_id: request.draft_id, k2_sha256: request.k2_sha256,
    rows: rows.map((r) => ({ trial_id: r.trial_id, config_label: r.config_label, registration_mode: r.registration_mode, k2_sha256: r.k2_sha256, registered_at: r.registered_at, record_hash: r.record_hash })),
    family_n: { family_id: request.family_id, n_raw: n.n_raw, n_distinct_configs: n.n_distinct_configs, n_is_lower_bound: n.n_is_lower_bound },
  };
}

module.exports = { ROLES, requestSha256, validateRequest, register };
