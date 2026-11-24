#!/usr/bin/env node
'use strict';

/**
 * W24 HEAVY_DRIVER_V1 host entry point.
 *
 *   research_lab_run.js --job <LAB_E2E_JOB_V1.json>
 *                       --config <W24 host config.json>
 *                       --services <pinned host-services module.js>
 *
 * The queue's supervised transient unit is the only production caller. Docker
 * is synchronous here; tests call host-driver with an injected runner and never
 * execute this effect.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const driver = require('../../services/research-lab-e2e/host-driver');

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i] || !argv[i].startsWith('--') || argv[i + 1] === undefined) throw new driver.DriverError('BAD_ARGUMENTS');
    const key = argv[i].slice(2);
    if (!['job', 'config', 'services'].includes(key) || Object.prototype.hasOwnProperty.call(out, key)) throw new driver.DriverError('BAD_ARGUMENTS');
    out[key] = path.resolve(argv[i + 1]);
  }
  for (const key of ['job', 'config', 'services']) if (!out[key]) throw new driver.DriverError('BAD_ARGUMENTS');
  return out;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function serviceFactory(file, ctx) {
  // The module path is a HEAVY_RUN_SPEC_V1 pin, never an untrusted job field.
  const loaded = require(file); // eslint-disable-line global-require, import/no-dynamic-require
  if (typeof loaded === 'function') return loaded(ctx);
  if (loaded && typeof loaded.createServices === 'function') return loaded.createServices(ctx);
  if (loaded && typeof loaded === 'object') return loaded;
  throw new driver.DriverError('HOST_SERVICES_INVALID');
}

function dockerRun(argv, env = process.env) {
  const childEnv = Object.fromEntries(['DOCKER_HOST', 'LC_ALL', 'LANG'].filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  const r = spawnSync('/usr/bin/docker', argv, { encoding: 'utf8', env: childEnv });
  if (r.error) throw r.error;
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function main(argv, env = process.env) {
  let args; let job; let config; let services;
  try {
    args = parse(argv); job = readJson(args.job); config = readJson(args.config);
    services = serviceFactory(args.services, { job, config, env });
  } catch (e) {
    const result = { exit: driver.EXIT.INVALID_CONFIG, sessions_done: 0, sessions_total: 1, last_date: null, reason: e && e.code || 'INVALID_DRIVER_CONFIG' };
    if (env.RQ_ATTEMPT_DIR) {
      try { driver.writeDriverResult(path.join(env.RQ_ATTEMPT_DIR, 'driver-result.json'), result); } catch { /* preserve the first result */ }
    }
    process.stderr.write(`${result.reason}\n`);
    return result.exit;
  }
  const result = driver.runDriver({ job, baseServices: services, config, env, effects: { dockerRun: (a) => dockerRun(a, env) } });
  process.stdout.write(`${driver.canonical(result)}\n`);
  return result.exit;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parse, serviceFactory, dockerRun, main };
