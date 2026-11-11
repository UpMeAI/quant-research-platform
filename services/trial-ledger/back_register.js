'use strict';

/**
 * 已封存研究的补登记 —— 研究框架修订（2026-11-10，过拟合控制）§2.5（★17 (a)）第 1、2 类。
 *
 *   第 1 类：QRP 已有的锁（海外、A 股封存结论，Q1–Q6 对比，Q0 基线，M2 轮次，Carry 封存结论；另读差距分解与 Q0 压力补充两把锁，供总表配对）；
 *   第 2 类：研究总表里「已出结论」「复用已有结果」的各行。总表按 sha256 钉住（命令行必须给出期望的 sha256）。
 *
 * 不改任何封存文件、锁、结论；补登记行 registration_mode = BACK_REGISTERED，source_refs 按 sha256 钉住原锁与原文件。
 * 臂的清单来自 K2 文本（§4 候选、§7 只报行）。K2 臂目录（arms 参数，协调会话核对后的 JSON，不进 git）给出的题按臂登记，
 * 每个臂的 k2_quote 必须逐字出现在按 sha256 复验过的 K2 文本里；目录里没有的题只登记一个「判定单元」行，
 * unknown.arms 写明原因，该族 N 标为「下限」。数字只从封存文件读：本工具不读结果数字，ŜR 一律 UNKNOWN（研究车道的日度账本另算）。
 * 前向影子与已冻结未封存的题（kind STATUS）、草稿（DRAFT）不在这里登记：按 §8 在封存时补。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir, read } = require('../../packages/ledger');
const ledger = require('./index');

const { need } = ledger.internals;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const MARKET = Object.freeze({
  US_V5_ETF_3000USD: 'US_EQUITY', US_CORE_9000USD_3X_GATEOBS: 'US_EQUITY', C17_V2_4000USDT: 'CRYPTO_USDM_PERP', QUICK_SHOT_V3_1000USDT: 'CRYPTO_USDM_PERP',
  CARRY_V2_SHADOW_10000USDT: 'CRYPTO', ASHARE_V6_PAPER: 'CN_A', INDEX_BOOK: 'CN_A',
});
const US5 = 'US_V5_ETF_3000USD'; const UC = 'US_CORE_9000USD_3X_GATEOBS'; const C17 = 'C17_V2_4000USDT'; const QS = 'QUICK_SHOT_V3_1000USDT';
const CN = 'ASHARE_V6_PAPER'; const IDX = 'INDEX_BOOK';

/** 总表里已出结论、却没有 QRP 锁的行：族由行文判定（basis_zh 写明依据，协调会话核对）。工程行不是试验，不登记。 */
const MASTER_FAMILIES = Object.freeze({
  A08: { families: [CN], basis_zh: '个股簿：主线龙头准入描述项（补充 1 A2）' },
  A17: { families: [CN], basis_zh: '个股簿：PVS-1 现行突破分组' },
  A23: { families: [CN], basis_zh: '个股簿：主线排序分的因子面板' },
  A26: { families: [CN], basis_zh: '个股簿：灵敏度 L-3 快变体（候选 F + 申万三级）' },
  D2: { families: [CN], basis_zh: '个股簿：库存钟只作行业初筛（核对，按保守口径计入）', confidence: 'REVIEW' },
  D3: { families: [IDX], basis_zh: '指数簿：升档时的政策行业扣留改为行业 k' },
  U12: { families: [UC], basis_zh: 'IX1 工具表达：期权只表达 ETF 信号，按 US_CORE 计', confidence: 'REVIEW' },
  U13: { families: [US5, UC, C17, QS], basis_zh: '凯利 K2：四本账各条线（海外桶、A19 是这几本账之上的线）' },
  U14: { families: [US5, UC, C17, QS], basis_zh: '凯利 K2 附录 1：同 U13' },
  U15: { families: [US5, UC], basis_zh: 'R1B-1 海外桶 Rule 1b：美股两本账', confidence: 'REVIEW' },
  U16: { families: [US5], basis_zh: '灵敏度 L-3（美股）：RSI 上沿是 US_V5 入场条件', confidence: 'REVIEW' },
  U19: { families: [US5, UC, C17, QS], basis_zh: '凯利 §2.2 重算：海外桶 Rule 1b、加密两本 A19、US_V5 上限' },
  C07: { families: [C17], basis_zh: '加密灵敏度 U4、U5（非主流领涨分档）', confidence: 'REVIEW' },
  C08: { families: [C17, QS], basis_zh: '加密凯利定仓 Phase 1：两本账' },
  R6: { families: [US5, C17], basis_zh: 'R6 方向分对称化：US_V5、C17 两个单元' },
  R7: { families: [C17], basis_zh: 'R7 C17 出场与持有期' },
  'W45-4': { families: [UC], basis_zh: 'RLC-US-2026W45-4 US_CORE 职责适配' },
  'ABL-1': { families: [US5], stage: 'ABLATION', basis_zh: 'US_V5 现行规则栈消融' },
});
const MASTER_STATUSES = Object.freeze(['已出结论', '复用已有结果']);
const ENGINEERING_LAYER = '不适用（工程）';

