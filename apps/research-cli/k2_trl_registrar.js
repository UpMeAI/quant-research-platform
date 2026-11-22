#!/usr/bin/env node
'use strict';
/**
 * TRL registrar for K2_FREEZE_PROGRAM_V1 (the Mac side of V9): registers a TRIAL_REGISTRATION_REQUEST_V1 through the trial ledger's front door as
 * PREREGISTERED and prints the TRIAL_REGISTRATION_RECEIPT_V1. Idempotent. Run by a launchd job with the completion authority; no session involved.
 *
 *   QRP_PRODUCT_MILESTONE_AUTHORITY=<authority> k2_trl_registrar.js --request <request.json> --registered-by <authority> [--registered-at <ISO +08:00>]
 */
const fs = require('fs');
const path = require('path');
const registrar = require('../../services/k2-freeze-program/registrar');
const { sortKeys } = require('../../services/k2-freeze-program/common');

try {
  const argv = process.argv.slice(2);
  const f = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    f[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of Object.keys(f)) if (!['request', 'registered-by', 'registered-at'].includes(k)) throw new Error(`UNKNOWN_FLAG:${k}`);
  for (const k of ['request', 'registered-by']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
  const receipt = registrar.register(JSON.parse(fs.readFileSync(path.resolve(f.request), 'utf8')), { registeredBy: f['registered-by'], registeredAt: f['registered-at'] || null });
  process.stdout.write(`${JSON.stringify(sortKeys(receipt))}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
