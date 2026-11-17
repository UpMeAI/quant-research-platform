'use strict';

/**
 * QRP 容量模型 CAPACITY_MODEL_V1 —— 引擎建模验收合同 ENGINE_MODELING_ACCEPTANCE_V1 §2.2 第 6 条（Owner 2026-11-17 00:15 签字，
 * 签字文本 8d214ddf）：容量模型 = PREV_DAY_VOLUME_CAP 加上每笔的参与率报告。
 *
 * 上限只用统一成交模型库的 PREV_DAY_VOLUME_CAP（packages/fill-model），这里不另算一遍；本模块只把逐笔的结果整理成报告。
 * 四种状态分开记，不混在一起：
 *   WITHIN_CAP           想成交的数量不超过上限，全部成交；
 *   CAPPED               超过上限，只成交上限那么多；
 *   PREV_VOLUME_MISSING  前一交易日量读不到：未知，成交 0，参与率 null（不当 0，不回退到当天量）；
 *   PREV_VOLUME_ZERO     读到了，前一交易日量就是 0：上限 0，成交 0，参与率 null（没有分母）。
 * 带当天量的成交（todayVolume / sameDayVolume / volume）拒收：容量只能按决策时已知的前一日量算。
 * 纯函数：不读行情、不写文件、不读宿主时钟。
 */
const crypto = require('crypto');
const fm = require('../../packages/fill-model');

const SCHEMA = 'CAPACITY_REPORT_V1';
const MODEL = 'PREV_DAY_VOLUME_CAP';
const AXIS_STATUS = 'MODELLED_PREV_DAY_VOLUME_CAP_V1';
const STATES = Object.freeze(['WITHIN_CAP', 'CAPPED', 'PREV_VOLUME_MISSING', 'PREV_VOLUME_ZERO']);
const SAME_DAY_KEYS = Object.freeze(['todayVolume', 'sameDayVolume', 'volume']);

