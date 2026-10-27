'use strict';

/**
 * 按策略档案补开运行态 case（复盘闭环验收 V1 修订 6 主稿 D6 ★；QRP 一侧说明 §2 第 2 条）。
 *
 * case_ref 取自档案（config/strategy_profiles.v1.json）；openCase 的每个字段都必须取自已有的事实，不发明：
 *   - 基线 = 该 case 当前的 Q0 基线锁（var/ledger/research/baseline_evaluations.jsonl 里替代链的最后一把），现场复验 LOCKED_VERIFIED；
 *     冻结基线的版本取自锁定文件的 identity.d_version，来源与 sha256 取自锁；
 *   - 运行通道 = 档案登记的 M1 证据清单（m1_evidence，sha256 现场核对）→ 它登记的输入包与源清单（sha256 逐级核对）→ 包里的运行账本文件。
 *     账本里有结构化的运行方式（mode）、簿号、最后一个 mark 的时间，才能开 case；
 *   - 数据质量：QRP 没有对这些输入做过新鲜度／质量评定，状态写合同自带的 UNKNOWN（as_of、known_at 取自账本最后一个 mark）；
 *   - Cycle：没有证据表明这条策略消费 Cycle，写 UNKNOWN；
 *   - 研究隔离：取自 M1 证据清单的 safety 块（三项都必须为 false）。
 * 某个必填字段找不到真实来源时抛 CaseFactError（`CASE_FACT_MISSING:<字段>`），不开 case。
 *
 * 开 case 写 var/ledger/runtime-research-loop/cases.jsonl（openCase 只追加、同 ID 同内容幂等）；这是运行上的一步，
 * 只在显式要求时做（apps/research-cli/open_profile_case.js，或导入 Desk 研究队列时带 --open-cases）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const profiles = require('../strategy-profiles');
const baselineEvaluation = require('../baseline-evaluation');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHA256 = /^[0-9a-f]{64}$/;
const LANE_MODES = Object.freeze(['OFF', 'SHADOW', 'PAPER', 'LIVE']);

class CaseFactError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new CaseFactError(code, detail); };
const need = (ok, code, detail) => { if (!ok) fail(code, detail); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function readBytes(file, code) {
  try { return fs.readFileSync(file); } catch { return fail(code, file); }
}
function readJsonBytes(bytes, code, file) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return fail(code, file); }
}

/** 源清单（`<sha256>  ./<相对路径>` 每行一个文件）→ Map(相对路径 → sha256)。 */
function manifestLines(bytes, file) {
  const map = new Map();
  for (const line of bytes.toString('utf8').trim().split('\n')) {
    const match = /^([0-9a-f]{64})\s+\.?\/?(.+)$/.exec(line.trim());
    need(match, 'CASE_FACT_SOURCE_MANIFEST_LINE_INVALID', `${file}:${line}`);
    map.set(match[2], match[1]);
  }
  return map;
}

/**
 * US_CORE 型 M1 证据清单（schema US_CORE_M1_NATIVE_DIAGNOSTIC_EVIDENCE_V1）的运行通道：book.ledger_file 指向包里的运行账本 JSON，
 * 账本的 mode、initialization.bookId、marks[-1].asOf／observedAt、notificationOutbox[*].payload.executionMode 都是结构化字段。
 * real_order：账本 mode = paper 且每条已记录动作的 executionMode 都是 paper 时为 0（纸面账本不下真实订单）；否则不开 case。
 */
