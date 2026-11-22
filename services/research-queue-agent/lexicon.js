'use strict';
/**
 * 词表（§5.6）：预测词（中英）、结论与建议词、方向词。验证器按它们拒绝；每个词在测试里各有一个失败夹具，变异检查逐个删。
 * 「做 / 不做」只在作为判断出现时才拒（不做、「结论：做」），日常用语「做过」不拒。
 */
const PREDICTION = [
  ['会涨', /会涨/], ['会跌', /会跌/], ['上涨概率', /上涨概率/], ['目标价', /目标价/], ['预计', /预计/], ['看多', /看多/], ['看空', /看空/],
  ['will rise', /\bwill\s+(rise|fall)\b/i], ['expect', /\bexpect(s|ed|ing)?\b/i], ['probability', /\bprobabilit(y|ies)\b/i],
  ['target', /\btarget\b/i], ['forecast', /\bforecast\w*/i], ['outperform', /\boutperform\w*/i],
];
const VERDICT = [
  ['不做', /不做/], ['结论做', /(结论|判断|裁决|判定|verdict)\s*[:：]\s*做/i], ['建议上线', /建议上线/], ['应当采用', /应当采用/],
  ['买入', /买入/], ['卖出', /卖出/], ['加仓', /加仓/], ['减仓', /减仓/], ['adopt', /\badopt\b/i],
];
const DIRECTION = [
  ['做多', /做多/], ['做空', /做空/], ['看涨', /看涨/], ['看跌', /看跌/], ['bullish', /\bbullish\b/i], ['bearish', /\bbearish\b/i],
  ['go long', /\bgo(ing)?\s+(long|short)\b/i],
];
const LISTS = { PREDICTION, VERDICT, DIRECTION };

/** @returns {{list: string, term: string}[]} */
function findWording(text, lists = ['PREDICTION', 'VERDICT']) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const name of lists) for (const [term, re] of LISTS[name]) if (re.test(text)) out.push({ list: name, term });
  return out;
}

module.exports = { PREDICTION, VERDICT, DIRECTION, findWording };
