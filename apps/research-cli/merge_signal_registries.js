#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const unified = require('../../services/signal-registry/unified');
const { validateRecord } = require('../../schemas');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
try {
  const f = flags(process.argv.slice(2));
  for (const k of ['us', 'crypto', 'ashare', 'out']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
  const out = path.resolve(f.out);
  if (fs.existsSync(out)) throw new Error(`OUTPUT_EXISTS:${out}`);
  const read = (key) => JSON.parse(fs.readFileSync(path.resolve(f[key]), 'utf8'));
  const registry = unified.mergeRegistries([read('us'), read('crypto'), read('ashare')], { generatedAt: f['generated-at'] || null });
  const valid = validateRecord(registry, registry.schema);
  if (!valid.ok) throw new Error(`UNIFIED_REGISTRY_SCHEMA_INVALID:${valid.problems.join(',')}`);
  for (const row of registry.rows) {
    const rv = validateRecord(row, row.schema);
    if (!rv.ok) throw new Error(`UNIFIED_REGISTRY_ROW_INVALID:${rv.problems.join(',')}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(registry)}\n`, { flag: 'wx' });
  process.stdout.write(`markets=${registry.markets.join(',')} rows=${registry.rows.length} hash=${registry.hash}\n`);
} catch (error) {
  process.stderr.write(`${String(error.message).split('\n')[0]}\n`);
  process.exitCode = 1;
}
