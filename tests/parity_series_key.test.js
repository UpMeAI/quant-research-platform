'use strict';
/**
 * 数据集登记表 1.14.0 的序列级口径（协调会话 2026-11-17 裁定）与挖掘空间的读数登记。先红后绿。
 *   - G-PARITY：混合数据集（pitSemantics 为 null、另有 pitSemanticsBySeries）的记号写 `DATA:<id>#series=<序列>@…`；
 *     没写 series → PARITY_SERIES_REQUIRED；序列不在表里 → PARITY_SERIES_UNKNOWN；PIT 按那个序列核；非混合数据集写 series → DATA_INPUT_INVALID；
 *     重复按（数据集, 序列）判；锁行带 series；非混合记号的锁行逐字节不变。
 *   - 历史：pitSemanticsBySeries 进 FINGERPRINT_FIELDS（旧版本没有不算变）。
 *   - parseSpace：读数的 dataset_id 要在钉住的登记表里，pit_available_at 要以登记表的 PIT 记号开头；混合数据集要写 series。
 * 登记表：用例都对真钉着的 1.14.0（#104 合并后，config/dataset-registry，KG a738d3b5，c5aabf57…）跑。
 * tests/fixtures/dataset-registry-kg369 是 KG #369 审阅之前的分支头 a8c272a5 的 1.14.0（f734f995…）——pre-review bytes，只留作对照（第一条用例）。
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
const BYTES = fs.readFileSync(path.join(__dirname, 'fixtures', 'dataset-registry-kg369', 'datasets.v1.json'));
const DOC = JSON.parse(BYTES.toString('utf8'));
/** KG #369 审阅之前的分支头 a8c272a5 的 1.14.0（pre-review bytes），只留作对照：#104 合并后真钉着的是 a738d3b5 的 1.14.0。 */
const FIXTURE_REG = Object.freeze({ registry_version: DOC.version, registry_sha256: sha(BYTES), datasets: new Map(DOC.datasets.map((d) => [d.id, d])), registry: DOC });
/** 下面的用例都对真钉着的 1.14.0（config/dataset-registry，KG a738d3b5，c5aabf57…）跑。 */
const REG = datasetRegistry.pinned();
const V = `@${REG.registry_version}#${REG.registry_sha256}`;
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const refuses = (fn, c, detail) => assert.throws(fn, (e) => e.code === `PARITY_${c}` && (!detail || String(e.detail).includes(detail)), `${c} ${detail || ''}`);
function direct(lines, registry = REG) {
  const k2 = Buffer.from(`# 合成 K2\n\n## 0\n**数据输入**：${lines.join('；')}\n`);
  return gate.check({ id: 'SERIES', kind: 'RESULT', sealed_on: '2026-11-20', k2: { sha256: sha(k2) }, k2_frozen_at: '2026-11-17T10:00:00+08:00' }, { k2Bytes: () => k2 }, { registry, history: new Map() });
}

test('真钉着的 1.14.0：三个混合数据集没有 pitSemantics（不写或 null）、带 pitSemanticsBySeries；两个新数据集 OBSERVED_AT。审阅前的夹具与它只差历史时钟、producedBy 与顶层清单，序列表一样', () => {
  assert.deepEqual([REG.commit, REG.registry_version, REG.registry_sha256], ['a738d3b52f552f48ae62017712b72c82c9365d2c', '1.14.0', 'c5aabf570888b15eb6cb3f24e40e6e9364bbb0024bd8a217e9f8918b5775f209']);
  const mixedOf = (reg) => [...reg.datasets.values()].filter((d) => (d.pitSemantics === null || d.pitSemantics === undefined) && d.pitSemanticsBySeries && Object.keys(d.pitSemanticsBySeries).length).map((d) => d.id).sort();
  assert.deepEqual(mixedOf(REG), ['CN_MARKET_PSYCHOLOGY', 'MACRO_CN_OFFICIAL', 'US_MARKET_PSYCHOLOGY']);
  assert.deepEqual(['V6_CN_STOCK_DAILY_BARS', 'V6_CN_STOCK_DAILY_BASIC'].map((id) => REG.datasets.get(id).pitSemantics), ['OBSERVED_AT', 'OBSERVED_AT']);
  // 审阅前的夹具（a8c272a5，f734f995…）：混合数据集与序列表和合并后的一样；差别只在 pitHistoricalClock（夹具里没有）、两个 V6 数据集的 producedBy、顶层 PIT 清单多的两个时钟
  assert.deepEqual([FIXTURE_REG.registry_version, FIXTURE_REG.registry_sha256], ['1.14.0', 'f734f9950c167b23d9ec8bbbbde86fa6a580160770cd7840a80164350ce43852']);
  assert.deepEqual(mixedOf(FIXTURE_REG), mixedOf(REG));
  for (const id of mixedOf(REG)) assert.deepEqual(FIXTURE_REG.datasets.get(id).pitSemanticsBySeries, REG.datasets.get(id).pitSemanticsBySeries, id);
});

