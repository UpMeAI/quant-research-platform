#!/usr/bin/env node
'use strict';
/**
 * 只读转换一份 ASHARE_V6_Q0_ACCOUNT_DAY_V1 JSONL；不连数据库、不写 V6、不读封存账户。
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const adapter = require('../../adapters/ashare-local/q0_account_export');
const { validateRecord } = require('../../schemas');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
async function readJsonl(file) {
  const rows = [];
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}
const writeFresh = (file, value) => {
  if (fs.existsSync(file)) throw new Error(`OUTPUT_EXISTS:${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx' });
};

(async () => {
  const f = flags(process.argv.slice(2));
  for (const key of ['input', 'out', 'registry-out', 'expect-sha256']) if (!f[key]) throw new Error(`MISSING_FLAG:${key}`);
  const input = path.resolve(f.input); const out = path.resolve(f.out); const registryOut = path.resolve(f['registry-out']);
  if (fs.existsSync(out) || fs.existsSync(registryOut)) throw new Error('OUTPUT_EXISTS');
  const sha256 = adapter.sha256File(input);
  if (sha256 !== f['expect-sha256']) throw new Error(`SOURCE_SHA256_MISMATCH:${sha256}`);
  const { result, registry } = adapter.adaptAccountDays(await readJsonl(input), {
    source: { file: input, sha256 }, generatedAt: f['generated-at'] || null,
  });
  const rv = validateRecord(result, result.schema); const sv = validateRecord(registry, registry.schema);
  if (!rv.ok) throw new Error(`RESULT_SCHEMA_INVALID:${rv.problems.join(',')}`);
  if (!sv.ok) throw new Error(`REGISTRY_SCHEMA_INVALID:${sv.problems.join(',')}`);
  for (const row of registry.rows) {
    const v = validateRecord(row, row.schema);
    if (!v.ok) throw new Error(`REGISTRY_ROW_SCHEMA_INVALID:${v.problems.join(',')}`);
  }
  writeFresh(out, result); writeFresh(registryOut, registry);
  process.stdout.write(`accountDays=${result.summary.accountDays} fills=${result.summary.fillCount} endingEquity=${result.summary.endingEquity} resultHash=${result.hash} registryHash=${registry.hash}\n`);
})().catch((error) => { process.stderr.write(`${String(error.message).split('\n')[0]}\n`); process.exitCode = 1; });
