#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { cstDate } = require('../../services/ai-review/daily-command');
const { runWeeklyPending } = require('../../services/ai-review/weekly-pending-runner');
function argumentsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--requests', '--date', '--output-root'].includes(key) || key in args || !value || value.startsWith('--')) throw Error('ARGUMENTS_INVALID');
    args[key] = value;
  }
  if (!args['--requests'] || !path.isAbsolute(args['--requests']) || (args['--output-root'] && !path.isAbsolute(args['--output-root']))) throw Error('ARGUMENTS_INVALID');
  const period = args['--date'] || cstDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period) || !Number.isFinite(Date.parse(period)) || new Date(period).toISOString().slice(0, 10) !== period) throw Error('ARGUMENTS_INVALID');
  return { period, requestsFile: args['--requests'], ...(args['--output-root'] ? { root: args['--output-root'] } : {}) };
}
async function main() {
  let args;
  try { args = argumentsOf(process.argv.slice(2)); } catch { console.error('ARGUMENTS_INVALID'); process.exitCode = 64; return; }
  try {
    const requests = JSON.parse(fs.readFileSync(args.requestsFile, 'utf8'));
    const rows = await runWeeklyPending({ ...args, requests });
    console.log(JSON.stringify({ period: args.period, comparisonReady: false, rows: rows.map(r => ({ status: r.result.status, sourceState: r.result.sealedSourceState, sourceReason: r.result.sourceReason, jsonFile: r.jsonFile, markdownFile: r.markdownFile })) }));
  } catch { console.error('WEEKLY_DELIVERY_FAILED'); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { argumentsOf };
