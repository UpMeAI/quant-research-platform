'use strict';

/**
 * RESEARCH_LAB_E2E_V1 (W24, PLAN_V1_1_AMENDMENT_1 section 3; the lineage report is also the parent plan's W04 check). Entry points:
 *   run(job, services)      drive one card through the 11 steps; stops at the first refusal (reason LAB_<STEP>_<CODE>) or at a legal external wait
 *   check({out_dir, as_of, services, next_bundle})   the acceptance checker (C1..C5, PASS/FAIL each)
 *   verdict.decide / verdict.assembleBundle         steps 8 to 10 as pure functions
 * Deterministic: no clock read (as_of is in the job), no randomness. Calls existing services only. Contract: docs/contracts/RESEARCH_LAB_E2E_V1.md.
 *
 * job      { schema: 'LAB_E2E_JOB_V1', card_id, market, as_of (+08:00), out_dir, idea_id?, files: { card_result, review_agent_access_log, dsl, k2_draft } }
 * services { bundle(), mechanism?.triage, k2: { ctx(phase), register(prepared) }, experiment: { execute({formulas, as_of}) },
 *            ledger?, holdoutScored?(roundId), evidence?: { verifier(view) }, engine? }
 */
const { path, fs, STEPS, HOLDOUT_NOT_BEFORE, CST_STAMP, text, sha256, isObj, beforeHoldout, defaultLedger, readJson } = require('./common');
const { Chain } = require('./chain');
const steps = require('./steps');
const verdict = require('./verdict');
const feedback = require('./feedback');
const seen = require('./seen');
const s2Evidence = require('./s2-evidence');
const ladder = require('./ladder');
const lineage = require('./lineage');
const checker = require('./checker');

const byName = (n) => STEPS.find((s) => s.name === n);
const holdoutScoredDefault = (roundId) => require('../mining-rounds/gate-records').recordsOf(roundId).length > 0;

/** The S0 and S1 evidence bodies come from the chain: dedupe passed, K2 validators from the freeze report. */
function bodies(S) {
  const s1 = {};
  for (const r of S.data.freeze.results) s1[r.v] = r.state === 'PASS' || (r.state === 'NOT_APPLICABLE' && r.reason === 'HUMAN_AUTHORED') ? 'PASS' : r.state === 'REFUSED' ? 'FAIL' : 'NOT_RUN';
  return { s0_body: { state: 'REGISTERED', fact_refs: S.data.idea.fact_ids, mechanism_ids: [S.data.mechanism.id] }, s1_body: { validators: s1 } };
}

/** Step 11, always last: every terminal state (also a refusal after the candidate is frozen) writes its feedback facts for the queue intake. */
function writeFeedback(S, { terminalState, engineVerdict, reasonCodes }) {
  const { chain } = S;
  const fb = feedback.build({ cardId: S.job.card_id, market: S.job.market, asOf: S.asOf, labCandidateId: S.data.freeze.terms.candidate_id, terminalState,
    verdict: feedback.verdictClass({ terminalState, engineVerdict }), reasonCodes, chainHeadSha256: chain.links[chain.links.length - 1].sha256 });
  if (!fb.ok) return { reason: fb.reason_code, step: byName('FEEDBACK') };
  chain.add(11, { 'feedback.json': fb.feedback_text, 'feedback_facts.json': fb.facts_text }, 'feedback.json');
  return { terminal: { state: terminalState } };
}
/** A refusal in steps 8 to 10 still reaches the next review. */
function refuse(S, step, reason, { terminalState, reasonCodes }) {
  writeFeedback(S, { terminalState, engineVerdict: null, reasonCodes });
  return { reason, step };
}