/** §4.1：补登记时，2020–2026 对美股、加密各族都是 SEEN；US_CORE 的 2010–2019 因凯利 K2 读过，也是 SEEN。 */
const SEEN_TO = '2026-11-10'; // 本修订冻结日；之后的日期还没有试验读过
const SEGMENT_PLAN = Object.freeze([
  ...[US5, UC, C17, QS, 'CARRY_V2_SHADOW_10000USDT'].map((f) => ({ family_id: f, market: MARKET[f], from: '2020-01-01', to: SEEN_TO, label: 'SEEN', reason: '§4.1 补登记：2020–2026 对美股、加密各族都是 SEEN（美股、加密的 2020–2026 历史已经全部读过）' })),
  { family_id: UC, market: MARKET[UC], from: '2010-01-01', to: '2019-12-31', label: 'SEEN', reason: '§4.1 补登记：US_CORE 的 2010–2019 因凯利 K2 读过，也是 SEEN' },
]);

// ── 第 1 类：QRP 已有的锁 ────────────────────────────────────────────────────────

const LOCK_SOURCES = Object.freeze([
  { cls: 'OVERSEAS_SEALED_VERDICT', file: 'overseas_sealed_verdicts.jsonl', schema: 'OVERSEAS_SEALED_VERDICT_LOCK_V1', key: (r) => `OSV:${r.entry_id}` },
  { cls: 'ASHARE_SEALED_VERDICT', file: 'ashare_sealed_verdicts.jsonl', schema: 'ASHARE_SEALED_VERDICT_LOCK_V1', key: (r) => `ASV:${r.entry_id}` },
  { cls: 'COMPARISON_EVALUATION', file: 'comparison_evaluations.jsonl', schema: 'COMPARISON_EVALUATION_LOCK_V1', key: (r) => `CMP:${r.strategy_ref}:${r.question_ref}` },
  { cls: 'BASELINE_EVALUATION', file: 'baseline_evaluations.jsonl', schema: 'BASELINE_EVALUATION_LOCK_V1', key: (r) => `Q0:${r.strategy_ref}` },
  { cls: 'M2_ROUND', file: 'm2_round_evaluations.jsonl', schema: 'M2_ROUND_LOCK_V1', key: (r) => `M2:${r.strategy_ref}:R${r.round}` },
  { cls: 'SEALED_RESEARCH_RESULT', file: 'sealed_research_results.jsonl', schema: 'SEALED_RESEARCH_RESULT_LOCK_V1', key: (r) => `SRR:${r.strategy_ref}` },
  // 不在 §2.5 的 6 类里，只用来给总表 U17、U18 配对
  { cls: 'GAP_DECOMPOSITION', file: 'gap_decompositions.jsonl', schema: 'GAP_DECOMPOSITION_LOCK_V1', key: (r) => `GAP:${r.strategy_ref}`, pairingOnly: true },
  { cls: 'BASELINE_STRESS_SUPPLEMENT', file: 'baseline_stress_supplements.jsonl', schema: 'BASELINE_STRESS_SUPPLEMENT_LOCK_V1', key: (r) => `STRESS:${r.strategy_ref}:${r.scenario}`, pairingOnly: true },
]);

/** 一把锁的所有 sha256（结果文件、K2、冻结页、封存包里的文件）——用于和总表 auth 里的 sha 前缀配对。 */
function shasOf(r) {
  const out = new Set([r.file_sha256, r.bundle_sha256, r.k2_sha256, r.k2_freeze_sha256].filter(Boolean));
  for (const x of [...(r.refs || []), ...(r.files || []), ...(r.sealed_files || [])]) if (x && x.sha256) out.add(x.sha256);
  return out;
}
const refSha = (r, role) => { const hit = (r.refs || []).find((x) => x.role === role); return hit ? hit.sha256 : null; };

