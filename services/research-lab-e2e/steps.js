'use strict';

/**
 * Steps 1 to 7 of the lab chain. Each step calls the existing service and returns one of
 *   { files: {name: bytes}, primary, data }          linked artifacts
 *   { reason: 'LAB_<STEP>_<CODE>' }                   a refusal (the run stops here)
 *   { wait: 'CODE' }                                  a legal external wait (not a failure)
 * Nothing here re-implements a service: the AQ agent validators, the register's triage, the DSL parser, the K2 freeze program and the round runner's own outputs.
 */
const { fs, path, sha256, canonicalJson, text, isObj, readIfFile } = require('./common');
const V = require('../research-queue-agent');
const agentCanon = require('../research-queue-agent/canon');
const routing = require('../research-queue-agent/routing');
const accessLog = require('../independent-verifier/access-log');
const k2Validators = require('../k2-freeze-program/validators');
const k2Program = require('../k2-freeze-program');
const engine = require('../promotion-engine');
const reviewSeen = require('../trial-ledger/review_pack_seen');

const first = (codes) => String((codes && codes[0]) || 'UNKNOWN');

function card(S) {
  const { job, services } = S;
  let bytes;
  try { bytes = fs.readFileSync(job.files.card_result); } catch { return { reason: 'LAB_CARD_RESULT_UNREADABLE' }; }
  let result;
  try { result = JSON.parse(bytes.toString('utf8')); } catch { return { reason: 'LAB_CARD_RESULT_INVALID' }; }
  if (!isObj(result) || result.schema !== 'RQ_AGENT_RESULT_V1' || result.kind !== 'AI_REVIEW_CARD') return { reason: 'LAB_CARD_RESULT_INVALID' };
  if (result.task_id !== job.card_id) return { reason: 'LAB_CARD_ID_MISMATCH' };
  if (result.status !== 'DONE') return { reason: 'LAB_CARD_NOT_DONE' };
  const o = result.outputs;
  if (!isObj(o) || !isObj(o.card) || !Array.isArray(o.factor_ideas) || !Array.isArray(o.idea_routes)) return { reason: 'LAB_CARD_RESULT_INVALID' };
  const bundle = services.bundle();
  const vctx = { pack: bundle.pack, registry: bundle.registry, market: job.market, week_id: bundle.week_id, existing_idea_count: 0 };
  const { schema: _s, task_id: _t, prompt_admission_sha256: _p, model: _m, ...raw } = o.card;
  const v = V.validateCard(JSON.stringify(raw), vctx);
  if (!v.ok) return { reason: `LAB_CARD_INVALID_${first(v.errors.map((e) => e.code))}` };
  if (o.card_sha256 !== sha256(agentCanon.canonicalJson(o.card))) return { reason: 'LAB_CARD_SHA_MISMATCH' };
  const log = readIfFile(job.files.review_agent_access_log || '');
  if (!log) return { reason: 'LAB_CARD_ACCESS_LOG_MISSING' };
  const logCheck = accessLog.verifyBytes(log);
  if (!logCheck.ok) return { reason: 'LAB_CARD_ACCESS_LOG_INVALID' };
  // what the review agent read is development information (W05 semantics): the log must name the span of the facts the card was built from
  const days = bundle.pack.facts.map((f) => String(f.at).slice(0, 10)).sort();
  const read = logCheck.rows.filter((r) => r.op === 'READ');
  if (!read.length || read.some((r) => r.from > days[0] || r.to < days[days.length - 1])) return { reason: 'LAB_CARD_ACCESS_LOG_RANGE_MISMATCH' };
  // W05: the pack the card was built from is a delivered review fact pack, so this step is one of its entry points: write its SEEN mark (idempotent by the pack sha256; a pack the relay
  // or the producer already marked is a replay). A refused mark is a refused card. The SEEN ranges of the lineage and the final test are read back from the ledger marks, not from the log.
  const seenSvc = services.reviewSeen || {};
  try {
    reviewSeen.markPack(bundle.pack, { registeredBy: seenSvc.registeredBy || process.env.QRP_PRODUCT_MILESTONE_AUTHORITY, registeredAt: S.asOf });
  } catch (e) { return { reason: `LAB_CARD_SEEN_MARK_${e.code || 'FAILED'}` }; }
  S.data.packMarks = reviewSeen.packMarks({ market: job.market, asOf: S.asOf });
  S.data.reviewRows = logCheck.rows;
  S.data.card = { result, vctx }; S.data.reviewLogSha = sha256(log);
  return { files: { 'card_result.json': bytes, 'review_agent_access_log.jsonl': log }, primary: 'card_result.json' };
}

