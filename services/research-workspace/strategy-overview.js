'use strict';

/**
 * 「策略总览」的唯一展示投影（队列 #21）。
 *
 * 结论只写「做」或「不做」（Owner 2026-10-06），由这里按数据给出，页面不得再从 role、lifecycle
 * 或 Q0 统计标签自行判断：
 *   - 普通 Desk 策略：按 Desk 目录的运行事实（模拟盘运行 = 做；影子、收尾、关闭 = 不做）；
 *   - 拆成研究模块的账本（登记里的上级 parent.desk_book，即 A 股整本账本）：模块、顺序、名称、簿 / 组件、研究线、方向、上级
 *     全部读 config/ashare_research_modules.v1.json（services/ashare-research-modules）；结论只取
 *     state = CONCLUDED 的 verdicts[].decision，仍在研究的题不写结论，放进「研究进行中」，写数据里的
 *     预计日期和转成做 / 不做的规则。统计标签（INSUFFICIENT 等）只进折叠详情。
 * 数据缺的地方写「待交付 · X」，不写「尚未接入」。上级账本只计一次。
 *
 * 层（三层分工合同 V1 §2.1，Owner 2026-11-08）：每个研究题带 layer（代码 + 中文），由 services/research-layer-register
 * 按 strategy_ref + 题号给出；没有登记的题写「待交付 · 层登记」。总览另给按层计数与那一行字（layer_line_zh）。
 */

const ashareModules = require('../ashare-research-modules');
const layerRegister = require('../research-layer-register');

const { PENDING_PREFIX } = ashareModules;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DECISION_CODES = Object.freeze({ 做: 'DO', 不做: 'DONT' });
const STATISTICAL_LABELS_ZH = Object.freeze({ INSUFFICIENT: '证据不足' });
const PRODUCTION_CHANGE_ZH = Object.freeze({ DRAFT_AWAITING_OWNER_SIGNATURE: '生产上线待 Owner 签字' });
const RUNS_AS_ZH = Object.freeze({ FORWARD_PAPER_SHADOW: '前向影子' });
const SECTIONS = Object.freeze([
  Object.freeze({ key: 'do', code: 'DO', title_zh: '做', note_zh: '在模拟盘运行，或封存结论为做' }),
  Object.freeze({ key: 'dont', code: 'DONT', title_zh: '不做', note_zh: '影子、收尾或已关闭' }),
  Object.freeze({ key: 'researching', code: null, title_zh: '研究进行中', note_zh: '尚未形成做 / 不做结论' }),
]);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const runtimeOf = (item) => [item.lifecycle && item.lifecycle.label, item.mode_label].filter(isText).join(' · ');

// ── 普通 Desk 策略（美股、加密）：沿用 #60 ─────────────────────────────────────────────

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

function researchOf(item, layerOf = layerRegister.layerOf) {
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
    in_progress: [],
    gaps: [],
    detail: !missing && stage ? { kind: 'STAGE', headline_zh: stage.headline_zh, steps: stage.steps || [] } : null,
    has_insufficient_statistics: Boolean(stage && JSON.stringify(stage).includes('证据不足')),
    items: (stage && stage.items ? stage.items : []).map((entry) => ({ ...entry, layer: layerOf(item.strategy_ref, entry.id) })),
  };
}

function ordinaryCard(item, layerOf) {
  const verdict = verdictOf(item);
  return {
    kind: 'STRATEGY', module_ref: item.strategy_ref, strategy_ref: item.strategy_ref,
    parent_strategy_ref: item.strategy_ref, parent_label_zh: null, market_label: item.market_label, name: item.name,
    role: item.role, lifecycle: item.lifecycle, mode_label: item.mode_label,
    runtime_zh: runtimeOf(item), rule_zh: null,
    verdict, summary_zh: verdict ? `${verdict.label_zh} · ${verdict.qualifier_zh}` : '研究进行中',
    research: researchOf(item, layerOf),
  };
}

// ── 拆成研究模块的账本（读 config/ashare_research_modules.v1.json）────────────────────

/** 预计日期：数据给日期（expected_by）或时刻（expected_end，未封存的写「估计」）；都没有写占位符。 */
function expectedOf(item) {
  if (DAY.test(item.expected_by || '')) return `预计 ${item.expected_by}`;
  if (STAMP.test(item.expected_end || '')) {
    return `预计 ${item.expected_end.slice(0, 10)} ${item.expected_end.slice(11, 16)}${item.sealed === false ? '（估计，未封存）' : ''}`;
  }
  return `${PENDING_PREFIX}预计日期`;
}

function openItem(item, fallbackId) {
  return {
    id: item.id || fallbackId, title_zh: item.title_zh, state_label_zh: item.state_label_zh,
    expected_zh: expectedOf(item),
    conversion_rule_zh: isText(item.decided_by_zh) ? item.decided_by_zh : null,
  };
}

/**
 * 封存结论旁的说明，由数据拼出：生产变更的状态与规则名（production_change.state、title_zh「：」前一段）
 * + 前向影子的臂名与起始日（runs_as.stage、runs_as.t_start），形如「生产上线待 Owner 签字（规则 vN）；X 前向影子 MM-DD 起」。
 * 两样都没有时用 decision_meaning_zh。
 */
