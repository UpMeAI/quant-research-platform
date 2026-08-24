'use strict';
/**
 * Factor Lab(L2,§9.1)—— FactorDefinition 注册 + 基础因子指标。
 *
 * §9.1 的产品边界(严格遵守,不越界):
 *   - Factor 只回答"一个信号是否具有统计/经济信息"(IC / Rank IC / Decay / Stability / Correlation);
 *   - Factor **不直接产生生产动作**:因子层不出 Opportunity、不进 Bundle、不触发发布;
 *     要影响生产必须经 Strategy 层 → Bundle → Race → Shadow → Promotion 全链;
 *   - MVP 只做"FactorDefinition 与基础指标",不建万能 Notebook(§23 非目标)。
 *
 * 指标由市场适配器的可选能力 `evaluate_factor(factorDef, opts)` 计算 —— 因子取值依赖
 * 市场特有数据,平台不持有;适配器未实现即显式 UNSUPPORTED,不臆造 IC。
 */
const path = require('path');
const { dataDir, hash, now, append, read } = require('../../packages/ledger');
const { getAdapter } = require('../../adapters/registry');

const FACTORS_LEDGER = () => path.join(dataDir('research'), 'factor_definitions.jsonl');
const FACTOR_EVAL_LEDGER = () => path.join(dataDir('research'), 'factor_evaluations.jsonl');

const FACTOR_DIRECTIONS = Object.freeze(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER']);

/** 注册 FactorDefinition(§8 风格的不可变定义;改动 = 新版本)。 */
function registerFactor(f = {}) {
  for (const k of ['factor_id', 'market', 'definition', 'economic_rationale']) {
    if (!f[k]) throw new Error(`FACTOR_MISSING_FIELD:${k}`);
  }
  if (!FACTOR_DIRECTIONS.includes(f.direction)) throw new Error(`FACTOR_BAD_DIRECTION:${f.direction}`);
  if (!Array.isArray(f.horizons) || !f.horizons.length) throw new Error('FACTOR_MISSING_FIELD:horizons');
  getAdapter(f.market); // 市场必须已注册
  const rows = read(FACTORS_LEDGER()).filter((r) => r.factor_id === f.factor_id);
  const version = rows.length ? Math.max(...rows.map((r) => r.version)) + 1 : 1;
  const content = {
    factor_id: f.factor_id, market: f.market, definition: f.definition,
    economic_rationale: f.economic_rationale, direction: f.direction,
    horizons: f.horizons, universe_ref: f.universe_ref || null,
    data_requirements: f.data_requirements || null,
  };
  return append(FACTORS_LEDGER(), {
    schema: 'FACTOR_DEFINITION_V1',
    ...content,
    version,
    factor_hash: hash(content),
    // §9.1 硬边界:因子层永远不产生生产动作
    production_action_authority: 'NONE',
    production_action_authorityCn: '因子只提供统计信息;要影响生产必须经 Strategy → Bundle → Race → Shadow → Promotion',
    owner: f.owner || 'FOUNDER',
    registeredAt: now(),
  });
}

function factorHead(factorId, version = null) {
  const rows = read(FACTORS_LEDGER()).filter((r) => r.factor_id === factorId && (version == null || r.version === version));
  return rows.length ? rows[rows.length - 1] : null;
}
function listFactors() {
  const m = new Map();
  for (const r of read(FACTORS_LEDGER())) m.set(`${r.factor_id}#v${r.version}`, r);
  return [...m.values()];
}

/**
 * 评估因子基础指标(IC / Rank IC / Decay / Coverage)。
 * 只报机械事实与样本量,**不发明**"因子有效"的阈值(判据属实验预注册,§9)。
 */
async function evaluateFactor(factorId, opts = {}) {
  const def = factorHead(factorId, opts.version ?? null);
  if (!def) throw new Error(`FACTOR_NOT_FOUND:${factorId}`);
  const adapter = getAdapter(def.market);
  if (typeof adapter.evaluate_factor !== 'function') {
    return {
      factor_id: factorId, version: def.version, status: 'UNSUPPORTED',
      reason: 'ADAPTER_LACKS_EVALUATE_FACTOR',
      reasonCn: `市场 ${def.market} 的 adapter 未实现 evaluate_factor —— 平台不臆造 IC/衰减`,
    };
  }
  const raw = await adapter.evaluate_factor(def, opts);
  const rec = {
    schema: 'FACTOR_EVALUATION_V1',
    factor_ref: `${def.factor_id}#v${def.version}`,
    factor_hash: def.factor_hash,
    market: def.market,
    dataset_snapshot_ref: opts.dataset_snapshot_ref || null,
    horizons: def.horizons,
    by_horizon: raw.by_horizon,
    sample_count: raw.sample_count,
    coverage: raw.coverage,
    decay: raw.decay,
    stability: raw.stability ?? null,
    correlation_to_refs: raw.correlation_to_refs ?? null,
    claimCn: '仅机械统计事实(IC/RankIC/衰减/覆盖);是否构成可交易 Alpha 须经 Strategy 层与全链验证',
    evaluatedAt: now(),
  };
  rec.evaluation_hash = hash({ ...rec, evaluatedAt: null });
  return append(FACTOR_EVAL_LEDGER(), rec);
}

function evaluationsFor(factorId) {
  return read(FACTOR_EVAL_LEDGER()).filter((r) => String(r.factor_ref).split('#v')[0] === factorId);
}

module.exports = {
  FACTOR_DIRECTIONS, registerFactor, factorHead, listFactors,
  evaluateFactor, evaluationsFor, FACTORS_LEDGER, FACTOR_EVAL_LEDGER,
};