/** Steps 8 to 11. */
function tail(S) {
  const { chain, data, services } = S;
  const exp = data.experiment; const terms = data.freeze.terms;
  const engine = services.engine || require('../promotion-engine');
  const common = { terms, ...bodies(S), as_of: S.asOf };
  const pre = (state, status, pendingReason, s2) => {
    chain.add(8, { 'verifier_pending.json': text({ schema: 'LAB_VERIFIER_PENDING_V1', status, reason: pendingReason, final_test: data.finalTest, earliest_holdout_read: HOLDOUT_NOT_BEFORE }) }, 'verifier_pending.json', status);
    const inputs = { schema: 'LAB_ENGINE_INPUTS_V1', ...common, terminal_state: state, seal: state === 'NOT_SELECTED_BY_VALIDATION' ? verdict.notSelectedSeal() : verdict.awaitingSeal(data.finalTest), ...(s2 ? { s2 } : {}) };
    const r = verdict.preHoldout(inputs, engine);
    if (!r.ok) return refuse(S, byName('VERDICT'), r.reason_code, { terminalState: 'REFUSED_AT_VERDICT', reasonCodes: [r.reason_code] });
    chain.add(9, { 'verdict.json': r.verdict_text, 'engine_inputs.json': text({ ...inputs, terminal_state: r.terminal_state, seal: r.seal }) }, 'verdict.json');
    chain.add(10, { 'seal.json': text({ schema: 'LAB_SEAL_V1', seal: r.seal, verdict_sha256: sha256(r.verdict_text) }) }, 'seal.json', status === 'NOT_APPLICABLE' ? 'DONE' : status);
    return writeFeedback(S, { terminalState: r.terminal_state, engineVerdict: r.engineVerdict, reasonCodes: r.engineVerdict ? r.verdict.engine.filter((e) => e.stage === 'S2')[0].reasonCodes : [pendingReason] });
  };
  if (!exp.selected) {
    const selection = JSON.parse(fs.readFileSync(path.join(chain.outDir, 'steps/07_EXPERIMENT/selection.json'), 'utf8'));
    const a = s2Evidence.fromSelection({ selection, candidateId: exp.candidate.id, minSampleN: terms.min_sample_n });
    const s2 = { classification: a.classification, body: a.body };
    if (a.classification === 'INSUFFICIENT') {
      const extra = typeof services.insufficientInputs === 'function' ? services.insufficientInputs({ candidate_id: terms.candidate_id }) : null;
      if (!extra) return { wait: 'INSUFFICIENT_INPUTS', step: byName('VERDICT') };
      s2.insufficient_inputs = extra;
    }
    return pre('NOT_SELECTED_BY_VALIDATION', 'NOT_APPLICABLE', 'NOT_SELECTED_BY_VALIDATION', s2);
  }
  if (data.finalTest.kind === 'FORWARD') return pre('FROZEN_AWAITING_FORWARD', 'PENDING_FORWARD', 'AWAITING_FORWARD');
  if (beforeHoldout(S.asOf)) return pre('FROZEN_AWAITING_HOLDOUT', 'PENDING_HOLDOUT', 'AWAITING_HOLDOUT');
  // after 2027-01-01 and a HOLDOUT final test: the exempt scorer must have scored it, and the evidence providers must have the rest
  if (!(services.holdoutScored || holdoutScoredDefault)(exp.round_id)) return { wait: 'HOLDOUT_SCORING', step: byName('VERIFY') };
  const view = { chain_candidate: exp.candidate, round_id: exp.round_id, k2_sha256: data.freeze.binding.k2_sha256, out_dir: chain.outDir };
  const ev = services.evidence && typeof services.evidence.verifier === 'function' ? services.evidence.verifier(view) : null;
  if (!ev) return { wait: 'VERIFIER_EVIDENCE', step: byName('VERIFY') };
  const k2Link = chain.links.find((l) => l.step === 6);
  const k2Ref = { path: `${path.dirname(k2Link.artifact_path)}/k2.frozen.md`, sha256: data.freeze.binding.k2_sha256 };
  const logRef = { path: 'steps/07_EXPERIMENT/access_log.jsonl', sha256: exp.files['access_log.jsonl'].sha256 };
  const familyId = data.freeze.binding.family_id;
  const bundle = verdict.assembleBundle({ chain: { candidateId: exp.candidate.id, candidateSha256: exp.candidate.sha256, market: S.job.market, familyId,
    mechanismId: data.mechanism.id, dedupeDecision: data.mechanism.route, accessLog: logRef, k2: k2Ref, unseenClaim: { from: data.finalTest.from, to: data.finalTest.to },
    segmentMarks: seen.marksFor({ familyId, seenRanges: data.seenRanges }) }, evidence: ev.bundle, asOf: S.asOf.slice(0, 10) });
  const base = verdict.engineS0S1(common, engine);
  if (!base.ok) return refuse(S, byName('VERDICT'), base.reason_code, { terminalState: 'REFUSED_AT_VERDICT', reasonCodes: [base.reason_code] });
  const [r0, r1] = base.results;
  const selection = JSON.parse(fs.readFileSync(path.join(chain.outDir, 'steps/07_EXPERIMENT/selection.json'), 'utf8'));
  const adapted = s2Evidence.fromSelection({ selection, candidateId: exp.candidate.id, minSampleN: terms.min_sample_n }).body;
  const dsr = ev.bundle && ev.bundle.v3 && ev.bundle.v3.overfit ? ev.bundle.v3.overfit.dsr : null;
  const stages = { ...(ev.stages || {}) };
  if (!stages.S2) stages.S2 = ev.s2 || { body: { ...adapted, dsr: typeof dsr === 'number' ? dsr : null } };
  const lad = ladder.run({ engine, terms, asOf: S.asOf, prior: [r0, r1].map((r) => ({ stage: r.stage, verdict: r.verdict, output_sha256: r.output_sha256 })), stages });
  if (lad.waiting) return { wait: lad.waiting, step: byName('VERDICT') };
  if (lad.invalid) return refuse(S, byName('VERDICT'), `LAB_VERDICT_${lad.invalid}`, { terminalState: 'REFUSED_AT_VERDICT', reasonCodes: [lad.invalid] });
  bundle.reachedS3 = lad.reachedS3; // V-6 runs only when S3 passed (amendment 2.1)
  const request = lad.lastRequest;
  const fromOut = (rel) => fs.readFileSync(path.join(chain.outDir, rel));
  const verifierCtx = { ...(ev.ctx || {}), promotionEngine: { s4: () => lad.s4 }, readBytes: (ref) => (ref.path === k2Ref.path || ref.path === logRef.path ? fromOut(ref.path) : ev.ctx.readBytes(ref)),
    authority: { ledgerFile: path.join(chain.outDir, 'steps/07_EXPERIMENT/holdout_grants.jsonl') } };
  const priorEngine = [r0, r1, ...lad.results.slice(0, -1)].map(verdict.summary);
  const d = verdict.decide({ bundle, verifierCtx, request, priorEngine, engine });
  const files = new Map(); // every file the verifier read, stored so the checker can re-run the verdict
  const stash = (b) => { for (const v of Object.values(b || {})) { if (Array.isArray(v)) v.forEach((x) => stash({ x })); else if (v && typeof v === 'object') { if (typeof v.path === 'string' && /^[0-9a-f]{64}$/.test(v.sha256 || '')) files.set(v.path, v); stash(v); } } };
  stash(bundle);
  if (d.verifier) {
    const stored = [];
    for (const ref of files.values()) {
      const bytes = verifierCtx.readBytes(ref);
      if (!bytes) continue;
      const rel = `steps/08_VERIFY/files/${sha256(ref.path).slice(0, 16)}`;
      fs.mkdirSync(path.join(chain.outDir, 'steps/08_VERIFY/files'), { recursive: true }); fs.writeFileSync(path.join(chain.outDir, rel), bytes);
      stored.push({ path: ref.path, sha256: ref.sha256, stored: rel });
    }
    S.data.storedFiles = stored;
    chain.add(8, { 'verifier_report.json': text(d.verifier.internal) }, 'verifier_report.json');
  }
  if (d.status !== 'DECIDED') {
    const verifierFail = d.reason_code.startsWith('LAB_VERIFY_') && d.verifier;
    return refuse(S, verifierFail ? byName('VERIFY') : byName('VERDICT'), d.reason_code,
      verifierFail ? { terminalState: 'VERIFIER_FAIL', reasonCodes: d.verifier.generator.reasonCodes } : { terminalState: 'REFUSED_AT_VERDICT', reasonCodes: [d.reason_code] });
  }
  const inputs = { schema: 'LAB_ENGINE_INPUTS_V1', ...common, terminal_state: d.verdict.terminal_state, seal: d.seal, post_holdout: { bundle, request, prior_engine: priorEngine, s4: lad.s4, files: S.data.storedFiles } };
  chain.add(9, { 'verdict.json': d.verdict_text, 'engine_inputs.json': text(inputs) }, 'verdict.json');
  chain.add(10, { 'seal.json': text({ schema: 'LAB_SEAL_V1', seal: d.seal, verdict_sha256: sha256(d.verdict_text) }) }, 'seal.json');
  return writeFeedback(S, { terminalState: d.verdict.terminal_state, engineVerdict: d.engine.verdict, reasonCodes: d.engine.reasonCodes });
}

