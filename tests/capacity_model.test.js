'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const fm = require('../packages/fill-model');

/**
 * QRP 容量模型 CAPACITY_MODEL_V1（ENGINE_MODELING_ACCEPTANCE_V1 §2.2 第 6 条，签字文本 8d214ddf）：
 * 容量模型 = PREV_DAY_VOLUME_CAP（packages/fill-model）加上每笔的参与率报告。先红后绿。
 * 四种状态分开记：WITHIN_CAP、CAPPED、PREV_VOLUME_MISSING（前一日量读不到 = 未知，不是 0）、PREV_VOLUME_ZERO（读到了，是 0）。
 * 赛马的容量轴只在作业带了报告时才填；没带的作业，两个适配器的输出逐字节不变（下面记录的 sha256 在改动前的 main c6e1dd4 上算出）。
 */
const load = () => require('../services/capacity-model');
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

const FILLS = [
  { id: 'a', symbol: '600000.SH', date: '2026-11-03', side: 'BUY', desired: 50_000, prevDayVolume: 1_000_000, prevDayVolumeDate: '2026-11-02', lotSize: 100 },
  { id: 'b', symbol: '600001.SH', date: '2026-11-03', side: 'BUY', desired: 50_000, prevDayVolume: 123_456, prevDayVolumeDate: '2026-11-02', lotSize: 100 },
  { id: 'c', symbol: '600002.SH', date: '2026-11-03', side: 'SELL', desired: 10_000, prevDayVolume: null, prevDayVolumeDate: null, lotSize: 100 },
  { id: 'd', symbol: '600003.SH', date: '2026-11-03', side: 'SELL', desired: 10_000, prevDayVolume: 0, prevDayVolumeDate: '2026-10-31', lotSize: 100 },
];

test('每笔：按前一交易日量 × 参与率封顶（就是库里的 PREV_DAY_VOLUME_CAP），报告成交数量、上限、参与率和想要的参与率', () => {
  const cm = load();
  const r = cm.participationReport({ fills: FILLS });
  assert.equal(r.schema, 'CAPACITY_REPORT_V1');
  assert.equal(r.model, 'PREV_DAY_VOLUME_CAP');
  assert.equal(r.participationLimit, fm.DEFAULT_PARTICIPATION);
  const [a, b] = r.trades;
  assert.deepEqual(a, { id: 'a', symbol: '600000.SH', date: '2026-11-03', side: 'BUY', desired: 50_000, quantity: 50_000, cap: 100_000,
    prevDayVolume: 1_000_000, prevDayVolumeDate: '2026-11-02', participation: 0.05, desiredParticipation: 0.05, state: 'WITHIN_CAP' });
  assert.deepEqual(b, { id: 'b', symbol: '600001.SH', date: '2026-11-03', side: 'BUY', desired: 50_000, quantity: 12_300, cap: 12_300,
    prevDayVolume: 123_456, prevDayVolumeDate: '2026-11-02', participation: 12_300 / 123_456, desiredParticipation: 50_000 / 123_456, state: 'CAPPED' });
  // 和库里的规则逐笔一致：容量模型不另算一遍上限
  for (const f of FILLS.slice(0, 2)) {
    assert.equal(r.trades.find((t) => t.id === f.id).quantity, fm.PREV_DAY_VOLUME_CAP({ prevDayVolume: f.prevDayVolume, desired: f.desired, lotSize: f.lotSize }).quantity);
  }
});

