'use strict';

/**
 * Report side checks of the label table (contract section 7.3 ES-1..ES-4, section 8.2 R-8, R-9, R-10 synthetic half).
 *   ES-1  rows are called rows; a sample size (or N) is written only together with its clustering method.
 *   ES-2  clusters are counted from fields of the panel record (sessionDate, book, securityId, finalOutcome, the `signalEpoch` and `industry` features), never recomputed elsewhere.
 *   ES-3  an estimate that cannot be made is N/A, never 0 and never a pass; insufficient power is "做 (forward shadow)", never "不做".
 *   ES-4  the four section 3.2 questions each get a table of counts and means. The tables state no conclusion: they say whether the data can answer, K2 studies answer.
 * Everything is a function of the joined rows (join.js); nothing here reads a file, a clock or a price.
 */
const v = require('./vocab');

const UNKNOWN = (reasonCode) => ({ state: 'UNKNOWN', reasonCode });
/** Books whose evaluation points are scans a few minutes apart: an event clustering is mandatory for them (ES-2). */
const SCAN_BOOKS = Object.freeze(['C17', 'US_V5', 'QUICK_SHOT']);
const HOUR = 3600000;

const withPanel = (joined) => joined.filter((j) => j.panel);
const eventKeyOf = (p) => {
  const epoch = (p.features || []).find((f) => f && f.name === 'signalEpoch' && f.state === 'VALUE');
  return epoch ? `epoch:${epoch.value}` : `outcome:${p.finalOutcome}`;
};
const byPoint = (a, b) => (a.evaluatedAt < b.evaluatedAt ? -1 : a.evaluatedAt > b.evaluatedAt ? 1 : a.evaluationPointId < b.evaluationPointId ? -1 : 1);

/** Distinct evaluation points and the per candidate series of event keys, per book. */
function structure(joined) {
  const books = new Map();
  const seen = new Set();
  for (const { panel: p, candidateId } of withPanel(joined)) {
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    if (!books.has(p.book)) books.set(p.book, { points: new Map(), series: new Map() });
    const b = books.get(p.book);
    b.points.set(p.evaluationPointId, { evaluationPointId: p.evaluationPointId, evaluatedAt: p.evaluatedAt, sessionDate: p.sessionDate });
    if (!b.series.has(p.securityId)) b.series.set(p.securityId, new Map());
    b.series.get(p.securityId).set(p.evaluationPointId, eventKeyOf(p));
  }
  return books;
}

function countEvents(books) {
  let events = 0;
  for (const b of books.values()) {
    const ordered = [...b.points.values()].sort(byPoint);
    for (const series of b.series.values()) {
      let prev = null;
      for (const pt of ordered) {
        const key = series.has(pt.evaluationPointId) ? series.get(pt.evaluationPointId) : null;
        if (key === null) prev = null; else { if (key !== prev) events += 1; prev = key; }
      }
    }
  }
  return events;
}

function overlapOf(windowId, books, sessionGap) {
  const unit = windowId.endsWith('H') ? 'HOUR' : 'SESSION';
  const length = Number(windowId.slice(1, -1));
  const gaps = [];
  for (const b of books.values()) {
    if (unit === 'HOUR') {
      const at = [...new Set([...b.points.values()].map((p) => p.evaluatedAt))].sort();
      for (let i = 1; i < at.length; i += 1) gaps.push((Date.parse(at[i]) - Date.parse(at[i - 1])) / HOUR);
    } else if (sessionGap) {
      const days = [...new Set([...b.points.values()].map((p) => p.sessionDate))].sort();
      for (let i = 1; i < days.length; i += 1) gaps.push(sessionGap(days[i - 1], days[i]));
    }
  }
  if (unit === 'SESSION' && !sessionGap) return { windowId, state: 'UNKNOWN', reasonCode: 'SESSION_CALENDAR_NOT_PROVIDED' };
  if (!gaps.length) return { windowId, state: 'UNKNOWN', reasonCode: 'SINGLE_EVALUATION_POINT' };
  const minEvaluationGap = Math.min(...gaps);
  return { windowId, state: length > minEvaluationGap ? 'OVERLAPPING' : 'NON_OVERLAPPING', minEvaluationGap, lag: Math.max(0, length - minEvaluationGap) };
}

/**
 * ES-2 cluster counts. `sessionGap(dateA, dateB)` is the number of sessions between two session dates, supplied by the caller from a real calendar; without it a
 * window counted in sessions is UNKNOWN / SESSION_CALENDAR_NOT_PROVIDED (no weekday guess).
 */
