#!/usr/bin/env node
'use strict';
/**
 * K2_FREEZE_PROGRAM_V1 (RF1118 r2): the program that freezes AI-drafted K2s. No model, no network, no clock (the host clock arrives in the ctx file).
 *
 *   k2_freeze_program.js prepare  --draft <K2_DRAFT_V1.json> --ctx <ctx.json>
 *   k2_freeze_program.js finalize --draft <K2_DRAFT_V1.json> --ctx <ctx.json> --receipts <TRIAL_REGISTRATION_RECEIPT_V1.json> --prepared <K2_PREPARED_V1.json>
 *
 * stdout: one JSON line (keys sorted). Exit 0: WAITING_EXTERNAL (TRL_RECEIPT) or FROZEN; 65: REFUSED (reason codes); 66: WAITING_FREEZE (draft goes to the coordinator
 * freeze path); 64: bad arguments. Writes only under ctx.outDir/<draft_id>/ (frozen text, report, page, refusal; all 0444).
 */
const fs = require('fs');
const path = require('path');
const program = require('../../services/k2-freeze-program');
const { fromSpec } = require('../../services/k2-freeze-program/ctx_files');
const { sortKeys } = require('../../services/k2-freeze-program/common');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw Object.assign(new Error(`BAD_ARGUMENTS:${argv[i]}`), { exit: 64 });
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
const json = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'prepare' && command !== 'finalize') throw Object.assign(new Error(`UNKNOWN_COMMAND:${command || ''}（prepare | finalize）`), { exit: 64 });
  const f = flags(rest);
  const required = command === 'prepare' ? ['draft', 'ctx'] : ['draft', 'ctx', 'receipts', 'prepared'];
  for (const k of required) if (!f[k]) throw Object.assign(new Error(`MISSING_FLAG:${k}`), { exit: 64 });
  const draft = json(f.draft);
  const ctx = fromSpec(json(f.ctx), { baseDir: path.dirname(path.resolve(f.ctx)) });
  const res = command === 'prepare' ? program.prepare(draft, ctx) : program.finalize(draft, json(f.receipts), ctx, json(f.prepared));
  const { prior_table_bytes: _t, refusal, ...rest2 } = res;
  const out = { ...rest2, ...(refusal ? { refusal: { name: refusal.name } } : {}) };
  process.stdout.write(`${JSON.stringify(sortKeys(out))}\n`);
  process.exitCode = res.state === 'REFUSED' ? 65 : res.state === 'WAITING_FREEZE' ? 66 : 0;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exit || 1;
}
