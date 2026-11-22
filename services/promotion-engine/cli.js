#!/usr/bin/env node
'use strict';

/**
 * node services/promotion-engine/cli.js evaluate --terms <file> --stage <S0..S6|TRADE_PLAN> --as-of <CST stamp> [--history <file>] [--out <file>]
 * node services/promotion-engine/cli.js recheck --paused <result file> --terms <file> --as-of <CST stamp> [--observed <file>] [--history <file>] [--out <file>]
 * Prints the result bytes (or writes them to --out, mode 0444, refusing to overwrite). Exit 0 for PASS/FAIL/INSUFFICIENT/RESUME/STILL_PAUSED, 2 for INVALID_INPUT.
 */
const fs = require('fs');
const engine = require('./index');

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  return o;
}
const readJson = (f, d) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);

function main(argv) {
  const [cmd, ...rest] = argv; const a = args(rest);
  let result;
  if (cmd === 'evaluate') result = engine.evaluateFromFiles({ termsPath: a.terms, stage: a.stage, historyPath: a.history || null, asOf: a['as-of'] });
  else if (cmd === 'recheck') result = engine.recheckPaused({ paused: readJson(a.paused), terms: readJson(a.terms), observed: readJson(a.observed, {}), history: readJson(a.history, []), as_of: a['as-of'] });
  else { process.stderr.write('usage: cli.js evaluate|recheck ...\n'); return 64; }
  const bytes = engine.render(result);
  if (a.out) { fs.writeFileSync(a.out, bytes, { flag: 'wx', mode: 0o444 }); } else process.stdout.write(bytes);
  return (result.verdict || result.state) === 'INVALID_INPUT' ? 2 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
