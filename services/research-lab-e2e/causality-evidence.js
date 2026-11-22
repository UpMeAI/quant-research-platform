'use strict';

/**
 * V-1 causality evidence for a mined DSL candidate by COMPOSITION (plan-coord decision 11-23, NOTE_1 6b3be10d item 3; contract RESEARCH_LAB_E2E_V1.md).
 *
 * The 12 whitelist operators were certified once with the G-CAUSAL harness (docs/evidence/mining-operators-v1/, role FEATURE, T-C1, T-C2, T-C3 PASS).
 * A candidate formula is a composition of those operators, so its evidence is those records, copied unchanged, for the operators the formula uses,
 * under a CAUSALITY_EVIDENCE_V1 document bound to the candidate's K2. The harness is not re-run and nothing is guessed:
 *   - an operator the evidence does not show as FEATURE with all three tests PASS is refused by name (CAUSALITY_COMPOSE_OPERATOR_NOT_CERTIFIED:<op>:<why>);
 *   - evidence whose code no longer matches operators.js (the re-run rule of tests/mining_operators_causality.test.js) is refused (..._EVIDENCE_STALE);
 *   - operator evidence that does not match its sha256 sidecar (or is not a valid evidence file) is refused.
 * Pointwise arithmetic (+ - * / and unary minus) and constants are not operators in the evidence and carry no CF id: they combine already certified, same-date values.
 * No clock (registered_at is the operator evidence's), no randomness, no network. production_effect NONE.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const causality = require('../causality-gate');
const dsl = require('../mining-sandbox/dsl');
const { OPERATORS_PATH } = require('../mining-sandbox/space');

const ROOT = path.join(__dirname, '..', '..');
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'evidence', 'mining-operators-v1');
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'CAUSALITY_EVIDENCE_V1.json');
const OPERATORS_FILE = path.join(ROOT, 'services', 'mining-sandbox', 'evaluator', 'operators.js');
const OPERATORS_RELATIVE = OPERATORS_PATH.slice(OPERATORS_PATH.indexOf(':') + 1);
const PRODUCER = 'research-lab-e2e/causality-evidence';
const SHA64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const DATA_TOKEN = /^DATA:[A-Z0-9][A-Z0-9_]*(?:#series=[A-Za-z0-9][A-Za-z0-9_.-]*)?@\d+\.\d+\.\d+#[0-9a-f]{64}(?:\|[A-Z]+=[^|`]+)+$/;
const TESTS = Object.freeze([['t_c1', 'T-C1'], ['t_c2', 'T-C2'], ['t_c3', 'T-C3']]);

class ComposeError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const refuse = (code, detail) => { throw new ComposeError(`CAUSALITY_COMPOSE_${code}`, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const idOf = (op) => `${OPERATORS_PATH}#ROWS.${op}`;

/** The operator calls a formula makes (sorted, unique). Arithmetic, unary minus, constants and readings are not operators. */
function operatorsOf(formula) {
  const { tree } = dsl.parseTree(formula);
  const out = new Set();
  const walk = (n) => { if (n.call) out.add(n.op); (n.args || []).forEach(walk); };
  walk(tree);
  return [...out].sort();
}

/** The `CF:` ids a K2 draft lists in `causality.functions` (sorted). A formula with no operator has nothing to certify and is refused. */
function functionIdsOf(formula) {
  const ops = operatorsOf(formula);
  if (!ops.length) refuse('NO_OPERATORS', 'FORMULA_USES_NO_WHITELIST_OPERATOR');
  for (const op of ops) if (!Object.prototype.hasOwnProperty.call(dsl.OPERATORS, op)) refuse('OPERATOR_NOT_CERTIFIED', `${op}:NOT_IN_EVIDENCE`);
  return ops.map(idOf);
}

/** Default operator evidence: the repo file, checked against its sha256 sidecar. */
function repoOperatorEvidence() {
  const bytes = fs.readFileSync(EVIDENCE_FILE);
  const side = fs.readFileSync(`${EVIDENCE_FILE}.sha256`, 'utf8').trim().split(/\s+/)[0];
  return { bytes, sha256: side };
}

