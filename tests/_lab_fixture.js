'use strict';
/**
 * W24 fixture world (PLAN_V1_1_AMENDMENT_1 section 3): a synthetic AI review card, the AI's DSL batch and K2 draft as files, and the host-side services the
 * orchestrator calls (K2 freeze context and registrar, terms freezer, experiment executor, next-week fact pack). Every stage's real service runs on tiny
 * synthetic data: the AQ agent runtime (mock gateway), the DSL parser, the mechanism register, the K2 freeze program with the real trial-ledger registrar,
 * the RF1116 round runner on the 15-stock fixture. Must be required after ./_env. Used by tests/research_lab_e2e.test.js and tools/research-lab-compute-estimate.js.
 */
require('./_env');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');


const F = require('./_rq_agent_fixture');
const K = require('./_k2_freeze_fixture');
const P = require('./_promotion_fixture');
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const V = require('../services/research-queue-agent');
const causalityEvidence = require('../services/research-lab-e2e/causality-evidence');
const backtester = require('../services/research-lab-e2e/backtester');
const datasetRegistry = require('../services/dataset-registry');
const { canonicalJson } = require('../services/research-queue-agent/canon');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const accessLog = require('../services/independent-verifier/access-log');

const AUTH = K.AUTH; // the K2 fixture sets QRP_PRODUCT_MILESTONE_AUTHORITY; the round runner and the registrar share it
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const AS_OF = '2026-11-24T18:00:00+08:00';
const W47_DATE = '2026-11-20';
const HOLDOUT_PATH_DATE = '2026-09-14';
const MECH = K.MECH_OK; // CN_A, NORMAL_NO_PRIOR in the checked-in register
const FORMULAS = ['rank((-ret_1d))', 'nope(close_hfq)', 'rank( (-ret_1d) )', 'zscore((-ret_1d))', 'rank(pb)']; // scored, parse-refused, deduped, scored, scored
const CANDIDATE_FORMULA = FORMULAS[0];
const SCORED_FORMULAS = ['rank((-ret_1d))', 'zscore((-ret_1d))', 'rank((-ts_mean(ret_1d,5)))', 'rank(pb)', 'rank(ts_delta(close_hfq,1))', 'zscore(turnover_f)', 'rank((-ts_mean(ret_1d,3)))', 'rank((-ts_mean(ret_1d,10)))', 'rank(ret_1d)', 'zscore(ret_1d)']; // the scored round also has losers (the validation rule rejects them)

let FX = null;
function miningFixture() { if (!FX) FX = makeMiningDataFixture(tmp('qrp-w24-e2e-fx-')); return FX; }

const candidateFormulaCanonical = (text) => { const f = runner.loadFrozenSpace(); return require('../services/mining-sandbox/dsl').parse(text, f.dslSpace).canonical; };
/** A daily net return series of the existing CN_A book (read-only export), independent of the candidate. */
function existingBook() {
  const R = require('./_lab_replay_fixture');
  const rnd = R.mulberry32(99);
  return R.weekdays('2020-06-01', 1700).map((date) => ({ date, net: 0.0002 + (rnd() - 0.5) * 0.008 }));
}
/** The 5-attempt fixture round has too few scored candidates for a real DSR/PBO (the trial-ledger functions answer UNKNOWN): the e2e worlds inject V-3 statistics in the #146 provenance format. The real adapter is tested on the 10-candidate scored round. */
function syntheticV3({ dsr = 0.97 } = {}) {
  const files = []; const provenance = {};
  const record = (name, value) => { const trialRecordId = `TRL-${sha(`rec-${name}`).slice(0, 16)}`; const body = Buffer.from(`${canonicalJson({ trialRecordId, statistic: name, value })}\n`); const rel = `v3/${name}.json`; files.push({ path: rel, bytes: body }); provenance[name] = { trialRecordId, run: { path: rel, sha256: sha(body) } }; };
  record('dsr', dsr); record('pbo', 0.2); record('bhy', 0.001);
  return { v3: { familyTrialCount: 12, overfit: { dsr, n_trials: 12, pbo: 0.2, pbo_scope: 'ROUND_CANDIDATE_SET', bhy: { pValues: [0.001, 0.2, 0.5], index: 0 } }, provenance, priorHoldoutFailures: [] }, files };
}
const mockClient = (script) => ({ calls: [], async chat(req) { this.calls.push(req); const r = script.shift(); if (r === undefined) throw new Error('mock client: no more scripted responses'); return r; } });
const okResp = (obj) => ({ ok: true, status: 200, data: { model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }], usage: {} } });
const cardTask = () => ({ task_id: 'RQT-LINUX-20261124-aaaa1111', host: 'LINUX', agent_host: 'LINUX', kind: 'AI_REVIEW_CARD', market: 'CN_A', template_id: 'AI_REVIEW_CARD_V1', template_sha256: sha('tpl'), attempt_no: 1 });
const registry = () => F.makeRegistry({ mechanisms: [...F.makeRegistry().mechanisms, { mechanism_id: MECH, layer: 'SELECTION_TIMING', decision_point: 'SELECT' }] });
/** The review facts are dated `factDate`: W47 (2026-11-20) overlaps the RF1116 holdout 10-19..12-31 (SEEN, forward path); an earlier date does not (holdout path). */
const packOf = (factDate) => { const p = F.makePack(); return { ...p, facts: p.facts.map((f) => ({ ...f, at: `${factDate}T18:00:00+08:00` })) }; };
const bundleOf = (factDate = HOLDOUT_PATH_DATE) => ({ schema: 'RQ_AGENT_BUNDLE_V1', market: 'CN_A', week_id: '2026-W47', pack: packOf(factDate), registry: registry() });

