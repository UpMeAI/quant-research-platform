#!/usr/bin/env node
'use strict';
/**
 * Clock preflight: turns the saved NTP status text of the registrar host and the program host into the `clockOffsets` block of the K2_FREEZE_PROGRAM_V1 ctx.
 *   k2_clock_preflight.js --registrar <status.txt> --program <status.txt> --measured-at <ISO +08:00> [--tolerance-ms 1000]
 */
const fs = require('fs');
const { clockOffsets } = require('../../services/k2-freeze-program/clock_preflight');

try {
  const a = process.argv.slice(2);
  const f = {};
  for (let i = 0; i < a.length; i += 2) { if (!a[i].startsWith('--') || a[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${a[i]}`); f[a[i].slice(2)] = a[i + 1]; }
  for (const k of ['registrar', 'program', 'measured-at']) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`);
  process.stdout.write(`${JSON.stringify(clockOffsets({ registrarText: fs.readFileSync(f.registrar, 'utf8'), programText: fs.readFileSync(f.program, 'utf8'), measuredAt: f['measured-at'], toleranceMs: f['tolerance-ms'] ? Number(f['tolerance-ms']) : 1000 }))}\n`);
} catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; }