function verdictNote(verdict) {
  const parts = [];
  const change = verdict.production_change;
  if (change && PRODUCTION_CHANGE_ZH[change.state]) {
    const rule = String(change.title_zh || '').split('：')[0].trim();
    parts.push(`${PRODUCTION_CHANGE_ZH[change.state]}${rule ? `（${rule}）` : ''}`);
  }
  const runs = verdict.runs_as;
  if (runs && RUNS_AS_ZH[runs.kind]) {
    const arm = /_([A-Z0-9]+)_SHADOW$/.exec(runs.stage || ''); // INDEX_ETF_VG_SHADOW → VG
    parts.push(`${arm ? `${arm[1]} ` : ''}${RUNS_AS_ZH[runs.kind]}${DAY.test(runs.t_start || '') ? ` ${runs.t_start.slice(5)} 起` : ''}`);
  }
  return parts.length ? parts.join('；') : (verdict.decision_meaning_zh || null);
}

function verdictDetail(verdict, layer) {
  return {
    layer,
    id: verdict.id, title_zh: verdict.title_zh, decision: verdict.decision, sealed_on: verdict.sealed_on || null,
    statistical_label: verdict.statistical_label || null,
    statistical_label_zh: verdict.statistical_label
      ? `${verdict.statistical_label}${STATISTICAL_LABELS_ZH[verdict.statistical_label] ? `（${STATISTICAL_LABELS_ZH[verdict.statistical_label]}）` : ''}`
      : null,
    meaning_zh: verdict.decision_meaning_zh || null,
    per_item_zh: (verdict.per_etf || []).map((row) => `${row.code}：${row.reading_zh || row.reading}`),
  };
}

function moduleCard(parent, registry, spec, q0Here, layerOf = layerRegister.layerOf) {
  const layered = (item) => ({ ...item, layer: layerOf(parent.strategy_ref, item.id) });
  const concluded = spec.verdicts.filter((item) => item.state === 'CONCLUDED' && DECISION_CODES[item.decision]);
  const lineVerdict = concluded.find((item) => item.id === spec.research_line) || null;
  const lineOpen = lineVerdict ? null : spec.in_progress.find((item) => item.id === spec.research_line) || null;
  const verdict = lineVerdict ? {
    code: DECISION_CODES[lineVerdict.decision], label_zh: lineVerdict.decision,
    qualifier_zh: verdictNote(lineVerdict), source_ref: lineVerdict.id, sealed_on: lineVerdict.sealed_on || null,
  } : null;
  const open = spec.in_progress.filter((item) => item !== lineOpen && item.id !== spec.research_line).map((item) => layered(openItem(item)));
  if (q0Here) open.push(layered(openItem(q0Here, 'Q0')));
  const lineLayer = layerOf(parent.strategy_ref, spec.research_line);
  const lineTitle = (lineVerdict || lineOpen || {}).title_zh || null;
  const rule = spec.production_rule;
  return {
    kind: 'RESEARCH_MODULE', module_ref: spec.module_id, module_id: spec.module_id, order: spec.order,
    book_ref: spec.book, component: spec.component, name: spec.label_zh, scope_zh: spec.scope_zh || null,
    research_ref: spec.research_line, research_direction_zh: spec.direction_zh,
    strategy_ref: parent.strategy_ref, parent_strategy_ref: parent.strategy_ref, parent_label_zh: registry.parent.label_zh,
    market_label: parent.market_label, role: parent.role, lifecycle: parent.lifecycle, mode_label: parent.mode_label,
    runtime_zh: runtimeOf(parent),
    rule_zh: rule && isText(rule.key) ? `${rule.key}${isText(rule.version) ? ` ${rule.version}` : ''}${isText(rule.rule_zh) ? `：${rule.rule_zh}` : ''}` : null,
    verdict, summary_zh: verdict ? `${verdict.label_zh} · ${verdict.qualifier_zh}` : (lineOpen ? lineOpen.state_label_zh : '研究进行中'),
    research: {
      state: lineVerdict ? 'CONCLUDED' : lineOpen ? 'RESEARCHING' : 'PENDING_DELIVERY',
      summary_zh: lineVerdict
        ? `${spec.research_line} 已封存${lineVerdict.sealed_on ? ` · ${lineVerdict.sealed_on}` : ''}`
        : lineOpen ? `${lineOpen.state_label_zh} · ${lineOpen.title_zh}` : `${PENDING_PREFIX}${spec.research_line} 研究状态`,
      expected_zh: lineOpen ? expectedOf(lineOpen) : null,
      conversion_rule_zh: lineOpen ? (isText(lineOpen.decided_by_zh) ? lineOpen.decided_by_zh : `${PENDING_PREFIX}做 / 不做转换规则`) : null,
      in_progress: open,
      gaps: spec.coverage_gaps.map((gap) => ({
        id: gap.id, label_zh: gap.label_zh, state: gap.state || null,
        placeholder_zh: isText(gap.placeholder_zh) ? gap.placeholder_zh : `${PENDING_PREFIX}${gap.label_zh}`,
      })),
      detail: concluded.length ? { kind: 'VERDICTS', verdicts: concluded.map((item) => verdictDetail(item, layerOf(parent.strategy_ref, item.id))) } : null,
      has_insufficient_statistics: concluded.some((item) => item.statistical_label === 'INSUFFICIENT'),
      // 研究线本身的层（卡片上研究线与方向那一行旁的标签）与本卡的研究题清单
      layer: lineLayer,
      items: [{ id: spec.research_line, title_zh: lineTitle, layer: lineLayer }, ...open.map((item) => ({ id: item.id, title_zh: item.title_zh, layer: item.layer }))],
    },
  };
}

