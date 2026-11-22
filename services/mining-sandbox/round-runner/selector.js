'use strict';

/**
 * 前推验证折上的选择（RF1116 §3.4「验证折：在候选之间做选择；不能反馈给生成方，只有沙箱的选择器看得到」；P2 规格 §1 第 5 步）。
 *
 * 折（11-10 修订 §7.2 的窗口：检验 6 个月、步长 6 个月、最后一折到数据末；训练窗锚定在挖掘段起点，挖掘段 3.5 年 ≥ 3 年）：
 *   验证折 2024-01-02 → 2026-10-16 按自然半年切：2024H1、2024H2、2025H1、2025H2、2026H1、2026-07-01 → 2026-10-16。
 *   挖出的公式没有要拟合的参数，所以「训练窗」不选任何东西；每折只是一段样本外。
 * 每个候选每折：中性化（行业 + 市值，求值器的 neutralizeForScoring）后的逐日 rank IC 的均值；标签不越出验证折（面板到验证折终点为止）。
 * 选择规则 VALIDATION_SELECTION_V1 —— FROZEN by R1.2（协调会话裁定 R1，RF1116_RULING_R1_20261117.md，ce254328…）：
 *   6 个半年折；全验证折的 IC 均值 > 0，且 6 折中至少 4 折 IC 均值 > 0，且挖掘段分数 > 0。
 *   规则作为数据写进每一轮的 MINING_ROUND_V1 清单（selection_rule），执行器从清单读，不读这里的常量；轮中不改，要改就是新的一轮。
 * 输出只进执行器的输出目录（selection.json）与一行只追加的选择记录（文件 sha + 过了的候选编号），不进试验台账的指标、不进 generatorView；选完之后本轮不能再生成。
 */
const segs = require('../segments');
const scoring = require('../scoring');

/** FROZEN by R1.2 —— 开轮时原样写进清单；改它不影响已开的轮（它们读自己的清单）。 */
const RULE = Object.freeze({
  schema: 'VALIDATION_SELECTION_V1', state: 'FROZEN', ruling: 'R1.2', ic: 'NEUTRALIZED_DAILY_RANK_IC_MEAN',
  folds: Object.freeze([
    Object.freeze({ fold: 1, from: '2024-01-02', to: '2024-06-30' }), Object.freeze({ fold: 2, from: '2024-07-01', to: '2024-12-31' }),
    Object.freeze({ fold: 3, from: '2025-01-01', to: '2025-06-30' }), Object.freeze({ fold: 4, from: '2025-07-01', to: '2025-12-31' }),
    Object.freeze({ fold: 5, from: '2026-01-01', to: '2026-06-30' }), Object.freeze({ fold: 6, from: '2026-07-01', to: '2026-10-16' }),
  ]),
  mean_ic_gt: 0, positive_folds_min: 4, mining_score_gt: 0,
});

class SelectorError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new SelectorError(`MINE_SELECT_${code}`, detail); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 规则里的折（按决策日）；默认是 R1.2 的六个半年折。 */
const folds = (rule = RULE) => rule.folds.map((f) => ({ ...f }));

function assertValidationPanel(panel) {
  const v = segs.SEGMENTS.VALIDATION; const d = panel && panel.dates;
  if (!panel || panel.segment !== 'VALIDATION' || !d || !d.length || d[d.length - 1] > v.to) fail('NOT_VALIDATION_PANEL', `${panel && panel.segment}:${d && d[d.length - 1]}`);
}

/**
 * 一个候选在各折上的 IC。
 * @returns {{fold_ic: Array<{fold, from, to, ic_mean, ic_days}>, mean_ic: number|null, ic_days: number, positive_folds: number}}
 */
function validationStats(parsed, panel, { holding_period: H, rule = RULE, neutralization }) {
  assertValidationPanel(panel);
  const neu = scoring.neutralizedValues(parsed, panel, { neutralization }); // 本轮的版本，必须给（修订 SIZE_V2 N2）
  const ic = scoring.dailyRankIc(neu.values, scoring.forwardReturns(panel, H), panel.universe);
  const fs = folds(rule);
  const per = fs.map((f) => {
    const xs = panel.dates.map((d, t) => (d >= f.from && d <= f.to ? ic[t] : NaN)).filter(isNum);
    return { fold: f.fold, from: f.from, to: f.to, ic_mean: xs.length ? scoring.meanFinite(xs) : null, ic_days: xs.length };
  });
  const all = panel.dates.map((d, t) => (d >= segs.SEGMENTS.VALIDATION.from ? ic[t] : NaN)).filter(isNum);
  return { fold_ic: per, mean_ic: all.length ? scoring.meanFinite(all) : null, ic_days: all.length, positive_folds: per.filter((f) => isNum(f.ic_mean) && f.ic_mean > 0).length,
    neutralization: neu.neutralization, values: neu.values };
}

/** 规则（清单里的那一条）：全折均值 > mean_ic_gt、正折 ≥ positive_folds_min、挖掘段分数 > mining_score_gt。 */
function passes(stats, miningScore, rule = RULE) {
  return isNum(stats.mean_ic) && stats.mean_ic > rule.mean_ic_gt && stats.positive_folds >= rule.positive_folds_min && isNum(miningScore) && miningScore > rule.mining_score_gt;
}

module.exports = { RULE, SelectorError, folds, validationStats, passes, assertValidationPanel };
