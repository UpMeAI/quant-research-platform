'use strict';

/** LAB_LINEAGE_V1: the chain {step, artifact path, sha256, prior_sha256} from the card to the feedback entry, every candidate attempt from the trial ledger, the holdout access log summary, the verdict bytes. (Also the W04 lineage check for this chain.) */
const { fs, path, sha256, stepDir, STEPS, readJson } = require('./common');
const authority = require('../independent-verifier/authority');
const accessLog = require('../independent-verifier/access-log');

const SCHEMA = 'LAB_LINEAGE_V1';
const dirOf = (n) => stepDir(STEPS.find((s) => s.n === n));

function summarizeLog(outDir, rel) {
  const bytes = fs.readFileSync(path.join(outDir, rel));
  const v = accessLog.verifyBytes(bytes);
  const rows = v.ok ? v.rows : [];
  const gens = new Set(authority.loadConfig().generatorPrincipals);
  return { path: rel, sha256: sha256(bytes), rows: rows.length, holdout_reads: rows.filter((r) => r.op === 'HOLDOUT_READ' && !gens.has(r.principal)).length,
    generator_holdout_reads: rows.filter((r) => r.op === 'HOLDOUT_READ' && gens.has(r.principal)).length };
}

/** Every refused attempt in the mining log and the review agent's log (incidents are listed, never hidden; a refused attempt is not a read). */
function incidentsOf(outDir) {
  const out = [];
  for (const [which, rel] of [['mining-generator', `${dirOf(7)}/access_log.jsonl`], ['review-agent', `${dirOf(1)}/review_agent_access_log.jsonl`]]) {
    const v = accessLog.verifyBytes(fs.readFileSync(path.join(outDir, rel)));
    if (v.ok) for (const r of v.rows) if (r.op === 'HOLDOUT_READ_REFUSED') out.push({ log: which, seq: r.seq, principal: r.principal, op: r.op, code: r.code || null, from: r.from, to: r.to });
  }
  return out;
}

function build({ outDir, cardId, asOf, market, links, terminal, seenRanges, finalTest }) {
  const exp = readJson(path.join(outDir, `${dirOf(7)}/experiment.json`));
  const verdictLink = links.find((l) => l.step === 9);
  const vtext = fs.readFileSync(path.join(outDir, verdictLink.artifact_path), 'utf8');
  return {
    schema: SCHEMA, card_id: cardId, as_of: asOf, market, chain: links,
    candidate: { id: exp.candidate.id, sha256: exp.candidate.sha256, formula_sha256: exp.candidate.formula_sha256, round_id: exp.round_id },
    attempts: exp.attempts, generation_log: { path: `${dirOf(7)}/generation_log.jsonl`, sha256: exp.files['generation_log.jsonl'].sha256 },
    access_log: summarizeLog(outDir, `${dirOf(7)}/access_log.jsonl`), review_agent_access_log: summarizeLog(outDir, `${dirOf(1)}/review_agent_access_log.jsonl`),
    seen_ranges: seenRanges, final_test: finalTest, incidents: incidentsOf(outDir),
    verdict: { path: verdictLink.artifact_path, sha256: sha256(vtext), text: vtext }, terminal,
  };
}

module.exports = { SCHEMA, build, dirOf, incidentsOf };
