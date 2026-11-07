'use strict';

/**
 * 「策略总览」的唯一展示投影。
 *
 * 这里把 Desk 目录已经给出的运行事实翻成用户要看的「做 / 不做」，并把研究进度降到
 * 折叠详情。页面不得再从 role、lifecycle 或 Q0 统计标签自行判断。
 */

const ASHARE_PARENT = 'ASHARE_V6_PAPER';
const PENDING_PREFIX = '待交付 · ';

const ASHARE_MODULES = Object.freeze([
  Object.freeze({
    module_ref: 'ASHARE_V6_PAPER:INDEX', book_ref: 'INDEX_BOOK', component: 'INDEX', name: '宽基 ETF',
    research_ref: 'R-ETF-1', research_direction_zh: '网格 / 均值回归', expected_on: '2026-11-10',
  }),
  Object.freeze({
    module_ref: 'ASHARE_V6_PAPER:STOCK', book_ref: 'STOCK_BOOK', component: 'STOCK', name: '个股 / 行业 ETF',
    research_ref: 'R-STK-1', research_direction_zh: '趋势跟踪', expected_on: '2026-11-14',
  }),
]);

function verdictOf(item) {
  if (item.role === 'SHADOW') {
    return { code: 'DONT', label_zh: '不做', qualifier_zh: '影子观察，不影响持仓' };
  }
  if (item.lifecycle.group === 'HISTORY') {
    return { code: 'DONT', label_zh: '不做', qualifier_zh: item.lifecycle.label };
  }
  if (item.role === 'PAPER') {
    return { code: 'DO', label_zh: '做', qualifier_zh: '已在模拟盘运行' };
  }
  return null;
}

function researchOf(item) {
  const stage = item.research_stage || null;
  const missing = !stage || stage.code === 'NOT_CONNECTED' || stage.code === 'M4_PENDING';
  const researching = Boolean(stage && (
    stage.code === 'CONNECTED' || stage.code === 'Q0_LOCKED' || stage.code === 'ROUND_FORWARD'
    || stage.code === 'ROUND_INVALID' || stage.code === 'Q0_INVALID' || stage.counts?.open > 0
  ));
  return {
    state: missing ? 'PENDING_DELIVERY' : researching ? 'RESEARCHING' : 'RECORDED',
    summary_zh: missing ? `${PENDING_PREFIX}研究状态` : researching ? '研究进行中' : '研究结果已登记',
    expected_zh: researching ? `${PENDING_PREFIX}预计日期` : null,
    conversion_rule_zh: researching ? `${PENDING_PREFIX}做 / 不做转换规则` : null,
    detail: !missing && stage ? { headline_zh: stage.headline_zh, steps: stage.steps || [] } : null,
    has_insufficient_statistics: Boolean(stage && JSON.stringify(stage).includes('证据不足')),
  };
}

function ordinaryCard(item) {
  const verdict = verdictOf(item);
  return {
    kind: 'STRATEGY', module_ref: item.strategy_ref, strategy_ref: item.strategy_ref,
    parent_strategy_ref: item.strategy_ref, market_label: item.market_label, name: item.name,
    role: item.role, lifecycle: item.lifecycle, mode_label: item.mode_label,
    verdict, summary_zh: verdict ? `${verdict.label_zh} · ${verdict.qualifier_zh}` : '研究进行中',
    research: researchOf(item),
  };
}

function ashareModules(parent) {
  const verdict = verdictOf(parent);
  return ASHARE_MODULES.map((spec) => ({
    kind: 'ASHARE_MODULE', ...spec, strategy_ref: parent.strategy_ref, parent_strategy_ref: parent.strategy_ref,
    market_label: parent.market_label, role: parent.role, lifecycle: parent.lifecycle, mode_label: parent.mode_label,
    verdict, summary_zh: verdict ? `${verdict.label_zh} · ${verdict.qualifier_zh}` : '研究进行中',
    research: {
      state: 'PENDING_DELIVERY', summary_zh: `${PENDING_PREFIX}${spec.research_ref} 研究状态`,
      expected_zh: `预计 ${spec.expected_on}`,
      conversion_rule_zh: '按冻结判据形成“做 / 不做”；证据不足时进入前向模拟影子',
      detail: null,
      has_insufficient_statistics: false,
    },
  }));
}

function buildOverview(directory) {
  const parents = directory.strategies.map((item) => {
    const modules = item.strategy_ref === ASHARE_PARENT ? ashareModules(item) : [ordinaryCard(item)];
    return {
      strategy_ref: item.strategy_ref, market_label: item.market_label, name: item.name,
      lifecycle: item.lifecycle, modules,
    };
  });
  const cards = parents.flatMap((item) => item.modules);
  const count = (code) => cards.filter((item) => item.verdict?.code === code).length;
  const researching = cards.filter((item) => !item.verdict).length;
  const counts = { do: count('DO'), dont: count('DONT'), researching };
  return {
    system_strategy_count: directory.strategies.length,
    display_module_count: cards.length,
    counts,
    parents,
    cards,
    groups: {
      do: cards.filter((item) => item.verdict?.code === 'DO'),
      dont: cards.filter((item) => item.verdict?.code === 'DONT'),
      researching: cards.filter((item) => !item.verdict),
    },
    answer_zh: `Desk 共登记 ${directory.strategies.length} 个系统策略，按研究模块展示 ${cards.length} 项：做 ${counts.do} 项，不做 ${counts.dont} 项${researching ? `，研究进行中 ${researching} 项` : ''}。A 股 1 个资金池拆为 2 个研究模块，父账本只计一次。`,
  };
}

module.exports = { ASHARE_PARENT, ASHARE_MODULES, PENDING_PREFIX, verdictOf, researchOf, buildOverview };