function idea(S) {
  const { job } = S;
  const { result, vctx } = S.data.card;
  const ideas = result.outputs.factor_ideas;
  const rec = job.idea_id ? ideas.find((i) => i.idea_id === job.idea_id) : (ideas.length === 1 ? ideas[0] : null);
  if (!rec) return { reason: job.idea_id || ideas.length === 0 ? 'LAB_IDEA_NOT_FOUND' : 'LAB_IDEA_AMBIGUOUS' };
  const v = V.validateIdeaRecord(rec, vctx);
  if (!v.ok) return { reason: `LAB_IDEA_INVALID_${first(v.errors.map((e) => e.code))}` };
  const route = result.outputs.idea_routes.find((r) => r.idea_id === rec.idea_id);
  if (!route) return { reason: 'LAB_IDEA_ROUTE_MISSING' };
  if (route.state === 'CLOSED_NOT_DO_SETTLED') return { reason: 'LAB_IDEA_CLOSED_NOT_DO_SETTLED' };
  if (route.state === 'WAITING_MECHANISM_ADMISSION') return { wait: 'MECHANISM_ADMISSION' };
  if (route.state === 'TRIAGE_PENDING') return { wait: 'TRIAGE_QUERY' };
  if (route.state !== 'GENERATOR_VIEW_PENDING') return { reason: `LAB_IDEA_ROUTE_NOT_ON_GENERATOR_PATH_${route.state}` };
  S.data.idea = rec; S.data.route = route;
  return { files: { 'factor_idea.json': text({ schema: 'LAB_IDEA_V1', idea: rec, route, review_agent_access_log_sha256: S.data.reviewLogSha }) }, primary: 'factor_idea.json' };
}

function mechanism(S) {
  const rec = S.data.idea;
  const mechanismId = routing.mechanismIdOf(rec);
  const triage = (S.services.mechanism && S.services.mechanism.triage) || ((q) => routing.triageViaRegister(q, { now: new Date(Date.parse(S.asOf)) }));
  let t;
  try { t = triage({ mechanism_id: mechanismId, market: rec.market }); } catch (e) { return { reason: `LAB_MECHANISM_TRIAGE_${String(e.code || 'ERROR')}` }; }
  if (!t || typeof t.route !== 'string') return { wait: 'TRIAGE_QUERY' };
  if (k2Validators.REFUSED_ROUTES.includes(t.route)) return { reason: `LAB_MECHANISM_${t.route}` };
  S.data.mechanism = { id: mechanismId, route: t.route };
  return { files: { 'mechanism_dedupe.json': text({ schema: 'LAB_MECHANISM_DEDUPE_V1', mechanism_id: mechanismId, market: rec.market, route: t.route, cite_seal_sha256: t.cite_seal_sha256 || [], as_of: S.asOf }) }, primary: 'mechanism_dedupe.json' };
}

