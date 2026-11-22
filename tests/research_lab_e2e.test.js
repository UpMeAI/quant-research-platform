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
const { spawnSync } = require('child_process');
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
  assert.deepEqual(w.spies, { executed: 1, registered: 1 });
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
  assert.deepEqual(lineage.chain.filter((l) => l.status === 'PENDING_HOLDOUT').map((l) => l.name), ['SEAL'], 'S2 to S4 and the verifier ran on dev + validation; only S5 (the holdout) is pending');
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
  assert.deepEqual(lineage.seen_ranges, [{ from: W.HOLDOUT_PATH_DATE, to: W.HOLDOUT_PATH_DATE, source: 'REVIEW_CARD' }], 'the fact range the card read is SEEN for the candidate');
  assert.equal(lineage.final_test.kind, 'HOLDOUT');
  assert.deepEqual(lineage.incidents, []);

  const nextBundle = mergeViaProducer(w.services.bundle(), json(path.join(w.outDir, path.dirname(lineage.chain[10].artifact_path), 'feedback_facts.json')));
  const acc = lab.check({ out_dir: w.outDir, as_of: AS_OF, services: w.services, next_bundle: nextBundle });
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
  assert.deepEqual(verdict.engine.map((e) => [e.stage, e.verdict]), [['S0', 'PASS'], ['S1', 'PASS'], ['S2', 'PASS'], ['S3', 'PASS'], ['S4', 'PASS']], 'NOTE_1: S2 -> S3 -> S4 on dev + validation before S5');
  assert.ok(verdict.engine.every((e) => /^[0-9a-f]{64}$/.test(e.output_sha256)));
  assert.equal(verdict.verifier.generator.verdict, 'pass', 'V-1..V-6 ran before S5');
  assert.deepEqual(Object.keys(verdict.verifier.generator).sort(), ['candidateId', 'reasonCodes', 'verdict']);
  assert.equal(verdict.seal.destination, 'AWAIT_HOLDOUT');
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
    // backtester.js measures wall time with hrtime for the compute estimate; the measurement is returned outside `replay` and never feeds a verdict
    if (f !== 'backtester.js') assert.equal(/Date\.now\(|new Date\(\)|performance\.now|process\.hrtime/.test(t), false, `${f} reads the clock`);
    // causality-evidence.js asks git (a pinned commit, read-only) whether operators.js is unchanged since the operator evidence; the answer is deterministic
    assert.equal(/Math\.random|require\('(net|http|https|dns)'\)/.test(t) || (f !== 'causality-evidence.js' && /child_process/.test(t)), false, `${f}`);
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
  const noTerms = json(w.files.k2_draft); delete noTerms.promotion_terms; fs.writeFileSync(w.files.k2_draft, JSON.stringify(noTerms));
  r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.reason_code], ['REFUSED', 'K2_FREEZE', 'LAB_K2_FREEZE_PREREG_TERMS_SHA_MISSING'], 'Q3b: a draft without promotion terms cannot be frozen');
  assert.equal(w.spies.executed, 0);
});

test('legal waiting states are not refusals: the Mac registrar receipt is external, the experiment does not start before it', async () => {
  let w = await buildWorld();
  w.services.k2.register = () => null;
  let r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.waiting], ['WAITING_EXTERNAL', 'K2_FREEZE', 'TRL_RECEIPT']);
  assert.equal(r.reason_code, null);
  assert.equal(w.spies.executed, 0);
});

/* ----------------------------------------------------------------------- acceptance checker: the four refusal cases */

