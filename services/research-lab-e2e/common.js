'use strict';

/** Shared helpers of RESEARCH_LAB_E2E_V1 (W24). No clock, no randomness, no network. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('../trial-ledger');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SHA64 = /^[0-9a-f]{64}$/;
/** RF1116 (PLAN_V1_1_AMENDMENT_1 section 1.1 S5): a mined candidate's final holdout is read once, no earlier than this instant. Same constant as the promotion engine's. */
const HOLDOUT_NOT_BEFORE = '2027-01-01T00:00:00+08:00';
const CST_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (obj) => `${canonicalJson(obj)}\n`;
const beforeHoldout = (asOf) => Date.parse(asOf) < Date.parse(HOLDOUT_NOT_BEFORE);

const STEPS = Object.freeze([
  { n: 1, name: 'CARD' }, { n: 2, name: 'IDEA' }, { n: 3, name: 'MECHANISM' }, { n: 4, name: 'DSL' }, { n: 5, name: 'K2_DRAFT' }, { n: 6, name: 'K2_FREEZE' },
  { n: 7, name: 'EXPERIMENT' }, { n: 8, name: 'VERIFY' }, { n: 9, name: 'VERDICT' }, { n: 10, name: 'SEAL' }, { n: 11, name: 'FEEDBACK' },
].map(Object.freeze));
const stepDir = (s) => `steps/${String(s.n).padStart(2, '0')}_${s.name}`;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readIfFile = (file) => (fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null);

/** Trial-ledger attempts of one mining round (every attempt, discarded ones included), straight from the ledger's front door. */
function defaultLedger() {
  return {
    attemptsOfRound(roundId) {
      const trials = require('../trial-ledger');
      return [...trials.heads().values()].filter((t) => t.role === 'MINED_CANDIDATE' && t.mining && t.mining.round_id === roundId)
        .map((t) => ({ candidate_id: t.mining.candidate_id, trial_id: t.trial_id, status: (t.rule_config && t.rule_config.attempt) || 'SCORED', formula_sha256: t.mining.formula_sha256 }))
        .sort((a, b) => (a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0));
    },
  };
}

module.exports = { crypto, fs, path, canonicalJson, sha256, SHA64, HOLDOUT_NOT_BEFORE, CST_STAMP, isObj, text, beforeHoldout, STEPS, stepDir, readJson, readIfFile, defaultLedger };