function dslStep(S) {
  const { job } = S;
  const runner = require('../mining-sandbox/round-runner');
  const dsl = require('../mining-sandbox/dsl');
  let batch;
  try { batch = JSON.parse(fs.readFileSync(job.files.dsl, 'utf8')); } catch { return { reason: 'LAB_DSL_BATCH_UNREADABLE' }; }
  if (!isObj(batch) || batch.schema !== 'LAB_DSL_BATCH_V1' || !Array.isArray(batch.formulas) || !batch.formulas.length || !batch.formulas.every((f) => typeof f === 'string') || typeof batch.candidate_formula !== 'string') return { reason: 'LAB_DSL_BATCH_INVALID' };
  if (batch.idea_id !== S.data.idea.idea_id) return { reason: 'LAB_DSL_IDEA_MISMATCH' };
  const f = runner.loadFrozenSpace();
  const parse = (t) => { try { const p = dsl.parse(t, f.dslSpace); return { text: t, canonical: p.canonical, sha256: p.sha256, refusal: null }; } catch (e) { if (e instanceof dsl.DslError) return { text: t, canonical: null, sha256: null, refusal: e.code }; throw e; } };
  const parsed = batch.formulas.map(parse);
  const cand = parse(batch.candidate_formula);
  if (cand.refusal) return { reason: `LAB_DSL_${cand.refusal}` };
  if (!S.data.idea.holding_periods.includes(f.holdingPeriod)) return { reason: 'LAB_DSL_HOLDING_PERIOD_NOT_IN_IDEA' };
  if (!parsed.some((p) => p.canonical === cand.canonical)) return { reason: 'LAB_DSL_CANDIDATE_NOT_IN_BATCH' };
  S.data.dsl = { formulas: batch.formulas, candidate: { formula_canonical: cand.canonical, formula_sha256: cand.sha256 }, spaceSha256: f.space.sha256, holdingPeriod: f.holdingPeriod };
  const art = { schema: 'LAB_DSL_V1', idea_id: batch.idea_id, space_sha256: f.space.sha256, holding_period: f.holdingPeriod, authored_by: batch.authored_by || null,
    formulas: parsed.map((p) => ({ text: p.text, canonical: p.canonical, refusal: p.refusal })), candidate: { formula_canonical: cand.canonical, formula_sha256: cand.sha256 } };
  return { files: { 'dsl.json': text(art) }, primary: 'dsl.json' };
}

function k2Draft(S) {
  let bytes; let draft;
  try { bytes = fs.readFileSync(S.job.files.k2_draft); draft = JSON.parse(bytes.toString('utf8')); } catch { return { reason: 'LAB_K2_DRAFT_UNREADABLE' }; }
  if (!isObj(draft) || draft.schema !== 'K2_DRAFT_V1' || !isObj(draft.section0) || !Array.isArray(draft.section0.mechanism_ids)) return { reason: 'LAB_K2_DRAFT_INVALID' };
  if (!draft.section0.mechanism_ids.includes(S.data.mechanism.id)) return { reason: 'LAB_K2_DRAFT_MECHANISM_MISMATCH' };
  const want = require('./causality-evidence').functionIdsOf(S.data.dsl.candidate.formula_canonical);
  if (!draft.causality || !Array.isArray(draft.causality.functions)) return { reason: 'LAB_K2_DRAFT_CAUSALITY_FUNCTIONS_MISSING' };
  if (JSON.stringify([...draft.causality.functions].sort()) !== JSON.stringify(want)) return { reason: 'LAB_K2_DRAFT_CAUSALITY_FUNCTIONS_MISMATCH' };
  if (draft.market !== S.job.market) return { reason: 'LAB_K2_DRAFT_MARKET_MISMATCH' };
  S.data.draft = draft;
  return { files: { 'k2_draft.json': bytes }, primary: 'k2_draft.json' };
}