/** The experiment executor: one RF1116 round on the fixture data, in this process, replaying the AI's batch (the test seam of the runner; the lane uses the CLI). */
function inProcessExecutor({ outDir, asOf, incident = false }) {
  const fx = miningFixture();
  const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
  return {
    execute({ formulas }) {
      const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 0 }, cap: formulas.length, openedAt: asOf });
      runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: sha(fs.readFileSync(path.join(fx.dirs.holdout, 'SHA256SUMS'))) });
      const file = runner.accessLogFile(outDir, r.round_id);
      const log = accessLog.writer(file);
      const gen = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => formulas.slice(view.mining_scores.length, view.mining_scores.length + n) };
      runner.internals.withGenerator(gen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir, registeredBy: AUTH, coverageFloor: { min_names_per_day: 5 }, accessLog: log }));
      runner.select({ roundId: r.round_id, sources: sources(), outDir, accessLog: log });
      // an attempt the read lock refused (what the launcher writes): an incident in the log, not a read
      if (incident) log.record({ principal: 'mining-generator', op: 'HOLDOUT_READ_REFUSED', dataset: 'HOLDOUT_DATA_DIR', from: '2026-10-19', to: '2026-12-31', code: 'VERIFIER_HOLDOUT_READ_REFUSED' });
      return { roundId: r.round_id, outDir, accessLogFile: file };
    },
  };
}

/**
 * @param {{asOf?: string, patch?: (parts: object) => void}} [o]
 * @returns {Promise<{job: object, services: object, work: string, outDir: string, spies: object, draft: object, card: object}>}
 */
