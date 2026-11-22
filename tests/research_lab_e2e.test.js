'use strict';
/**
 * W24 AI Quant Research Lab end to end (PLAN_V1_1_AMENDMENT_1 section 3; parent plan W04 lineage check). Red first.
 * One full fixture chain, every stage's real service on tiny synthetic data:
 *   card (AQ agent runtime) -> FACTOR_IDEA -> mechanism dedupe (register) -> DSL (MINING_SPACE_V1) -> AI K2 draft -> K2 freeze program (+ terms seam)
 *   -> RF1116 round (dev + validation) -> verifier V-1..V-6 -> promotion engine -> seal -> feedback in the next fact pack.
 * Before 2027-01-01T00:00+08:00 the expected terminal state is FROZEN_AWAITING_HOLDOUT (RF1116: the holdout is read once, after 12-31).
 * Refusal cases: a generator holdout read, a missing lineage link, a discarded candidate missing from the ledger, a non-deterministic verdict.
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const W = require('./_lab_fixture');
const VF = require('./_verifier_fixture');
const lab = require('../services/research-lab-e2e');
const accessLog = require('../services/independent-verifier/access-log');
const engine = require('../services/promotion-engine');

const { buildWorld, AS_OF, F, P, sha } = W;
const read = (p) => fs.readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));
const STEPS = ['CARD', 'IDEA', 'MECHANISM', 'DSL', 'K2_DRAFT', 'K2_FREEZE', 'EXPERIMENT', 'VERIFY', 'VERDICT', 'SEAL', 'FEEDBACK'];
const verdictOf = (c, id) => c.conditions.find((x) => x.id === id);
const PASS5 = ['C1_COMPLETE_LINEAGE', 'C2_ALL_ATTEMPTS_IN_LEDGER', 'C3_NO_GENERATOR_HOLDOUT_ACCESS', 'C4_DETERMINISTIC_VERDICT', 'C5_FEEDBACK_IN_NEXT_PACK'];

let cached = null;
/** One shared complete run for the read-only assertions (each mutation test works on a copy of the output directory). */
async function complete() {
  if (!cached) { const w = await buildWorld(); const res = lab.run(w.job, w.services); cached = { w, res }; }
  return cached;
}
function copyOut(w, name) {
  const dest = path.join(w.work, name);
  fs.cpSync(w.outDir, dest, { recursive: true });
  return dest;
}

