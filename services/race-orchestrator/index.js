'use strict';
/**
 * Race Orchestrator(L4,§10)—— Stage / Module / Bundle Race + 受控变量 + RaceResult。
 * 迁移自 Ashare-V5 services/phase2/race_orchestrator,按新设计扩展:
 *   - RaceResult 携带 canonical 七轴指标、regime_breakdown、guardrail_result、reason_codes、result_hash(§8);
 *   - 控制变量声明加入 same_market(多市场下双方必须同市场同 adapter 版本);
 *   - 预注册裁决器:verdict 只能由冻结的 primary_metric + guardrails 机械推导,禁止事后改规则。
 *
 * 控制变量规则(硬校验,§10):
 *   - Champion 与 Challenger 同 Market、同 Universe、同 PIT 数据、同交易日、同成本、同基准;
 *   - Component Race 只能改 changed_component;paired sample 逐条对齐可重放,缺边 = 拒绝;
 *   - 任何结果(Winner/Loser/Negative)都入台账 —— 负结果是资产。
 */
const path = require('path');
const { dataDir, hash, now, uid, append, read } = require('../../packages/ledger');
const experiments = require('../../services/experiment-orchestrator');

const RACES_LEDGER = () => path.join(dataDir('research'), 'races.jsonl');

const RACE_TYPES = Object.freeze(['STAGE_RACE', 'MODULE_RACE', 'BUNDLE_INTEGRATION_VALIDATION', 'PORTFOLIO_RACE']);

function openRace(o = {}) {
  if (!RACE_TYPES.includes(o.race_type)) throw new Error(`BAD_RACE_TYPE:${o.race_type}`);
  if (o.race_type === 'PORTFOLIO_RACE') throw new Error('PORTFOLIO_RACE_NOT_IN_MVP'); // §10:后续阶段
  if (!o.experiment_ref) throw new Error('RACE_MISSING_EXPERIMENT_REF');
  const v = experiments.verifyFreeze(o.experiment_ref);
  if (!v.ok) throw new Error(`RACE_REJECTED_EXPERIMENT:${v.reason}`);
  const spec = v.spec;
  if (o.race_type === 'BUNDLE_INTEGRATION_VALIDATION' && !o.upstream_race_ref) {
    throw new Error('BUNDLE_INTEGRATION_REQUIRES_UPSTREAM_RACE_REF');
  }
  const rec = {
    schema: 'RACE_RUN_V1',
    race_id: o.race_id || `RACE-${o.race_type}-${hash({ e: o.experiment_ref, t: uid() })}`,
    race_type: o.race_type,
    market: spec.market,
    experiment_ref: o.experiment_ref,
    experiment_freeze_hash: spec.freeze_hash,
    champion_ref: spec.champion_ref,
    challenger_ref: spec.challenger_ref,
    changed_component: spec.changed_component,
    fixed_components: spec.fixed_components || null,
    upstream_race_ref: o.upstream_race_ref || null,
    control_declaration: {
      same_market: true, same_universe: true, same_pit_data: true,
      same_trading_days: true, same_costs: true, same_benchmark: true,
      declaredCn: '双方同 Market/Universe/PIT/交易日/成本/基准;违反任一项 = 实验失效(§10)',
    },
    status: 'OPEN',
    openedAt: now(),
  };
  return append(RACES_LEDGER(), rec);
}

/**
 * 提交 paired sample(逐条对齐:同 key 下 champion 与 challenger 各自输出)。
 * 缺边 = 非受控比较,拒绝。
 */
function submitPairedSamples(raceId, samples = []) {
  const head = raceHead(raceId);
  if (!head) throw new Error('RACE_NOT_FOUND');
  if (head.status !== 'OPEN') throw new Error(`RACE_NOT_OPEN:${head.status}`);
  if (!Array.isArray(samples) || !samples.length) throw new Error('EMPTY_PAIRED_SAMPLES');
  for (const s of samples) {
    for (const k of ['key', 'champion_output', 'challenger_output']) {
      if (s[k] === undefined || s[k] === null) throw new Error(`PAIRED_SAMPLE_MISSING:${k}`);
    }
  }
  return append(RACES_LEDGER(), {
    ...head,
    status: 'SAMPLED',
    paired_sample_count: samples.length,
    paired_sample_hash: hash(samples),
    sampledAt: now(),
  });
}