async function buildWorld({ asOf = AS_OF, patch = null, factDate = HOLDOUT_PATH_DATE, formulas = FORMULAS, candidateFormula = CANDIDATE_FORMULA, incident = false, backtestRules = { rebalance: 'WEEKLY', quantile: 0.2 }, realBacktest = false, idleBook = 0 } = {}) {
  const work = tmp('qrp-w24-world-');
  process.env.QRP_DATA_DIR = path.join(work, 'data'); fs.mkdirSync(process.env.QRP_DATA_DIR);
  const outDir = path.join(work, 'out'); fs.mkdirSync(outDir);
  const inDir = path.join(work, 'in'); fs.mkdirSync(inDir);
  const triage = () => ({ route: 'NORMAL_NO_PRIOR', cite_seal_sha256: [] });
  const client = mockClient([okResp(F.makeCard({ factor_ideas: [F.goodIdea({ mechanism: MECH })] }))]);
  const result = await V.runAgentTask(cardTask(), bundleOf(factDate), { client, env: {}, host: 'LINUX', triage, now: () => '2026-11-24T09:00:00+08:00' });
  const write = (name, text) => { const p = path.join(inDir, name); fs.writeFileSync(p, text); return p; };
  const files = { card_result: write('card_result.json', `${canonicalJson(result)}\n`) };
  const reviewLog = path.join(inDir, 'review_agent_access_log.jsonl');
  accessLog.writer(reviewLog).record({ principal: 'review-agent', op: 'READ', dataset: 'REVIEW_FACT_PACK_V1', from: factDate, to: factDate });
  files.review_agent_access_log = reviewLog;
  const ideaId = result.outputs.factor_ideas[0].idea_id;
  files.dsl = write('dsl.json', `${canonicalJson({ schema: 'LAB_DSL_BATCH_V1', idea_id: ideaId, formulas, candidate_formula: candidateFormula, authored_by: { kind: 'AI_MINED_LLM', model: 'deepseek-pro' } })}\n`);
  // the registered star values with the NOTE_1 overlap default (0.7); AI-authored terms must equal them (Q3b)
  const STAR07 = JSON.parse(JSON.stringify(K.TERMS_STAR)); for (const L of Object.values(STAR07.by_layer)) L.thresholds.s4.max_overlap = 0.7;
  const dataToken = `DATA:${K.DATASET}@${K.pinned.registry_version}#${K.pinned.registry_sha256}|PIT=OBSERVED_AT|VENDOR=Tushare`;
  const ce0 = causalityEvidence.fromExpression({ formula: candidateFormulaCanonical(candidateFormula), dataInputs: [dataToken] });
  const baseD = K.baseDraft();
  const draft = K.baseDraft({ section0: { ...baseD.section0, mechanism_ids: [MECH] }, arms: baseD.arms.map((a) => ({ ...a, stage: 'SIGNAL' })),
    causality: { functions: causalityEvidence.functionIdsOf(candidateFormulaCanonical(candidateFormula)), evidence_sha256: ce0.sha256 },
    promotion_terms: { ...baseD.promotion_terms, layer: 'ALPHA', min_economic_value: STAR07.by_layer.ALPHA.min_economic_value, thresholds: STAR07.by_layer.ALPHA.thresholds } });
  files.k2_draft = write('k2_draft.json', `${canonicalJson(draft)}\n`);

  const spies = { executed: 0, registered: 0 };
  const k2Ctx = K.baseCtx({ promotionTermsStar: STAR07, evidenceBytes: (h) => (h === ce0.sha256 ? ce0.bytes : null), pinnedCodeShas: ce0.pinnedCodeShas });
  const services = {
    bundle: () => bundleOf(factDate),
    k2: {
      ctx: (phase) => (phase === 'PREPARE' ? k2Ctx : { ...k2Ctx, now: K.NOW_FREEZE, ledgerRows: K.ledgerRows() }),
      register: (prepared) => { spies.registered += 1; return K.registerAt(prepared); },
    },
    // default: a well-behaved synthetic replay output (the 15-stock fixture's own economics cannot pass S3 after costs); realBacktest: true runs the QRP backtester on the fixture tables
    backtest: { run: ({ formula, candidateId }) => { if (!realBacktest) { const rp = require('./_lab_replay_fixture').makeReplay({ days: 504 }); if (idleBook) { const keep = Math.round(rp.portfolio.without.length * (1 - idleBook)); rp.portfolio.without = rp.portfolio.without.map((x, i) => (i < keep ? x : { ...x, net: 0 })); } return { replay: rp }; } const fx = miningFixture();
      const r = backtester.run({ formula, candidateId, sources: [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })], rules: backtestRules,
        existingBook: existingBook(), market: 'CN_A', costBook: 'STOCK_BOOK', costModelRef: 'W24_QRP_BACKTEST_COSTS_V1' }); if (r.refusal) return { refusal: r.refusal };
      // the fixture's synthetic codes (S01.SH) carry no board prefix: map them to real-format codes for V-4's board and price-limit functions
      const seenCodes = new Map(); const real = (c) => { if (/^\d{6}\.(SH|SZ)$/.test(c)) return c; if (!seenCodes.has(c)) seenCodes.set(c, `${/SH$/.test(c) ? '60' : '00'}${String(seenCodes.size + 1).padStart(4, '0')}.${c.slice(-2)}`); return seenCodes.get(c); };
      return { replay: { ...r.replay, trades: r.replay.trades.map((t) => ({ ...t, code: real(t.code) })) } }; } },
    devEvidence: { v3: syntheticV3() },
    verifierGateOptions: { causality: { effectiveFrom: '2026-11-16T00:00:00+08:00' }, parity: { registry: [...datasetRegistry.history().values()].find((h) => h.registry_version === K.pinned.registry_version) || K.pinned } },
    experiment: (() => { const e = inProcessExecutor({ outDir: path.join(work, 'lane-out'), asOf, incident }); fs.mkdirSync(path.join(work, 'lane-out')); return { execute: (a) => { spies.executed += 1; return e.execute(a); } }; })(),
  };
  const job = { schema: 'LAB_E2E_JOB_V1', card_id: result.task_id, market: 'CN_A', as_of: asOf, out_dir: outDir, idea_id: ideaId,
    files: { card_result: files.card_result, review_agent_access_log: files.review_agent_access_log, dsl: files.dsl, k2_draft: files.k2_draft } };
  const world = { job, services, work, outDir, spies, draft, card: result, files, inDir };
  if (patch) patch(world);
  return world;
}