test('steps are fixed: the orchestrator order is the amendment chain', () => {
  assert.deepEqual(lab.STEPS.map((s) => s.name), STEPS);
  assert.deepEqual(lab.STEPS.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(lab.HOLDOUT_NOT_BEFORE, '2027-01-01T00:00:00+08:00');
});

test('full chain on the fixture: card to feedback, terminal FROZEN_AWAITING_HOLDOUT, 11 linked artifacts, every service called once, acceptance PASS x5', async () => {
  const w = await buildWorld();
  const res = lab.run(w.job, w.services);
  assert.equal(res.status, 'COMPLETE', JSON.stringify(res));
  assert.equal(res.terminal_state, 'FROZEN_AWAITING_HOLDOUT');
  assert.equal(res.reason_code, null);
  assert.deepEqual(w.spies, { executed: 1, termsCalls: 1, registered: 1 });
  const lineage = json(res.lineage_path);
  assert.equal(lineage.schema, 'LAB_LINEAGE_V1');
  assert.equal(lineage.card_id, w.card.task_id);
  assert.deepEqual(lineage.chain.map((l) => l.name), STEPS);
  assert.deepEqual(lineage.chain.map((l) => l.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  lineage.chain.forEach((l, i) => {
    assert.equal(l.prior_sha256, i === 0 ? null : lineage.chain[i - 1].sha256, `link ${l.step} binds the one before it`);
    assert.equal(sha(fs.readFileSync(path.join(w.outDir, l.artifact_path))), l.sha256, `link ${l.step} sha is the file's`);
    assert.ok(!path.isAbsolute(l.artifact_path) && !l.artifact_path.includes('..'));
  });
  assert.deepEqual(lineage.chain.filter((l) => l.status === 'PENDING_HOLDOUT').map((l) => l.name), ['VERIFY', 'SEAL'], 'only the steps that need the holdout are pending');
  // every attempt, discarded ones included, from the trial ledger
  assert.deepEqual(lineage.attempts.map((a) => a.status), ['SCORED', 'PARSE_REFUSED', 'DEDUPED', 'SCORED', 'SCORED']);
  assert.equal(lineage.attempts.length, W.FORMULAS.length);
  assert.ok(lineage.attempts.every((a) => /^TRL-[0-9a-f]{16}$/.test(a.trial_id) && /^[0-9a-f]{64}$/.test(a.formula_sha256)));
  // the holdout access log proves no generator access
  assert.equal(lineage.access_log.generator_holdout_reads, 0);
  assert.equal(lineage.access_log.holdout_reads, 0);
  assert.ok(lineage.access_log.rows >= 2);
  assert.match(lineage.access_log.sha256, /^[0-9a-f]{64}$/);
  assert.equal(lineage.review_agent_access_log.rows, 1);
  // the verdict bytes
  assert.equal(lineage.verdict.sha256, sha(Buffer.from(lineage.verdict.text)));
  assert.equal(sha(fs.readFileSync(path.join(w.outDir, lineage.verdict.path))), lineage.verdict.sha256);
  assert.equal(JSON.parse(lineage.verdict.text).terminal_state, 'FROZEN_AWAITING_HOLDOUT');
  assert.equal(lineage.terminal.state, 'FROZEN_AWAITING_HOLDOUT');
  assert.equal(lineage.terminal.earliest_holdout_read, '2027-01-01T00:00:00+08:00');

  const acc = lab.check({ out_dir: w.outDir, as_of: AS_OF, services: w.services });
  assert.equal(acc.schema, 'LAB_ACCEPTANCE_V1');
  assert.deepEqual(acc.conditions.map((c) => c.id), PASS5);
  assert.deepEqual(acc.conditions.map((c) => c.verdict), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'], JSON.stringify(acc.conditions));
  assert.equal(acc.terminal_state, 'FROZEN_AWAITING_HOLDOUT');
  assert.equal(acc.overall, 'PASS');
});

test('the K2 binding and promotion terms are real: the frozen K2 sha is in the lineage, the terms were frozen with it, S0 and S1 came from the engine', async () => {
  const { w, res } = await complete();
  const lineage = json(res.lineage_path);
  const k2 = json(path.join(w.outDir, lineage.chain[5].artifact_path));
  assert.equal(k2.schema, 'LAB_K2_BINDING_V1');
  assert.match(k2.k2_sha256, /^[0-9a-f]{64}$/);
  assert.equal(k2.promotion_terms.k2_sha256, k2.k2_sha256);
  assert.equal(k2.promotion_terms.terms_frozen_at, k2.k2_frozen_at);
  assert.equal(k2.validators.length, 14);
  assert.ok(k2.validators.every((v) => v.state === 'PASS'));
  assert.equal(k2.dsl_formula_sha256, json(path.join(w.outDir, lineage.chain[3].artifact_path)).candidate.formula_sha256);
  const verdict = JSON.parse(lineage.verdict.text);
  assert.deepEqual(verdict.engine.map((e) => [e.stage, e.verdict]), [['S0', 'PASS'], ['S1', 'PASS']]);
  assert.ok(verdict.engine.every((e) => /^[0-9a-f]{64}$/.test(e.output_sha256)));
  assert.equal(verdict.verifier, null, 'the verifier runs once the holdout has been read');
});

test('re-running the same inputs: nothing re-executes (the round is not opened twice) and the chain and verdict bytes are identical', async () => {
  const w = await buildWorld();
  const a = lab.run(w.job, w.services);
  const chainA = fs.readFileSync(a.chain_path); const verdictA = json(a.lineage_path).verdict.text;
  const b = lab.run(w.job, w.services);
  assert.equal(b.status, 'COMPLETE');
  assert.equal(w.spies.executed, 1, 'the experiment is memoised by its artifact');
  assert.ok(fs.readFileSync(b.chain_path).equals(chainA), 'chain.json is byte-identical');
  assert.equal(json(b.lineage_path).verdict.text, verdictA);
});

test('the orchestrator is deterministic: no clock read (source scan) and as_of is the only time input', () => {
  const dir = path.join(__dirname, '..', 'services', 'research-lab-e2e');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const t = read(path.join(dir, f));
    assert.equal(/Date\.now\(|new Date\(\)|performance\.now|process\.hrtime/.test(t), false, `${f} reads the clock`);
    assert.equal(/Math\.random|child_process|require\('(net|http|https|dns)'\)/.test(t), false, `${f}`);
  }
});

/* ----------------------------------------------------------------------- stops at the first refusal, with a reason code */

test('stops at the first refusal with a reason code; later steps never run', async () => {
  let w = await buildWorld();
  const result = json(w.files.card_result); result.status = 'BLOCKED_DETERMINISTIC'; fs.writeFileSync(w.files.card_result, JSON.stringify(result));
  let r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.reason_code], ['REFUSED', 'CARD', 'LAB_CARD_NOT_DONE']);
  assert.equal(w.spies.executed, 0);
  assert.equal(r.links.length, 0, 'no artifact is linked for a refused first step');

  w = await buildWorld();
  r = lab.run({ ...w.job, idea_id: 'FI-CN_A-2026-W47-9' }, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.reason_code], ['REFUSED', 'IDEA', 'LAB_IDEA_NOT_FOUND']);
  assert.deepEqual(r.links.map((l) => l.name), ['CARD']);

  w = await buildWorld();
  w.services.mechanism = { triage: () => ({ route: 'NOT_DO_SETTLED', cite_seal_sha256: ['a'.repeat(64)]}) };
  r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.reason_code], ['REFUSED', 'MECHANISM', 'LAB_MECHANISM_NOT_DO_SETTLED']);

  w = await buildWorld();
  const dsl = json(w.files.dsl); dsl.candidate_formula = 'nope(close_hfq)'; fs.writeFileSync(w.files.dsl, JSON.stringify(dsl));
  r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.reason_code], ['REFUSED', 'DSL', 'LAB_DSL_MINE_DSL_OPERATOR_NOT_WHITELISTED']);
  assert.equal(w.spies.registered, 0);

  w = await buildWorld();
  const draft = json(w.files.k2_draft); draft.scope.new_data_fetch = true; fs.writeFileSync(w.files.k2_draft, JSON.stringify(draft));
  r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at], ['REFUSED', 'K2_FREEZE']);
  assert.equal(r.reason_code, 'LAB_K2_FREEZE_PREREG_DATA_NEW_FETCH');
  assert.equal(w.spies.executed, 0, 'no experiment on an unfrozen K2');

  w = await buildWorld();
  w.services.promotionTerms = (f) => P.terms({ candidate_id: f.draft.draft_id, k2_sha256: 'b'.repeat(64), k2_frozen_at: f.k2_frozen_at, mechanism_ids: [W.MECH] });
  r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.reason_code], ['REFUSED', 'K2_FREEZE', 'LAB_TERMS_K2_MISMATCH']);
  assert.equal(w.spies.executed, 0);
});