function usCoreLedgerLane({ evidence, packageRoot, sourceManifest }) {
  const book = evidence.book;
  need(isObject(book) && typeof book.ledger_file === 'string' && typeof book.book_id === 'string', 'CASE_FACT_MISSING', 'runtime_lane.source_ref');
  const ledgerFile = path.join(packageRoot, book.ledger_file);
  const bytes = readBytes(ledgerFile, 'CASE_FACT_SOURCE_MISSING');
  const ledgerSha = sha256(bytes);
  need(sourceManifest.get(book.ledger_file) === ledgerSha, 'CASE_FACT_SOURCE_SHA256_MISMATCH', book.ledger_file);
  const ledger = readJsonBytes(bytes, 'CASE_FACT_SOURCE_NOT_JSON', ledgerFile);
  const bookId = ledger.initialization && ledger.initialization.bookId;
  need(typeof bookId === 'string' && bookId === book.book_id, 'CASE_FACT_MISSING', 'runtime_lane.version_ref');
  need(typeof ledger.mode === 'string' && LANE_MODES.includes(ledger.mode.toUpperCase()), 'CASE_FACT_MISSING', 'runtime_lane.mode');
  const mode = ledger.mode.toUpperCase();
  const actions = Array.isArray(ledger.notificationOutbox) ? ledger.notificationOutbox : [];
  const paperOnly = mode === 'PAPER' && actions.every((row) => isObject(row.payload) && row.payload.executionMode === 'paper');
  need(paperOnly, 'CASE_FACT_MISSING', 'runtime_lane.real_order');
  const marks = Array.isArray(ledger.marks) ? ledger.marks : [];
  const last = marks[marks.length - 1];
  need(last && iso(last.observedAt), 'CASE_FACT_MISSING', 'runtime_lane.as_of');
  need(/^\d{4}-\d{2}-\d{2}$/.test(last.asOf || ''), 'CASE_FACT_MISSING', 'data_quality.as_of');
  return {
    lane: { source_ref: ledgerFile, source_hash: ledgerSha, version_ref: bookId, as_of: last.observedAt, mode, real_order: 0 },
    data_as_of: last.asOf, known_at: last.observedAt, source_refs: [ledgerFile],
  };
}

/** 按 M1 证据清单的 schema 取运行通道。没有登记读法的清单（例如 QS、C17 的包里没有结构化的运行方式字段）→ runtime_lane.mode 无来源。 */
const LANE_READERS = Object.freeze({
  US_CORE_M1_NATIVE_DIAGNOSTIC_EVIDENCE_V1: usCoreLedgerLane,
});

/** 当前 Q0 基线锁：替代链最后一把，现场复验 LOCKED_VERIFIED；锁定文件的 identity.d_version 是冻结基线的版本。 */
function baselineOf(profile, { allowNonActual = false } = {}) {
  const lock = baselineEvaluation.headLock(profile.case_ref);
  need(lock, 'CASE_FACT_MISSING', 'baseline (Q0 baseline lock)');
  need(lock.strategy_ref === profile.strategy_ref, 'CASE_FACT_BASELINE_STRATEGY_MISMATCH', lock.result_id);
  const projection = baselineEvaluation.buildProjection(lock, { allowNonActual });
  need(projection.state === 'LOCKED_VERIFIED', 'CASE_FACT_BASELINE_NOT_LOCKED', `${lock.result_id}:${projection.state}`);
  const doc = readJsonBytes(readBytes(lock.file_ref, 'CASE_FACT_BASELINE_FILE_MISSING'), 'CASE_FACT_BASELINE_FILE_NOT_JSON', lock.file_ref);
  const version = doc.identity && doc.identity.d_version;
  need(typeof version === 'string' && version.trim(), 'CASE_FACT_MISSING', 'baseline.version_ref (Q0 identity.d_version)');
  return {
    lock,
    baseline: {
      baseline_id: `BASELINE-${lock.result_id}`, strategy_ref: lock.strategy_ref, market: profile.market,
      version_ref: version, source_ref: lock.file_ref, source_hash: lock.file_sha256,
      expected_baseline: { result_ref: lock.result_id, eval_class: lock.eval_class, verdict_state: lock.verdict_state, lock_hash: lock.lock_hash },
      frozen_at: lock.locked_at,
    },
  };
}

/**
 * 一条已登记策略的 openCase 输入（不写账）。`repoRoot` 是档案相对路径（m1_evidence.manifest_ref、输入包 relative_root）的根，
 * 默认 QRP 仓库根；测试注入临时根。
 */