test('G-PARITY 混合数据集：没写 series → SERIES_REQUIRED；序列不在表里 → SERIES_UNKNOWN；PIT 按序列核（sf_month 要 END_OF_FOLLOWING_MONTH_CONSERVATIVE）；锁行带 series', () => {
  refuses(() => direct([`\`DATA:MACRO_CN_OFFICIAL${V}|PIT=OBSERVED_AT|VENDOR=NBS\``]), 'SERIES_REQUIRED', 'MACRO_CN_OFFICIAL');
  refuses(() => direct([`\`DATA:MACRO_CN_OFFICIAL#series=cn_rent${V}|PIT=OBSERVED_AT|VENDOR=NBS\``]), 'SERIES_UNKNOWN', 'cn_rent');
  refuses(() => direct([`\`DATA:MACRO_CN_OFFICIAL#series=sf_month${V}|PIT=OBSERVED_AT|VENDOR=PBOC\``]), 'PIT_SEMANTICS_MISMATCH', 'OBSERVED_AT≠END_OF_FOLLOWING_MONTH_CONSERVATIVE');
  const r = direct([`\`DATA:MACRO_CN_OFFICIAL#series=sf_month${V}|PIT=END_OF_FOLLOWING_MONTH_CONSERVATIVE|VENDOR=PBOC\``,
    `\`DATA:MACRO_CN_OFFICIAL#series=cn_pmi${V}|PIT=OBSERVED_AT|VENDOR=NBS\``, `\`DATA:US_MARKET_PSYCHOLOGY#series=US.VIX_VIX3M${V}|PIT=CBOE_SAME_DAY_2130_ET|VENDOR=Cboe\``]);
  assert.equal(r.state, 'PASS');
  assert.deepEqual(r.data_inputs.map((d) => [d.dataset_id, d.series, d.pit_semantics, d.pit_check]), [
    ['MACRO_CN_OFFICIAL', 'sf_month', 'END_OF_FOLLOWING_MONTH_CONSERVATIVE', 'CHECKED'],
    ['MACRO_CN_OFFICIAL', 'cn_pmi', 'OBSERVED_AT', 'CHECKED'],
    ['US_MARKET_PSYCHOLOGY', 'US.VIX_VIX3M', 'CBOE_SAME_DAY_2130_ET', 'CHECKED'],
  ]);
  assert.deepEqual(Object.keys(r.data_inputs[0]).slice(0, 2), ['dataset_id', 'series']);
  // 重复按（数据集, 序列）判：同一序列写两次 → INVALID；同一数据集两个序列可以
  refuses(() => direct([`\`DATA:MACRO_CN_OFFICIAL#series=cn_pmi${V}|PIT=OBSERVED_AT|VENDOR=NBS\``, `\`DATA:MACRO_CN_OFFICIAL#series=cn_pmi${V}|PIT=OBSERVED_AT|VENDOR=NBS\``]), 'DATA_INPUT_INVALID', 'duplicate');
  // 跨文件：同一（数据集, 序列）写法不同 → CONFLICT
  const k2 = Buffer.from(`# K2\n\n## 0\n**数据输入**：\`DATA:MACRO_CN_OFFICIAL#series=cn_pmi${V}|PIT=OBSERVED_AT|VENDOR=NBS\`\n`);
  const note = Buffer.from(`\`DATA:MACRO_CN_OFFICIAL#series=cn_pmi${V}|PIT=OBSERVED_AT|VENDOR=Tushare\`\n\`DATA:MACRO_CN_OFFICIAL#series=cn_cpi${V}|PIT=OBSERVED_AT|VENDOR=NBS\`\n`);
  const entry = { id: 'SERIES-N', kind: 'RESULT', sealed_on: '2026-11-20', k2: { sha256: sha(k2) }, k2_frozen_at: '2026-11-17T10:00:00+08:00', k2_notes: [{ source: 'coordinator', path: 'N.md', sha256: sha(note) }] };
  refuses(() => gate.check(entry, { k2Bytes: () => k2, noteBytes: () => [note] }, { registry: REG, history: new Map() }), 'DATA_INPUTS_CONFLICT', 'MACRO_CN_OFFICIAL#series=cn_pmi');
});