test('legal waiting states are not refusals: the Mac registrar receipt and the Q3b terms freezer are external, the experiment does not start before them', async () => {
  let w = await buildWorld();
  w.services.k2.register = () => null;
  let r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.waiting], ['WAITING_EXTERNAL', 'K2_FREEZE', 'TRL_RECEIPT']);
  assert.equal(r.reason_code, null);
  w = await buildWorld();
  delete w.services.promotionTerms;
  r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.waiting], ['WAITING_EXTERNAL', 'K2_FREEZE', 'PROMOTION_TERMS']);
  assert.equal(w.spies.executed, 0);
});

/* ----------------------------------------------------------------------- acceptance checker: the four refusal cases */

test('refusal: a generator that reads the holdout is flagged (V-2 semantics), even when the read was refused; no other condition hides it', async () => {
  const { w, res } = await complete();
  const out = copyOut(w, 'out-gen-holdout');
  const lin = json(path.join(out, 'lineage.json'));
  accessLog.writer(path.join(out, lin.access_log.path)).record({ principal: 'mining-generator', op: 'HOLDOUT_READ', dataset: 'HOLDOUT_DATA_DIR', from: '2026-10-19', to: '2026-12-31', refused: true, code: 'VERIFIER_HOLDOUT_READ_REFUSED' });
  const acc = lab.check({ out_dir: out, as_of: AS_OF, services: w.services });
  const c3 = verdictOf(acc, 'C3_NO_GENERATOR_HOLDOUT_ACCESS');
  assert.equal(c3.verdict, 'FAIL');
  assert.ok(c3.codes.includes('V2_GENERATOR_HOLDOUT_READ'), JSON.stringify(c3.codes));
  assert.equal(acc.overall, 'FAIL');
  assert.equal(res.status, 'COMPLETE');
});

