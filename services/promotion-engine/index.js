'use strict';

/**
 * PROMOTION_ENGINE_V1: the research evaluation and promotion engine (W16 extension, PLAN_V1_1_AMENDMENT_1 section 1; DECISION_ID PLAN-V1-20261123-01).
 * Contract: docs/contracts/PROMOTION_ENGINE_V1.md.
 *
 *   evaluate(request)                 one candidate, one requested stage -> PROMOTION_RESULT_V1 { stage, verdict, reasonCodes, nextAction, resolution, ... }
 *   evaluateFromFiles(args)           the same, reading the K2 terms file and the stage evidence file(s) the terms name (each verified by sha256)
 *   recheckPaused(args)               the monthly recheck of a paused (暂停) result; escalates after the K2's failed-recheck count, never converts
 *   rankInformationValue(items, opts) frozen information-value order of 做 items inside one market
 *   kpi9(input)                       KPI 9: mechanism-deduplicated S4 passes per model cost and per core-hour
 *   render(result) / outputSha256     the byte form (sorted keys, one-space indent, trailing newline) and its sha256
 *
 * No clock (as_of is handed in), no network, no model call, no ledger write: same input, same bytes. A result is never mutated and nothing is
 * written here; the caller (W24 wiring) stores the result file and appends its sha to the candidate's history.
 * The engine reuses (does not re-implement): the K2 freeze program's helpers, power tool constants and validator list, the trial ledger's DSR gate,
 * PAPER_VALIDATION_V1's states, RACE_V2's partitions, the cost gate's G-COST assessment, the mechanism register's route names.
 */
const fs = require('fs');
const path = require('path');
const common = require('./common');
const termsMod = require('./terms');
const stages = require('./stages');
const insufficient = require('./insufficient');
const value = require('./value');