class CapacityError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const need = (condition, code, detail) => { if (!condition) throw new CapacityError(code, detail); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string' && v !== '';

/** 最近秩分位数（升序，q ∈ (0, 1]）；空数组 null。 */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * 逐笔参与率报告。
 *   fills：[{ id, symbol, date, side: BUY|SELL, desired（想成交的数量）, prevDayVolume（前一交易日成交量，已按拆分换算；读不到写 null）, lotSize? }]
 *   participation：参与率上限（默认 0.1，同库）；lotSize：没写每手股数的成交用它（默认 1）。
 * 返回 { schema, model, participationLimit, trades: [...], summary }，trades 与 fills 同序。
 */
function participationReport({ fills, participation = fm.DEFAULT_PARTICIPATION, lotSize = 1 } = {}) {
  need(Array.isArray(fills), 'CAPACITY_FILL_INVALID', 'fills');
  need(isNum(participation) && participation > 0 && participation <= 1, 'CAPACITY_FILL_INVALID', `participation ${participation}`);
  const ids = new Set();
  const trades = fills.map((f, i) => {
    const at = `fills[${i}]`;
    need(f && typeof f === 'object' && isText(f.id) && !ids.has(f.id), 'CAPACITY_FILL_INVALID', `${at}.id`);
    ids.add(f.id);
    for (const key of SAME_DAY_KEYS) need(!(key in f), 'CAPACITY_SAME_DAY_VOLUME_REFUSED', `${at}.${key}`);
    need(isText(f.symbol) && isText(f.date) && fm.SIDES.includes(f.side), 'CAPACITY_FILL_INVALID', `${at}.symbol/date/side`);
    need(isNum(f.desired) && f.desired >= 0, 'CAPACITY_FILL_INVALID', `${at}.desired`);
    const lot = f.lotSize === undefined ? lotSize : f.lotSize;
    need(isNum(lot) && lot > 0, 'CAPACITY_FILL_INVALID', `${at}.lotSize`);
    const known = isNum(f.prevDayVolume) && f.prevDayVolume >= 0;
    const r = fm.PREV_DAY_VOLUME_CAP({ prevDayVolume: known ? f.prevDayVolume : undefined, participation, desired: f.desired, lotSize: lot });
    const prevDayVolume = known ? f.prevDayVolume : null;
    const state = !known ? 'PREV_VOLUME_MISSING' : f.prevDayVolume === 0 ? 'PREV_VOLUME_ZERO' : r.capped ? 'CAPPED' : 'WITHIN_CAP';
    const ratio = (q) => (known && f.prevDayVolume > 0 ? q / f.prevDayVolume : null);
    return { id: f.id, symbol: f.symbol, date: f.date, side: f.side, desired: f.desired, quantity: r.quantity, cap: known ? r.cap : null,
      prevDayVolume, participation: ratio(r.quantity), desiredParticipation: ratio(f.desired), state };
  });
  const count = (s) => trades.filter((t) => t.state === s).length;
  const knownRows = trades.filter((t) => t.participation !== null);
  const parts = knownRows.map((t) => t.participation).sort((a, b) => a - b);
  const desiredParts = knownRows.map((t) => t.desiredParticipation);
  const unfilled = trades.reduce((sum, t) => sum + (t.desired - t.quantity), 0);
  const unfilledUnknown = trades.filter((t) => t.state === 'PREV_VOLUME_MISSING').reduce((sum, t) => sum + t.desired, 0);
  const summary = {
    trades: trades.length, withinCap: count('WITHIN_CAP'), capped: count('CAPPED'), prevVolumeMissing: count('PREV_VOLUME_MISSING'),
    prevVolumeZero: count('PREV_VOLUME_ZERO'), known: knownRows.length,
    maxParticipation: parts.length ? parts[parts.length - 1] : null, p50Participation: quantile(parts, 0.5), p95Participation: quantile(parts, 0.95),
    maxDesiredParticipation: desiredParts.length ? Math.max(...desiredParts) : null,
    unfilledQuantity: unfilled, unfilledQuantityUnknown: unfilledUnknown,
  };
  return { schema: SCHEMA, model: MODEL, participationLimit: participation, trades, summary };
}

/** 报告的 sha256（JSON 原样序列化；报告由 participationReport 产出，键序固定）。 */
const reportSha256 = (report) => crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');

/**
 * 报告自洽：结构对、每笔的状态与字段对得上（未知 → 量、上限都是 null、成交 0；为 0 → 上限 0、成交 0；
 * 封顶 → 成交 = 上限 < 想要的；未封顶 → 成交 ≤ 上限；上限 ≤ 前一日量 × 参与率上限）、汇总的四个计数与逐笔一致。
 * 不一致抛 CAPACITY_REPORT_INVALID。
 */
function checkReport(report) {
  need(report && report.schema === SCHEMA && report.model === MODEL && Array.isArray(report.trades) && report.summary
    && isNum(report.participationLimit), 'CAPACITY_REPORT_INVALID', 'shape');
  for (const t of report.trades) {
    const ok = t && STATES.includes(t.state) && isNum(t.desired) && isNum(t.quantity) && t.quantity >= 0 && t.quantity <= t.desired + 1e-9 && (
      t.state === 'PREV_VOLUME_MISSING' ? t.prevDayVolume === null && t.cap === null && t.quantity === 0
        : t.state === 'PREV_VOLUME_ZERO' ? t.prevDayVolume === 0 && t.cap === 0 && t.quantity === 0
          : isNum(t.prevDayVolume) && t.prevDayVolume > 0 && isNum(t.cap) && t.cap <= t.prevDayVolume * report.participationLimit + 1e-9
            && (t.state === 'CAPPED' ? t.quantity === t.cap && t.cap < t.desired : t.quantity <= t.cap));
    need(ok, 'CAPACITY_REPORT_INVALID', `trade ${t && t.id}`);
  }
  for (const [k, s] of [['withinCap', 'WITHIN_CAP'], ['capped', 'CAPPED'], ['prevVolumeMissing', 'PREV_VOLUME_MISSING'], ['prevVolumeZero', 'PREV_VOLUME_ZERO']]) {
    need(report.summary[k] === report.trades.filter((t) => t.state === s).length, 'CAPACITY_REPORT_INVALID', `summary.${k}`);
  }
  need(report.summary.trades === report.trades.length, 'CAPACITY_REPORT_INVALID', 'summary.trades');
  return report;
}

/** 赛马的容量轴（CanonicalRaceMetrics.capacity）：状态、模型、参与率上限、汇总，钉住报告的 sha256。 */
function capacityAxis(report) {
  checkReport(report);
  const s = report.summary;
  return {
    status: AXIS_STATUS, model: MODEL, participation_limit: report.participationLimit,
    trade_count: s.trades, within_cap_count: s.withinCap, capped_count: s.capped, prev_volume_missing_count: s.prevVolumeMissing, prev_volume_zero_count: s.prevVolumeZero,
    max_participation: s.maxParticipation, p50_participation: s.p50Participation, p95_participation: s.p95Participation, max_desired_participation: s.maxDesiredParticipation,
    unfilled_quantity: s.unfilledQuantity, report_sha256: reportSha256(report),
  };
}

module.exports = { SCHEMA, MODEL, AXIS_STATUS, STATES, SAME_DAY_KEYS, CapacityError, participationReport, reportSha256, checkReport, capacityAxis, quantile };