test('refusal: a review-agent log that touches anything but the fact pack, or a holdout row, fails C3', async () => {
  const { w } = await complete();
  const out = copyOut(w, 'out-review-log');
  const lin = json(path.join(out, 'lineage.json'));
  accessLog.writer(path.join(out, lin.review_agent_access_log.path)).record({ principal: 'review-agent', op: 'READ', dataset: 'V6_CN_STOCK_DAILY_BARS', from: '2026-11-01', to: '2026-11-20' });
  const c3 = verdictOf(lab.check({ out_dir: out, as_of: AS_OF, services: w.services }), 'C3_NO_GENERATOR_HOLDOUT_ACCESS');
  assert.equal(c3.verdict, 'FAIL');
  assert.ok(c3.codes.some((c) => c.startsWith('REVIEW_AGENT_READ_NOT_FACT_PACK')), JSON.stringify(c3.codes));
});

test('refusal: a missing lineage link fails C1 (link removed, artifact deleted, artifact edited, prior sha broken)', async () => {
  const { w } = await complete();
  const mutate = (name, fn) => {
    const out = copyOut(w, `out-${name}`);
    fn(out);
    return verdictOf(lab.check({ out_dir: out, as_of: AS_OF, services: w.services }), 'C1_COMPLETE_LINEAGE');
  };
  const chainFile = (out) => path.join(out, 'chain.json');
  let c1 = mutate('nolink', (out) => { const c = json(chainFile(out)); c.links = c.links.filter((l) => l.step !== 4); fs.writeFileSync(chainFile(out), JSON.stringify(c)); });
  assert.equal(c1.verdict, 'FAIL'); assert.ok(c1.codes.includes('LINEAGE_LINK_MISSING:4'), JSON.stringify(c1.codes));
  c1 = mutate('noartifact', (out) => { const c = json(chainFile(out)); fs.rmSync(path.join(out, c.links[2].artifact_path)); });
  assert.equal(c1.verdict, 'FAIL'); assert.ok(c1.codes.includes('LINEAGE_ARTIFACT_MISSING:3'), JSON.stringify(c1.codes));
  c1 = mutate('edited', (out) => { const c = json(chainFile(out)); fs.appendFileSync(path.join(out, c.links[1].artifact_path), ' '); });
  assert.equal(c1.verdict, 'FAIL'); assert.ok(c1.codes.includes('LINEAGE_SHA_MISMATCH:2'), JSON.stringify(c1.codes));
  c1 = mutate('prior', (out) => { const c = json(chainFile(out)); c.links[4].prior_sha256 = 'f'.repeat(64); fs.writeFileSync(chainFile(out), JSON.stringify(c)); });
  assert.equal(c1.verdict, 'FAIL'); assert.ok(c1.codes.includes('LINEAGE_PRIOR_MISMATCH:5'), JSON.stringify(c1.codes));
});

