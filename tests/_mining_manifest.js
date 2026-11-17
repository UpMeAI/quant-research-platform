'use strict';
/**
 * 每份 MINING_ROUND_V1 清单都要带的两项（协调会话裁定 R1，ce254328…，2026-11-17）：
 *   rulings —— 引用裁定页（协调目录的路径 + sha256；仓库 docs/freeze/ 里有逐字节副本，车道上能核）；
 *   selection_rule —— R1.2 冻结的验证折选择规则（6 个半年折、均值 IC > 0、≥ 4 折为正、挖掘段分数 > 0），作为数据写进清单。
 * 测试直接调 openRound 时用这一份；执行器（round-runner）开轮时写的是同一份。
 */
const R1_RULING = Object.freeze({ path: 'artifacts/coordinator/RF1116_RULING_R1_20261117.md', sha256: 'ce25432851b8bfc6447809de7fb220111d80d418da1b31f1f07982b2037f4269' });
const R1_SELECTION_RULE = Object.freeze({
  schema: 'VALIDATION_SELECTION_V1', state: 'FROZEN', ruling: 'R1.2', ic: 'NEUTRALIZED_DAILY_RANK_IC_MEAN',
  folds: Object.freeze([
    Object.freeze({ fold: 1, from: '2024-01-02', to: '2024-06-30' }), Object.freeze({ fold: 2, from: '2024-07-01', to: '2024-12-31' }),
    Object.freeze({ fold: 3, from: '2025-01-01', to: '2025-06-30' }), Object.freeze({ fold: 4, from: '2025-07-01', to: '2025-12-31' }),
    Object.freeze({ fold: 5, from: '2026-01-01', to: '2026-06-30' }), Object.freeze({ fold: 6, from: '2026-07-01', to: '2026-10-16' }),
  ]),
  mean_ic_gt: 0, positive_folds_min: 4, mining_score_gt: 0,
});
const R1 = Object.freeze({ rulings: Object.freeze([R1_RULING]), selection_rule: R1_SELECTION_RULE });

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/**
 * R1.6：一段留出段最多给 2 轮用，第 3 轮起换一段整段在旧段之后的新段。测试里连开几轮时用它挑留出段：
 * 最新那一段还没用满就接着用，用满了就从旧段终点的次日起、60 天一段。
 */
function nextHoldout(rounds, market, base) {
  const prior = rounds.roundsOf(market);
  if (!prior.length) return base;
  const latest = prior[prior.length - 1].holdout;
  if (prior.filter((r) => r.holdout.from === latest.from && r.holdout.to === latest.to).length < 2) return { ...latest };
  const lastEnd = prior.reduce((m, r) => (r.holdout.to > m ? r.holdout.to : m), '');
  return { from: addDays(lastEnd, 1), to: addDays(lastEnd, 60) };
}

module.exports = { R1, R1_RULING, R1_SELECTION_RULE, nextHoldout };
