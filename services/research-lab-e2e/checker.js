'use strict';

/**
 * Acceptance checker for PLAN_V1_1_AMENDMENT_1 section 3's five conditions. Deterministic; PASS or FAIL per condition with reason codes.
 *   C1 complete lineage (11 linked artifacts, re-hashed; pending steps only where the holdout rule allows)
 *   C2 every candidate attempt, discarded ones included, is in the trial ledger and in the lineage
 *   C3 no generator touched the holdout (verifier V-2 semantics on the mining log; the review agent's log may only name the fact pack)
 *   C4 the verdict is deterministic (rebuilt twice from its stored inputs; bytes equal each other and the stored file)
 *   C5 the feedback is visible in the next weekly fact pack
 * "Frozen candidate awaiting holdout" is the expected terminal state before 2027-01-01T00:00+08:00 (RF1116); still awaiting after it is a FAIL.
 */
const { fs, path, sha256, STEPS, HOLDOUT_NOT_BEFORE, beforeHoldout, readJson, readIfFile, isObj, defaultLedger } = require('./common');
const accessLog = require('../independent-verifier/access-log');
const authority = require('../independent-verifier/authority');
const { runners } = require('../independent-verifier/stages');
const verdictMod = require('./verdict');
const feedback = require('./feedback');
const lineageMod = require('./lineage');

const SCHEMA = 'LAB_ACCEPTANCE_V1';
const IDS = Object.freeze(['C1_COMPLETE_LINEAGE', 'C2_ALL_ATTEMPTS_IN_LEDGER', 'C3_NO_GENERATOR_HOLDOUT_ACCESS', 'C4_DETERMINISTIC_VERDICT', 'C5_FEEDBACK_IN_NEXT_PACK']);
const cond = (id, codes) => ({ id, verdict: codes.length ? 'FAIL' : 'PASS', codes: [...new Set(codes)] });
const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback(e); } };