test('refusal: a discarded candidate missing from the trial ledger fails C2 (and a ledger that has them passes)', async () => {
  const { w } = await complete();
  process.env.QRP_DATA_DIR = path.join(w.work, 'data'); // the ledger of this world (other tests built other worlds since)
  const real = lab.defaultLedger();
  const without = (status) => ({ attemptsOfRound: (id) => real.attemptsOfRound(id).filter((a) => a.status !== status) });
  for (const status of ['PARSE_REFUSED', 'DEDUPED']) {
    const c2 = verdictOf(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: { ...w.services, ledger: without(status) } }), 'C2_ALL_ATTEMPTS_IN_LEDGER');
    assert.equal(c2.verdict, 'FAIL', status);
    assert.ok(c2.codes.some((c) => c.startsWith('ATTEMPT_NOT_IN_LEDGER:')), JSON.stringify(c2.codes));
  }
  assert.equal(verdictOf(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: { ...w.services, ledger: real } }), 'C2_ALL_ATTEMPTS_IN_LEDGER').verdict, 'PASS');
  // the generation log has an attempt the lineage does not list
  const out = copyOut(w, 'out-genlog');
  const lin = json(path.join(out, 'lineage.json'));
  const log = path.join(out, lin.generation_log.path);
  fs.appendFileSync(log, `${JSON.stringify({ candidate_id: 'MR-X:A999', text: 'rank(x)', canonical: null, status: 'PARSE_REFUSED', refusal: 'X', mining_score: null })}\n`);
  const c2 = verdictOf(lab.check({ out_dir: out, as_of: AS_OF, services: w.services }), 'C2_ALL_ATTEMPTS_IN_LEDGER');
  assert.equal(c2.verdict, 'FAIL');
});

test('refusal: a non-deterministic verdict fails C4 (verdict bytes edited; an engine that answers differently on a re-run)', async () => {
  const { w } = await complete();
  const out = copyOut(w, 'out-verdict');
  const lin = json(path.join(out, 'lineage.json'));
  const vf = path.join(out, lin.verdict.path);
  fs.writeFileSync(vf, read(vf).replace('FROZEN_AWAITING_HOLDOUT', 'SEALED_FORWARD_SHADOW'));
  let c4 = verdictOf(lab.check({ out_dir: out, as_of: AS_OF, services: w.services }), 'C4_DETERMINISTIC_VERDICT');
  assert.equal(c4.verdict, 'FAIL');
  assert.ok(c4.codes.includes('VERDICT_BYTES_CHANGED'), JSON.stringify(c4.codes));
  let n = 0;
  const flaky = { ...engine, evaluate: (req) => { const r = engine.evaluate(req); n += 1; return { ...r, output_sha256: sha(`run-${n}`) }; } };
  c4 = verdictOf(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: { ...w.services, engine: flaky } }), 'C4_DETERMINISTIC_VERDICT');
  assert.equal(c4.verdict, 'FAIL');
  assert.ok(c4.codes.includes('VERDICT_NOT_DETERMINISTIC'), JSON.stringify(c4.codes));
});

test('C5: feedback must be visible in the next fact pack; a producer pack without it fails, the producer pack that carries it passes', async () => {
  const { w } = await complete();
  const lin = json(path.join(w.outDir, 'lineage.json'));
  const labPack = json(path.join(w.outDir, lin.chain[10].artifact_path.replace('feedback.json', 'next_fact_pack.json')));
  const fact = labPack.facts[labPack.facts.length - 1];
  assert.equal(fact.id, 'F-006');
  assert.deepEqual(Object.keys(fact.value).sort(), ['candidate_id', 'reason_codes', 'terminal_state', 'verdict'], 'generator-facing: no metric of any kind');
  assert.equal(fact.value.verdict, 'pending');
  assert.equal(fact.value.terminal_state, 'FROZEN_AWAITING_HOLDOUT');
  assert.equal(require('../services/research-queue-agent').checkPack(labPack, { purpose: 'CARD', maxTokens: Infinity }).ok, true);
  const plain = verdictOf(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: { ...w.services }, next_pack: F.makePack({ week_id: '2026-W48' }) }), 'C5_FEEDBACK_IN_NEXT_PACK');
  assert.equal(plain.verdict, 'FAIL');
  assert.ok(plain.codes.includes('FEEDBACK_NOT_IN_NEXT_PACK'), JSON.stringify(plain.codes));
  const real = lab.check({ out_dir: w.outDir, as_of: AS_OF, services: w.services, next_pack: labPack });
  assert.equal(verdictOf(real, 'C5_FEEDBACK_IN_NEXT_PACK').verdict, 'PASS');
  assert.equal(real.next_pack_source, 'PRODUCER');
  const none = verdictOf(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: { ...w.services, nextPack: undefined } }), 'C5_FEEDBACK_IN_NEXT_PACK');
  assert.equal(none.verdict, 'PASS', 'the lab-written next pack is used when no producer pack exists yet, and the result says so');
  assert.equal(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: { ...w.services, nextPack: undefined } }).next_pack_source, 'LAB_OUTPUT');
});