const gitShow = (commit) => {
  try { return execFileSync('git', ['-C', ROOT, 'show', `${commit}:${OPERATORS_RELATIVE}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch { return null; }
};

/**
 * @param {object} o
 * @param {string} o.formula            canonical DSL expression
 * @param {string} [o.k2Sha256]         the frozen K2; omitted at draft stage: bound to the operators' own signed K2 (K2 freeze V5 allows an earlier K2 there)
 * @param {string[]} o.dataInputs       the PIT data tokens (`DATA:<id>@<version>#<sha>|PIT=…|VENDOR=…`) the K2 carries
 * @param {{bytes: Buffer, sha256: string}} [o.operatorEvidence]  default: the repo file with its sidecar sha256
 * @param {string} [o.codeSha]          the run commit, when it should stand as code_sha (V-1 needs it equal to the run log's qrp_run_commit); git must show operators.js identical there
 * @param {Buffer} [o.operatorsSource]  operators.js bytes to check against (default: the file)
 * @param {string} [o.evidencePath]     path the evidence is stored under in the verifier input (default causality.json)
 */
function fromExpression({ formula, k2Sha256, dataInputs, operatorEvidence, codeSha, operatorsSource, evidencePath = 'causality.json' } = {}) {
  const { tree } = dsl.parseTree(formula);
  const ids = functionIdsOf(formula);
  const given = operatorEvidence || repoOperatorEvidence();
  if (!Buffer.isBuffer(given.bytes) || !SHA64.test(given.sha256 || '') || sha256(given.bytes) !== given.sha256) refuse('OPERATOR_EVIDENCE_SHA_MISMATCH', String(given.sha256));
  let base;
  try { base = causality.parseEvidence(given.bytes, 'operator-evidence'); } catch (e) { return refuse('OPERATOR_EVIDENCE_INVALID', e.code || e.message); }
  if (base.code_repo !== 'qrp') refuse('OPERATOR_EVIDENCE_INVALID', `code_repo:${base.code_repo}`);
  const bound = k2Sha256 === undefined ? base.k2_sha256 : k2Sha256;
  if (!SHA64.test(bound || '')) refuse('K2_SHA_INVALID', String(k2Sha256));
  if (!Array.isArray(dataInputs) || !dataInputs.length) refuse('DATA_INPUTS_MISSING');
  const tokens = [...new Set(dataInputs.map((t) => (typeof t === 'string' ? t.trim().replace(/^`|`$/g, '') : null)))];
  for (const t of tokens) if (!t || !DATA_TOKEN.test(t)) refuse('DATA_INPUTS_INVALID', String(t));
  tokens.sort();

  // 1. every used operator is certified: role FEATURE, T-C1, T-C2, T-C3 PASS
  const records = ids.map((id) => {
    const op = id.split('#ROWS.')[1];
    const rec = base.functions.find((f) => f.function_id === id);
    if (!rec) return refuse('OPERATOR_NOT_CERTIFIED', `${op}:NOT_IN_EVIDENCE`);
    if (rec.role !== 'FEATURE') refuse('OPERATOR_NOT_CERTIFIED', `${op}:ROLE_NOT_FEATURE`);
    for (const [key, label] of TESTS) if (rec[key] !== 'PASS') refuse('OPERATOR_NOT_CERTIFIED', `${op}:${label}_NOT_PASS`);
    return rec;
  });

  // 2. the re-run rule: the evidence still describes the code (file hash, and operators.js at the evidence's commit equals the current one)
  const source = operatorsSource || fs.readFileSync(OPERATORS_FILE);
  const sourceSha = sha256(source);
  for (const rec of records) if (rec.file_sha256 !== sourceSha) refuse('OPERATOR_EVIDENCE_STALE', `${rec.function_id}:FILE_SHA256`);
  const atEvidence = base.code_sha ? gitShow(base.code_sha) : null;
  if (!atEvidence) refuse('OPERATOR_EVIDENCE_STALE', 'EVIDENCE_COMMIT_NOT_READABLE');
  if (sha256(atEvidence) !== sourceSha) refuse('OPERATOR_EVIDENCE_STALE', 'OPERATORS_CHANGED_SINCE_EVIDENCE_COMMIT');
  let codeSha256 = base.code_sha;
  if (codeSha !== undefined) {
    const atRun = SHA40.test(codeSha || '') ? gitShow(codeSha) : null;
    if (!atRun || sha256(atRun) !== sourceSha) refuse('CODE_SHA_UNVERIFIED', String(codeSha));
    codeSha256 = codeSha;
  }

  const canonical = dsl.canonicalOf(tree);
  const { functions: _f, record_hash: _h, composition: _c, ...top } = base;
  const evidence = { ...top, study_ref: `W24B_COMPOSED_${sha256(canonical).slice(0, 16)}`, k2_sha256: bound, code_sha: codeSha256, functions: records.map((r) => JSON.parse(JSON.stringify(r))),
    composition: { producer: PRODUCER, formula_canonical: canonical, operators: ids.map((i) => i.split('#ROWS.')[1]), operator_evidence_sha256: given.sha256, operator_evidence_k2_sha256: base.k2_sha256,
      operator_evidence_code_sha: base.code_sha, data_inputs: tokens },
    registered_by: PRODUCER };
  evidence.record_hash = causality.recordHash(evidence);
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  causality.parseEvidence(bytes, 'composed-evidence'); // the document must pass the gate's own structure check
  const digest = sha256(bytes);
  return {
    evidence, bytes, sha256: digest, code_sha: codeSha256, pinnedCodeShas: { [base.code_repo]: codeSha256 }, run_commit_key: causality.runCommitKey(base.code_repo),
    v1: { entry: { k2: { sha256: bound }, causality_evidence: { sha256: digest } }, files: { causalityEvidence: { path: evidencePath, sha256: digest } } },
  };
}

module.exports = { operatorsOf, functionIdsOf, fromExpression, ComposeError };
