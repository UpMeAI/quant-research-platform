'use strict';
/**
 * G-PARITY 核登记表的历史时钟 pitHistoricalClock（KG 1.14.0 起；协调会话审阅意见 2026-11-17）。先红后绿，用真钉着的登记表（1.14.0 起有这个字段；现在是 1.17.0，f4b24f41，930bae16…）。
 *   记号可选字段 `|HIST=<时钟>`：钉在有这个字段的版本（≥ 1.14.0）上、且数据集写了 pitHistoricalClock 时必填（PARITY_HIST_CLOCK_REQUIRED），
 *   要等于 rule 或 bySeries[series]（PARITY_HIST_CLOCK_MISMATCH）；更早的版本 NOT_APPLICABLE_PRE_FIELD（同 BASIS）。
 *   实时 PIT 只有一个、历史时钟按序列分的数据集（V6_CN_STOCK_DAILY_BARS：daily / adj_factor），允许写 `#series=` 选时钟。
 *   锁行在钉在有这个字段的版本上时带 hist_check；更早版本、不写 HIST 的现有记号，锁行逐字节不变。
 *   parseSpace 的读数可选 hist_clock，写了照样核。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const gate = require('../services/parity-gate');
const datasetRegistry = require('../services/dataset-registry');
const space = require('../services/mining-sandbox/space');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const REG = datasetRegistry.pinned();
const V = `@${REG.registry_version}#${REG.registry_sha256}`;
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const refuses = (fn, c, detail) => assert.throws(fn, (e) => e.code === `PARITY_${c}` && (!detail || String(e.detail).includes(detail)), `${c} ${detail || ''}`);
function direct(lines, registry = REG) {
  const k2 = Buffer.from(`# 合成 K2\n\n## 0\n**数据输入**：${lines.join('；')}\n`);
  return gate.check({ id: 'HIST', kind: 'RESULT', sealed_on: '2026-11-20', k2: { sha256: sha(k2) }, k2_frozen_at: '2026-11-17T10:00:00+08:00' }, { k2Bytes: () => k2 }, { registry });
}
const tok = (head, tail) => `\`DATA:${head}${V}|${tail}\``;

test('钉着的是 1.20.0（1.14.0 起的历史时钟原样带着）；三个数据集有历史时钟：BASIC 是 rule，BARS 与 CN_MARKET_PSYCHOLOGY 按序列', () => {
  assert.deepEqual([REG.commit, REG.registry_version], ['36214c21fd4e79d3ef4e3b9ab79d584dadfa5723', '1.20.0']);
  assert.equal(REG.datasets.get('V6_CN_STOCK_DAILY_BASIC').pitHistoricalClock.rule, 'CLOSE_DATED_NEXT_OPEN_USABLE');
  assert.deepEqual(REG.datasets.get('V6_CN_STOCK_DAILY_BARS').pitHistoricalClock.bySeries, { daily: 'BAR_CLOSE', adj_factor: 'CLOSE_DATED_NEXT_OPEN_USABLE' });
  assert.ok(REG.pit_semantics.includes('CLOSE_DATED_NEXT_OPEN_USABLE') && REG.pit_semantics.includes('NEXT_DAY_0000_CST'));
});

test('rule 型（V6_CN_STOCK_DAILY_BASIC）：1.14.0 的记号不写 HIST → REQUIRED；写错 → MISMATCH；写对 → CHECKED', () => {
  refuses(() => direct([tok('V6_CN_STOCK_DAILY_BASIC', 'PIT=OBSERVED_AT|VENDOR=Tushare')]), 'HIST_CLOCK_REQUIRED', 'CLOSE_DATED_NEXT_OPEN_USABLE');
  refuses(() => direct([tok('V6_CN_STOCK_DAILY_BASIC', 'PIT=OBSERVED_AT|VENDOR=Tushare|HIST=BAR_CLOSE')]), 'HIST_CLOCK_MISMATCH', 'BAR_CLOSE≠CLOSE_DATED_NEXT_OPEN_USABLE');
  const [row] = direct([tok('V6_CN_STOCK_DAILY_BASIC', 'PIT=OBSERVED_AT|VENDOR=Tushare|HIST=CLOSE_DATED_NEXT_OPEN_USABLE')]).data_inputs;
  assert.deepEqual([row.hist_clock, row.hist_check, row.pit_check], ['CLOSE_DATED_NEXT_OPEN_USABLE', 'CHECKED', 'CHECKED']);
  assert.throws(() => direct([tok('V6_CN_STOCK_DAILY_BASIC', 'PIT=OBSERVED_AT|VENDOR=Tushare|HIST=close dated')]), (e) => e.code === 'PARITY_DATA_INPUT_INVALID');
});

test('按序列型、实时 PIT 只有一个（V6_CN_STOCK_DAILY_BARS）：#series= 选时钟（daily → BAR_CLOSE，adj_factor → CLOSE_DATED_NEXT_OPEN_USABLE）；不写序列、序列不在表里、时钟不符 → 拒绝', () => {
  const t = (s, hist) => tok(`V6_CN_STOCK_DAILY_BARS${s ? `#series=${s}` : ''}`, `PIT=OBSERVED_AT|VENDOR=Tushare|BASIS=PRICE/RAW${hist ? `|HIST=${hist}` : ''}`);
  refuses(() => direct([t(null, 'BAR_CLOSE')]), 'SERIES_REQUIRED', 'pitHistoricalClock');
  refuses(() => direct([t('minute', 'BAR_CLOSE')]), 'SERIES_UNKNOWN', 'pitHistoricalClock');
  refuses(() => direct([t('daily', null)]), 'HIST_CLOCK_REQUIRED', 'BAR_CLOSE');
  refuses(() => direct([t('adj_factor', 'BAR_CLOSE')]), 'HIST_CLOCK_MISMATCH', 'BAR_CLOSE≠CLOSE_DATED_NEXT_OPEN_USABLE');
  const r = direct([t('daily', 'BAR_CLOSE'), t('adj_factor', 'CLOSE_DATED_NEXT_OPEN_USABLE')]);
  assert.deepEqual(r.data_inputs.map((d) => [d.series, d.pit_semantics, d.hist_clock, d.pit_check, d.hist_check]), [
    ['daily', 'OBSERVED_AT', 'BAR_CLOSE', 'CHECKED', 'CHECKED'], ['adj_factor', 'OBSERVED_AT', 'CLOSE_DATED_NEXT_OPEN_USABLE', 'CHECKED', 'CHECKED']]);
  // 实时 PIT 仍按数据集的那一个核（不是按历史时钟）
  refuses(() => direct([t('daily', 'BAR_CLOSE').replace('PIT=OBSERVED_AT', 'PIT=BAR_CLOSE')]), 'PIT_SEMANTICS_MISMATCH', 'BAR_CLOSE≠OBSERVED_AT');
  // 没有历史时钟按序列的非混合数据集，照旧不许写 series
  refuses(() => direct([tok('V6_CN_STOCK_DAILY_BASIC#series=daily', 'PIT=OBSERVED_AT|VENDOR=Tushare|HIST=CLOSE_DATED_NEXT_OPEN_USABLE')]), 'DATA_INPUT_INVALID', 'NOT_A_MIXED_DATASET');
});

test('实时与历史都按序列（CN_MARKET_PSYCHOLOGY）：同一个 series 同时选实时 PIT 与历史时钟', () => {
  const r = direct([tok('CN_MARKET_PSYCHOLOGY#series=CN-2', 'PIT=NEXT_TRADING_DAY_0900_CST|VENDOR=SSE|HIST=NEXT_TRADING_DAY_0900_CST'),
    tok('CN_MARKET_PSYCHOLOGY#series=CN-1', 'PIT=OBSERVED_AT|VENDOR=SSE|HIST=NEXT_DAY_0000_CST')]);
  assert.deepEqual(r.data_inputs.map((d) => [d.series, d.hist_check]), [['CN-2', 'CHECKED'], ['CN-1', 'CHECKED']]);
  refuses(() => direct([tok('CN_MARKET_PSYCHOLOGY#series=CN-1', 'PIT=OBSERVED_AT|VENDOR=SSE')]), 'HIST_CLOCK_REQUIRED', 'NEXT_DAY_0000_CST');
  refuses(() => direct([tok('CN_MARKET_PSYCHOLOGY#series=CN-1', 'PIT=OBSERVED_AT|VENDOR=SSE|HIST=NEXT_TRADING_DAY_0900_CST')]), 'HIST_CLOCK_MISMATCH');
});

test('1.14.0 上没有历史时钟的数据集 → hist_check PENDING_REGISTRY_FIELD；钉在更早版本的记号 → 不写 HIST 的锁行逐字节不变，写了记 NOT_APPLICABLE_PRE_FIELD', () => {
  const [row] = direct([tok('V6_CSI300_INDEX_DAILY', 'PIT=OBSERVED_AT|VENDOR=Tushare|BASIS=PRICE/RAW')]).data_inputs;
  assert.equal(row.hist_check, 'PENDING_REGISTRY_FIELD');
  const h = datasetRegistry.history();
  const v113 = [...h.values()].find((x) => x.registry_version === '1.13.0');
  const old = `@1.13.0#${v113.registry_sha256}`;
  const [plain] = direct([`\`DATA:V6_CSI300_INDEX_DAILY${old}|PIT=OBSERVED_AT|VENDOR=Tushare|BASIS=PRICE/RAW\``]).data_inputs;
  assert.equal(JSON.stringify(plain), JSON.stringify({ dataset_id: 'V6_CSI300_INDEX_DAILY', registry_version: '1.13.0', registry_sha256: v113.registry_sha256, pit_semantics: 'OBSERVED_AT',
    vendor: 'Tushare', price_basis: 'PRICE/RAW', pin_check: 'HISTORY_UNCHANGED', pit_check: 'CHECKED', basis_check: 'CHECKED', vendor_check: 'MATCH' }));
  const [withHist] = direct([`\`DATA:V6_CSI300_INDEX_DAILY${old}|PIT=OBSERVED_AT|VENDOR=Tushare|BASIS=PRICE/RAW|HIST=BAR_CLOSE\``]).data_inputs;
  assert.deepEqual([withHist.hist_clock, withHist.hist_check], ['BAR_CLOSE', 'NOT_APPLICABLE_PRE_FIELD']);
});

test('历史：pitHistoricalClock 进一致性字段，只比 rule 与 bySeries（detail 的文字改了不算变）', () => {
  assert.ok(datasetRegistry.FINGERPRINT_FIELDS.includes('pitHistoricalClock'));
  const now = REG.datasets.get('V6_CN_STOCK_DAILY_BARS');
  assert.deepEqual(datasetRegistry.changedFields({ ...now, pitHistoricalClock: { ...now.pitHistoricalClock, detail: 'older wording' } }, now), []);
  assert.deepEqual(datasetRegistry.changedFields({ ...now, pitHistoricalClock: { bySeries: { ...now.pitHistoricalClock.bySeries, daily: 'OBSERVED_AT' } } }, now), ['pitHistoricalClock']);
  assert.deepEqual(datasetRegistry.changedFields({ id: now.id }, now), []);
});

const EVIDENCE = fs.readFileSync(path.join(ROOT, 'docs', 'evidence', 'mining-operators-v1', 'CAUSALITY_EVIDENCE_V1.json'));
const PROOF = { evidence: JSON.parse(EVIDENCE), evidenceBytes: EVIDENCE };
const spaceOf = (readings) => Buffer.from(JSON.stringify({ schema: 'MINING_SPACE_V1', space_ref: 'MS-HIST', market: 'CN_A', readings,
  operators: ['rank'], constants: [1], lookbacks: [5], holding_periods: [5], max_tokens: 20, max_depth: 5,
  operator_evidence: { path: 'docs/evidence/mining-operators-v1/CAUSALITY_EVIDENCE_V1.json', sha256: sha(EVIDENCE) } }));

test('parseSpace（协调会话审阅意见）：读数的 PIT 开头可以是实时 PIT，也可以是历史时钟（rule，或按 series 取）；多序列读数取最保守的那个时钟；先后没定义的组合拒绝', () => {
  const ok = (r, registry) => space.parseSpace(spaceOf([r]), PROOF, registry ? { registry } : {});
  // DAILY_BASIC：rule = CLOSE_DATED_NEXT_OPEN_USABLE
  assert.equal(ok({ name: 'turnover_f', dataset_id: 'V6_CN_STOCK_DAILY_BASIC', pit_available_at: 'CLOSE_DATED_NEXT_OPEN_USABLE (backfill convention)' }).readings[0].name, 'turnover_f');
  assert.throws(() => ok({ name: 'turnover_f', dataset_id: 'V6_CN_STOCK_DAILY_BASIC', pit_available_at: 'BAR_CLOSE' }), code(/MINE_SPACE_READING_PIT_MISMATCH:turnover_f:BAR_CLOSE≠CLOSE_DATED_NEXT_OPEN_USABLE/));
  assert.throws(() => ok({ name: 'turnover_f', dataset_id: 'V6_CN_STOCK_DAILY_BASIC', series: 'daily', pit_available_at: 'CLOSE_DATED_NEXT_OPEN_USABLE' }), code(/MINE_SPACE_READING_SERIES_NOT_ALLOWED:turnover_f/));
  // BARS：按序列；ret_1d 只用 daily
  const bars = { dataset_id: 'V6_CN_STOCK_DAILY_BARS' };
  assert.equal(ok({ ...bars, name: 'ret_1d', series: 'daily', pit_available_at: 'BAR_CLOSE (prices_daily.known_at)' }).readings[0].series, 'daily');
  assert.throws(() => ok({ ...bars, name: 'ret_1d', pit_available_at: 'BAR_CLOSE' }), code(/MINE_SPACE_READING_SERIES_REQUIRED:ret_1d/));
  assert.throws(() => ok({ ...bars, name: 'ret_1d', series: 'adj_factor', pit_available_at: 'BAR_CLOSE' }), code(/MINE_SPACE_READING_PIT_MISMATCH:ret_1d:BAR_CLOSE≠CLOSE_DATED_NEXT_OPEN_USABLE/));
  assert.throws(() => ok({ ...bars, name: 'ret_1d', series: 'minute', pit_available_at: 'BAR_CLOSE' }), code(/MINE_SPACE_READING_SERIES_UNKNOWN:ret_1d:minute/));
  // 后复权价 = daily × adj_factor：最保守的是 CLOSE_DATED_NEXT_OPEN_USABLE
  const hfq = { ...bars, name: 'close_hfq', series: ['daily', 'adj_factor'] };
  assert.deepEqual(ok({ ...hfq, pit_available_at: 'CLOSE_DATED_NEXT_OPEN_USABLE (adj factor usable at the next open)' }).readings[0].series, ['daily', 'adj_factor']);
  assert.throws(() => ok({ ...hfq, pit_available_at: 'BAR_CLOSE' }), code(/MINE_SPACE_READING_PIT_MISMATCH:close_hfq:BAR_CLOSE≠CLOSE_DATED_NEXT_OPEN_USABLE/));
  // 协调会话裁定（2026-11-17）之后：有历史时钟的数据集不收实时 PIT（见 mining_space_history_clock）
  assert.throws(() => ok({ ...hfq, pit_available_at: 'OBSERVED_AT (live ingest)' }), code(/MINE_SPACE_READING_LIVE_CLOCK_IN_HISTORY:close_hfq/));
  assert.throws(() => ok({ ...hfq, series: ['daily'] }), code(/MINE_SPACE_READING_INVALID/)); // 数组至少两个
  assert.throws(() => ok({ ...hfq, series: ['daily', 'daily'] }), code(/MINE_SPACE_READING_INVALID/));
  // 混合数据集上不许写数组
  assert.throws(() => ok({ name: 'psy', dataset_id: 'CN_MARKET_PSYCHOLOGY', series: ['CN-1', 'CN-3'], pit_available_at: 'NEXT_DAY_0000_CST' }), code(/MINE_SPACE_READING_SERIES_NOT_ALLOWED:psy/));
  assert.equal(ok({ name: 'psy', dataset_id: 'CN_MARKET_PSYCHOLOGY', series: 'CN-2', pit_available_at: 'NEXT_TRADING_DAY_0900_CST' }).readings[0].series, 'CN-2');
  // 先后没定义的组合（合成登记表：BAR_CLOSE 与 NEXT_DAY_0000_CST）→ 拒绝；同一条序里的照常取最晚的
  const synthetic = { ...REG, datasets: new Map([['SYN', { id: 'SYN', pitSemantics: 'OBSERVED_AT',
    pitHistoricalClock: { bySeries: { a: 'BAR_CLOSE', b: 'NEXT_DAY_0000_CST', c: 'NEXT_TRADING_DAY_0900_CST' } } }]]) };
  assert.throws(() => ok({ name: 'syn', dataset_id: 'SYN', series: ['a', 'b'], pit_available_at: 'NEXT_DAY_0000_CST' }, synthetic), code(/MINE_SPACE_READING_CLOCK_ORDER_UNDEFINED:syn:a=BAR_CLOSE,b=NEXT_DAY_0000_CST/));
  assert.equal(ok({ name: 'syn', dataset_id: 'SYN', series: ['b', 'c'], pit_available_at: 'NEXT_TRADING_DAY_0900_CST' }, synthetic).readings[0].name, 'syn');
  assert.deepEqual(space.CLOCK_ORDER.map((c) => [...c]), [['BAR_CLOSE', 'CLOSE_DATED_NEXT_OPEN_USABLE'], ['NEXT_DAY_0000_CST', 'NEXT_TRADING_DAY_0900_CST']]);
});

const COORDINATOR_DIR = path.resolve(process.env.QRP_COORDINATOR_DIR || path.join(ROOT, '..', 'artifacts', 'coordinator'));
const DRAFT = path.join(COORDINATOR_DIR, 'MINING_SPACE_V1_CN_A_R1.draft.bee978ed.json');
test('空间草稿 DRAFT_3（全是 OBSERVED_AT）在协调会话裁定之后被拒（LIVE_CLOCK_IN_HISTORY）', { skip: fs.existsSync(DRAFT) ? false : `协调会话目录里没有 ${path.basename(DRAFT)}` }, () => {
  assert.throws(() => space.parseSpace(fs.readFileSync(DRAFT), PROOF), code(/MINE_SPACE_READING_LIVE_CLOCK_IN_HISTORY/));
});

test('1.20.0 的 V6_CN_PARKING_ETF_HISTORY（R-XM-1，KG #371 在 1.15.0 登记，到 1.20.0 原样）：实时 PIT 一个（BAR_CLOSE），历史时钟按序列；BASIS PRICE/RAW；VENDOR Tushare', () => {
  const ds = REG.datasets.get('V6_CN_PARKING_ETF_HISTORY');
  assert.deepEqual([ds.pitSemantics, ds.vendor, ds.priceBasis], ['BAR_CLOSE', 'Tushare', 'PRICE/RAW']);
  assert.deepEqual(ds.pitHistoricalClock.bySeries, { fund_daily: 'BAR_CLOSE', fund_adj: 'CLOSE_DATED_NEXT_OPEN_USABLE', fund_nav: 'ANNOUNCEMENT_NEXT_OPEN' });
  const t = (s, hist) => tok(`V6_CN_PARKING_ETF_HISTORY${s ? `#series=${s}` : ''}`, `PIT=BAR_CLOSE|VENDOR=Tushare|BASIS=PRICE/RAW${hist ? `|HIST=${hist}` : ''}`);
  const r = direct([t('fund_daily', 'BAR_CLOSE'), t('fund_adj', 'CLOSE_DATED_NEXT_OPEN_USABLE'), t('fund_nav', 'ANNOUNCEMENT_NEXT_OPEN')]);
  assert.equal(r.state, 'PASS');
  assert.deepEqual(r.data_inputs.map((d) => [d.series, d.registry_version, d.pin_check, d.pit_check, d.hist_check, d.basis_check, d.vendor_check]), [
    ['fund_daily', '1.20.0', 'CURRENT', 'CHECKED', 'CHECKED', 'CHECKED', 'MATCH'],
    ['fund_adj', '1.20.0', 'CURRENT', 'CHECKED', 'CHECKED', 'CHECKED', 'MATCH'],
    ['fund_nav', '1.20.0', 'CURRENT', 'CHECKED', 'CHECKED', 'CHECKED', 'MATCH']]);
  refuses(() => direct([t(null, 'BAR_CLOSE')]), 'SERIES_REQUIRED', 'pitHistoricalClock');
  refuses(() => direct([t('fund_adj', 'BAR_CLOSE')]), 'HIST_CLOCK_MISMATCH', 'BAR_CLOSE≠CLOSE_DATED_NEXT_OPEN_USABLE');
  refuses(() => direct([t('fund_daily', 'BAR_CLOSE').replace('|BASIS=PRICE/RAW', '')]), 'PRICE_BASIS_MISSING');
});