test('反例：前一日量读不到是「未知」，不当 0、不回退到当天量；读到 0 是另一种状态；带当天量的成交拒收', () => {
  const cm = load();
  const r = cm.participationReport({ fills: FILLS });
  const c = r.trades.find((t) => t.id === 'c');
  const d = r.trades.find((t) => t.id === 'd');
  assert.deepEqual([c.state, c.quantity, c.cap, c.prevDayVolume, c.participation, c.desiredParticipation], ['PREV_VOLUME_MISSING', 0, null, null, null, null]);
  assert.deepEqual([d.state, d.quantity, d.cap, d.prevDayVolume, d.participation, d.desiredParticipation], ['PREV_VOLUME_ZERO', 0, 0, 0, null, null]);
  for (const key of ['todayVolume', 'sameDayVolume', 'volume']) {
    assert.throws(() => cm.participationReport({ fills: [{ ...FILLS[0], [key]: 9_000_000 }] }), (e) => e.code === 'CAPACITY_SAME_DAY_VOLUME_REFUSED', key);
  }
  assert.throws(() => cm.participationReport({ fills: [{ ...FILLS[0], id: '' }] }), (e) => e.code === 'CAPACITY_FILL_INVALID');
  assert.throws(() => cm.participationReport({ fills: [FILLS[0], FILLS[0]] }), (e) => e.code === 'CAPACITY_FILL_INVALID');
  assert.throws(() => cm.participationReport({ fills: [{ ...FILLS[0], desired: -1 }] }), (e) => e.code === 'CAPACITY_FILL_INVALID');
  assert.throws(() => cm.participationReport({ fills: FILLS, participation: 1.5 }), (e) => e.code === 'CAPACITY_FILL_INVALID');
});

test('汇总：只在前一日量已知且大于 0 的成交上算参与率的分位数；未知和 0 单独计数；没有一笔已知时分位数是 null', () => {
  const cm = load();
  const s = cm.participationReport({ fills: FILLS }).summary;
  assert.deepEqual(s, {
    trades: 4, withinCap: 1, capped: 1, prevVolumeMissing: 1, prevVolumeZero: 1, known: 2,
    maxParticipation: 12_300 / 123_456, p50Participation: 0.05, p95Participation: 12_300 / 123_456,
    maxDesiredParticipation: 50_000 / 123_456, unfilledQuantity: 37_700 + 10_000 + 10_000, unfilledQuantityUnknown: 10_000,
  });
  const none = cm.participationReport({ fills: [FILLS[2]] }).summary;
  assert.deepEqual([none.known, none.maxParticipation, none.p50Participation, none.p95Participation, none.maxDesiredParticipation], [1 - 1, null, null, null, null]);
  assert.equal(cm.participationReport({ fills: [] }).summary.trades, 0);
});

test('容量轴：带报告的作业填 MODELLED_PREV_DAY_VOLUME_CAP_V1 和汇总，钉住报告的 sha256；报告不对就拒收', () => {
  const cm = load();
  const report = cm.participationReport({ fills: FILLS });
  const axis = cm.capacityAxis(report);
  assert.deepEqual(axis, {
    status: 'MODELLED_PREV_DAY_VOLUME_CAP_V1', model: 'PREV_DAY_VOLUME_CAP', participation_limit: 0.1,
    trade_count: 4, within_cap_count: 1, capped_count: 1, prev_volume_missing_count: 1, prev_volume_zero_count: 1,
    max_participation: 12_300 / 123_456, p50_participation: 0.05, p95_participation: 12_300 / 123_456, max_desired_participation: 50_000 / 123_456,
    unfilled_quantity: 57_700, report_sha256: cm.reportSha256(report),
  });
  assert.match(axis.report_sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => cm.capacityAxis({ ...report, schema: 'OTHER' }), (e) => e.code === 'CAPACITY_REPORT_INVALID');
  assert.throws(() => cm.capacityAxis({ ...report, summary: { ...report.summary, capped: 9 } }), (e) => e.code === 'CAPACITY_REPORT_INVALID');
});

// ── 两个适配器：带报告才填容量轴，不带的逐字节不变 ────────────────────────────────────
const ashare = () => require('../adapters/ashare-local');
const bridgeAdapter = () => require('../adapters/registry').getAdapter('CRYPTO');
const side = (x) => ({ cumRet: x, cagr: x, tradeCount: 3, max_dd_recovery_days: 2, basisCn: 'b', maxDrawdown: -x, annualized_vol: x, calmar: 1, sortino_like: 1,
  sharpe_like: 1, good_precision: 0.5, bad_precision: 0.4, good_count: 2, bad_count: 1, payoff_ratio: 1.2, expectancy: 0.01, avg_win: 0.02, avg_loss: -0.01,
  mae_avg_on_good: -0.01, mfe_avg_on_good: 0.03, signal_turnover_per_day: 0.1, exposure_ratio: 0.5, costPerSide: 0.0015 });
