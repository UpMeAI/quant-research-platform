'use strict';
/**
 * 每份 MINING_ROUND_V1 清单都要带的两项（协调会话裁定 R1，修订 5 f904e0fe…，2026-11-17）：
 *   rulings —— 引用裁定页（协调目录的路径 + sha256；仓库 docs/freeze/ 里有逐字节副本，车道上能核）；
 *   selection_rule —— R1.2 冻结的验证折选择规则（6 个半年折、均值 IC > 0、≥ 4 折为正、挖掘段分数 > 0），作为数据写进清单。
 * 测试直接调 openRound 时用这一份；执行器（round-runner）开轮时写的是同一份。
 */
// 修订 5（加 R1.12a）：f904e0fe…；修订 4 705e2e6a…（R1.5、R1.6 本意写明，加 R1.12）、修订 3 5f0d0328…、修订 2 d80ce988…、修订 1 ce254328… 留在协调目录
const R1_RULING = Object.freeze({ path: 'artifacts/coordinator/RF1116_RULING_R1_20261117.md', sha256: 'f904e0feb3dc8e96a6e5b80e0ecc790f3cdca309b47fb88972c803f50a689d44' });
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
  const sharing = prior.filter((r) => r.holdout.from === latest.from && r.holdout.to === latest.to);
  if (sharing.length < 2 && !sharing.some((r) => r.holdout_opens)) return { ...latest }; // 修订 4：开启过的段不再开新轮
  const lastEnd = prior.reduce((m, r) => (r.holdout.to > m ? r.holdout.to : m), '');
  return { from: addDays(lastEnd, 1), to: addDays(lastEnd, 60) };
}

module.exports = { R1, R1_RULING, R1_SELECTION_RULE, nextHoldout };