function describeSample(joined, { windows = [], sessionGap = null } = {}) {
  const rowsWithPanel = withPanel(joined);
  const books = structure(joined);
  const dates = new Set(rowsWithPanel.map((j) => j.panel.sessionDate));
  const markets = new Set(rowsWithPanel.map((j) => j.panel.market));
  const industries = new Set();
  for (const j of rowsWithPanel) for (const f of j.panel.features || []) if (f && f.name === 'industry' && f.state === 'VALUE') industries.add(String(f.value));
  let industry;
  if (markets.size && [...markets].every((m) => m === 'CRYPTO')) industry = { state: 'NOT_APPLICABLE', reasonCode: 'CRYPTO_HAS_NO_INDUSTRY_CLUSTER' };
  else industry = industries.size ? { state: 'VALUE', count: industries.size } : UNKNOWN('INDUSTRY_NOT_IN_PANEL');
  const methods = ['DATE'];
  if (markets.has('CRYPTO') || [...books.keys()].some((b) => SCAN_BOOKS.includes(b))) methods.push('EVENT');
  if (industry.state === 'VALUE') methods.push('INDUSTRY');
  return {
    rows: rowsWithPanel.length, unjoinedRows: joined.length - rowsWithPanel.length, dates: dates.size, events: countEvents(books), industries: industry, books: [...books.keys()].sort(),
    windowOverlap: windows.map((w) => overlapOf(w, books, sessionGap)), clusterMethods: methods,
    effectiveSampleSize: { state: 'N/A', reasonCode: 'NO_ESTIMATOR_DECLARED' },
  };
}

/** Any wording of a sample size: 样本量, 样本数, 有效样本, 有效N, sample size, effective n, "N = 12", "N 12", "n=12". */
const SAMPLE_WORD = /样本量|样本数|有效\s*样本|有效\s*N(?![A-Za-z/])|sample\s*size|effective\s*(sample|n)\b|(^|[^A-Za-z0-9/_])N\s*[=＝:：为]\s*\d|(^|[^A-Za-z0-9/_])N\s+\d/i;
/** The one line a sample size may appear on: the number (or N/A) and its clustering method together. */
const STRUCTURED = /^有效样本量[：:]\s*(N\/A|\d+)\s*[；;]\s*聚类方法[：:]\s*([A-Z_+]+)\s*([；;].*)?$/;
const BOOK_LINE = /^账本\s*[:：]\s*(.+)$/m;

/**
 * ES-1: a sample size or N in any wording is valid only on one structured line that states the number and its clustering method together.
 * ES-2: the method includes DATE (the minimum), and EVENT for a scan book (C17, US_V5 scans); the books come from the `账本：` line or from `options.books`.
 * ES-3: insufficient power is never "不做".
 */
function checkReportTemplate(text, { books = [] } = {}) {
  const violations = [];
  const bookLine = BOOK_LINE.exec(text);
  const scan = [...books, ...(bookLine ? bookLine[1].split(/[,，、\s]+/).filter(Boolean) : [])].some((b) => SCAN_BOOKS.includes(b));
  const methods = [];
  let unstructured = false;
  for (const line of text.split('\n')) {
    if (!SAMPLE_WORD.test(line)) continue;
    const m = STRUCTURED.exec(line.trim());
    if (m) methods.push(m[2].split('+')); else unstructured = true;
  }
  if (unstructured) violations.push('SAMPLE_SIZE_WITHOUT_CLUSTER_METHOD');
  else {
    if (methods.some((m) => !m.includes('DATE'))) violations.push('CLUSTER_METHOD_MISSING_DATE');
    if (scan && methods.some((m) => !m.includes('EVENT'))) violations.push('CLUSTER_METHOD_MISSING_EVENT');
  }
  if (/功效不足[^\n]*不做|不做[^\n]*功效不足/.test(text)) violations.push('POWER_INSUFFICIENT_MUST_NOT_BE_NOT_DO');
  return { ok: violations.length === 0, violations };
}

/** R-9: candidates the panel cut have no row and so no label; say how many. */
function truncationSummary(records) {
  const out = { truncatedNoLabel: 0, records: [], problems: [] };
  for (const rec of records) {
    const t = rec.truncation;
    if (!v.isObj(t)) { out.problems.push({ evaluationPointId: rec.evaluationPointId, code: 'TRUNCATION_OBJECT_MISSING' }); continue; }
    const cut = t.totalCount - t.keptCount;
    const dropped = (t.droppedByOutcome || []).reduce((s, d) => s + d.count, 0);
    if (cut !== dropped) out.problems.push({ evaluationPointId: rec.evaluationPointId, code: 'TRUNCATION_COUNTS_INCONSISTENT' });
    if (t.keptCount !== (rec.rows || []).length) out.problems.push({ evaluationPointId: rec.evaluationPointId, code: 'TRUNCATION_KEPT_COUNT_DIFFERS_FROM_ROWS' });
    out.truncatedNoLabel += cut;
    out.records.push({ evaluationPointId: rec.evaluationPointId, truncatedNoLabel: cut, droppedByOutcome: t.droppedByOutcome || [] });
  }
  return out;
}

const gapText = (o) => (o.state === 'UNKNOWN' ? `${o.windowId} 未知（${o.reasonCode}）` : `${o.windowId} ${o.state === 'OVERLAPPING' ? '重叠' : '不重叠'}，评价间隔 ${Number(o.minEvaluationGap.toFixed(3))}，滞后 ${Number(o.lag.toFixed(3))}`);