function k2Freeze(S) {
  const { services } = S; const draft = S.data.draft;
  const k2 = services.k2;
  if (!k2 || typeof k2.ctx !== 'function') return { wait: 'K2_FREEZE_CONTEXT' };
  const prog = services.k2Program || k2Program;
  const prepared = prog.prepare(draft, k2.ctx('PREPARE'));
  if (prepared.state === 'REFUSED' || prepared.state === 'WAITING_FREEZE') return { reason: `LAB_K2_FREEZE_${first(prepared.codes)}` };
  let receipts = null;
  if (prepared.state === 'WAITING_EXTERNAL') {
    receipts = typeof k2.register === 'function' ? k2.register(prepared) : null;
    if (!receipts) return { wait: 'TRL_RECEIPT' };
  }
  const fctx = k2.ctx('FINALIZE');
  const frozen = prog.finalize(draft, receipts, fctx, prepared.prepared);
  if (frozen.state === 'REFUSED' || frozen.state === 'WAITING_FREEZE') return { reason: `LAB_K2_FREEZE_${first(frozen.codes)}` };
  if (frozen.state === 'WAITING_EXTERNAL') return { wait: first([frozen.code]) };
  if (frozen.state !== 'FROZEN') return { reason: `LAB_K2_FREEZE_STATE_${frozen.state}` };
  // Q3b (QRP #148): the freeze program writes the candidate's PROMOTION_TERMS_V1 in the same event as the K2 (bound by k2_sha256, terms_frozen_at = k2_frozen_at) and names it
  // on the freeze page. The registered star values for AI-authored terms arrive as ctx.promotionTermsStar (config/promotion_terms_star.v1.json, Q3b follow-up) in services.k2.ctx.
  // The frozen terms never name stage evidence shas (the evidence does not exist yet): each stage's PROMOTION_STAGE_EVIDENCE_V1 goes to the engine separately, chained by
  // prior_output_sha256 (verdict.js).
  const dir = path.join(fctx.outDir, draft.draft_id);
  const sha8 = frozen.k2_sha256.slice(0, 8);
  const k2File = `${draft.draft_id}_K2_V1.frozen.${sha8}.md`; const pageFile = `${draft.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`; const reportFile = `${draft.draft_id}_K2_V1_VALIDATION_REPORT_1.json`;
  const k2Bytes = fs.readFileSync(path.join(dir, k2File)); const page = fs.readFileSync(path.join(dir, pageFile)); const report = fs.readFileSync(path.join(dir, reportFile));
  if (sha256(k2Bytes) !== frozen.k2_sha256) return { reason: 'LAB_K2_FREEZE_FILE_SHA_MISMATCH' };
  const block = JSON.parse(/```json K2_PROGRAM_FREEZE_PAGE_V1\n([\s\S]*?)\n```/.exec(page.toString('utf8'))[1]);
  if (!block.promotion_terms) return { wait: 'PROMOTION_TERMS' }; // a freeze made before Q3b carries no terms file
  const termsBytes = fs.readFileSync(path.join(dir, block.promotion_terms.file));
  if (sha256(termsBytes) !== block.promotion_terms.sha256) return { reason: 'LAB_TERMS_FILE_SHA_MISMATCH' };
  const terms = JSON.parse(termsBytes.toString('utf8'));
  if (terms.k2_sha256 !== frozen.k2_sha256) return { reason: 'LAB_TERMS_K2_MISMATCH' };
  const bad = engine.validateTerms(terms, { asOf: S.asOf });
  if (bad.length) return { reason: `LAB_TERMS_${first(bad)}` };
  if (!terms.mechanism_ids.includes(S.data.mechanism.id)) return { reason: 'LAB_TERMS_MECHANISM_MISMATCH' };
  const binding = {
    schema: 'LAB_K2_BINDING_V1', draft_id: draft.draft_id, draft_sha256: sha256(canonicalJson(draft)), family_id: draft.family_id, k2_sha256: frozen.k2_sha256, k2_frozen_at: frozen.k2_frozen_at,
    k2_file: { name: k2File, sha256: sha256(k2Bytes) }, freeze_page: { name: pageFile, sha256: sha256(page) }, report: { name: reportFile, sha256: sha256(report) },
    validators: frozen.results.map((r) => ({ v: r.v, state: r.state, reason: r.reason || null })), trial_ids: [...frozen.trial_ids].sort(), idea_id: S.data.idea.idea_id,
    dsl_formula_sha256: S.data.dsl.candidate.formula_sha256, promotion_terms: terms, robustness_declaration_sha256: block.robustness_declaration_sha256,
  };
  S.data.freeze = { binding, terms, k2Bytes, results: frozen.results };
  return { files: { 'k2_binding.json': text(binding), 'k2.frozen.md': k2Bytes }, primary: 'k2_binding.json' };
}

