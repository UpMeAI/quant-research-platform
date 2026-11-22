'use strict';

/**
 * Builds the program context from files (CLI use). The context is plain data: the clock (now), the host facts, the receipt of the agent run, the prompt admissions,
 * the register commit (the register bytes are read from QRP git at that commit, as G-MECH does at import), the local data inventory, the ledger snapshot,
 * the earlier freezes (for the caps) and the queue log text. Nothing here reads the clock or the network.
 */
const fs = require('fs');
const path = require('path');
const mechGate = require('../research-mechanism-register/gate');
const { isObj } = require('./common');

/** Earlier program freezes found under dir (one level of <ID>/ directories), for the RF1118 caps. */
function loadPriorFreezes(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  for (const id of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, id);
    if (!fs.statSync(sub).isDirectory()) continue;
    const page = path.join(sub, `${id}_K2_V1_FREEZE_PROGRAM_1.md`);
    if (!fs.existsSync(page)) continue;
    const m = /```json K2_PROGRAM_FREEZE_PAGE_V1\n([\s\S]*?)\n```/.exec(fs.readFileSync(page, 'utf8'));
    if (!m) continue;
    const b = JSON.parse(m[1]);
    out.push({ market: b.market, frozen_at: b.k2_frozen_at, k2_sha256: b.k2_sha256, n_arms: Array.isArray(b.trial_ids) ? b.trial_ids.length : 0 });
  }
  return out;
}

/** @param {object} spec parsed ctx file */
function fromSpec(spec, { baseDir = '.' } = {}) {
  const abs = (p) => (p ? path.resolve(baseDir, p) : null);
  const ctx = {
    now: spec.now, host: spec.host || 'LINUX', outDir: abs(spec.outDir), bundle: spec.bundle || null, receipt: spec.receipt === undefined ? null : spec.receipt,
    admissions: spec.admissions || [], registerCommit: spec.registerCommit || null, marks: spec.marks || [], inventory: new Set(spec.inventory || []),
    ledgerRows: spec.ledgerRows || (spec.ledgerFile ? JSON.parse(fs.readFileSync(abs(spec.ledgerFile), 'utf8')) : []),
    priorFreezes: spec.priorFreezes || loadPriorFreezes(abs(spec.priorFreezesDir || spec.outDir)),
    queueLogText: spec.queueLogText !== undefined ? spec.queueLogText : (spec.queueLogFile ? fs.readFileSync(abs(spec.queueLogFile), 'utf8') : ''),
    pinnedCodeShas: spec.pinnedCodeShas || {}, freezeMode: spec.freezeMode || 'PROGRAM', downgradedClasses: spec.downgradedClasses || [],
    powerOutputs: spec.powerOutputs || null, riskRules: spec.riskRules || null,
    clockOffsets: spec.clockOffsets || null,
    registeredComponents: spec.registeredComponents || { readings: [], ruleParts: [] },
    evidenceBytes: spec.evidenceDir ? (sha) => { const f = path.join(abs(spec.evidenceDir), `${sha}.json`); return fs.existsSync(f) ? fs.readFileSync(f) : null; } : () => null,
  };
  if (spec.registerCommit) {
    // test seam only (same guard as testDisableValidators): serve the register bytes from a file instead of QRP git; production reads git at the commit
    if (spec.registerFile && process.env.QRP_TEST_K2_PROGRAM_MUTANT === '1') {
      ctx.registerBytes = fs.readFileSync(abs(spec.registerFile));
      ctx.registerAt = (c) => (c === spec.registerCommit ? ctx.registerBytes : null);
    } else {
      ctx.registerBytes = mechGate.internals.gitRegisterAt(spec.registerCommit);
      if (!ctx.registerBytes) throw new Error(`REGISTER_COMMIT_NOT_IN_GIT:${spec.registerCommit}`);
    }
  }
  if (spec.testDisableValidators) ctx.testDisableValidators = spec.testDisableValidators;
  if (isObj(spec.rf1118)) ctx.rf1118 = spec.rf1118;
  return ctx;
}

module.exports = { loadPriorFreezes, fromSpec };