function caseInputFor(strategyRef, { repoRoot = REPO_ROOT, allowNonActual = false } = {}) {
  const profile = profiles.get(strategyRef);
  need(profile, 'CASE_FACT_STRATEGY_NOT_REGISTERED', strategyRef);
  // 基线与运行通道分开取：两边各缺什么都一次报全（只收集「无来源」；sha256 不符、锁未通过复验这类完整性错误立即失败）
  const missing = [];
  const attempt = (fn) => {
    try { return fn(); } catch (error) {
      if (error instanceof CaseFactError && error.code === 'CASE_FACT_MISSING') { missing.push(error.detail); return null; }
      throw error;
    }
  };
  const base = attempt(() => baselineOf(profile, { allowNonActual }));
  const lane = attempt(() => laneOf(profile, repoRoot));
  need(!missing.length, 'CASE_FACT_MISSING', missing.join(','));
  const { baseline } = base;
  const { facts, isolation } = lane;

  return {
    case_id: profile.case_ref, strategy_ref: profile.strategy_ref, market: profile.market,
    runtime_lane: facts.lane,
    baseline: { ...baseline, runtime_mode: facts.lane.mode },
    cycle_context: { state: 'UNKNOWN', source_ref: null, source_hash: null },
    data_quality: {
      status: 'UNKNOWN', as_of: facts.data_as_of, known_at: facts.known_at, source_refs: facts.source_refs,
      freshness: { state: 'UNKNOWN' },
    },
    isolation,
  };
}

/** 运行通道与研究隔离：档案的 M1 证据清单 → 输入包源清单 → 运行账本（每级 sha256 现场核对）。 */
function laneOf(profile, repoRoot) {
  const m1 = profile.m1_evidence;
  const evidenceFile = path.join(repoRoot, m1.manifest_ref);
  const evidenceBytes = readBytes(evidenceFile, 'CASE_FACT_M1_EVIDENCE_MISSING');
  need(sha256(evidenceBytes) === m1.manifest_sha256, 'CASE_FACT_M1_EVIDENCE_SHA256_MISMATCH', m1.manifest_ref);
  const evidence = readJsonBytes(evidenceBytes, 'CASE_FACT_M1_EVIDENCE_NOT_JSON', evidenceFile);
  const reader = LANE_READERS[evidence.schema];
  need(reader, 'CASE_FACT_MISSING', 'runtime_lane.mode');
  need(evidence.strategy_ref === profile.strategy_ref && evidence.case_ref === profile.case_ref, 'CASE_FACT_M1_EVIDENCE_IDENTITY_MISMATCH', m1.manifest_ref);

  const pkg = evidence.input_package;
  const source = evidence.source_package;
  need(isObject(pkg) && typeof pkg.relative_root === 'string' && isObject(source) && SHA256.test(source.manifest_sha256 || ''), 'CASE_FACT_MISSING', 'runtime_lane.source_ref');
  const packageRoot = path.join(repoRoot, pkg.relative_root);
  const manifestFile = path.join(packageRoot, source.manifest_path);
  const manifestBytes = readBytes(manifestFile, 'CASE_FACT_SOURCE_MANIFEST_MISSING');
  need(sha256(manifestBytes) === source.manifest_sha256, 'CASE_FACT_SOURCE_MANIFEST_SHA256_MISMATCH', manifestFile);
  const facts = reader({ evidence, packageRoot, sourceManifest: manifestLines(manifestBytes, manifestFile) });

  const safety = evidence.safety;
  const isolation = { research_can_order: false, research_can_activate: false, research_can_write_runtime: false };
  need(isObject(safety) && Object.keys(isolation).every((key) => safety[key] === false), 'CASE_FACT_MISSING', 'isolation');
  return { facts, isolation };
}

/** 运行态 case 已存在就原样返回；否则按档案取事实后 openCase（写账）。取不到事实时抛 CaseFactError，账本不写。 */
function ensureProfileCase(strategyRef, options = {}) {
  const loop = require('./index');
  const profile = profiles.get(strategyRef);
  need(profile, 'CASE_FACT_STRATEGY_NOT_REGISTERED', strategyRef);
  const existing = loop.listCases().find((row) => row.case_id === profile.case_ref);
  if (existing) return { ...existing, replayHit: true };
  return loop.openCase({ ...caseInputFor(strategyRef, options), ...(options.openedAt ? { opened_at: options.openedAt } : {}) });
}

module.exports = { CaseFactError, LANE_READERS, caseInputFor, ensureProfileCase, REPO_ROOT };
