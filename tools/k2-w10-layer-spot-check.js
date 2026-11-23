#!/usr/bin/env node
'use strict';

/** Deterministic W10 spot check: every layer-register row and every tracked legacy K2 draft fixture. No network, clock, data write or model call. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const layerRegister = require('../services/research-layer-register');
const proposed = require('../services/k2-freeze-program/proposed');

const ROOT = path.join(__dirname, '..');

function audit() {
  const register = layerRegister.REGISTER.entries.map((entry) => {
    const valid = proposed.LAYER_CODES.includes(entry.layer) && entry.layer !== 'UNDECIDED';
    return { ref: `${entry.strategy_ref}+${entry.id}`, layer: entry.layer, state: valid ? 'PASS' : 'REFUSED', codes: valid ? [] : [entry.layer === 'UNDECIDED' ? 'PREREG_LAYER_UNDECIDED' : `PREREG_LAYER_INVALID:${entry.layer}`] };
  });
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((file) => file.endsWith('.md') && /K2.*DRAFT|DRAFT.*K2/i.test(file));
  const drafts = tracked.map((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const match = /^- 研究层：([A-Z_]+)\s*$/m.exec(text);
    if (!match) return { ref: file, schema: 'LEGACY_MARKDOWN', state: 'REFUSED', codes: ['PREREG_LAYER_MISSING'] };
    if (!proposed.LAYER_CODES.includes(match[1])) return { ref: file, schema: 'LEGACY_MARKDOWN', state: 'REFUSED', codes: [`PREREG_LAYER_INVALID:${match[1]}`] };
    if (match[1] === 'UNDECIDED') return { ref: file, schema: 'LEGACY_MARKDOWN', state: 'REFUSED', codes: ['PREREG_LAYER_UNDECIDED'] };
    return { ref: file, schema: 'LEGACY_MARKDOWN', layer: match[1], state: 'PASS', codes: [] };
  });
  // The executable test fixture is intentionally K2_DRAFT_V1. The RF1118 transition keeps that version accepted without v2-only fields or layer.
  drafts.push({ ref: 'tests/_k2_freeze_fixture.js#baseDraft', schema: 'K2_DRAFT_V1', state: 'PASS', codes: [], reason: 'LEGACY_TRANSITION' });
  const summary = (rows) => ({ total: rows.length, pass: rows.filter((r) => r.state === 'PASS').length, refused: rows.filter((r) => r.state === 'REFUSED').length,
    reasons: Object.fromEntries([...new Set(rows.flatMap((r) => r.codes))].sort().map((code) => [code, rows.filter((r) => r.codes.includes(code)).length])) });
  return { schema: 'K2_W10_LAYER_SPOT_CHECK_V1', register: { ...summary(register), rows: register }, drafts: { ...summary(drafts), rows: drafts } };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(audit(), null, 2)}\n`);
module.exports = { audit };
