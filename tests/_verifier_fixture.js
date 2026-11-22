'use strict';
/**
 * W20 独立验证器（PLAN V1.1 修订 1 §2）的合成输入：一份全部通过的 INDEPENDENT_VERIFIER_INPUT_V1 与按 sha256 读字节的解析器。
 * 现有闸门（G-CAUSAL、G-PARITY、G-COST、G-MINE 的 DSR/PBO）用它们自己测试里的合成写法；这里的数没有经济含义。
 */
const crypto = require('crypto');
const causality = require('../services/causality-gate');
const costGate = require('../services/cost-gate');
const miningGate = require('../services/mining-gate');
const datasetRegistry = require('../services/dataset-registry');
const { canonicalJson } = require('../services/trial-ledger');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ZERO = '0'.repeat(64);
const REG = [...datasetRegistry.history().values()].find((h) => h.registry_version === '1.11.0');
const CODE = 'c'.repeat(40);
const FN = 'smartflow:src/features/f.js#f';
const OWN_MODEL = 'W20_FIXTURE_COSTS_V1';

function fnRecord(id, patch = {}) {
  const [p, entry] = id.slice(id.indexOf(':') + 1).split('#');
  return { function_id: id, path: p, entry, runner: 'node', file_sha256: 'f'.repeat(64),
    inputs: [{ name: 'bars', file: 'bars.json', file_sha256: 'b'.repeat(64), rows: 60, availability: { rule: 'DATE_AT', field: 'date', time: '15:00', tz: '+08:00' } }],
    cut_points: ['2025-01-10T07:00:00.000Z'], t_c1: 'PASS', t_c2: 'PASS', t_c3: 'PASS', fail_reasons: {}, mismatches: [], ...patch };
}
function evidenceOf(k2Sha, functions = [fnRecord(FN)]) {
  const doc = { schema: 'CAUSALITY_EVIDENCE_V1', contract_ref: causality.CONTRACT_REF, study_ref: 'W20_FIX_K2_V1', k2_sha256: k2Sha, code_repo: 'smartflow', code_sha: CODE, harness_version: '1.0.0',
    harness_sha256: 'a'.repeat(64), seed: causality.SEED, cut_points_per_function: causality.CUT_POINTS, manifest_sha256: 'd'.repeat(64), functions, unknown: {},
    production_effect: 'NONE', registered_by: 'TEST', registered_at: '2026-11-15T14:00:00Z' };
  doc.record_hash = causality.recordHash(doc);
  return doc;
}

const chargedItems = (book) => Object.entries(costGate.coverage.loadRegistry().markets.CN_A[book].items)
  .filter(([, d]) => d.state === 'CHARGED').map(([item]) => ({ item, state: 'CHARGED', amount: 1 }));