function run(job, services = {}) {
  if (!isObj(job) || job.schema !== 'LAB_E2E_JOB_V1' || !CST_STAMP.test(job.as_of || '') || typeof job.out_dir !== 'string' || typeof job.card_id !== 'string' || !isObj(job.files)) {
    return { schema: 'LAB_RUN_RESULT_V1', status: 'REFUSED', terminal_state: null, stopped_at: null, reason_code: 'LAB_JOB_INVALID', waiting: null, links: [], chain_path: null, lineage_path: null };
  }
  const chain = new Chain(job.out_dir);
  const S = { job, services, asOf: job.as_of, chain, data: {} };
  const finish = (status, step, extra = {}) => {
    const header = { card_id: job.card_id, as_of: job.as_of, status, stopped_at: step ? step.name : null, reason_code: extra.reason_code || null, waiting: extra.waiting || null, terminal: extra.terminal || { state: status }, seen_ranges: S.data.seenRanges || null, final_test: S.data.finalTest || null };
    const chainPath = chain.writeChain(header);
    let lineagePath = null;
    if (status === 'COMPLETE') {
      lineagePath = path.join(job.out_dir, 'lineage.json');
      fs.writeFileSync(lineagePath, text(lineage.build({ outDir: job.out_dir, cardId: job.card_id, asOf: job.as_of, market: job.market, links: chain.links, terminal: { ...header.terminal, earliest_holdout_read: HOLDOUT_NOT_BEFORE }, seenRanges: header.seen_ranges, finalTest: header.final_test })));
    }
    return { schema: 'LAB_RUN_RESULT_V1', status, terminal_state: status === 'COMPLETE' ? header.terminal.state : null, stopped_at: header.stopped_at, reason_code: header.reason_code, waiting: header.waiting,
      links: chain.links, chain_path: chainPath, lineage_path: lineagePath };
  };
  for (let i = 0; i < steps.ORDER.length; i += 1) {
    const step = STEPS[i];
    const out = steps.ORDER[i](S);
    if (out.reason) return finish('REFUSED', step, { reason_code: out.reason });
    if (out.wait) return finish('WAITING_EXTERNAL', step, { waiting: out.wait });
    chain.add(step.n, out.files, out.primary);
  }
  S.data.seenRanges = seen.seenRangesOf(S.data.reviewRows);
  S.data.finalTest = seen.finalTestOf(S.data.seenRanges);
  const t = tail(S);
  if (t.reason) return finish('REFUSED', t.step, { reason_code: t.reason, terminal: { state: 'REFUSED' } });
  if (t.wait) return finish('WAITING_EXTERNAL', t.step, { waiting: t.wait });
  return finish('COMPLETE', null, { terminal: t.terminal });
}

module.exports = { STEPS, HOLDOUT_NOT_BEFORE, run, check: checker.check, verdict, seen, defaultLedger };
