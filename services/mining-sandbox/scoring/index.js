'use strict';

/**
 * 挖掘段打分（RF1116 §3.4「挖掘段：算分、生成下一批」；P2 规格 §2「适应度只用挖掘段的分数：中性化后的 rank IC 均值」）。
 *
 *   miningScore(parsed, panel, { holding_period })：面板必须是挖掘段的（segment MINING，日期整段在挖掘段里），否则 MINE_SCORE_NOT_MINING_SEGMENT ——
 *     验证折、留出段的面板一喂就抛错。因子值先过求值器的 neutralizeForScoring（行业 + 市值；只在股票池里的名字上中性化），
 *     再逐日算与前推收益的 rank IC（Spearman），分数 = 各日 IC 的均值（有效日少于 MIN_IC_DAYS → null）。
 *   forwardReturns(panel, H)：决策日开盘买、H 个交易日后的开盘卖（labels.exec_open，后复权）；超出面板的为 NaN，所以标签不会越出本段。
 *   dailyRankIc(values, fwd, universe)：每天只用池里、两边都有数的名字；少于 MIN_NAMES 个 → NaN。
 * 长度惩罚在 GP 里（../gp 的 fitnessOf），这里记的分数就是试验台账 metrics.mining_segment_score。只读面板，不写台账，不连网络。
 */
const evaluator = require('../evaluator');
const segs = require('../segments');

const MIN_NAMES = 5;
const MIN_IC_DAYS = 20;

class ScoreError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new ScoreError(`MINE_SCORE_${code}`, detail); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function assertMiningPanel(panel) {
  const m = segs.SEGMENTS.MINING;
  const d = panel && Array.isArray(panel.dates) ? panel.dates : [];
  if (!panel || panel.segment !== 'MINING' || !d.length || d[0] < m.from || d[d.length - 1] > m.to) {
    fail('NOT_MINING_SEGMENT', `${panel ? panel.segment : 'none'}:${d[0] || '?'}..${d[d.length - 1] || '?'} vs ${m.from}..${m.to}`);
  }
}

/** 决策日开盘到 H 个交易日后开盘的收益（面板之内）。 */
function forwardReturns(panel, H) {
  if (!Number.isInteger(H) || H < 1) fail('HOLDING_PERIOD', H);
  const ex = panel && panel.labels && panel.labels.exec_open;
  if (!Array.isArray(ex) || ex.length !== panel.dates.length) fail('LABELS_MISSING');
  const T = ex.length;
  return ex.map((row, t) => row.map((p, j) => (t + H < T && p > 0 && ex[t + H][j] > 0 ? ex[t + H][j] / p - 1 : NaN)));
}

function averageRanks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let s = 0; s < idx.length;) { let e = s; while (e + 1 < idx.length && idx[e + 1][0] === idx[s][0]) e += 1; for (let k = s; k <= e; k += 1) r[idx[k][1]] = (s + e) / 2; s = e + 1; }
  return r;
}
function pearson(a, b) {
  const n = a.length; let ma = 0; let mb = 0; for (let k = 0; k < n; k += 1) { ma += a[k]; mb += b[k]; } ma /= n; mb /= n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let k = 0; k < n; k += 1) { sab += (a[k] - ma) * (b[k] - mb); saa += (a[k] - ma) ** 2; sbb += (b[k] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}
/** 一天的 Spearman（只用 mask 里、两边都有限的名字）。 */
function rankIcOfDay(values, fwd, mask) {
  const x = []; const y = [];
  for (let j = 0; j < values.length; j += 1) if ((!mask || mask[j]) && isNum(values[j]) && isNum(fwd[j])) { x.push(values[j]); y.push(fwd[j]); }
  return x.length < MIN_NAMES ? NaN : pearson(averageRanks(x), averageRanks(y));
}
/** 逐日 rank IC（与 values 同长；算不出的日子是 NaN）。 */
const dailyRankIc = (values, fwd, universe) => values.map((row, t) => rankIcOfDay(row, fwd[t], universe ? universe[t] : null));

/** 打分用的面板：行业在池外置空，中性化后池外的名字就是 NaN，不进中性化回归也不进 IC。 */
function scoringPanel(panel) {
  if (!panel.industry || !panel.universe) return panel;
  return { ...panel, industry: panel.industry.map((row, t) => row.map((g, j) => (panel.universe[t][j] ? g : null))) };
}

/** 求值 + 打分前的中性化（求值器的 neutralizeForScoring，盖 neutralization 戳）。 */
const neutralizedValues = (parsed, panel) => evaluator.neutralizeForScoring(evaluator.evaluate(parsed, panel), scoringPanel(panel));

const meanFinite = (xs) => { const f = xs.filter(isNum); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null; };

/**
 * 挖掘段的分数（GP 的适应度用它减长度惩罚；试验台账 metrics.mining_segment_score 写它）。
 * @returns {{score: number|null, ic_days: number, holding_period: number, neutralization: object, segment: 'MINING'}}
 */
function miningScore(parsed, panel, { holding_period: H } = {}) {
  assertMiningPanel(panel);
  const neu = neutralizedValues(parsed, panel);
  const ics = dailyRankIc(neu.values, forwardReturns(panel, H), panel.universe);
  const finite = ics.filter(isNum);
  return { score: finite.length >= MIN_IC_DAYS ? meanFinite(finite) : null, ic_days: finite.length, holding_period: H, neutralization: neu.neutralization, segment: 'MINING' };
}

module.exports = {
  MIN_NAMES, MIN_IC_DAYS, ScoreError, assertMiningPanel, forwardReturns, dailyRankIc, rankIcOfDay, scoringPanel, neutralizedValues, meanFinite, miningScore,
  internals: { averageRanks, pearson },
};