function splitParent(item, registry, layerOf = layerRegister.layerOf) {
  const specs = [...registry.modules].sort((a, b) => a.order - b.order);
  const q0 = registry.q0 || null;
  const q0OnParent = Boolean(q0 && specs.every((spec) => q0.applies_to.includes(spec.module_id)));
  const modules = specs.map((spec) => moduleCard(item, registry, spec,
    q0 && !q0OnParent && q0.applies_to.includes(spec.module_id) ? q0 : null, layerOf));
  const q0Item = q0OnParent ? openItem(q0, 'Q0') : null;
  return {
    strategy_ref: item.strategy_ref, market_label: item.market_label, name: registry.parent.label_zh, desk_name: item.name,
    lifecycle: item.lifecycle, split: true, counted_once: registry.parent.counted_once === true,
    summary_zh: `1 个资金池 · ${modules.length} 个研究模块 · 上级只计一次`,
    note_zh: registry.parent.note_zh || null,
    runtime_zh: runtimeOf(item),
    in_progress: q0Item ? [{ ...q0Item, layer: layerOf(item.strategy_ref, q0Item.id) }] : [],
    modules,
  };
}

/**
 * 全部研究题（同一 strategy_ref + 题号只列一次）：总览卡片上的题、上级账本的题，加上只在详情页出现的题
 * （extraItems：strategy_ref → [{ id, title_zh }]，由读模型从海外封存结论、差距分解取出）。每题带层。
 */
function researchItemsOf(parents, extraItems, layerOf) {
  const rows = [];
  const seen = new Set();
  const push = (strategyRef, item, where) => {
    const key = `${strategyRef}\u0000${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ strategy_ref: strategyRef, id: item.id, title_zh: item.title_zh || null, where, layer: item.layer || layerOf(strategyRef, item.id) });
  };
  for (const parent of parents) {
    for (const item of parent.in_progress || []) push(parent.strategy_ref, item, 'OVERVIEW');
    for (const card of parent.modules) for (const item of card.research.items || []) push(card.strategy_ref, item, 'OVERVIEW');
  }
  for (const [strategyRef, items] of extraItems) for (const item of items) push(strategyRef, item, 'DETAIL');
  return rows;
}

function buildOverview(directory, { registryFor = ashareModules.forDeskBook, layerOf = layerRegister.layerOf, extraItems = new Map() } = {}) {
  const parents = directory.strategies.map((item) => {
    const registry = registryFor(item.strategy_ref);
    if (registry) return splitParent(item, registry, layerOf);
    return {
      strategy_ref: item.strategy_ref, market_label: item.market_label, name: item.name,
      lifecycle: item.lifecycle, split: false, modules: [ordinaryCard(item, layerOf)],
    };
  });
  const cards = parents.flatMap((item) => item.modules);
  const sections = SECTIONS.map((section) => ({
    ...section, cards: cards.filter((card) => (section.code ? card.verdict?.code === section.code : !card.verdict)),
  }));
  const [doCards, dontCards, researchingCards] = sections.map((section) => section.cards);
  const counts = { do: doCards.length, dont: dontCards.length, researching: researchingCards.length };
  const researchItems = researchItemsOf(parents, extraItems, layerOf);
  const layerCounts = layerRegister.countsOf(researchItems);
  const splits = parents.filter((item) => item.split)
    .map((item) => `${item.market_label} 1 个资金池拆为 ${item.modules.length} 个研究模块，父账本只计一次。`).join('');
  return {
    system_strategy_count: directory.strategies.length,
    display_module_count: cards.length,
    counts,
    parents,
    cards,
    sections,
    groups: { do: doCards, dont: dontCards, researching: researchingCards },
    research_items: researchItems,
    layer_counts: layerCounts,
    layer_line_zh: layerRegister.countsLine(layerCounts),
    answer_zh: `Desk 共登记 ${directory.strategies.length} 个系统策略，按研究模块展示 ${cards.length} 项：做 ${counts.do} 项，不做 ${counts.dont} 项${counts.researching ? `，研究进行中 ${counts.researching} 项` : ''}。${splits}`,
  };
}

module.exports = { PENDING_PREFIX, SECTIONS, verdictOf, researchOf, verdictNote, expectedOf, researchItemsOf, buildOverview };
