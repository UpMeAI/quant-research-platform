'use strict';

/**
 * V-1…V-6（PLAN V1.1 修订 1 §2.1）。每项只调用现有闸门，不重写：
 *   V1  ../causality-gate（G-CAUSAL）、../parity-gate（研究实盘一致口令门）
 *   V2  ../mining-sandbox/segments（三段切分）、../trial-ledger segmentsFor（W05 SEEN/UNSEEN）、./authority 的留出段读取台账（与 ../holdout-vault 的一轮一开一致）
 *   V3  ../mining-gate checkDsr / checkPbo（门槛读 ../trial-ledger/overfit）、overfit.bhy、../factor-library DEDUPE.RHO_MAX
 *   V4  ../cost-gate（FLOORS + coverage，QRP #143）、../mining-sandbox/price-limits（涨跌停成交约束）
 *   V5  K2 事先写明的鲁棒性声明（声明的 sha256 写在冻结的 K2 里），只做声明里的检验
 *   V6  晋级引擎的 S4 合同（W16 并行 PR）；引擎未合并前读文件合同 {candidateId, s4Evidence}
 * 一项返回 { codes, detail }：codes 为空 = 通过。闸门抛出的错误由编排器按 reasonCode 映射。
 */
const crypto = require('crypto');
const { canonicalJson } = require('../trial-ledger');
const trials = require('../trial-ledger');
const overfit = require('../trial-ledger/overfit');
const causality = require('../causality-gate');
const parity = require('../parity-gate');
const costGate = require('../cost-gate');
const miningGate = require('../mining-gate');
const factorLib = require('../factor-library');
const limits = require('../mining-sandbox/price-limits');
const { SEGMENTS } = require('../mining-sandbox/segments');
const authority = require('./authority');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ZERO = '0'.repeat(64);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

class StageError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const stop = (code) => { throw new StageError(code); };
const result = (codes, detail = {}) => ({ codes: [...new Set(codes)], detail });

/** 按 sha256 复验后的字节：缺文件、字节被改都失败即关。 */
function bytesOf(ctx, ref) {
  if (!isObj(ref) || typeof ref.path !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256 || '')) stop('FILE_REF_INVALID');
  const b = ctx.readBytes(ref);
  if (!b) stop('FILE_MISSING');
  if (sha(b) !== ref.sha256) stop('FILE_SHA_MISMATCH');
  return b;
}

// ── V-1 ──────────────────────────────────────────────────────────────────────

function v1(bundle, ctx) {
  const { entry, files } = bundle.v1;
  const k2 = bytesOf(ctx, files.k2);
  if (!entry || !entry.k2 || entry.k2.sha256 !== files.k2.sha256) stop('FILE_SHA_MISMATCH');
  const opt = (ref) => (ref ? () => bytesOf(ctx, ref) : () => null);
  if (entry.causality_evidence && (!files.causalityEvidence || entry.causality_evidence.sha256 !== files.causalityEvidence.sha256)) stop('FILE_SHA_MISMATCH');
  const gateOptions = ctx.gateOptions || {};
  const c = causality.check(entry, { k2Bytes: () => k2, evidenceBytes: opt(files.causalityEvidence), runLogBytes: opt(files.runLog), rulingBytes: opt(files.ruling) }, gateOptions.causality || {});
  if (!c.applies) stop('CAUSALITY_OUT_OF_SCOPE');
  const p = parity.check(entry, { k2Bytes: () => k2, noteBytes: () => (files.k2Notes || []).map((r) => bytesOf(ctx, r)) }, gateOptions.parity || {});
  if (!p.applies) stop('PARITY_OUT_OF_SCOPE');
  return result([], { causality: c.state, parity: p.state, data_inputs: p.data_inputs.length });
}

// ── V-2 ──────────────────────────────────────────────────────────────────────

/** 访问记录：逐行 JSON；hash = sha256(canonicalJson(行去掉 hash))，prev 接上一行的 hash，第一行 prev 全零，seq 从 1 连续。 */
function parseAccessLog(bytes) {
  const rows = bytes.toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return stop('ACCESS_LOG_ROW_INVALID'); } });
  let prev = ZERO;
  rows.forEach((r, i) => {
    if (!isObj(r) || !Number.isInteger(r.seq) || typeof r.principal !== 'string' || !['READ', 'HOLDOUT_READ'].includes(r.op) || !DATE.test(r.from || '') || !DATE.test(r.to || '') || r.from > r.to) stop('ACCESS_LOG_ROW_INVALID');
    const { hash, ...body } = r;
    if (r.seq !== i + 1 || r.prev !== prev || hash !== sha(canonicalJson(body))) stop('ACCESS_LOG_CHAIN_BROKEN');
    prev = hash;
  });
  return rows;
}