test('refusal: a generator that SUCCESSFULLY reads the holdout fails C3; a refused attempt is an incident (listed, not a read) and C3 still passes', async () => {
  const { w } = await complete();
  let out = copyOut(w, 'out-gen-holdout');
  let lin = json(path.join(out, 'lineage.json'));
  accessLog.writer(path.join(out, lin.access_log.path)).record({ principal: 'mining-generator', op: 'HOLDOUT_READ', dataset: 'HOLDOUT_DATA_DIR', from: '2026-10-19', to: '2026-12-31' });
  const bad = verdictOf(lab.check({ out_dir: out, as_of: AS_OF, services: w.services }), 'C3_NO_GENERATOR_HOLDOUT_ACCESS');
  assert.equal(bad.verdict, 'FAIL');
  assert.ok(bad.codes.includes('V2_GENERATOR_HOLDOUT_READ'), JSON.stringify(bad.codes));
  const w2 = await buildWorld({ incident: true });
  const res2 = lab.run(w2.job, w2.services);
  assert.equal(res2.status, 'COMPLETE');
  const c3 = verdictOf(lab.check({ out_dir: w2.outDir, as_of: AS_OF, services: w2.services }), 'C3_NO_GENERATOR_HOLDOUT_ACCESS');
  assert.equal(c3.verdict, 'PASS', JSON.stringify(c3));
  assert.equal(c3.incidents.length, 1, 'every attempt is listed');
  assert.deepEqual([c3.incidents[0].principal, c3.incidents[0].op, c3.incidents[0].code], ['mining-generator', 'HOLDOUT_READ_REFUSED', 'VERIFIER_HOLDOUT_READ_REFUSED']);
  assert.equal(json(res2.lineage_path).incidents.length, 1, 'the lineage report has an incidents section');
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

/** The Q1 producer (services/research-queue/rq/producer.py) merges the lab's facts file into the next card's bundle; the test calls the producer, not a copy of it. */
function mergeViaProducer(bundle, feedbackFacts) {
  const r = spawnSync('python3', ['-c', `import sys, json
sys.path.insert(0, 'services/research-queue')
from rq import producer
d = json.load(sys.stdin)
d['bundle']['pack'] = producer.merge_lab_feedback(d['bundle']['pack'], [d['facts']])
print(json.dumps(d['bundle']))`], { cwd: path.join(__dirname, '..'), input: JSON.stringify({ bundle, facts: feedbackFacts }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('C5: the lab writes LAB_FEEDBACK_FACTS_V1 for the queue intake; the Q1 producer merges it into the next card bundle with its own ids; C5 checks that bundle cites it', async () => {
  const { w } = await complete();
  const lin = json(path.join(w.outDir, 'lineage.json'));
  const dir = path.dirname(lin.chain[10].artifact_path);
  const facts = json(path.join(w.outDir, dir, 'feedback_facts.json'));
  assert.equal(facts.schema, 'LAB_FEEDBACK_FACTS_V1');
  assert.equal(facts.facts.length, 1);
  assert.ok(!('id' in facts.facts[0]), 'ids belong to the producer');
  assert.deepEqual(Object.keys(facts.facts[0].value).sort(), ['candidate_id', 'limits', 'reason_codes', 'terminal_state', 'verdict'], 'generator-facing: no metric of any kind (limits are labels)');
  assert.equal(facts.facts[0].value.verdict, 'pending');
  const base = w.services.bundle();
  const merged = mergeViaProducer(base, facts);
  assert.equal(merged.pack.facts.length, base.pack.facts.length + 1);
  assert.equal(merged.pack.facts[merged.pack.facts.length - 1].id, 'F-006');
  assert.equal(require('../services/research-queue-agent').checkPack(merged.pack, { purpose: 'CARD', maxTokens: Infinity }).ok, true);
  const good = lab.check({ out_dir: w.outDir, as_of: AS_OF, services: w.services, next_bundle: merged });
  assert.equal(verdictOf(good, 'C5_FEEDBACK_IN_NEXT_PACK').verdict, 'PASS', JSON.stringify(verdictOf(good, 'C5_FEEDBACK_IN_NEXT_PACK')));
  const plain = verdictOf(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: w.services, next_bundle: base }), 'C5_FEEDBACK_IN_NEXT_PACK');
  assert.equal(plain.verdict, 'FAIL');
  assert.ok(plain.codes.includes('FEEDBACK_NOT_IN_NEXT_BUNDLE'), JSON.stringify(plain.codes));
  const none = verdictOf(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: w.services }), 'C5_FEEDBACK_IN_NEXT_PACK');
  assert.equal(none.verdict, 'FAIL');
  assert.ok(none.codes.includes('NEXT_BUNDLE_NOT_PROVIDED'));
  const out = copyOut(w, 'out-bad-facts');
  fs.writeFileSync(path.join(out, dir, 'feedback_facts.json'), '{}');
  assert.ok(verdictOf(lab.check({ out_dir: out, as_of: AS_OF, services: w.services, next_bundle: merged }), 'C5_FEEDBACK_IN_NEXT_PACK').codes.includes('FEEDBACK_FACTS_INVALID'));
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

/* ----------------------------------------------------------------------- plan-coord rulings 11-23: SEEN by review, forward path, NOT_SELECTED, feedback always */

test('ruling 1: a candidate born from the W47 card (facts SEEN, overlapping the RF1116 holdout) cannot use that holdout: its terminal path is FORWARD, recorded in the lineage, and the checker expects it', async () => {
  const w = await buildWorld({ factDate: W.W47_DATE });
  const res = lab.run(w.job, w.services);
  assert.equal(res.status, 'COMPLETE', JSON.stringify(res));
  assert.equal(res.terminal_state, 'FROZEN_AWAITING_FORWARD');
  const lin = json(res.lineage_path);
  assert.deepEqual(lin.seen_ranges, [{ from: W.W47_DATE, to: W.W47_DATE, source: 'REVIEW_CARD' }]);
  assert.deepEqual(lin.final_test, { kind: 'FORWARD', from: '2026-11-21', reason: 'SEEN_OVERLAPS_RF1116_HOLDOUT' });
  assert.deepEqual(lin.chain.filter((l) => l.status === 'PENDING_FORWARD').map((l) => l.name), ['SEAL']);
  assert.equal(JSON.parse(lin.verdict.text).seal.destination, 'AWAIT_FORWARD');
  const bundle = w.services.bundle();
  for (const at of [AS_OF, '2027-03-01T00:00:00+08:00']) {
    const acc = lab.check({ out_dir: w.outDir, as_of: at, services: w.services, next_bundle: bundle });
    assert.deepEqual(['C1_COMPLETE_LINEAGE', 'C2_ALL_ATTEMPTS_IN_LEDGER', 'C3_NO_GENERATOR_HOLDOUT_ACCESS', 'C4_DETERMINISTIC_VERDICT'].map((id) => verdictOf(acc, id).verdict), ['PASS', 'PASS', 'PASS', 'PASS'], `${at} ${JSON.stringify(acc.conditions)}`);
  }
  // the exempt scorer reading the RF1116 holdout for this candidate is a final test on SEEN data
  const out = copyOut(w, 'out-seen-holdout');
  accessLog.writer(path.join(out, lin.access_log.path)).record({ principal: 'holdout-scorer', op: 'HOLDOUT_READ', dataset: 'CN_A_HOLDOUT_R1', from: '2026-10-19', to: '2026-12-31', candidateSha256: lin.candidate.sha256 });
  const c3 = verdictOf(lab.check({ out_dir: out, as_of: '2027-02-01T00:00:00+08:00', services: w.services }), 'C3_NO_GENERATOR_HOLDOUT_ACCESS');
  assert.equal(c3.verdict, 'FAIL');
  assert.ok(c3.codes.includes('FINAL_TEST_OVERLAPS_SEEN'), JSON.stringify(c3.codes));
  // after 2027-01-01 the run does not wait for holdout scoring: the forward path has its own wait
  const w2 = await buildWorld({ factDate: W.W47_DATE, asOf: '2027-01-06T10:00:00+08:00' });
  assert.equal(lab.run(w2.job, w2.services).terminal_state, 'FROZEN_AWAITING_FORWARD');
});

test('ruling 1 (W05 semantics): the holdout-path claim goes through V-2 UNSEEN marks built from the lineage SEEN ranges', async () => {
  const { w } = await complete();
  const lin = json(path.join(w.outDir, 'lineage.json'));
  const marks = lab.seen.marksFor({ familyId: 'X', seenRanges: [{ from: '2026-10-25', to: '2026-10-25', source: 'REVIEW_CARD' }] });
  const trials = require('../services/trial-ledger');
  const pieces = trials.segmentsFor('X', '2026-10-19', '2026-12-31', { marks }).pieces;
  assert.ok(pieces.some((p) => p.label === 'SEEN' && p.from === '2026-10-25'), 'the seen day is SEEN inside the holdout');
  assert.ok(pieces.some((p) => p.label === 'UNSEEN'), 'the rest of the holdout is UNSEEN');
  assert.equal(lab.seen.finalTestOf([{ from: '2026-09-14', to: '2026-09-14' }]).kind, 'HOLDOUT');
  assert.deepEqual(lab.seen.finalTestOf([{ from: '2026-12-31', to: '2026-12-31' }]), { kind: 'FORWARD', from: '2027-01-01', reason: 'SEEN_OVERLAPS_RF1116_HOLDOUT' });
  assert.equal(lin.final_test.kind, 'HOLDOUT');
});

test('ruling 3: not selected by the validation rule is S2 FAIL (不做) with that reason code, sealed to the failure library, and feedback says fail', async () => {
  const w = await buildWorld({ formulas: ['rank(ret_1d)', 'rank((-ret_1d))', 'zscore((-ret_1d))', 'rank(pb)', 'rank(amount)'], candidateFormula: 'rank(ret_1d)' });
  const res = lab.run(w.job, w.services);
  assert.equal(res.status, 'COMPLETE', JSON.stringify(res));
  assert.equal(res.terminal_state, 'NOT_SELECTED_BY_VALIDATION');
  const verdict = JSON.parse(json(res.lineage_path).verdict.text);
  const s2 = verdict.engine.find((e) => e.stage === 'S2');
  assert.deepEqual([s2.verdict, s2.nextAction, s2.reasonCodes], ['FAIL', 'SEAL_NOT_DO_TO_FAILURE_LIBRARY', ['S2_NOT_SELECTED_BY_VALIDATION']]);
  assert.equal(verdict.seal.destination, 'FAILURE_LIBRARY');
  const lin = json(res.lineage_path);
  assert.equal(json(path.join(w.outDir, path.dirname(lin.chain[10].artifact_path), 'feedback_facts.json')).facts[0].value.verdict, 'fail');
  const merged = mergeViaProducer(w.services.bundle(), json(path.join(w.outDir, path.dirname(lin.chain[10].artifact_path), 'feedback_facts.json')));
  const acc = lab.check({ out_dir: w.outDir, as_of: AS_OF, services: w.services, next_bundle: merged });
  assert.equal(acc.overall, 'PASS', JSON.stringify(acc.conditions));
});

test('ruling 5: a verifier FAIL still writes feedback (last step); C5 checks it; the run is REFUSED with the verifier reason code', async () => {
  const w = await buildWorld();
  w.services.devEvidence = { v3: W.syntheticV3({ dsr: 0.5 }), stages: { S2: { body: P.BODY.S2.PASS } } }; // the S2 stage forced to PASS so that the verifier is what stops the chain
  const r = lab.run(w.job, w.services);
  assert.deepEqual([r.status, r.stopped_at, r.reason_code], ['REFUSED', 'VERIFY', 'LAB_VERIFY_V3_MINE_DSR_BELOW_MIN']);
  assert.equal(r.links[r.links.length - 1].name, 'FEEDBACK', 'feedback is always the last step');
  const dir = path.dirname(r.links[r.links.length - 1].artifact_path);
  const facts = json(path.join(w.outDir, dir, 'feedback_facts.json'));
  assert.equal(facts.facts[0].value.verdict, 'fail');
  assert.equal(facts.facts[0].value.terminal_state, 'VERIFIER_FAIL');
  assert.ok(facts.facts[0].value.reason_codes[0].startsWith('V3_'));
  const merged = mergeViaProducer(w.services.bundle(), facts);
  assert.equal(verdictOf(lab.check({ out_dir: w.outDir, as_of: AS_OF, services: w.services, next_bundle: merged }), 'C5_FEEDBACK_IN_NEXT_PACK').verdict, 'PASS');
});

test('NOTE_1: S3 fails on the fixture tables with the real QRP backtester: the candidate is sealed to the failure library before any holdout, with S2 PASS and S3 FAIL in the verdict; feedback says fail', async () => {
  const w = await buildWorld({ realBacktest: true });
  const r = lab.run(w.job, w.services);
  assert.equal(r.status, 'COMPLETE', JSON.stringify(r));
  assert.equal(r.terminal_state, 'SEALED_FAILURE_LIBRARY');
  const verdict = JSON.parse(json(r.lineage_path).verdict.text);
  const stages = verdict.engine.map((e) => [e.stage, e.verdict]);
  assert.deepEqual(stages, [['S0', 'PASS'], ['S1', 'PASS'], ['S2', 'PASS'], ['S3', 'FAIL']]);
  assert.equal(verdict.verifier, null, 'the verifier gates the move to S5; a candidate that failed S3 gets the engine verdict');
  assert.equal(verdict.seal.destination, 'FAILURE_LIBRARY');
  assert.equal(json(r.lineage_path).chain[7].status, 'NOT_APPLICABLE');
  assert.ok(fs.existsSync(path.join(w.outDir, 'steps/07_EXPERIMENT/replay_output.json')), 'the replay output was written inside QRP from the round tables');
});

/* ----------------------------------------------------------------------- NOTE_1 follow-up: S5 holdout is 3-way, idle existing book is visible */

async function s5World(outcome, { insufficient = true } = {}) {
  const w = await buildWorld({ asOf: '2027-01-06T10:00:00+08:00' });
  w.services.holdoutScored = () => true;
  w.services.holdoutOutcome = () => outcome;
  if (insufficient) w.services.insufficientInputs = () => P.insuff();
  return { w, r: lab.run(w.job, w.services) };
}
const verdictText = (w, r) => JSON.parse(json(r.lineage_path).verdict.text);

test('S5 holdout, 3-way (Owner: insufficient is never a rejection): G-MINE PASS is S5 PASS; FAIL with the required sample is S5 FAIL (不做); short of sample or power is S5 INSUFFICIENT resolved by section 4.2', async () => {
  const pass = await s5World({ pass: true, sufficient: true });
  assert.equal(pass.r.status, 'COMPLETE', JSON.stringify(pass.r));
  let v = verdictText(pass.w, pass.r);
  assert.deepEqual(v.engine.filter((e) => e.stage === 'S5').map((e) => e.verdict), ['PASS']);
  assert.equal(pass.r.terminal_state, 'SEALED_FORWARD_SHADOW');

  const fail = await s5World({ pass: false, sufficient: true });
  v = verdictText(fail.w, fail.r);
  assert.deepEqual(v.engine.filter((e) => e.stage === 'S5').map((e) => [e.verdict, e.nextAction]), [['FAIL', 'SEAL_NOT_DO_TO_FAILURE_LIBRARY']]);
  assert.equal(fail.r.terminal_state, 'SEALED_FAILURE_LIBRARY');

  const short = await s5World({ pass: false, sufficient: false });
  v = verdictText(short.w, short.r);
  const s5 = v.engine.find((e) => e.stage === 'S5');
  assert.equal(s5.verdict, 'INSUFFICIENT', 'short of sample or power is never a rejection');
  assert.notEqual(v.seal.destination, 'FAILURE_LIBRARY');
  assert.ok(['FORWARD_SHADOW', 'PAUSE'].includes(v.seal.destination), v.seal.destination);
  assert.equal(short.r.terminal_state === 'SEALED_FAILURE_LIBRARY', false);
  const factsDir = path.dirname(short.r.links[short.r.links.length - 1].artifact_path);
  assert.equal(json(path.join(short.w.outDir, factsDir, 'feedback_facts.json')).facts[0].value.verdict, 'pending');
});

test('S5 INSUFFICIENT needs the section 4.2 inputs from the host: without them the run waits (INSUFFICIENT_INPUTS), it does not guess and does not reject', async () => {
  const { r } = await s5World({ pass: false, sufficient: false }, { insufficient: false });
  assert.deepEqual([r.status, r.waiting], ['WAITING_EXTERNAL', 'INSUFFICIENT_INPUTS']);
});

test('default holdout outcome: sufficient only when the holdout IC days reach the K2 min_sample_n; G-MINE pass from the record (unit)', () => {
  const o = lab.holdoutOutcome.fromScore({ record: { pass: true }, result: { holdout: { ic_days: 50 } }, minSampleN: 32 });
  assert.deepEqual(o, { pass: true, sufficient: true });
  assert.deepEqual(lab.holdoutOutcome.fromScore({ record: { pass: false }, result: { holdout: { ic_days: 20 } }, minSampleN: 32 }), { pass: false, sufficient: false });
  assert.deepEqual(lab.holdoutOutcome.fromScore({ record: { pass: false }, result: { holdout: { ic_days: 60 } }, minSampleN: 32 }), { pass: false, sufficient: true });
  assert.deepEqual(lab.holdoutOutcome.fromScore({ record: { pass: false }, result: { holdout: { ic_days: null } }, minSampleN: 32 }), { pass: false, sufficient: false }, 'unknown is not enough');
});

test('idle existing book: S4 carries existing_book_active_share and, below 20%, limitation EXISTING_BOOK_MOSTLY_IDLE; it reaches the verdict limits and the feedback fact; the decision still rests on the marginal contribution', async () => {
  const w = await buildWorld({ idleBook: 0.807 });
  const r = lab.run(w.job, w.services);
  assert.equal(r.status, 'COMPLETE', JSON.stringify(r));
  const v = verdictText(w, r);
  assert.deepEqual(v.limits, ['EXISTING_BOOK_MOSTLY_IDLE']);
  assert.equal(v.engine.find((e) => e.stage === 'S4').verdict, 'PASS', 'the S4 decision is the marginal net contribution');
  const dir = path.dirname(r.links[r.links.length - 1].artifact_path);
  assert.deepEqual(json(path.join(w.outDir, dir, 'feedback_facts.json')).facts[0].value.limits, ['EXISTING_BOOK_MOSTLY_IDLE']);
  const clean = await complete();
  assert.deepEqual(JSON.parse(json(clean.res.lineage_path).verdict.text).limits, []);
});