/** A scored round on the fixture (generate, select, mechanism review, holdout score through the exempt scorer, as of 2027-01-06): what the V-3 adapter reads. */
function scoredRound() {
  const fx = miningFixture();
  const root = tmp('qrp-w24-holdout-'); const v = { partial: path.join(root, 'partial'), complete: path.join(root, 'complete') };
  for (const d of Object.values(v)) fs.mkdirSync(d);
  const { internals: fi } = require('./_mining_data_fixture');
  for (const name of fs.readdirSync(fx.dirs.holdout).filter((n) => n.endsWith('.csv'))) {
    const rows = []; adapter.internals.forEachCsvRow(path.join(fx.dirs.holdout, name), (r) => rows.push(r));
    const cols = rows.length ? Object.keys(rows[0]) : fs.readFileSync(path.join(fx.dirs.holdout, name), 'utf8').split('\n')[0].split(',');
    const isCal = name === 'trading_calendar.csv'; const day = (r) => r.trade_date || r.business_date;
    const early = isCal ? rows : rows.filter((r) => day(r) <= '2026-11-17'); const late = isCal ? [] : rows.filter((r) => day(r) > '2026-11-17');
    for (const d of Object.values(v)) fs.writeFileSync(path.join(d, name), fi.csv(cols, early));
    if (!isCal) fs.writeFileSync(path.join(v.complete, name.replace(/\.csv$/, '_20270105.csv')), fi.csv(cols, late));
  }
  const sums = (dir) => { const files = fs.readdirSync(dir).filter((n) => n.endsWith('.csv')).sort(); fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${files.map((n) => `${sha(fs.readFileSync(path.join(dir, n)))}  ${n}`).join('\n')}\n`); };
  sums(v.partial); fs.copyFileSync(path.join(v.partial, 'SHA256SUMS'), path.join(v.complete, 'SHA256SUMS.sealed')); sums(v.complete);
  const out = process.env.QRP_DATA_DIR; const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
  const r = runner.requestRound({ generator: { mode: 'AI_MINED_GP', gp_seed: 5 }, cap: SCORED_FORMULAS.length, openedAt: '2026-11-21T02:00:00Z' });
  runner.sealHoldout({ roundId: r.round_id, dataRef: 'synthetic:holdout', dataSha256: sha(fs.readFileSync(path.join(v.partial, 'SHA256SUMS'))) });
  const log = accessLog.writer(runner.accessLogFile(out, r.round_id));
  const gen = { mode: 'AI_MINED_GP', seed: 0, params: { batch_size: 40 }, nextBatch: (view, { n }) => SCORED_FORMULAS.slice(view.mining_scores.length, view.mining_scores.length + n) };
  runner.internals.withGenerator(gen, () => runner.generate({ roundId: r.round_id, sources: sources(), outDir: out, registeredBy: AUTH, coverageFloor: { min_names_per_day: 5 }, accessLog: log }));
  const sel = runner.select({ roundId: r.round_id, sources: sources(), outDir: out, accessLog: log });
  require('./_mining_manifest').reviewAll(r.round_id);
  runner.scoreHoldout({ roundId: r.round_id, sources: sources(), holdoutDir: v.complete, outDir: out, scoredAt: '2027-01-06T10:00:00+08:00', holdoutFloor: { min_names_per_day: 5 }, accessLog: log });
  return { roundId: r.round_id, selected: sel.selected, selection: sel, outDir: out };
}

module.exports = { syntheticV3, SCORED_FORMULAS, scoredRound, W47_DATE, HOLDOUT_PATH_DATE, buildWorld, inProcessExecutor, miningFixture, AS_OF, MECH, FORMULAS, CANDIDATE_FORMULA, sha, canonicalJson, F, K, P, AUTH };