test('G-PARITY 非混合数据集：写 series → DATA_INPUT_INVALID；不写 series 的锁行逐字节不变（没有 series 键）', () => {
  refuses(() => direct([`\`DATA:V6_CN_STOCK_DAILY_BARS#series=close${V}|PIT=OBSERVED_AT|VENDOR=Tushare|BASIS=PRICE/RAW\``]), 'DATA_INPUT_INVALID', 'NOT_A_MIXED_DATASET');
  const r = direct([`\`DATA:V6_CN_STOCK_DAILY_BARS${V}|PIT=OBSERVED_AT|VENDOR=Tushare|BASIS=PRICE/RAW\``]);
  assert.equal(JSON.stringify(r.data_inputs[0]), JSON.stringify({ dataset_id: 'V6_CN_STOCK_DAILY_BARS', registry_version: '1.14.0', registry_sha256: REG.registry_sha256, pit_semantics: 'OBSERVED_AT',
    vendor: 'Tushare', price_basis: 'PRICE/RAW', pin_check: 'CURRENT', pit_check: 'CHECKED', basis_check: 'CHECKED', vendor_check: 'MATCH' }));
  refuses(() => direct([`\`DATA:V6_CN_STOCK_DAILY_BARS${V}|PIT=BAR_CLOSE|VENDOR=Tushare|BASIS=PRICE/RAW\``]), 'PIT_SEMANTICS_MISMATCH', 'BAR_CLOSE≠OBSERVED_AT');
  // 不写 series 的非混合记号：没有 series 键
  const cur = datasetRegistry.pinned();
  const row = direct([`\`DATA:SMARTFLOW_US_1M@${cur.registry_version}#${cur.registry_sha256}|PIT=BAR_CLOSE|VENDOR=Yahoo\``], cur).data_inputs[0];
  assert.equal('series' in row, false);
});

test('历史：pitSemanticsBySeries 进一致性字段；旧版本没有这个键不算变，有而改了算变', () => {
  assert.ok(datasetRegistry.FINGERPRINT_FIELDS.includes('pitSemanticsBySeries'));
  const now = REG.datasets.get('MACRO_CN_OFFICIAL');
  assert.deepEqual(datasetRegistry.changedFields({ id: now.id, owner: now.owner }, now), []);
  const older = { ...now, pitSemanticsBySeries: { ...now.pitSemanticsBySeries, sf_month: 'OBSERVED_AT' } };
  assert.deepEqual(datasetRegistry.changedFields(older, now), ['pitSemanticsBySeries']);
});

/** 夹具空间：读数取自 1.14.0；算子证据用仓库里的那份。 */
const EVIDENCE = fs.readFileSync(path.join(ROOT, 'docs', 'evidence', 'mining-operators-v1', 'CAUSALITY_EVIDENCE_V1.json'));
const PROOF = { evidence: JSON.parse(EVIDENCE), evidenceBytes: EVIDENCE };
const spaceOf = (readings) => Buffer.from(JSON.stringify({ schema: 'MINING_SPACE_V1', space_ref: 'MS-SERIES', market: 'CN_A', readings,
  operators: ['rank', 'ts_mean'], constants: [1], lookbacks: [5, 20], holding_periods: [5], max_tokens: 20, max_depth: 5,
  operator_evidence: { path: 'docs/evidence/mining-operators-v1/CAUSALITY_EVIDENCE_V1.json', sha256: sha(EVIDENCE) } }));