const ASHARE_ART = { summary: { challenger: side(0.1), champion: side(0.05), benchmark: side(0.02), is: { challenger: side(0.1), champion: side(0.05) }, oos: { challenger: side(0.08), champion: side(0.04) } },
  precision: { challenger: side(0.1), champion: side(0.05) }, nav: { challenger: [1, 1.1] }, benchmark: '000300.SH', result_hash: 'h', evaluable_range: null };
const BRIDGE_ART = { output: { profile: 'NEXT_BAR_OPEN', metrics: { totalReturn: { value: 0.1, definitionId: 'TOTAL_RETURN_V1' } }, fills: [], gaps: [] },
  result_hash: 'h', replay_core: { core_version_hash: 'x', hooks_id: 'c17-hooks@x', input_hash: null } };
/** normalize_result 的 sha256，改动前在 QRP main c6e1dd4 上算出（红色提交里写死）。 */
const BEFORE = { ashare: '32c5326aa5f4facd89871e0976a2f53dd6bf580d549abe4b626837f235820a77', bridge: '8fb1ffc4e47594b1535096f216d951cabd3a93d4a28ada88f42808dbcac3e9f2' };

test('惰性：没带容量报告的作业，A 股与加密两个适配器的 normalize_result 和改动前逐字节一致（容量轴仍是 NOT_IMPLEMENTED_P4）', () => {
  const a = ashare().normalize_result(ASHARE_ART);
  const b = bridgeAdapter().normalize_result(BRIDGE_ART);
  assert.equal(a.capacity.status, 'NOT_IMPLEMENTED_P4');
  assert.equal(b.capacity.status, 'NOT_IMPLEMENTED_P4');
  assert.deepEqual([sha(a), sha(b)], [BEFORE.ashare, BEFORE.bridge]);
});

test('带了容量报告：两个适配器的容量轴 = capacityAxis(报告)，其余七轴与不带时一样', () => {
  const cm = load();
  const report = cm.participationReport({ fills: FILLS });
  const a0 = ashare().normalize_result(ASHARE_ART);
  const a1 = ashare().normalize_result({ ...ASHARE_ART, capacity_report: report });
  assert.deepEqual(a1.capacity, cm.capacityAxis(report));
  assert.deepEqual({ ...a1, capacity: null }, { ...a0, capacity: null });
  const b1 = bridgeAdapter().normalize_result({ ...BRIDGE_ART, capacity_report: report });
  assert.deepEqual(b1.capacity, cm.capacityAxis(report));
  assert.throws(() => ashare().normalize_result({ ...ASHARE_ART, capacity_report: { schema: 'OTHER' } }), (e) => e.code === 'CAPACITY_REPORT_INVALID');
});

test('#110 复审 19:30 反例：前一日量的日期必须早于成交日——字段名不算数；同一天或更晚的量、缺日期、日期写错都拒收（与 V6_SWAP_SAME_DAY_VOLUME 同一类）', () => {
  const cm = load();
  for (const prevDayVolumeDate of ['2026-11-03', '2026-11-04', undefined, null, '2026/11/02', 'x']) {
    assert.throws(() => cm.participationReport({ fills: [{ ...FILLS[0], prevDayVolumeDate }] }), (e) => e.code === 'CAPACITY_PREV_VOLUME_DATE_INVALID', String(prevDayVolumeDate));
  }
  // 量读不到时日期可以没有；若写了，同样必须早于成交日
  assert.equal(cm.participationReport({ fills: [{ ...FILLS[2], prevDayVolumeDate: undefined }] }).trades[0].state, 'PREV_VOLUME_MISSING');
  assert.throws(() => cm.participationReport({ fills: [{ ...FILLS[2], prevDayVolumeDate: '2026-11-03' }] }), (e) => e.code === 'CAPACITY_PREV_VOLUME_DATE_INVALID');
  // 报告里的行也核对：日期不早于成交日的报告拒收
  const report = cm.participationReport({ fills: FILLS });
  assert.throws(() => cm.capacityAxis({ ...report, trades: report.trades.map((t, i) => (i === 0 ? { ...t, prevDayVolumeDate: t.date } : t)) }), (e) => e.code === 'CAPACITY_REPORT_INVALID');
});
