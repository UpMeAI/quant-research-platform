#!/usr/bin/env node
'use strict';
/**
 * Deterministic input-bundle builder for the AI_PREREG agent. Whitelist by kind; refuses sealed, holdout, mining-out, race, paper and production sources and canary content.
 *
 *   k2_bundle_builder.js --spec <spec.json> --out <empty dir>      spec = { market, root, built_at, files: [{kind, path}] }  (paths relative to root)
 */
const fs = require('fs');
const path = require('path');
const bundle = require('../../services/k2-freeze-program/bundle');

try {
  const argv = process.argv.slice(2);
  const f = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    f[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['spec', 'out']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
  const spec = JSON.parse(fs.readFileSync(path.resolve(f.spec), 'utf8'));
  const res = bundle.build({ market: spec.market, root: path.resolve(path.dirname(path.resolve(f.spec)), spec.root), files: spec.files, outDir: path.resolve(f.out), builtAt: spec.built_at });
  process.stdout.write(`${JSON.stringify({ builder: res.builder, sha256: res.sha256, dir: res.dir, files: res.manifest.files.length })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