// ── 预注册裁决器 ─────────────────────────────────────────────────────────────
/** 支持的 guardrail 声明规则(未知规则 fail-closed 抛错,不静默放过)。 */
function evaluateGuardrail(g, ctx) {
  const { champion, challenger } = ctx;
  if (g.rule === 'NOT_WORSE_THAN_CHAMPION_BY') {
    const c = champion[g.metric]; const h = challenger[g.metric];
    if (c == null || h == null) return { id: g.id, breached: true, reasonCn: `指标缺失:${g.metric}(样本不足按违约处理)` };
    return { id: g.id, breached: h < c - g.value, champion: c, challenger: h };
  }
  if (g.rule === 'AT_LEAST_FRACTION_OF_CHAMPION') {
    const c = champion[g.metric]; const h = challenger[g.metric];
    if (c == null || h == null) return { id: g.id, breached: true, reasonCn: `指标缺失:${g.metric}` };
    return { id: g.id, breached: h < c * g.value, champion: c, challenger: h };
  }
  throw new Error(`UNKNOWN_GUARDRAIL_RULE:${g.rule}`);
}

/**
 * 按冻结 spec 机械裁决:
 *   challenger primary > champion primary 且零 guardrail 违约 → CHALLENGER_WINS;
 *   guardrail 违约 → NEGATIVE_RESULT;否则 → CHAMPION_HOLDS;双边指标缺失 → INCONCLUSIVE。
 */
function adjudicate(spec, { championMetrics, challengerMetrics }) {
  const pm = spec.primary_metric;
  const c = championMetrics[pm]; const h = challengerMetrics[pm];
  const guardrail_result = (spec.guardrails || []).map((g) => evaluateGuardrail(g, { champion: championMetrics, challenger: challengerMetrics }));
  const breaches = guardrail_result.filter((g) => g.breached);
  let verdict;
  if (c == null || h == null) verdict = 'INCONCLUSIVE';
  else if (breaches.length) verdict = 'NEGATIVE_RESULT';
  else if (h > c) verdict = 'CHALLENGER_WINS';
  else verdict = 'CHAMPION_HOLDS';
  return { verdict, primary_metric: pm, champion_value: c ?? null, challenger_value: h ?? null, guardrail_result, guardrail_breaches: breaches.map((b) => b.id) };
}

/**
 * 关闭 Race 并出 RaceResult(§8):verdict 由预注册裁决器给出;
 * 结果同步 result-lock 写回实验;Winner/Loser/Negative 都是合法出口。
 */
function closeRace(raceId, { championMetrics, challengerMetrics, canonical, regime_breakdown = null, reason_codes = [] } = {}) {
  const head = raceHead(raceId);
  if (!head) throw new Error('RACE_NOT_FOUND');
  if (head.status !== 'SAMPLED') throw new Error(`RACE_NOT_SAMPLED:${head.status}`);
  const v = experiments.verifyFreeze(head.experiment_ref);
  if (!v.ok) throw new Error(`RACE_CLOSE_REJECTED:${v.reason}`);
  const adj = adjudicate(v.spec, { championMetrics, challengerMetrics });
  // result lock 在 experiment 台账发生(单结果锁)
  experiments.recordResult(head.experiment_ref, {
    verdict: adj.verdict,
    primary_metric_value: adj.challenger_value,
    champion_value: adj.champion_value,
    challenger_value: adj.challenger_value,
    guardrail_breaches: adj.guardrail_breaches,
    regime_breakdown,
    sample_evidence_ref: head.paired_sample_hash,
  });
  const result = {
    schema: 'RACE_RESULT_V1',
    race_id: raceId,
    experiment_ref: head.experiment_ref,
    paired_sample_ref: head.paired_sample_hash,
    conclusion: adj.verdict,
    primary_metric: adj.primary_metric,
    champion_value: adj.champion_value,
    challenger_value: adj.challenger_value,
    guardrail_result: adj.guardrail_result,
    canonical_metrics: canonical || null,   // 七轴 CanonicalRaceMetrics(adapter.normalize_result)
    regime_breakdown,
    reason_codes,
  };
  result.result_hash = hash(result);
  return append(RACES_LEDGER(), { ...head, status: 'CLOSED', result, closedAt: now() });
}

function raceHead(raceId) {
  const rows = read(RACES_LEDGER()).filter((r) => r.race_id === raceId);
  return rows.length ? rows[rows.length - 1] : null;
}
function listRaces() {
  const m = new Map();
  for (const r of read(RACES_LEDGER())) m.set(r.race_id, r);
  return [...m.values()];
}

module.exports = { RACE_TYPES, openRace, submitPairedSamples, adjudicate, closeRace, raceHead, listRaces, RACES_LEDGER };
