'use strict';

/**
 * 前推验证折上的选择（RF1116 §3.4「验证折：在候选之间做选择；不能反馈给生成方，只有沙箱的选择器看得到」；P2 规格 §1 第 5 步）。
 *
 * 折（11-10 修订 §7.2 的窗口：检验 6 个月、步长 6 个月、最后一折到数据末；训练窗锚定在挖掘段起点，挖掘段 3.5 年 ≥ 3 年）：
 *   验证折 2024-01-02 → 2026-10-16 按自然半年切：2024H1、2024H2、2025H1、2025H2、2026H1、2026-07-01 → 2026-10-16。
 *   挖出的公式没有要拟合的参数，所以「训练窗」不选任何东西；每折只是一段样本外。
 * 每个候选每折：中性化（行业 + 市值，求值器的 neutralizeForScoring）后的逐日 rank IC 的均值；标签不越出验证折（面板到验证折终点为止）。
 * 选择规则 VALIDATION_SELECTION_V1（协调会话没有定，先按 DEFAULT_A 取最朴素的一条，交协调会话审）：
 *   全验证折的 IC 均值 > 0，且 IC 均值为正的折 ≥ ⌈2/3 × 折数⌉，且挖掘段分数也为正（方向一致）。
 * 输出只进执行器的输出目录（selection.json），不进试验台账、不进 generatorView；选完之后本轮不能再生成。
 */
const segs = require('../segments');
const scoring = require('../scoring');

const RULE = Object.freeze({
  schema: 'VALIDATION_SELECTION_V1', status: 'DEFAULT_PENDING_COORDINATOR_REVIEW', folds: 'HALF_YEAR_TEST_WINDOWS_11_10_S7_2', ic: 'NEUTRALIZED_DAILY_RANK_IC_MEAN',
  mean_ic_gt: 0, positive_fold_share_min: 2 / 3, mining_score_gt: 0,
});

class SelectorError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new SelectorError(`MINE_SELECT_${code}`, detail); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 验证折的半年窗（按决策日）。 */
function folds(seg = segs.SEGMENTS.VALIDATION) {
  const out = []; let y = Number(seg.from.slice(0, 4)); let h = Number(seg.from.slice(5, 7)) <= 6 ? 1 : 2;
  for (;;) {
    const from = h === 1 ? `${y}-01-01` : `${y}-07-01`; const to = h === 1 ? `${y}-06-30` : `${y}-12-31`;
    if (from > seg.to) break;
    out.push({ fold: out.length + 1, from: from < seg.from ? seg.from : from, to: to > seg.to ? seg.to : to });
    if (h === 1) h = 2; else { h = 1; y += 1; }
  }
  return out;
}

function assertValidationPanel(panel) {
  const v = segs.SEGMENTS.VALIDATION; const d = panel && panel.dates;
  if (!panel || panel.segment !== 'VALIDATION' || !d || !d.length || d[d.length - 1] > v.to) fail('NOT_VALIDATION_PANEL', `${panel && panel.segment}:${d && d[d.length - 1]}`);
}

/**
 * 一个候选在各折上的 IC。
 * @returns {{fold_ic: Array<{fold, from, to, ic_mean, ic_days}>, mean_ic: number|null, ic_days: number, positive_folds: number}}
 */
function validationStats(parsed, panel, { holding_period: H }) {
  assertValidationPanel(panel);
  const neu = scoring.neutralizedValues(parsed, panel);
  const ic = scoring.dailyRankIc(neu.values, scoring.forwardReturns(panel, H), panel.universe);
  const fs = folds();
  const per = fs.map((f) => {
    const xs = panel.dates.map((d, t) => (d >= f.from && d <= f.to ? ic[t] : NaN)).filter(isNum);
    return { fold: f.fold, from: f.from, to: f.to, ic_mean: xs.length ? scoring.meanFinite(xs) : null, ic_days: xs.length };
  });
  const all = panel.dates.map((d, t) => (d >= segs.SEGMENTS.VALIDATION.from ? ic[t] : NaN)).filter(isNum);
  return { fold_ic: per, mean_ic: all.length ? scoring.meanFinite(all) : null, ic_days: all.length, positive_folds: per.filter((f) => isNum(f.ic_mean) && f.ic_mean > 0).length,
    neutralization: neu.neutralization };
}

/** 规则：全折均值 > 0、正折占比 ≥ 2/3、挖掘段分数 > 0。 */
function passes(stats, miningScore) {
  const need = Math.ceil(RULE.positive_fold_share_min * folds().length - 1e-9);
  return isNum(stats.mean_ic) && stats.mean_ic > RULE.mean_ic_gt && stats.positive_folds >= need && isNum(miningScore) && miningScore > RULE.mining_score_gt;
}

module.exports = { RULE, SelectorError, folds, validationStats, passes, assertValidationPanel };
