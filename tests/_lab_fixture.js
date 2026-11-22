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
const { canonicalJson } = require('../services/research-queue-agent/canon');
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const accessLog = require('../services/independent-verifier/access-log');

const AUTH = K.AUTH; // the K2 fixture sets QRP_PRODUCT_MILESTONE_AUTHORITY; the round runner and the registrar share it
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const AS_OF = '2026-11-24T18:00:00+08:00';
const MECH = K.MECH_OK; // CN_A, NORMAL_NO_PRIOR in the checked-in register
const FORMULAS = ['rank((-ret_1d))', 'nope(close_hfq)', 'rank( (-ret_1d) )', 'zscore((-ret_1d))', 'rank(pb)']; // scored, parse-refused, deduped, scored, scored
const CANDIDATE_FORMULA = FORMULAS[0];

let FX = null;
function miningFixture() { if (!FX) FX = makeMiningDataFixture(tmp('qrp-w24-e2e-fx-')); return FX; }

const mockClient = (script) => ({ calls: [], async chat(req) { this.calls.push(req); const r = script.shift(); if (r === undefined) throw new Error('mock client: no more scripted responses'); return r; } });
const okResp = (obj) => ({ ok: true, status: 200, data: { model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }], usage: {} } });
const cardTask = () => ({ task_id: 'RQT-LINUX-20261124-aaaa1111', host: 'LINUX', agent_host: 'LINUX', kind: 'AI_REVIEW_CARD', market: 'CN_A', template_id: 'AI_REVIEW_CARD_V1', template_sha256: sha('tpl'), attempt_no: 1 });
const registry = () => F.makeRegistry({ mechanisms: [...F.makeRegistry().mechanisms, { mechanism_id: MECH, layer: 'SELECTION_TIMING', decision_point: 'SELECT' }] });
const bundleOf = () => ({ schema: 'RQ_AGENT_BUNDLE_V1', market: 'CN_A', week_id: '2026-W47', pack: F.makePack(), registry: registry() });

/** The experiment executor: one RF1116 round on the fixture data, in this process, replaying the AI's batch (the test seam of the runner; the lane uses the CLI). */
function inProcessExecutor({ outDir, asOf }) {
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
      return { roundId: r.round_id, outDir, accessLogFile: file };
    },
  };
}

/**
 * @param {{asOf?: string, patch?: (parts: object) => void}} [o]
 * @returns {Promise<{job: object, services: object, work: string, outDir: string, spies: object, draft: object, card: object}>}
 */
async function buildWorld({ asOf = AS_OF, patch = null } = {}) {
  const work = tmp('qrp-w24-world-');
  process.env.QRP_DATA_DIR = path.join(work, 'data'); fs.mkdirSync(process.env.QRP_DATA_DIR);
  const outDir = path.join(work, 'out'); fs.mkdirSync(outDir);
  const inDir = path.join(work, 'in'); fs.mkdirSync(inDir);
  const triage = () => ({ route: 'NORMAL_NO_PRIOR', cite_seal_sha256: [] });
  const client = mockClient([okResp(F.makeCard({ factor_ideas: [F.goodIdea({ mechanism: MECH })] }))]);
  const result = await V.runAgentTask(cardTask(), bundleOf(), { client, env: {}, host: 'LINUX', triage, now: () => '2026-11-24T09:00:00+08:00' });
  const write = (name, text) => { const p = path.join(inDir, name); fs.writeFileSync(p, text); return p; };
  const files = { card_result: write('card_result.json', `${canonicalJson(result)}\n`) };
  const reviewLog = path.join(inDir, 'review_agent_access_log.jsonl');
  accessLog.writer(reviewLog).record({ principal: 'review-agent', op: 'READ', dataset: 'REVIEW_FACT_PACK_V1', from: '2026-11-20', to: '2026-11-20' });
  files.review_agent_access_log = reviewLog;
  const ideaId = result.outputs.factor_ideas[0].idea_id;
  files.dsl = write('dsl.json', `${canonicalJson({ schema: 'LAB_DSL_BATCH_V1', idea_id: ideaId, formulas: FORMULAS, candidate_formula: CANDIDATE_FORMULA, authored_by: { kind: 'AI_MINED_LLM', model: 'deepseek-pro' } })}\n`);
  const draft = K.baseDraft({ section0: { ...K.baseDraft().section0, mechanism_ids: [MECH] } });
  files.k2_draft = write('k2_draft.json', `${canonicalJson(draft)}\n`);

  const spies = { executed: 0, termsCalls: 0, registered: 0 };
  const k2Ctx = K.baseCtx();
  const services = {
    bundle: () => bundleOf(),
    k2: {
      ctx: (phase) => (phase === 'PREPARE' ? k2Ctx : { ...k2Ctx, now: K.NOW_FREEZE, ledgerRows: K.ledgerRows() }),
      register: (prepared) => { spies.registered += 1; return K.registerAt(prepared); },
    },
    promotionTerms: (freeze) => {
      spies.termsCalls += 1;
      return P.terms({ candidate_id: freeze.draft.draft_id, k2_sha256: freeze.k2_sha256, k2_frozen_at: freeze.k2_frozen_at, mechanism_ids: [MECH], market: 'CN_A', layer: 'ALPHA' });
    },
    experiment: (() => { const e = inProcessExecutor({ outDir: path.join(work, 'lane-out'), asOf }); fs.mkdirSync(path.join(work, 'lane-out')); return { execute: (a) => { spies.executed += 1; return e.execute(a); } }; })(),
    nextPack: () => F.makePack({ week_id: '2026-W48' }),
  };
  const job = { schema: 'LAB_E2E_JOB_V1', card_id: result.task_id, market: 'CN_A', as_of: asOf, out_dir: outDir, idea_id: ideaId,
    files: { card_result: files.card_result, review_agent_access_log: files.review_agent_access_log, dsl: files.dsl, k2_draft: files.k2_draft } };
  const world = { job, services, work, outDir, spies, draft, card: result, files, inDir };
  if (patch) patch(world);
  return world;
}

module.exports = { buildWorld, inProcessExecutor, miningFixture, AS_OF, MECH, FORMULAS, CANDIDATE_FORMULA, sha, canonicalJson, F, K, P, AUTH };