function v2(bundle, ctx, cfg) {
  const t = bundle.v2;
  const rows = parseAccessLog(bytesOf(ctx, t.accessLog));
  const codes = [];
  const generators = new Set(cfg.generatorPrincipals);
  for (const r of rows) {
    if (!generators.has(r.principal)) continue;
    if (r.op === 'HOLDOUT_READ') codes.push('GENERATOR_HOLDOUT_READ');
    else if (r.to > SEGMENTS.VALIDATION.to) codes.push('GENERATOR_READ_BEYOND_VALIDATION');
  }
  const holdout = rows.filter((r) => r.op === 'HOLDOUT_READ');
  if (holdout.some((r) => r.candidateSha256 !== bundle.candidateSha256)) codes.push('HOLDOUT_READ_NOT_THIS_CANDIDATE');
  const own = holdout.filter((r) => r.candidateSha256 === bundle.candidateSha256).length;
  const granted = authority.holdoutReadsOf(bundle.candidateSha256, ctx.authority || {}).length;
  if (Math.max(own, granted) > 1) codes.push('HOLDOUT_READ_MORE_THAN_ONCE');
  if (holdout.length && !(bundle.asOf > SEGMENTS.HOLDOUT.to)) codes.push('HOLDOUT_READ_BEFORE_SEAL_END');
  if (t.unseenClaim) { // W05：把一段当「未见样本」，这段里不能有 SEEN（没有标签的日期按 SEEN）
    const { pieces } = trials.segmentsFor(bundle.familyId, t.unseenClaim.from, t.unseenClaim.to, { marks: t.segmentMarks || [] });
    if (pieces.some((p) => p.label !== 'UNSEEN')) codes.push('UNSEEN_CLAIM_NOT_UNSEEN');
  }
  return result(codes, { access_rows: rows.length, holdout_reads: own, validation_end: SEGMENTS.VALIDATION.to });
}

// ── V-3 ──────────────────────────────────────────────────────────────────────

/** 被留出段否掉的候选的近似重提：同机制，或因子序列相关性超过因子库去重线。 */
function nearDuplicates(bundle) {
  const rhoMax = factorLib.DEDUPE.RHO_MAX;
  return (bundle.v3.priorHoldoutFailures || []).filter((p) => p.mechanismId === bundle.mechanism.id || (isNum(p.rho) && Math.abs(p.rho) > rhoMax));
}

function v3(bundle) {
  const t = bundle.v3; const codes = [];
  const dup = nearDuplicates(bundle);
  if (dup.length) {
    if (!bundle.mechanism.dedupeDecision) codes.push('RESUBMISSION_NOT_DEDUPED');
    if (dup.some((p) => p.familyId !== bundle.familyId)) codes.push('RESUBMISSION_FAMILY_SPLIT');
    if (dup.some((p) => !(t.familyTrialCount > p.nTrialsAtFailure))) codes.push('RESUBMISSION_N_NOT_CUMULATIVE');
  }
  const cand = { overfit: t.overfit };
  codes.push(...miningGate.checkDsr(cand, { familyTrialCount: t.familyTrialCount }).codes, ...miningGate.checkPbo(cand).codes);
  const b = t.overfit && t.overfit.bhy;
  if (!isObj(b) || !Array.isArray(b.pValues) || !Number.isInteger(b.index)) codes.push('BHY_INPUT_MISSING');
  else if (!(overfit.bhy(b.pValues)[b.index] <= bundle.cfg.bhyAlpha)) codes.push('BHY_NOT_SIGNIFICANT');
  return result(codes, { dsr: t.overfit && t.overfit.dsr, pbo: t.overfit && t.overfit.pbo, n_trials: t.overfit && t.overfit.n_trials, family_trial_count: t.familyTrialCount,
    ...(dup.length ? { resubmissionOf: dup.map((p) => p.candidateId) } : {}) });
}

// ── V-4 ──────────────────────────────────────────────────────────────────────