/** 每类锁的 head（同一题最后一行；被 supersedes 的旧锁不登记）。 */
function lockUnits() {
  const units = [];
  for (const src of LOCK_SOURCES) {
    const file = path.join(dataDir('research'), src.file);
    const rows = read(file).filter((r) => r.schema === src.schema);
    const headByKey = new Map();
    for (const r of rows) headByKey.set(src.key(r), r);
    for (const [study, r] of headByKey) {
      if (r.kind === 'DRAFT' || r.kind === 'STATUS') continue; // §8：封存时补登记
      units.push({
        cls: src.cls, pairingOnly: Boolean(src.pairingOnly), study_ref: study, family_id: r.strategy_ref, lock_id: r.result_id, kind: r.kind || null,
        k2_sha256: r.k2_sha256 || refSha(r, 'K2'), freeze_sha256: r.k2_freeze_sha256 || refSha(r, 'FREEZE'),
        verdict: r.decision || r.verdict_state || r.verdict_result || null, shas: shasOf(r),
        source_refs: [{ kind: 'QRP_LOCK', ledger: `var/ledger/research/${src.file}`, schema: src.schema, result_id: r.result_id, lock_hash: r.lock_hash || null,
          file_sha256: r.file_sha256 || r.bundle_sha256 || null, k2_ref: r.k2_ref || null }],
      });
    }
  }
  return units;
}

// ── 第 2 类：总表 ────────────────────────────────────────────────────────────────

const HEX_TOKEN = /(?<![0-9a-f])[0-9a-f]{8,64}(?![0-9a-f])/g;

function loadMasterTable(file, expectSha256) {
  need(typeof file === 'string' && path.isAbsolute(file), 'BACKREG_MASTER_TABLE_PATH_MUST_BE_ABSOLUTE');
  need(ledger.SHA64.test(expectSha256 || ''), 'BACKREG_MASTER_TABLE_SHA256_REQUIRED');
  const bytes = fs.readFileSync(file);
  const actual = sha256(bytes);
  need(actual === expectSha256, 'BACKREG_MASTER_TABLE_SHA256_MISMATCH', `${actual.slice(0, 12)}…≠${expectSha256.slice(0, 12)}…`);
  const doc = JSON.parse(bytes.toString('utf8'));
  need(Array.isArray(doc.items) && Number.isInteger(doc.revision), 'BACKREG_MASTER_TABLE_SHAPE');
  return { doc, sha256: actual, revision: doc.revision, file };
}

const LAYER_REFINED = new Set(['OVERSEAS_SEALED_VERDICT', 'ASHARE_SEALED_VERDICT', 'MASTER_TABLE']);
function roleOf(unit, layer) {
  if (unit.cls === 'BASELINE_EVALUATION' || unit.cls === 'BASELINE_STRESS_SUPPLEMENT') return 'BASELINE';
  if (unit.cls === 'GAP_DECOMPOSITION') return 'DIAGNOSTIC_ARM';
  if (unit.kind === 'READING') return 'REPORT_ONLY_VARIANT';
  // 总表的层只用来细分封存结论锁与总表自立的单元；Q1–Q6、M2 轮次、Carry 锁本身带候选，恒为判定臂
  if (!LAYER_REFINED.has(unit.cls)) return 'VERDICT_ARM';
  if (layer === '诊断（全策略基线）') return 'BASELINE';
  if (layer && layer.startsWith('诊断')) return 'DIAGNOSTIC_ARM';
  return 'VERDICT_ARM';
}

// ── 计划与执行 ──────────────────────────────────────────────────────────────────

const UNIT_UNKNOWN = Object.freeze({
  arms: 'K2_ARMS_NOT_CATALOGUED（§2.5：臂的清单来自 K2 文本；目录未给出本题，只登记判定单元，本族 N 为下限）',
  metrics: 'NOT_READ_BY_BACK_REGISTRATION（数字只从封存文件读；补登记工具不读结果数字）',
  sr_monthly_delta: 'NO_DAILY_LEDGER_IN_QRP（日度账本在研究车道，哈希核对后另算，标 DERIVED_FROM_SEALED）',
  window: 'NOT_READ_BY_BACK_REGISTRATION',
});