/** A report that passes checkReportTemplate by construction: counts, the cluster method, N/A for the estimate, the truncation line. */
function renderReport({ joined, panelRecords, windows = [], sessionGap = null }) {
  const s = describeSample(joined, { windows, sessionGap });
  const t = truncationSummary(panelRecords || []);
  const industry = s.industries.state === 'VALUE' ? `行业数 ${s.industries.count}` : s.industries.state === 'NOT_APPLICABLE' ? '行业 不适用' : `行业 未知（${s.industries.reasonCode}）`;
  const lines = [
    '候选面板标签读数（只陈述事实，不下结论）',
    ...(s.books.length ? [`账本：${s.books.join(', ')}`] : []),
    `行数 ${s.rows}；未关联行数 ${s.unjoinedRows}`,
    `日期数 ${s.dates}；事件数 ${s.events}；${industry}`,
    `有效样本量：N/A；聚类方法：${s.clusterMethods.join('+')}；原因：${s.effectiveSampleSize.reasonCode}`,
    ...s.windowOverlap.map((o) => `窗口重叠：${gapText(o)}`),
    `截断 ${t.truncatedNoLabel} 个，无标签`,
    ...t.problems.map((p) => `截断记录问题：${p.code}`),
  ];
  return `${lines.join('\n')}\n`;
}

/* ---------------------------------------------------------------- ES-4: the four questions, one table each, no conclusion */

const COLUMNS = Object.freeze(['group', 'windowId', 'rows', 'valueRows', 'unknownRows', 'dates', 'meanGrossReturn', 'meanExcessReturn']);
const outcomeIs = (...names) => (p) => names.includes(p.finalOutcome);
const hasPlan = (p) => Boolean(p.planLink) && typeof p.planLink.planId === 'string';
const QUESTIONS = Object.freeze({
  SIGNAL_INCREMENT: { question: '信号增量：入选候选的结果，与全部候选的结果相比', groups: [['SELECTED', (p) => p.selected === true], ['ALL_CANDIDATES', () => true]] },
  FILTER_QUALITY: { question: '过滤质量：被名次或过滤条件挡下的候选，结果如何（入选作参照）', groups: [['NOT_SELECTED_RANK', outcomeIs('NOT_SELECTED_RANK')], ['REJECTED_FILTER', outcomeIs('REJECTED_FILTER')], ['SELECTED', (p) => p.selected === true]] },
  ACCOUNT_CONSTRAINT: { question: '账户约束：被风控、账户、执行层拦下的候选，结果如何（入选作参照）', groups: [['BLOCKED_ACCOUNT', outcomeIs('BLOCKED_ACCOUNT')], ['BLOCKED_RISK', outcomeIs('BLOCKED_RISK')], ['BLOCKED_EXECUTION', outcomeIs('BLOCKED_EXECUTION')], ['SELECTED', (p) => p.selected === true]] },
  HUMAN_DELAY: { question: '人工延迟：出了计划的候选与没出计划的候选的结果；延迟本身没有数据来源', groups: [['PLAN_LINKED', hasPlan], ['NOT_PLAN_LINKED', (p) => !hasPlan(p)]] },
});

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : UNKNOWN('NO_VALUE_ROWS'));

function statRow(group, windowId, entries) {
  const values = entries.filter((j) => j.state === 'VALUE');
  return {
    group, windowId, rows: entries.length, valueRows: values.length, unknownRows: entries.length - values.length, dates: new Set(entries.map((j) => j.panel.sessionDate)).size,
    meanGrossReturn: mean(values.map((j) => j.grossReturn)), meanExcessReturn: mean(values.filter((j) => typeof j.excessReturn === 'number').map((j) => j.excessReturn)),
  };
}

/** Counts and means of the matured labels per group and window; unknown rows are counted apart and never enter a mean as 0. */
function questionTables(joined) {
  const rows = withPanel(joined);
  const windows = [...new Set(rows.map((j) => j.windowId))].sort();
  const tables = {};
  for (const [id, q] of Object.entries(QUESTIONS)) {
    const table = { id, question: q.question, columns: id === 'HUMAN_DELAY' ? [...COLUMNS, 'humanActionDelay'] : [...COLUMNS], rows: [] };
    for (const w of windows) {
      for (const [group, member] of q.groups) {
        const row = statRow(group, w, rows.filter((j) => j.windowId === w && member(j.panel)));
        if (id === 'HUMAN_DELAY') row.humanActionDelay = { state: 'NOT_PROVIDED', reasonCode: 'HUMAN_ACTION_TIME_NOT_IN_PANEL_OR_LABEL' };
        table.rows.push(row);
      }
    }
    tables[id] = table;
  }
  return tables;
}

module.exports = { describeSample, checkReportTemplate, truncationSummary, renderReport, questionTables };