test('parseSpace：读数的数据集要在钉住的登记表里；pit_available_at 以登记表的 PIT 记号开头；混合数据集要写在表里的 series', () => {
  const ok = (readings) => space.parseSpace(spaceOf(readings), PROOF, { registry: REG });
  const bars = { name: 'close_hfq', dataset_id: 'V6_CN_STOCK_DAILY_BARS', pit_available_at: 'OBSERVED_AT (ingest instant); next-open only' };
  assert.equal(ok([bars]).readings[0].dataset_id, 'V6_CN_STOCK_DAILY_BARS');
  assert.throws(() => ok([{ ...bars, dataset_id: 'TUSHARE_DAILY_UNREGISTERED' }]), code(/MINE_SPACE_READING_UNREGISTERED:TUSHARE_DAILY_UNREGISTERED/));
  assert.throws(() => ok([{ ...bars, pit_available_at: 'BAR_CLOSE 15:00 +08:00' }]), code(/MINE_SPACE_READING_PIT_MISMATCH:close_hfq:BAR_CLOSE.*OBSERVED_AT/));
  assert.throws(() => ok([{ ...bars, pit_available_at: 'OBSERVED_AT_LATE (not the same token)' }]), code(/MINE_SPACE_READING_PIT_MISMATCH/));
  // 混合数据集
  const macro = { name: 'sf', dataset_id: 'MACRO_CN_OFFICIAL', series: 'sf_month', pit_available_at: 'END_OF_FOLLOWING_MONTH_CONSERVATIVE (month-end + 1 month)' };
  assert.equal(ok([macro]).readings[0].series, 'sf_month');
  assert.throws(() => ok([{ ...macro, series: undefined }]), code(/MINE_SPACE_READING_SERIES_REQUIRED:sf/));
  assert.throws(() => ok([{ ...macro, series: 'cn_rent' }]), code(/MINE_SPACE_READING_SERIES_UNKNOWN:sf:cn_rent/));
  assert.throws(() => ok([{ ...macro, pit_available_at: 'OBSERVED_AT' }]), code(/MINE_SPACE_READING_PIT_MISMATCH:sf/));
  assert.throws(() => ok([{ ...bars, series: 'close' }]), code(/MINE_SPACE_READING_SERIES_NOT_ALLOWED:close_hfq/));
  // 不传 registry → 用真钉着的登记表（#104 之后是 1.14.0，a738d3b5）：同样的读数照样过，没登记的照样拒
  assert.equal(space.parseSpace(spaceOf([bars]), PROOF).readings[0].dataset_id, 'V6_CN_STOCK_DAILY_BARS');
  assert.throws(() => space.parseSpace(spaceOf([{ ...bars, dataset_id: 'TUSHARE_DAILY_UNREGISTERED' }]), PROOF), code(/MINE_SPACE_READING_UNREGISTERED:TUSHARE_DAILY_UNREGISTERED@1\.14\.0/));
});

const COORDINATOR_DIR = path.resolve(process.env.QRP_COORDINATOR_DIR || path.join(ROOT, '..', 'artifacts', 'coordinator'));
// DRAFT_3（parity 订正 6 之后，只改了 pit_available_at 的文字）；用按 sha 命名的只读副本，草稿再改也不影响这条
const DRAFT = path.join(COORDINATOR_DIR, 'MINING_SPACE_V1_CN_A_R1.draft.bee978ed.json');
test('协调会话的空间草稿 MINING_SPACE_V1_CN_A_R1（DRAFT_3，bee978ed…）对 1.14.0 夹具通过', { skip: fs.existsSync(DRAFT) ? false : `协调会话目录里没有 ${path.basename(DRAFT)}` }, () => {
  const bytes = fs.readFileSync(DRAFT);
  assert.equal(sha(bytes), 'bee978ed5d1f98460dab2914cd9a6aedc14413301f92e89cb62865ffa258a16b');
  const s = space.parseSpace(bytes, PROOF, { registry: REG });
  assert.equal(s.space_ref, 'MINING_SPACE_V1:CN_A:R1:DRAFT_3');
  assert.ok(s.readings.every((r) => r.pit_available_at.startsWith('OBSERVED_AT ')));
  assert.deepEqual([...new Set(s.readings.map((r) => r.dataset_id))].sort(), ['V6_CN_STOCK_DAILY_BARS', 'V6_CN_STOCK_DAILY_BASIC']);
});