const { sha256, prettyJson, isObj, isCstStamp, SHA64, clone } = common;
const SCHEMA = 'PROMOTION_RESULT_V1';
const STAGES = Object.freeze(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
const VERDICTS = Object.freeze(['PASS', 'FAIL', 'INSUFFICIENT', 'INVALID_INPUT']);
/** plan-coord ruling 11-23 (3): production trade plans need S6 (adopted); an S5 forward candidate may only produce labelled SHADOW plans. */
const TRADE_PLAN_MIN_STAGE = 'S6';
const SHADOW_PLAN_MIN_STAGE = 'S5';
const TRADE_PLAN = 'TRADE_PLAN';
const SHADOW_PLAN = 'SHADOW_PLAN';

const outputSha256 = (body) => sha256(prettyJson(body));
const render = (result) => { const { output_sha256: _o, ...body } = result; return prettyJson({ ...body, output_sha256: outputSha256(body) }); };

function finish({ candidate_id: candidateId = null, stage, verdict, reasonCodes, nextAction, resolution = null, asOf = null, inputs = {} }) {
  const body = {
    schema: SCHEMA, candidate_id: candidateId, stage, verdict, reasonCodes, nextAction, resolution, as_of: asOf,
    inputs: { terms_sha256: inputs.terms_sha256 || null, evidence_sha256: inputs.evidence_sha256 || null },
    value_config_sha256: value.VALUE_CONFIG_SHA256, production_effect: 'NONE',
  };
  return { ...body, output_sha256: outputSha256(body) };
}

const invalidResult = (ctx, codes) => finish({ ...ctx, verdict: 'INVALID_INPUT', reasonCodes: codes, nextAction: 'FIX_INPUT', resolution: null });

/** @returns {{codes: string[], passedThrough: number, last: Map<string, object>}} */
function readHistory(history) {
  const last = new Map();
  const codes = [];
  if (!Array.isArray(history)) return { codes: ['PROMOTION_HISTORY_INVALID'], passedThrough: -1, last };
  for (const h of history) {
    if (!isObj(h) || !STAGES.includes(h.stage) || !VERDICTS.includes(h.verdict) || typeof h.output_sha256 !== 'string' || !SHA64.test(h.output_sha256)) { codes.push('PROMOTION_HISTORY_INVALID'); break; }
    last.set(h.stage, h);
  }
  let passedThrough = -1;
  while (passedThrough + 1 < STAGES.length && last.has(STAGES[passedThrough + 1]) && last.get(STAGES[passedThrough + 1]).verdict === 'PASS') passedThrough++;
  return { codes, passedThrough, last };
}

/**
 * @param {{candidate_id: string, requested_stage: string, terms: object, terms_sha256?: string, evidence?: object, evidence_sha256?: string,
 *          history: {stage: string, verdict: string, output_sha256: string}[], as_of: string}} req
 * history: the candidate's earlier results in order (the last entry per stage counts). requested_stage: S0..S6 or TRADE_PLAN (may a PASS feed trade plans?).
 */
function evaluate(req) {
  const r = isObj(req) ? req : {};
  const stage = typeof r.requested_stage === 'string' ? r.requested_stage : null;
  const ctx = { candidate_id: isObj(r.terms) && typeof r.terms.candidate_id === 'string' ? r.terms.candidate_id : (typeof r.candidate_id === 'string' ? r.candidate_id : null), stage, asOf: typeof r.as_of === 'string' ? r.as_of : null };
  try {
    const termsSha = typeof r.terms_sha256 === 'string' ? r.terms_sha256 : (isObj(r.terms) ? sha256(prettyJson(r.terms)) : null);
    const evSha = typeof r.evidence_sha256 === 'string' ? r.evidence_sha256 : (isObj(r.evidence) ? sha256(prettyJson(r.evidence)) : null);
    ctx.inputs = { terms_sha256: termsSha, evidence_sha256: evSha };
    if (!isCstStamp(r.as_of)) return invalidResult(ctx, ['PROMOTION_AS_OF_INVALID']);
    const tc = termsMod.validate(r.terms);
    if (tc.length) return invalidResult(ctx, tc);
    const t = r.terms;
    if (r.candidate_id !== t.candidate_id) return invalidResult(ctx, ['PROMOTION_CANDIDATE_MISMATCH']);
    if (!STAGES.includes(stage) && stage !== TRADE_PLAN && stage !== SHADOW_PLAN) return invalidResult(ctx, ['PROMOTION_STAGE_UNKNOWN']);

    const hist = readHistory(r.history);
    if (hist.codes.length) return invalidResult(ctx, hist.codes);
    for (const s of STAGES) if (hist.last.has(s) && hist.last.get(s).verdict === 'FAIL') return invalidResult(ctx, [`PROMOTION_CANDIDATE_SEALED_NOT_DO:${s}`]);

    // no skipping: every earlier stage must have its own PASS
    const use = stage === TRADE_PLAN || stage === SHADOW_PLAN;
    // TRADE_PLAN: S6 PASS. SHADOW_PLAN: the candidate has reached S5, i.e. S4 PASS.
    const needed = stage === TRADE_PLAN ? STAGES.indexOf(TRADE_PLAN_MIN_STAGE) : stage === SHADOW_PLAN ? STAGES.indexOf(SHADOW_PLAN_MIN_STAGE) - 1 : STAGES.indexOf(stage) - 1;
    if (hist.passedThrough < needed) return invalidResult(ctx, [`PROMOTION_STAGE_SKIP:${hist.passedThrough < 0 ? 'NONE' : STAGES[hist.passedThrough]}->${stage}`]);
    if (stage === TRADE_PLAN) return finish({ ...ctx, verdict: 'PASS', reasonCodes: [`PROMOTION_TRADE_PLAN_ALLOWED_AFTER_${TRADE_PLAN_MIN_STAGE}`], nextAction: 'ALLOW_TRADE_PLAN', resolution: { plan_class: 'PRODUCTION' } });
    if (use) return finish({ ...ctx, verdict: 'PASS', reasonCodes: [`PROMOTION_SHADOW_PLAN_ONLY_AT_${SHADOW_PLAN_MIN_STAGE}`], nextAction: 'ALLOW_SHADOW_PLAN_ONLY', resolution: { plan_class: 'SHADOW', label: 'SHADOW', executable: false } });

    const ev = r.evidence;
    if (!isObj(ev) || ev.schema !== 'PROMOTION_STAGE_EVIDENCE_V1') return invalidResult(ctx, ['PROMOTION_EVIDENCE_INVALID']);
    const head = [];
    if (ev.candidate_id !== t.candidate_id) head.push('PROMOTION_EVIDENCE_CANDIDATE_MISMATCH');
    if (ev.k2_sha256 !== t.k2_sha256) head.push('PROMOTION_EVIDENCE_K2_MISMATCH');
    if (ev.stage !== stage) head.push('PROMOTION_EVIDENCE_STAGE_MISMATCH');
    if (head.length) return invalidResult(ctx, head);
    const idx = STAGES.indexOf(stage);
    const prior = idx === 0 ? null : hist.last.get(STAGES[idx - 1]).output_sha256;
    if (ev.prior_output_sha256 !== prior) return invalidResult(ctx, [`PROMOTION_LINEAGE_MISMATCH:${stage}`]);
    if (isObj(ev.validator) && ev.validator.first_failed !== null && ev.validator.first_failed !== undefined) return invalidResult(ctx, [`PROMOTION_VALIDATOR_STOPPED_AT:${ev.validator.first_failed}`]);

    const out = stages.EVALUATORS[stage](ev.body, t);
    if (out.invalid) return invalidResult(ctx, out.invalid);
    if (out.verdict !== 'INSUFFICIENT') {
      return finish({ ...ctx, verdict: out.verdict, reasonCodes: out.codes, nextAction: out.verdict === 'PASS' ? (stage === 'S6' ? 'ADOPT_NEW_D_VERSION' : `PROCEED_TO_${STAGES[idx + 1]}`) : 'SEAL_NOT_DO_TO_FAILURE_LIBRARY' });
    }
    if (out.external) return finish({ ...ctx, verdict: 'INSUFFICIENT', reasonCodes: out.codes, nextAction: out.external });

    // INSUFFICIENT: section 4.2 (做 or 暂停), never 不做
    const res = insufficient.resolve({ terms: t, inputs: ev.insufficient_inputs, asOf: r.as_of });
    if (res.invalid) return invalidResult(ctx, res.invalid);
    return finish({ ...ctx, verdict: 'INSUFFICIENT', reasonCodes: [...out.codes, ...res.verdictCodes], nextAction: res.nextAction, resolution: res.resolution });
  } catch (e) {
    return invalidResult(ctx, [`PROMOTION_INTERNAL_ERROR:${String(e && e.message).slice(0, 120)}`]);
  }
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/**
 * File form. The terms file names each stage's evidence file by relative path and sha256 (terms.stage_evidence). Paths resolve against the
 * terms file's directory (or baseDir); absolute paths and ".." are refused. The history file is a JSON array of {stage, verdict, output_sha256}.
 * @param {{termsPath: string, stage: string, historyPath?: string, asOf: string, baseDir?: string}} a
 */
function evaluateFromFiles({ termsPath, stage, historyPath = null, asOf, baseDir = null } = {}) {
  const ctx = { stage: typeof stage === 'string' ? stage : null, asOf: typeof asOf === 'string' ? asOf : null, inputs: {} };
  let termsBytes; let terms;
  try { termsBytes = fs.readFileSync(termsPath); terms = JSON.parse(termsBytes.toString('utf8')); } catch { return invalidResult(ctx, [isCstStamp(asOf) ? 'PROMOTION_TERMS_UNPARSEABLE' : 'PROMOTION_AS_OF_INVALID']); }
  const termsSha = sha256(termsBytes);
  ctx.candidate_id = isObj(terms) && typeof terms.candidate_id === 'string' ? terms.candidate_id : null;
  ctx.inputs = { terms_sha256: termsSha };
  if (!isCstStamp(asOf)) return invalidResult(ctx, ['PROMOTION_AS_OF_INVALID']);
  let history = [];
  if (historyPath) { try { history = readJson(historyPath); } catch { return invalidResult(ctx, ['PROMOTION_HISTORY_UNREADABLE']); } }
  let evidence; let evidenceSha;
  if (stage !== TRADE_PLAN && stage !== SHADOW_PLAN) {
    const ref = isObj(terms) && isObj(terms.stage_evidence) ? terms.stage_evidence[stage] : null;
    if (!ref) return invalidResult(ctx, [`PROMOTION_EVIDENCE_NOT_NAMED:${stage}`]);
    const rel = path.normalize(String(ref.path));
    if (path.isAbsolute(String(ref.path)) || rel.split(path.sep).includes('..')) return invalidResult(ctx, [`PROMOTION_EVIDENCE_PATH_INVALID:${stage}`]);
    let bytes;
    try { bytes = fs.readFileSync(path.join(baseDir || path.dirname(termsPath), rel)); } catch { return invalidResult(ctx, [`PROMOTION_EVIDENCE_UNREADABLE:${stage}`]); }
    evidenceSha = sha256(bytes);
    if (evidenceSha !== ref.sha256) return invalidResult({ ...ctx, inputs: { ...ctx.inputs, evidence_sha256: evidenceSha } }, [`PROMOTION_EVIDENCE_SHA_MISMATCH:${stage}`]);
    try { evidence = JSON.parse(bytes.toString('utf8')); } catch { return invalidResult(ctx, [`PROMOTION_EVIDENCE_UNPARSEABLE:${stage}`]); }
  }
  return evaluate({ candidate_id: ctx.candidate_id, requested_stage: stage, terms, terms_sha256: termsSha, evidence, evidence_sha256: evidenceSha, history, as_of: asOf });
}

/**
 * Monthly recheck of a paused result (AMENDMENT_1 section 4.3).
 * @param {{paused: object, terms: object, observed: object, history: {as_of: string, state: string}[], as_of: string}} a
 *   paused: the engine's earlier PROMOTION_RESULT_V1 with resolution.conclusion 暂停; history: earlier recheck results (as_of, state), oldest first.
 * @returns {object} PROMOTION_RECHECK_V1 with state RESUME | STILL_PAUSED | PAUSE_ESCALATE_TO_OWNER | INVALID_INPUT
 */
function recheckPaused({ paused, terms, observed, history, as_of: asOf } = {}) {
  let core;
  try {
    const tc = termsMod.validate(terms);
    if (!isCstStamp(asOf)) core = { state: 'INVALID_INPUT', reasonCodes: ['PROMOTION_AS_OF_INVALID'] };
    else if (tc.length) core = { state: 'INVALID_INPUT', reasonCodes: tc };
    else core = insufficient.recheck({ paused, terms, observed, history: history || [], asOf });
  } catch (e) { core = { state: 'INVALID_INPUT', reasonCodes: [`PROMOTION_INTERNAL_ERROR:${String(e && e.message).slice(0, 120)}`] }; }
  const body = {
    schema: 'PROMOTION_RECHECK_V1', candidate_id: isObj(terms) ? terms.candidate_id || null : null, as_of: typeof asOf === 'string' ? asOf : null,
    paused_output_sha256: isObj(paused) && typeof paused.output_sha256 === 'string' ? paused.output_sha256 : null,
    paused_code: isObj(paused) && isObj(paused.resolution) ? paused.resolution.code || null : null,
    state: core.state, conclusion: core.conclusion === undefined ? null : core.conclusion, failed_rechecks: core.failed_rechecks === undefined ? null : core.failed_rechecks,
    escalate: core.escalate === true, nextAction: core.nextAction || 'FIX_INPUT', reasonCodes: core.reasonCodes, production_effect: 'NONE',
  };
  return { ...body, output_sha256: outputSha256(body) };
}

module.exports = {
  SCHEMA, STAGES, VERDICTS, TRADE_PLAN, SHADOW_PLAN, TRADE_PLAN_MIN_STAGE, SHADOW_PLAN_MIN_STAGE, CUTOFF: insufficient.CUTOFF, MINED_HOLDOUT_NOT_BEFORE: stages.MINED_HOLDOUT_NOT_BEFORE,
  evaluate, evaluateFromFiles, recheckPaused, render, outputSha256,
  rankInformationValue: value.rankInformationValue, kpi9: value.kpi9, valueConfig: value.valueConfig, VALUE_CONFIG_SHA256: value.VALUE_CONFIG_SHA256,
  validateTerms: termsMod.validate, clone,
};
