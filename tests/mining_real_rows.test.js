'use strict';
/**
 * 真实行夹具（协调会话 2026-11-18：第 1 轮的三处数据原因都出在手写夹具与 V6 真实编码不同——行业成员全是 DEGRADED、daily_basic 的 { state, value }、
 * SW2021 effective_to 含当天）。tests/fixtures/mining-real-rows-20261118/ 是从协调会话只读导出的 -r4 验证尾段（导出规格 rev 4 33093147，
 * SHA256SUMS 758323e8）按 MAKE.py 取的 34 只股票的全部行（ST、北交所、新上市、退市、整日停牌、写了 effective_to 的、科创、创业、缺 pe_ttm、主板），
 * 交易日历截在 2025-06-01 → 2026-10-16（留出段里的日子一行都不带，2026-11-18 复审）。SHA256SUMS 的 sha 钉在下面。只读这个目录，按 VALIDATION 段建面板（2026-09-29 → 2026-10-16）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_ROUND_RUNNER_AUTHORITY';
const adapter = require('../services/mining-sandbox/data-adapter');
const runner = require('../services/mining-sandbox/round-runner');
const evaluator = require('../services/mining-sandbox/evaluator');
const dsl = require('../services/mining-sandbox/dsl');
const { forEachCsvRow } = require('../services/mining-sandbox/data-adapter/csv');

const DIR = path.join(__dirname, 'fixtures', 'mining-real-rows-20261118');
const SUMS_SHA256 = 'b6c7becb35cb90392d06a021c626ae5f9d8a790accbb9472bc8f88c1a32da088';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rowsOf = (file) => { const out = []; forEachCsvRow(path.join(DIR, file), (r) => out.push(r)); return out; };
const f = runner.loadFrozenSpace();
const panel = adapter.buildPanel({ sources: [adapter.csvDirSource(DIR, { mode: 'LIVE', label: 'real-tail-r4' })], space: f.space, segment: 'VALIDATION', from: '2026-09-29', to: '2026-10-16' });
const at = (d, id) => ({ i: panel.dates.indexOf(d), j: panel.codes.indexOf(id) });
const master = rowsOf('security_master_stock.csv');

test('真实行夹具钉住：SHA256SUMS 的 sha 与逐个文件都对得上', () => {
  assert.equal(sha256(fs.readFileSync(path.join(DIR, 'SHA256SUMS'))), SUMS_SHA256);
  for (const line of fs.readFileSync(path.join(DIR, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) {
    const [h, file] = line.split(/\s+/);
    assert.equal(sha256(fs.readFileSync(path.join(DIR, file))), h, file);
  }
});

test('真实编码：行业成员全是 DEGRADED，收进面板；局限照实写（单一来源、effective_to 按含读）；北交所不在面板', () => {
  const c = panel.manifest.counts.industry;
  assert.ok(c.by_quality.DEGRADED > 0 && c.by_quality.READY === 0 && c.rows === c.by_quality.DEGRADED, JSON.stringify(c));
  assert.deepEqual(panel.manifest.industry_limits, ['SINGLE_SOURCE_NOT_RECONCILED', 'END_DATE_INCLUSIVE_V6_READS_EXCLUSIVE']);
  assert.ok(!panel.codes.some((c2) => c2.endsWith('.BJ')));
  const inU = []; panel.universe.forEach((row, t) => row.forEach((u, j) => { if (u && t > 0) inU.push([t, j]); }));
  const withInd = inU.filter(([t, j]) => typeof panel.industry[t][j] === 'string').length;
  assert.ok(inU.length > 50 && withInd / inU.length >= 0.95, `${withInd}/${inU.length}`);
});

test('真实编码：daily_basic 的 { state, value } 读成数；与 CSV 里的 PRESENT 值逐格相同；MISSING 计入 value_missing', () => {
  const basic = rowsOf('market_daily_basic_observation_stock.csv');
  assert.ok(panel.manifest.counts.daily_basic.value_missing > 0);
  let checked = 0;
  for (const r of basic) {
    const k = panel.dates.indexOf(r.trade_date); if (k < 0 || k + 1 >= panel.dates.length) continue; // 收盘记，次一开市日起用
    const j = panel.codes.indexOf(r.security_id); if (j < 0) continue;
    const v = JSON.parse(r.values);
    for (const [name, key] of [['pb', 'pb'], ['total_mv', 'total_mv'], ['pe_ttm', 'pe_ttm']]) {
      const x = panel.readings[name] ? panel.readings[name][k + 1][j] : (name === 'total_mv' ? panel.size[k + 1][j] : undefined);
      if (x === undefined) continue;
      if (v[key] && v[key].state === 'PRESENT') { assert.equal(x, v[key].value, `${r.security_id} ${r.trade_date} ${key}`); checked += 1; } else assert.ok(!Number.isFinite(x), `${r.security_id} ${r.trade_date} ${key} ${v[key] && v[key].state}`);
    }
  }
  assert.ok(checked > 100, `checked ${checked}`);
});

test('真实编码：ST、新上市不满 120 个交易日不进池；整日停牌那天不进池；退市的不进池', () => {
  const st = new Set(master.filter((r) => r.risk_warning_status === 'ST').map((r) => r.security_id));
  for (const id of st) { const j = panel.codes.indexOf(id); if (j >= 0) assert.ok(panel.universe.every((row, t) => !row[j] || master.some((m) => m.security_id === id && m.business_date <= panel.dates[t] && m.risk_warning_status === 'NORMAL'))); }
  for (const id of ['001232.SZ', '001237.SZ']) { const j = panel.codes.indexOf(id); assert.ok(j < 0 || panel.universe.every((row) => !row[j]), id); }
  const susp = rowsOf('security_suspension_observation.csv').filter((r) => r.full_session === 't' && panel.dates.includes(r.trade_date));
  assert.ok(susp.length > 0);
  for (const r of susp) { const { i, j } = at(r.trade_date, r.security_id); if (j >= 0) assert.equal(panel.universe[i][j], false, `${r.security_id} ${r.trade_date}`); }
});

test('真实编码：(-close_hfq) 经打分前的中性化（行业 + 市值），逐日有限值的名字 ≥ 当天覆盖数的 0.9', () => {
  const neu = evaluator.neutralizeForScoring(evaluator.evaluate(dsl.parse('(-close_hfq)', f.dslSpace), panel), {
    ...panel, industry: panel.industry.map((row, t) => row.map((g, j) => (panel.universe[t][j] ? g : null))) }).values;
  for (let t = 1; t < panel.dates.length; t += 1) {
    let cov = 0; let n = 0;
    panel.codes.forEach((_, j) => { if (!panel.universe[t][j]) return; if (Number.isFinite(panel.readings.close_hfq[t][j])) cov += 1; if (Number.isFinite(neu[t][j])) n += 1; });
    assert.ok(cov >= 10 && n >= 0.9 * cov, `${panel.dates[t]}: ${n}/${cov}`);
  }
});

// ── 车道副本的 2021-07-29 切片（BASE 回放库，MAKE.py）：SW2021 换行业的那一天，effective_to 含当天（★RF1116_INDUSTRY_END_INCLUSIVE (a)）
const LANE_DIR = path.join(__dirname, 'fixtures', 'mining-real-rows-lane-20210729');
const LANE_SUMS_SHA256 = '81813b0dd3932880d7494fbfcd6f80ed81d349278a693aea8573ad9e2446be0d';
test('车道切片钉住；2021-07-29 换行业的 8 只：07-29 还是旧行业，07-30 起是新行业（按含读）；当天 24 只都有行业', () => {
  assert.equal(sha256(fs.readFileSync(path.join(LANE_DIR, 'SHA256SUMS'))), LANE_SUMS_SHA256);
  const p = adapter.buildPanel({ sources: [adapter.csvDirSource(LANE_DIR, { mode: 'HISTORY', label: 'lane-20210729' })], space: f.space, segment: 'MINING', from: '2021-07-22', to: '2021-08-04' });
  const ind = []; forEachCsvRow(path.join(LANE_DIR, 'industry_membership_sw2021.csv'), (r) => { if (r.industry_level === 'L1') ind.push(r); });
  const ended = [...new Set(ind.filter((r) => r.effective_to === '2021-07-29').map((r) => r.security_id))].filter((id) => ind.some((r) => r.security_id === id && r.effective_from === '2021-07-30'));
  assert.equal(ended.length, 8);
  const i29 = p.dates.indexOf('2021-07-29'); const i30 = p.dates.indexOf('2021-07-30');
  for (const id of ended) {
    const j = p.codes.indexOf(id);
    const oldRow = ind.find((r) => r.security_id === id && r.effective_to === '2021-07-29'); const newRow = ind.find((r) => r.security_id === id && r.effective_from === '2021-07-30');
    assert.equal(p.industry[i29][j], oldRow.industry_code, `${id} on its last day`);
    assert.equal(p.industry[i30][j], newRow.industry_code, `${id} from the next day`);
  }
  assert.equal(p.codes.filter((id, j) => typeof p.industry[i29][j] === 'string').length, p.codes.length, 'every name has an industry on 2021-07-29');
});