/** Round runner on dev + validation. The executor is a service (the lane runs the CLI; tests run the runner in process); the lab reads the outputs back through the runner's own files and the ledger. */
function experiment(S) {
  const { services, chain } = S;
  const dsl = S.data.dsl; const fz = S.data.freeze;
  const inputsSha = sha256(canonicalJson({ dsl: dsl.candidate.formula_sha256, formulas: dsl.formulas, k2: fz.binding.k2_sha256 }));
  const prior = chain.existing(7, 'experiment.json');
  let art = null;
  if (prior) { try { const p = JSON.parse(prior.toString('utf8')); if (p.inputs_sha256 === inputsSha) art = p; } catch { /* re-run below */ } }
  if (art) { S.data.experiment = art; return { files: {}, primary: 'experiment.json' }; }
  if (!services.experiment || typeof services.experiment.execute !== 'function') return { wait: 'EXPERIMENT_EXECUTOR' };
  const ran = services.experiment.execute({ formulas: dsl.formulas, as_of: S.asOf, idea_id: S.data.idea.idea_id });
  const runDir = path.dirname(ran.accessLogFile);
  const read = (n) => readIfFile(path.join(runDir, n));
  const files = { 'generation_log.jsonl': read('attempts.jsonl'), 'generate.json': read('generate.json'), 'selection.json': read('selection.json'), 'access_log.jsonl': read('access_log.jsonl') };
  for (const [n, b] of Object.entries(files)) if (!b) return { reason: `LAB_EXPERIMENT_OUTPUT_MISSING_${n.replace(/\W/g, '_').toUpperCase()}` };
  if (ran.grantLedgerFile && readIfFile(ran.grantLedgerFile)) files['holdout_grants.jsonl'] = readIfFile(ran.grantLedgerFile);
  const attempts = (services.ledger || require('./common').defaultLedger()).attemptsOfRound(ran.roundId);
  const cand = attempts.find((a) => a.status === 'SCORED' && a.formula_sha256 === dsl.candidate.formula_sha256);
  if (!cand) return { reason: 'LAB_EXPERIMENT_CANDIDATE_NOT_SCORED' };
  const selection = JSON.parse(files['selection.json'].toString('utf8'));
  const selectedNow = selection.selected.includes(cand.candidate_id);
  if (selectedNow && services.backtest) {
    const bt = services.backtest.run({ formula: dsl.candidate.formula_canonical, candidateId: cand.candidate_id });
    if (bt.refusal) return { reason: `LAB_BACKTEST_${bt.refusal}` };
    files['replay_output.json'] = text(bt.replay); // the S3/S4 input, written inside QRP from the same tables the round read (no external replay core)
  }
  const candSha = accessLog.candidateSha256Of({ roundId: ran.roundId, candidateId: cand.candidate_id, formula: dsl.candidate.formula_canonical });
  const log = accessLog.verifyBytes(files['access_log.jsonl']);
  if (!log.ok) return { reason: `LAB_EXPERIMENT_ACCESS_LOG_${log.code}` };
  art = {
    schema: 'LAB_EXPERIMENT_V1', inputs_sha256: inputsSha, round_id: ran.roundId, run_dir: runDir, candidate: { id: cand.candidate_id, sha256: candSha, formula_sha256: dsl.candidate.formula_sha256, formula_canonical: dsl.candidate.formula_canonical },
    selected: selection.selected.includes(cand.candidate_id), selected_ids: [...selection.selected], attempts,
    files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, { sha256: sha256(b) }])), access_log_rows: log.rows.length,
  };
  S.data.experiment = art;
  return { files: { ...files, 'experiment.json': text(art) }, primary: 'experiment.json' };
}

module.exports = { ORDER: [card, idea, mechanism, dslStep, k2Draft, k2Freeze, experiment], card, idea, mechanism, dslStep, k2Draft, k2Freeze, experiment };