function v4(bundle) {
  const t = bundle.v4; const codes = [];
  if (!Array.isArray(t.runs) || !t.runs.length) stop('RUNS_INVALID');
  const floorMarket = costGate.floorMarketOf(t.market);
  t.runs.forEach((run, i) => {
    const at = `${bundle.candidateId}:runs[${i}]`;
    costGate.assessCostModel(run, t.market, { at });
    const own = isObj(run.cost_breakdown) ? run.cost_breakdown : {};
    costGate.coverage.requireComplete({ items: own.items, books: run.cost_book, flags: run.cost_flags }, floorMarket, at);
  });
  if (!Array.isArray(t.fills) || !t.fills.length) stop('FILLS_MISSING');
  for (const f of t.fills) {
    if (!isNum(f.participation)) stop('FILL_ROW_INVALID');
    if (f.participation > bundle.cfg.participationCap) codes.push('PARTICIPATION_CAP_EXCEEDED');
    if (t.market === 'CN_A') {
      const { pct } = limits.bandOf({ board: limits.boardOf(f.code), st: f.st, date: f.date });
      const can = f.side === 'BUY' ? limits.canBuy({ open: f.open, prevClose: f.prevClose, pct }) : f.side === 'SELL' ? limits.canSell({ open: f.open, prevClose: f.prevClose, pct }) : stop('FILL_ROW_INVALID');
      if (!can) codes.push('FILL_AT_PRICE_LIMIT');
    }
  }
  return result(codes, { runs: t.runs.length, fills: t.fills.length, floor_market: floorMarket });
}

// ── V-5 ──────────────────────────────────────────────────────────────────────

const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b };

function v5(bundle, ctx) {
  const t = bundle.v5; const cfg = bundle.cfg;
  const k2 = bytesOf(ctx, bundle.v1.files.k2).toString('utf8');
  const line = new RegExp(`^${cfg.robustness.declarationLine}: ([0-9a-f]{64})\\s*$`, 'm').exec(k2);
  if (!line || line[1] !== sha(canonicalJson(t.declaration))) return result(['DECLARATION_NOT_IN_K2']);
  const tests = Array.isArray(t.declaration.tests) ? t.declaration.tests : stop('DECLARATION_INVALID');
  const codes = [];
  for (const kind of cfg.robustness.requiredKinds) if (!tests.some((x) => x.kind === kind)) codes.push(`${kind}_NOT_DECLARED`);
  if (!tests.some((x) => x.kind === 'COST_MULTIPLIER' && x.multiplier >= cfg.robustness.minCostMultiplier)) codes.push('COST_X2_NOT_DECLARED');
  const results = Array.isArray(t.results) ? t.results : stop('RESULTS_INVALID');
  const declared = new Map(tests.map((x) => [x.id, x]));
  const seen = new Set();
  for (const r of results) {
    if (seen.has(r.id)) codes.push('DUPLICATE_RESULT'); seen.add(r.id);
    const d = declared.get(r.id);
    if (!d) { codes.push('UNDECLARED_TEST'); continue; }
    if (!isNum(r.value) || !OPS[d.op] || !isNum(d.threshold)) { codes.push('RESULT_INVALID'); continue; }
    if (!OPS[d.op](r.value, d.threshold)) codes.push(`${d.kind}_FAILED`);
  }
  for (const id of declared.keys()) if (!seen.has(id)) codes.push('DECLARED_TEST_MISSING');
  return result(codes, { declared: tests.length, results: results.length });
}

// ── V-6 ──────────────────────────────────────────────────────────────────────

const S4_VERDICTS = ['PASS', 'FAIL', 'INSUFFICIENT', 'INVALID'];

/**
 * 组合增量（§1.1 S4）。TODO(W16 接缝)：晋级引擎（并行 PR）合并后，由 ctx.promotionEngine.s4({ candidateId }) 直接给出 { verdict, reasonCodes, sha256 }；
 * 在那之前读文件合同 { candidateId, s4Evidence: { verdict, reasonCodes, sha256 } }。两条路径的形状相同，改接线不改 V-6 的判定。
 */
function v6(bundle, ctx) {
  let ev;
  if (ctx.promotionEngine && typeof ctx.promotionEngine.s4 === 'function') ev = ctx.promotionEngine.s4({ candidateId: bundle.candidateId });
  else {
    if (!bundle.v6 || !bundle.v6.s4Contract) return result(['S4_EVIDENCE_MISSING']);
    let doc;
    try { doc = JSON.parse(bytesOf(ctx, bundle.v6.s4Contract).toString('utf8')); } catch (e) { if (e instanceof StageError) throw e; return stop('S4_CONTRACT_INVALID'); }
    if (!isObj(doc) || doc.candidateId !== bundle.candidateId) return result(['S4_CANDIDATE_MISMATCH']);
    ev = doc.s4Evidence;
  }
  if (!isObj(ev) || !S4_VERDICTS.includes(ev.verdict)) return result(['S4_CONTRACT_INVALID']);
  return result(ev.verdict === 'PASS' ? [] : [`S4_${ev.verdict}`], { s4_verdict: ev.verdict, s4_evidence_sha256: ev.sha256 || null });
}

module.exports = { StageError, S4_VERDICTS, runners: { V1: v1, V2: v2, V3: v3, V4: v4, V5: v5, V6: v6 }, internals: { nearDuplicates, parseAccessLog, bytesOf } };