function unitSpec(u, extra = {}) {
  const base = {
    family_id: u.family_id, market: MARKET[u.family_id] || 'UNKNOWN', study_ref: u.study_ref, k2_sha256: u.k2_sha256 || null, freeze_sha256: u.freeze_sha256 || null,
    stage: u.stage || 'BOOK', role: u.role, config_label: `${u.study_ref}#VERDICT_UNIT`,
    rule_config: { back_registered_unit: { family_id: u.family_id, study_ref: u.study_ref } },
    study_verdict: u.verdict ?? null, source_refs: u.source_refs, unknown: { ...UNIT_UNKNOWN, ...(u.k2_sha256 ? {} : { k2_sha256: 'NOT_IN_LOCK' }) },
    notes_zh: u.notes_zh || undefined,
  };
  return { ...base, ...extra };
}

/** K2 臂目录：{ studies: [{ study_ref, family_id, k2_sha256, k2_file?, arms: [{ config_label, role, stage, line_start, line_end, k2_quote, ... }] }] } */
function armsSpecs(u, catalogue) {
  const entry = (catalogue && catalogue.studies || []).find((s) => s.study_ref === u.study_ref && s.family_id === u.family_id);
  if (!entry) return null;
  need(entry.status == null || entry.status === 'OK' || entry.status === 'REVIEW', 'BACKREG_ARMS_STATUS_INVALID', `${u.study_ref}:${entry.status}`);
  need(entry.k2_sha256 && entry.k2_sha256 === u.k2_sha256, 'BACKREG_ARMS_K2_MISMATCH', `${u.study_ref}:${u.family_id}`);
  need(typeof entry.k2_file === 'string' && path.isAbsolute(entry.k2_file), 'BACKREG_ARMS_K2_FILE_REQUIRED', u.study_ref);
  const k2 = fs.readFileSync(entry.k2_file);
  need(sha256(k2) === entry.k2_sha256, 'BACKREG_ARMS_K2_FILE_SHA256_MISMATCH', u.study_ref);
  if (entry.status === 'REVIEW') {
    need(typeof entry.review_reason === 'string' && entry.review_reason.trim(), 'BACKREG_ARMS_REVIEW_REASON_REQUIRED', u.study_ref);
    return null;
  }
  const text = k2.toString('utf8');
  const lines = text.split(/\r?\n/);
  need(Array.isArray(entry.arms) && entry.arms.length, 'BACKREG_ARMS_EMPTY', u.study_ref);
  return entry.arms.map((arm) => {
    need(Number.isInteger(arm.line_start) && Number.isInteger(arm.line_end) && arm.line_start >= 1 && arm.line_end >= arm.line_start && arm.line_end <= lines.length,
      'BACKREG_ARM_SOURCE_LINES_INVALID', `${u.study_ref}:${arm.config_label}:${arm.line_start}-${arm.line_end}`);
    const sourceLines = lines.slice(arm.line_start - 1, arm.line_end).join('\n');
    need(typeof arm.k2_quote === 'string' && arm.k2_quote.trim() && text.includes(arm.k2_quote), 'BACKREG_ARM_NOT_IN_K2_TEXT', `${u.study_ref}:${arm.config_label}`);
    need(sourceLines.includes(arm.k2_quote), 'BACKREG_ARM_NOT_IN_SOURCE_LINES', `${u.study_ref}:${arm.config_label}:${arm.line_start}-${arm.line_end}`);
    const { arms: _a, ...unknown } = UNIT_UNKNOWN;
    return unitSpec(u, {
      stage: arm.stage || u.stage || 'BOOK', role: arm.role, config_label: arm.config_label, delta_vs_baseline: arm.delta_vs_baseline || [], params_tried: arm.params_tried || [],
      rule_config: arm.rule_config || { back_registered_arm: { family_id: u.family_id, study_ref: u.study_ref, config_label: arm.config_label } },
      unknown, source_refs: [...u.source_refs, { kind: 'K2_TEXT', sha256: entry.k2_sha256, line_start: arm.line_start, line_end: arm.line_end, quote: arm.k2_quote }],
    });
  });
}

/**
 * 只算不写：锁 → 判定单元；总表行 → 配对到锁或按 MASTER_FAMILIES 另立单元；工程行跳过；既没配对也没登记族的行失败即关。
 * @returns {{specs, segments, master: {revision, sha256}, pairing: object[], skipped: object[]}}
 */