function check({ out_dir: outDir, as_of: checkAsOf = null, services = {}, next_pack: nextPack = null } = {}) {
  const chain = safe(() => readJson(path.join(outDir, 'chain.json')), () => null);
  const lineage = safe(() => readJson(path.join(outDir, 'lineage.json')), () => null);
  if (!chain || !lineage) {
    const codes = [!chain ? 'CHAIN_MISSING' : 'LINEAGE_REPORT_MISSING'];
    return { schema: SCHEMA, card_id: null, terminal_state: null, as_of: checkAsOf, next_pack_source: null, conditions: IDS.map((id) => cond(id, codes)), overall: 'FAIL' };
  }
  const links = Array.isArray(chain.links) ? chain.links : [];
  const terminal = isObj(chain.terminal) ? chain.terminal : {};
  const at = checkAsOf || chain.as_of;
  const abs = (rel) => path.join(outDir, rel);
  const linkOf = (n) => links.find((l) => l.step === n);

  // C1
  const c1 = [];
  if (chain.status !== 'COMPLETE') c1.push(`CHAIN_NOT_COMPLETE:${chain.status}`);
  for (const s of STEPS) {
    const l = linkOf(s.n);
    if (!l) { c1.push(`LINEAGE_LINK_MISSING:${s.n}`); continue; }
    const bytes = readIfFile(abs(l.artifact_path));
    if (!bytes) c1.push(`LINEAGE_ARTIFACT_MISSING:${s.n}`); else if (sha256(bytes) !== l.sha256) c1.push(`LINEAGE_SHA_MISMATCH:${s.n}`);
    const prev = linkOf(s.n - 1);
    if (s.n === 1 ? l.prior_sha256 !== null : (prev && l.prior_sha256 !== prev.sha256)) c1.push(`LINEAGE_PRIOR_MISMATCH:${s.n}`);
    if (l.status !== 'DONE') {
      const okPending = (terminal.state === 'FROZEN_AWAITING_HOLDOUT' && l.status === 'PENDING_HOLDOUT' && [8, 10].includes(s.n))
        || (terminal.state === 'NOT_SELECTED_BY_VALIDATION' && l.status === 'NOT_APPLICABLE' && s.n === 8);
      if (!okPending) c1.push(`LINEAGE_PENDING_NOT_ALLOWED:${s.n}`);
    }
  }
  if (JSON.stringify(lineage.chain) !== JSON.stringify(links)) c1.push('LINEAGE_REPORT_MISMATCH');
  if (terminal.state === 'FROZEN_AWAITING_HOLDOUT' && !beforeHoldout(at)) c1.push('AWAITING_HOLDOUT_PAST_DATE');

  // C2
  const c2 = [];
  const exp = safe(() => readJson(abs(`${lineageMod.dirOf(7)}/experiment.json`)), () => null);
  const genLog = readIfFile(abs(lineage.generation_log.path));
  if (!exp || !genLog) c2.push('GENERATION_LOG_MISSING');
  else {
    if (sha256(genLog) !== exp.files['generation_log.jsonl'].sha256) c2.push('GENERATION_LOG_SHA_MISMATCH');
    const genIds = genLog.toString('utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x).candidate_id);
    const lineageIds = new Set(exp.attempts.map((a) => a.candidate_id));
    const ledgerIds = new Set(((services.ledger || defaultLedger()).attemptsOfRound(exp.round_id)).map((a) => a.candidate_id));
    for (const id of genIds) { if (!lineageIds.has(id)) c2.push(`ATTEMPT_NOT_IN_LINEAGE:${id}`); if (!ledgerIds.has(id)) c2.push(`ATTEMPT_NOT_IN_LEDGER:${id}`); }
    for (const id of lineageIds) if (!genIds.includes(id)) c2.push(`ATTEMPT_NOT_IN_GENERATION_LOG:${id}`);
    if (JSON.stringify(exp.attempts) !== JSON.stringify(lineage.attempts)) c2.push('LINEAGE_ATTEMPTS_MISMATCH');
  }

  // C3
  const c3 = [];
  const miningLog = exp ? readIfFile(abs(lineage.access_log.path)) : null;
  if (!miningLog) c3.push('ACCESS_LOG_MISSING');
  else {
    if (sha256(miningLog) !== exp.files['access_log.jsonl'].sha256) c3.push('ACCESS_LOG_SHA_MISMATCH');
    const ref = { path: lineage.access_log.path, sha256: sha256(miningLog) };
    const grants = readIfFile(abs(`${lineageMod.dirOf(7)}/holdout_grants.jsonl`)) ? abs(`${lineageMod.dirOf(7)}/holdout_grants.jsonl`) : abs(`${lineageMod.dirOf(7)}/no_grants.jsonl`);
    const bundle = { candidateSha256: lineage.candidate.sha256, asOf: String(chain.as_of).slice(0, 10), familyId: 'LAB_CHECK', v2: { accessLog: ref } };
    try { c3.push(...runners.V2(bundle, { readBytes: () => miningLog, authority: { ledgerFile: grants } }, authority.loadConfig()).codes.map((c) => `V2_${c}`)); } catch (e) { c3.push(`V2_${e.code || 'STAGE_ERROR'}`); }
    const v = accessLog.verifyBytes(miningLog);
    if (v.ok && v.rows.some((r) => r.op === 'HOLDOUT_READ' && !r.refused) && beforeHoldout(chain.as_of)) c3.push('HOLDOUT_READ_BEFORE_2027_01_01');
  }
  const reviewLog = readIfFile(abs(lineage.review_agent_access_log.path));
  const ideaArt = safe(() => readJson(abs(linkOf(2).artifact_path)), () => null);
  if (!reviewLog) c3.push('REVIEW_AGENT_LOG_MISSING');
  else {
    if (!ideaArt || ideaArt.review_agent_access_log_sha256 !== sha256(reviewLog)) c3.push('REVIEW_AGENT_LOG_SHA_MISMATCH');
    const v = accessLog.verifyBytes(reviewLog);
    if (!v.ok) c3.push('REVIEW_AGENT_LOG_INVALID');
    else for (const r of v.rows) {
      if (r.op === 'HOLDOUT_READ') c3.push('REVIEW_AGENT_HOLDOUT_READ');
      if (r.dataset !== 'REVIEW_FACT_PACK_V1') c3.push(`REVIEW_AGENT_READ_NOT_FACT_PACK:${r.dataset}`);
    }
  }

  // C4
  const c4 = [];
  const vLink = linkOf(9);
  const storedText = vLink ? readIfFile(abs(vLink.artifact_path)) : null;
  const inputs = vLink ? safe(() => readJson(abs(path.join(path.dirname(vLink.artifact_path), 'engine_inputs.json'))), () => null) : null;
  if (!storedText || !inputs) c4.push('VERDICT_MISSING');
  else {
    const engine = services.engine || require('../promotion-engine');
    const rebuild = () => {
      if (inputs.post_holdout) {
        const ph = inputs.post_holdout;
        const files = new Map(ph.files.map((f) => [f.path, readIfFile(abs(f.stored))]));
        const d = verdictMod.decide({ bundle: ph.bundle, verifierCtx: { readBytes: (ref) => files.get(ref.path) || null, gateOptions: services.verifierGateOptions || {}, authority: { ledgerFile: abs(`${lineageMod.dirOf(7)}/no_grants.jsonl`) } },
          request: ph.request, priorEngine: ph.prior_engine, engine });
        return d.status === 'DECIDED' ? d.verdict_text : `UNDECIDED:${d.reason_code}`;
      }
      const r = verdictMod.preHoldout(inputs, engine);
      return r.ok ? r.verdict_text : `UNDECIDED:${r.reason_code}`;
    };
    const t1 = safe(rebuild, (e) => `ERROR:${e.message}`); const t2 = safe(rebuild, (e) => `ERROR:${e.message}`);
    if (t1 !== t2) c4.push('VERDICT_NOT_DETERMINISTIC');
    else if (t1 !== storedText.toString('utf8')) c4.push('VERDICT_BYTES_CHANGED');
  }

  // C5
  const c5 = [];
  const fbLink = linkOf(11);
  let source = 'LAB_OUTPUT'; let pack = null;
  if (nextPack) { pack = nextPack; source = 'PRODUCER'; } else if (fbLink) pack = safe(() => readJson(abs(path.join(path.dirname(fbLink.artifact_path), 'next_fact_pack.json'))), () => null);
  if (!fbLink || !pack) c5.push('NEXT_PACK_NOT_PROVIDED');
  else {
    const pc = feedback.checkPack(pack, { purpose: 'CARD', maxTokens: Infinity });
    if (!pc.ok) c5.push(`FEEDBACK_PACK_INVALID:${pc.errors[0].code}`);
    const fbBytes = readIfFile(abs(fbLink.artifact_path));
    const fact = fbBytes ? feedback.findIn(pack, sha256(fbBytes)) : null;
    if (!fact) c5.push('FEEDBACK_NOT_IN_NEXT_PACK');
    else if (isObj(fact.value) && JSON.parse(fbBytes.toString('utf8')).lab_candidate_id !== fact.value.candidate_id) c5.push('FEEDBACK_FACT_CANDIDATE_MISMATCH');
  }

  const conditions = [cond(IDS[0], c1), cond(IDS[1], c2), cond(IDS[2], c3), cond(IDS[3], c4), cond(IDS[4], c5)];
  return { schema: SCHEMA, card_id: chain.card_id, terminal_state: terminal.state || null, as_of: at, next_pack_source: source, conditions, overall: conditions.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL' };
}

module.exports = { SCHEMA, IDS, check, HOLDOUT_NOT_BEFORE };