/** 访问记录：逐行哈希链（prev + hash = sha256(canonicalJson(行去掉 hash))），合同写在 docs/contracts/INDEPENDENT_VERIFIER_V1.md。 */
function chain(rows) {
  let prev = ZERO;
  return rows.map((r, i) => { const body = { seq: i + 1, ...r, prev }; const row = { ...body, hash: sha(canonicalJson(body)) }; prev = row.hash; return row; });
}
const jsonl = (rows) => Buffer.from(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

const GEN_READ = { principal: 'mining-generator', op: 'READ', dataset: 'V6_CN_STOCK_DAILY_BARS', from: '2020-06-01', to: '2023-12-29' };
const GEN_READ_VALIDATION = { principal: 'mining-generator', op: 'READ', dataset: 'V6_CN_STOCK_DAILY_BARS', from: '2024-01-02', to: '2026-10-16' };
const holdoutRead = (candidateSha256) => ({ principal: 'holdout-scorer', op: 'HOLDOUT_READ', dataset: 'V6_CN_STOCK_DAILY_BARS', from: '2026-10-19', to: '2026-12-31', candidateSha256 });

/**
 * @param {object} [o] 覆盖项：v1/v2/v3/v4/v5/v6 的补丁函数、reachedS3、asOf、accessRows、s4
 * @returns {{bundle: object, ctx: object, files: Map}}
 */
function build(o = {}) {
  const files = new Map();
  const put = (p, buf) => { files.set(p, Buffer.from(buf)); return { path: p, sha256: sha(buf) }; };
  const robustness = o.robustness || { tests: [
    { id: 'COST_X2', kind: 'COST_MULTIPLIER', multiplier: 2, metric: 'NET_EXCESS_ANNUAL', op: '>', threshold: 0 },
    { id: 'PARAM_PLUS_MINUS_20', kind: 'PARAM_PERTURBATION', metric: 'WORST_NET_EXCESS_ANNUAL', op: '>', threshold: 0 },
    { id: 'SUB_PERIOD_HALVES', kind: 'SUB_PERIOD', metric: 'WORST_HALF_NET_EXCESS_ANNUAL', op: '>', threshold: 0 },
  ] };
  const robustnessSha = sha(canonicalJson(robustness));
  const data = `\`DATA:V6_CSI300_INDEX_DAILY@${REG.registry_version}#${REG.registry_sha256}|PIT=BAR_CLOSE|VENDOR=Tushare\``;
  const k2Text = `# W20 fixture K2\n\n## 0\n- 新增函数：\`CF:${FN}\`\n**数据输入**：${data}\nROBUSTNESS_DECLARATION_SHA256: ${robustnessSha}\n`;
  const k2 = put('k2.md', k2Text);
  const ev = put('causality.json', JSON.stringify(o.evidence || evidenceOf(k2.sha256)));
  const runLog = put('runlog.json', JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: k2.sha256, runs: [], smartflow_run_commit: CODE }));
  const candidateSha256 = sha('candidate-1');
  const accessRows = o.accessRows || [GEN_READ, GEN_READ_VALIDATION];
  const accessBytes = o.accessBytes || jsonl(o.accessChained ? accessRows : chain(accessRows));
  const access = put('access.jsonl', accessBytes);
  const s4 = put('s4.json', JSON.stringify(o.s4 || { candidateId: 'cand-1', s4Evidence: { verdict: 'PASS', reasonCodes: [], sha256: 'e'.repeat(64) } }));
  const book = 'STOCK_BOOK';
  const bundle = {
    schema: 'INDEPENDENT_VERIFIER_INPUT_V1', candidateId: 'cand-1', candidateSha256, market: 'CN_A', familyId: 'CN_A_H5', asOf: o.asOf || '2026-12-01', reachedS3: o.reachedS3 !== false,
    mechanism: { id: 'SEL.MOMENTUM.SHORT', dedupeDecision: 'NO_CONFLICT' },
    v1: { entry: { id: 'W20-FIX', kind: 'RESULT', sealed_on: '2026-11-30', k2: { sha256: k2.sha256 }, k2_frozen_at: '2026-11-18T10:00:00+08:00', causality_evidence: { sha256: ev.sha256 } },
      files: { k2, causalityEvidence: ev, runLog } },
    v2: { accessLog: access, unseenClaim: null, segmentMarks: [] },
    v3: { familyTrialCount: 12, overfit: { dsr: 0.97, n_trials: 12, pbo: 0.2, pbo_scope: miningGate.PBO_SCOPE, bhy: { pValues: [0.001, 0.2, 0.5], index: 0 } }, priorHoldoutFailures: [] },
    v4: { market: 'CN_A', runs: [{ cost_model_ref: OWN_MODEL, cost_book: book, cost_flags: {},
      cost_breakdown: { model: OWN_MODEL, commission_bps: costGate.FLOORS.CN_A.commission_bps_min + 1, slippage_bps: costGate.FLOORS.CN_A.slippage_bps_min + 1, items: chargedItems(book) } }],
      fills: [{ date: '2025-03-03', code: '600000.SH', st: false, side: 'BUY', open: 10.2, prevClose: 10, participation: 0.02 }, { date: '2025-03-04', code: '600000.SH', st: false, side: 'SELL', open: 10.1, prevClose: 10.2, participation: 0.02 }] },
    v5: { declaration: robustness, results: [{ id: 'COST_X2', value: 0.03 }, { id: 'PARAM_PLUS_MINUS_20', value: 0.02 }, { id: 'SUB_PERIOD_HALVES', value: 0.01 }] },
    v6: { s4Contract: s4 },
  };
  for (const k of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) if (o[k]) o[k](bundle[k], bundle);
  if (o.bundle) o.bundle(bundle);
  const ctx = { readBytes: (ref) => files.get(ref.path) || null, gateOptions: { causality: { effectiveFrom: '2026-11-16T00:00:00+08:00' }, parity: { registry: REG } } };
  return { bundle, ctx, files, put };
}

module.exports = { build, sha, chain, jsonl, evidenceOf, fnRecord, FN, holdoutRead, GEN_READ, GEN_READ_VALIDATION, ZERO, REG };