function plan({ masterTable, masterTableSha256, arms = null }) {
  const table = loadMasterTable(masterTable, masterTableSha256);
  const units = lockUnits();
  const pairing = []; const skipped = []; const masterUnits = [];
  const layerByUnit = new Map();
  for (const item of table.doc.items) {
    if (!MASTER_STATUSES.includes(item.status)) continue;
    const tokens = new Set(String((item.auth || []).join(' ')).match(HEX_TOKEN) || []);
    const matched = units.filter((u) => [...tokens].some((t) => [...u.shas].some((s) => s.startsWith(t))));
    const own = MASTER_FAMILIES[item.id];
    if (own) {
      for (const f of own.families) {
        masterUnits.push({ cls: 'MASTER_TABLE', study_ref: `MASTER:${item.id}`, family_id: f, stage: own.stage, verdict: item.verdict, k2_sha256: null, freeze_sha256: null, layer: item.layer,
          source_refs: [{ kind: 'MASTER_TABLE_ROW', file: 'artifacts/coordinator/RESEARCH_MASTER_TABLE_20261110.json', sha256: table.sha256, revision: table.revision, id: item.id, auth: item.auth }],
          notes_zh: `族：${own.basis_zh}${own.confidence ? '（待核对）' : ''}` });
      }
      pairing.push({ id: item.id, mode: 'OWN_UNIT', families: own.families, confidence: own.confidence || 'OK', also_matched_locks: matched.map((u) => u.lock_id) });
    } else if (matched.length) {
      for (const u of matched) if (!layerByUnit.has(u)) layerByUnit.set(u, item.layer);
      pairing.push({ id: item.id, mode: 'PAIRED_TO_LOCK', locks: matched.map((u) => u.lock_id) });
    } else if (item.layer === ENGINEERING_LAYER) {
      skipped.push({ id: item.id, reason: 'ENGINEERING_NOT_A_TRIAL' });
    } else {
      need(false, 'BACKREG_MASTER_ROW_UNMAPPED', `${item.id}（${item.market}，${item.layer}）`);
    }
  }
  const specs = [];
  for (const u of units) {
    if (u.pairingOnly && !layerByUnit.has(u)) { skipped.push({ id: u.lock_id, reason: 'PAIRING_ONLY_LOCK_NOT_IN_MASTER_TABLE' }); continue; }
    const unit = { ...u, role: roleOf(u, layerByUnit.get(u)) };
    specs.push(...(armsSpecs(unit, arms) || [unitSpec(unit)]));
  }
  for (const m of masterUnits) specs.push(...(armsSpecs({ ...m, role: roleOf(m, m.layer) }, arms) || [unitSpec({ ...m, role: roleOf(m, m.layer) })]));
  const catalogueReview = (arms && arms.studies || []).filter((entry) => entry.status === 'REVIEW').map((entry) => ({
    study_ref: entry.study_ref, family_id: entry.family_id, reason: entry.review_reason,
  }));
  return { specs, segments: SEGMENT_PLAN.map((s) => ({ ...s, source_refs: [{ kind: 'AMENDMENT', ref: 'RESEARCH_FRAMEWORK_AMENDMENT_20261110_OVERFIT_CONTROLS §4.1' }] })),
    master: { revision: table.revision, sha256: table.sha256 }, pairing, skipped, catalogueReview };
}

/** 计数汇总（按族）：用计划出来的行在内存里算，不读台账。 */
function summarize(rows) {
  const families = [...new Set(rows.map((r) => r.family_id))].sort();
  return families.map((f) => ledger.count(f, { rows }));
}

/** 执行补登记（完成权威）。dryRun 只返回计划和计数，不写。重复执行是幂等重放。 */
function run({ masterTable, masterTableSha256, arms = null, registeredBy, registeredAt = null, dryRun = false }) {
  const p = plan({ masterTable, masterTableSha256, arms });
  const rows = ledger.register(p.specs, { registeredBy, registeredAt, mode: 'BACK_REGISTERED', dryRun });
  const segments = dryRun ? ledger.markSegments(p.segments, { registeredBy, registeredAt, dryRun: true }) : markSegmentsOnce(p.segments, { registeredBy, registeredAt });
  return { ...p, rows, segmentRows: segments, counts: summarize(rows) };
}

/** 段标签只追加一次：同族同段同标签已有则跳过（幂等）。 */
function markSegmentsOnce(specs, opts) {
  const existing = read(ledger.SEGMENTS()).filter((r) => r.schema === 'DATA_SEGMENT_MARK_V1');
  const todo = specs.filter((s) => !existing.some((r) => r.family_id === s.family_id && r.from === s.from && r.to === s.to && r.label === s.label && !r.shadow_ref));
  return todo.length ? ledger.markSegments(todo, opts) : [];
}

module.exports = { MASTER_FAMILIES, MASTER_STATUSES, SEGMENT_PLAN, LOCK_SOURCES, MARKET, plan, run, summarize, internals: { lockUnits, loadMasterTable, roleOf, armsSpecs } };