/* ----------------------------------------------------------------------- holdout timing (RF1116) */

test('holdout timing: awaiting the holdout is the expected terminal state before 2027-01-01T00:00+08:00; after it, still awaiting is a FAIL; a holdout read before it fails C3', async () => {
  const { w } = await complete();
  const before = lab.check({ out_dir: w.outDir, as_of: '2026-12-31T23:59:59+08:00', services: w.services });
  assert.equal(verdictOf(before, 'C1_COMPLETE_LINEAGE').verdict, 'PASS');
  const after = lab.check({ out_dir: w.outDir, as_of: '2027-01-01T00:00:00+08:00', services: w.services });
  const c1 = verdictOf(after, 'C1_COMPLETE_LINEAGE');
  assert.equal(c1.verdict, 'FAIL');
  assert.ok(c1.codes.includes('AWAITING_HOLDOUT_PAST_DATE'));
  const out = copyOut(w, 'out-early-read');
  const lin = json(path.join(out, 'lineage.json'));
  accessLog.writer(path.join(out, lin.access_log.path)).record({ principal: 'holdout-scorer', op: 'HOLDOUT_READ', dataset: 'HOLDOUT_DATA_DIR', from: '2026-10-19', to: '2026-12-31', candidateSha256: lin.candidate.sha256 });
  const c3 = verdictOf(lab.check({ out_dir: out, as_of: AS_OF, services: w.services }), 'C3_NO_GENERATOR_HOLDOUT_ACCESS');
  assert.equal(c3.verdict, 'FAIL');
  assert.ok(c3.codes.includes('HOLDOUT_READ_BEFORE_2027_01_01'), JSON.stringify(c3.codes));
});

test('after 2027-01-01 the run proceeds to the verifier only once the holdout has been scored; until then it waits on HOLDOUT_SCORING (not a refusal)', async () => {
  const w = await buildWorld({ asOf: '2027-01-06T10:00:00+08:00' });
  const r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.waiting, r.reason_code], ['WAITING_EXTERNAL', 'VERIFY', 'HOLDOUT_SCORING', null]);
  assert.deepEqual(r.links.map((l) => l.name), STEPS.slice(0, 7), 'steps 1 to 7 are linked');
});

/* ----------------------------------------------------------------------- verifier + engine + seal (steps 8 to 10) */

function decideFixture({ verifier = {}, stage = 'S2', verdict = 'PASS', termsOver = {}, insufficient } = {}) {
  const v = VF.build(verifier);
  const terms = P.terms({ candidate_id: 'CAND-W24-001', k2_sha256: v.bundle.v1.files.k2.sha256, ...termsOver });
  const request = P.request(stage, verdict, { terms, ...(insufficient ? { insufficient } : {}) });
  return { bundle: v.bundle, verifierCtx: v.ctx, request };
}

test('verdict (steps 8 to 10): verifier pass, engine verdict, seal destination; the same inputs give the same bytes', () => {
  const a = lab.verdict.decide(decideFixture());
  assert.equal(a.status, 'DECIDED', JSON.stringify(a));
  assert.equal(a.verifier.generator.verdict, 'pass');
  assert.deepEqual(Object.keys(a.verifier.generator).sort(), ['candidateId', 'reasonCodes', 'verdict'], 'generator-facing keys only');
  assert.deepEqual([a.engine.stage, a.engine.verdict, a.engine.nextAction], ['S2', 'PASS', 'PROCEED_TO_S3']);
  assert.equal(a.seal.destination, 'FORWARD_SHADOW');
  const b = lab.verdict.decide(decideFixture());
  assert.equal(b.verdict_text, a.verdict_text, 'byte-identical on a re-run');
  assert.equal(JSON.parse(a.verdict_text).seal.destination, 'FORWARD_SHADOW');
});

test('verdict: the verifier stops the chain at its first failing check, with its reason code; the engine is not asked', () => {
  const d = decideFixture({ verifier: { v3: (t) => { t.overfit.dsr = 0.5; } } });
  let asked = 0;
  const r = lab.verdict.decide({ ...d, engine: { ...engine, evaluate: (q) => { asked += 1; return engine.evaluate(q); } } });
  assert.deepEqual([r.status, r.reason_code], ['REFUSED', 'LAB_VERIFY_V3_MINE_DSR_BELOW_MIN']);
  assert.equal(asked, 0);
  assert.equal(r.verifier.generator.verdict, 'fail');
  const gen = decideFixture({ verifier: { accessRows: [{ principal: 'mining-generator', op: 'HOLDOUT_READ', dataset: 'V6_CN_STOCK_DAILY_BARS', from: '2026-10-19', to: '2026-12-31' }] } });
  assert.equal(lab.verdict.decide(gen).reason_code, 'LAB_VERIFY_V2_GENERATOR_HOLDOUT_READ');
});

test('verdict: engine FAIL seals to the failure library; engine INSUFFICIENT is 做 (forward shadow) or 暂停 (PAUSE), never the failure library; verifier K2 must be the frozen K2', () => {
  assert.equal(lab.verdict.decide(decideFixture({ verdict: 'FAIL' })).seal.destination, 'FAILURE_LIBRARY');
  const cont = lab.verdict.decide(decideFixture({ verdict: 'INSUFFICIENT' }));
  assert.deepEqual([cont.engine.nextAction, cont.seal.destination], ['RUN_TO_REVIEW_ENDPOINT', 'FORWARD_SHADOW']);
  const pause = lab.verdict.decide(decideFixture({ verdict: 'INSUFFICIENT', insufficient: P.insuff({ effect_ci: { lower: -0.03, upper: -0.01 } }) }));
  assert.deepEqual([pause.engine.nextAction, pause.seal.destination], ['PAUSE_UNTIL_RESUME_CONDITION', 'PAUSE']);
  assert.equal(pause.engine.resolution.conclusion, '暂停');
  const d = decideFixture();
  d.request = { ...d.request, terms: { ...d.request.terms, k2_sha256: 'c'.repeat(64) } };
  assert.equal(lab.verdict.decide(d).reason_code, 'LAB_VERIFY_K2_BINDING');
});

test('verifier input that the lab assembles: candidate, K2 and access log come from the chain, the evidence provider cannot override them', () => {
  const d = decideFixture();
  const bundle = lab.verdict.assembleBundle({ chain: { candidateId: 'MR-X:A001', candidateSha256: 'd'.repeat(64), market: 'CN_A', familyId: 'CN_A_H5', mechanismId: W.MECH, dedupeDecision: 'NORMAL_NO_PRIOR',
    accessLog: { path: 'steps/07/access_log.jsonl', sha256: 'e'.repeat(64) }, k2: d.bundle.v1.files.k2 }, evidence: { ...d.bundle, candidateId: 'EVIL', candidateSha256: '0'.repeat(64), v2: { accessLog: { path: 'x', sha256: '1'.repeat(64) } } }, asOf: '2027-01-06' });
  assert.equal(bundle.candidateId, 'MR-X:A001');
  assert.equal(bundle.candidateSha256, 'd'.repeat(64));
  assert.equal(bundle.v2.accessLog.sha256, 'e'.repeat(64));
  assert.equal(bundle.v1.files.k2.sha256, d.bundle.v1.files.k2.sha256);
  assert.equal(bundle.asOf, '2027-01-06');
});
