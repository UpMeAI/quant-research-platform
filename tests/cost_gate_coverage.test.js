'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gate = require('../services/cost-gate');
const trials = require('../services/trial-ledger');

/**
 * G-COST 覆盖面检查（PAPER_TRADING_COST_MODEL_V1 ★C4，合同 sha256 1be6e080…，登记文件 r2 sha256 44cdebd5…）。先红后绿。
 * 研究净值行必须收齐登记文件里该市场标为 CHARGED 的每一项，缺一项或 UNKNOWN 即 NET_PARTIAL，不算净值行（门拒绝导入）。
 * 佣金与滑点的下限照 a3329481 不变；只对合同冻结（2026-11-22T17:35:16+08:00）之后才冻结的 K2 生效，更早的 K2 逐字节不变。
 * 只用合成 K2、合成运行日志；登记文件读 vendor/paper-cost-model/（PIN.json 钉 sha256）。
 */
const AUTH = 'TEST_COST_COVERAGE_AUTHORITY';
const EFF = '2026-11-01T00:00:00+08:00';
const BOUND = Object.freeze({ path: 'artifacts/coordinator/SYNTH_ADDENDUM_FREEZE_1.md', sha256: 'a'.repeat(64), state: 'FREEZE_1', texts: [{ id: 'DRAFT_REV_1', sha256: 'b'.repeat(64) }] });
const FAMILY = 'C17_V2_4000USDT';
const STUDY = 'R99-COVERAGE-SYNTH';
const OWN = 'SYNTH_ENGINE_COSTS_V1';
const CUTOFF = '2026-11-22T17:35:16+08:00';
const AFTER = '2026-11-22T17:35:16+08:00'; // 恰在冻结时刻：生效（含边界）
const BEFORE = '2026-11-22T17:35:15+08:00';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ARMS = [
  { config_label: 'T', role: 'VERDICT_ARM', stage: 'BOOK', market: 'CRYPTO_USDM_PERP', rule_config: { c: 1 } },
  { config_label: 'T_CN', role: 'VERDICT_ARM', stage: 'BOOK', market: 'CN_A', rule_config: { c: 2 } },
  { config_label: 'T_US', role: 'VERDICT_ARM', stage: 'BOOK', market: 'US_EQUITY', rule_config: { c: 3 } },
  { config_label: 'T_HK', role: 'VERDICT_ARM', stage: 'BOOK', market: 'HK', rule_config: { c: 4 } },
];
const arm = (l) => ARMS.find((a) => a.config_label === l);
const K2_SHA = sha('# R99 覆盖面 K2（合成）\n');
const idOf = (l) => trials.trialIdOf({ family_id: FAMILY, study_ref: STUDY, config_label: l });

/** 登记文件 r2 里各市场 CHARGED 项（手写一份，独立于被测代码）。 */
const REQUIRED = {
  CN_STOCK: ['COMMISSION', 'MIN_COMMISSION_TOPUP', 'SLIPPAGE', 'STAMP_DUTY', 'TRANSFER_FEE', 'EXCHANGE_FEE'],
  CN_ETF: ['COMMISSION', 'MIN_COMMISSION_TOPUP', 'SLIPPAGE', 'EXCHANGE_FEE'],
  US: ['COMMISSION', 'SLIPPAGE', 'SEC_FEE', 'FINRA_TAF', 'CAT_FEE'],
  PERP: ['COMMISSION', 'SLIPPAGE', 'FUNDING'],
  SPOT: ['COMMISSION', 'SLIPPAGE'],
};
const charged = (names) => names.map((item) => ({ item, state: 'CHARGED', amount: 1.5, ccy: 'X', source: 'MODELLED' }));
const without = (names, drop) => charged(names.filter((n) => n !== drop));
const withState = (names, item, patch) => charged(names).map((r) => (r.item === item ? { ...r, ...patch } : r));
const CASES = {
  CN_STOCK: { label: 'T_CN', book: 'STOCK_BOOK', bps: [2.5, 10] },
  CN_ETF: { label: 'T_CN', book: 'INDEX_SLEEVE_ETF', bps: [2.5, 10] },
  US: { label: 'T_US', book: undefined, bps: [0, 5] },
  PERP: { label: 'T', book: 'BINANCE_USDT_PERP', bps: [2, 2] },
  SPOT: { label: 'T', book: 'BINANCE_SPOT', bps: [2, 2] },
};
function row(kind, items, patch = {}) {
  const c = CASES[kind];
  return { family_id: FAMILY, config_label: c.label, trial_id: idOf(c.label), rule_config_hash: trials.ruleConfigHash(arm(c.label).rule_config),
    verdict_metric_kind: 'NET_RETURN_SERIES', cost_model_ref: OWN, ...(c.book ? { cost_book: c.book } : {}),
    cost_breakdown: { model: OWN, commission_bps: c.bps[0], slippage_bps: c.bps[1], ...(items === undefined ? {} : { items }) }, ...patch };
}
function direct(runRow, { frozenAt = '2026-11-23T10:00:00+08:00', opts = {} } = {}) {
  const bytes = Buffer.from(JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: K2_SHA, runs: [runRow] }));
  const entry = { id: 'C17-R99-COVERAGE', kind: 'RESULT', strategy_ref: FAMILY, sealed_on: '2026-11-30', k2: { sha256: K2_SHA }, k2_frozen_at: frozenAt };
  return gate.check(entry, { runLogBytes: () => bytes }, { effectiveFrom: EFF, freeze: BOUND, ...opts });
}
const refuses = (fn, code, detail) => assert.throws(fn, (e) => e.code === `COST_MODEL_${code}` && (!detail || String(e.detail).includes(detail)), `${code} ${detail || ''}`);

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  try { fs.rmSync(trials.TRIALS()); } catch { /* 首次 */ }
  trials.register(ARMS.map((a) => ({ family_id: FAMILY, study_ref: STUDY, k2_sha256: K2_SHA, ...a })), { registeredBy: AUTH, registeredAt: '2026-11-08T09:00:00+08:00' });
});

test('常量与登记文件：生效时刻 = 合同冻结时刻；vendor/paper-cost-model/PIN.json 钉合同 1be6e080… 与登记 r2 44cdebd5…，文件字节与钉值一致；加载器改一个字节即失败即关', () => {
  const cov = require('../services/cost-gate/coverage');
  assert.equal(cov.COVERAGE_EFFECTIVE_FROM, CUTOFF);
  assert.equal(cov.CONTRACT_SHA256, '1be6e0807995a9501e8b3393427c6367af47cd333e5bf89a0a95c03cc21e76fb');
  const dir = path.join(__dirname, '..', 'vendor', 'paper-cost-model');
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'PIN.json'), 'utf8'));
  assert.equal(pin.contract, 'PAPER_TRADING_COST_MODEL_V1');
  assert.equal(pin.contractSha256, cov.CONTRACT_SHA256);
  assert.equal(pin.registryRevision, 2);
  assert.equal(pin.files['PAPER_COST_MODEL_V1.json'], '44cdebd53a28d25c195690696bf99050573ef7f647d81c7b65a464c4b4607776');
  assert.equal(sha(fs.readFileSync(path.join(dir, 'PAPER_COST_MODEL_V1.json'))), pin.files['PAPER_COST_MODEL_V1.json']);
  const reg = cov.loadRegistry();
  assert.equal(reg.registryRevision, 2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-pcm-'));
  fs.copyFileSync(path.join(dir, 'PIN.json'), path.join(tmp, 'PIN.json'));
  fs.writeFileSync(path.join(tmp, 'PAPER_COST_MODEL_V1.json'), `${fs.readFileSync(path.join(dir, 'PAPER_COST_MODEL_V1.json'), 'utf8')} `);
  assert.throws(() => cov.loadRegistry(tmp), (e) => e.code === 'COST_MODEL_COVERAGE_REGISTRY_PIN_MISMATCH');
  assert.throws(() => cov.loadRegistry(path.join(tmp, 'nope')), (e) => e.code === 'COST_MODEL_COVERAGE_REGISTRY_MISSING');
});

test('不复制费率：覆盖面模块的源码里没有 bps 数值字面值，也不含任何成本项的费率（成本项清单只从登记文件读）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'cost-gate', 'coverage.js'), 'utf8');
  assert.doesNotMatch(src, /\b\d+\.\d+\b/);
  assert.doesNotMatch(src, /STAMP_DUTY|SEC_FEE|FINRA_TAF|TRANSFER_FEE|FUNDING/);
});

test('反例：A 股个股簿净值行缺印花税 → NET_PARTIAL（门拒绝，细节点名 STAMP_DUTY）；每缺一项都一样', () => {
  refuses(() => direct(row('CN_STOCK', without(REQUIRED.CN_STOCK, 'STAMP_DUTY'))), 'NET_PARTIAL', 'STAMP_DUTY');
  for (const drop of REQUIRED.CN_STOCK) refuses(() => direct(row('CN_STOCK', without(REQUIRED.CN_STOCK, drop))), 'NET_PARTIAL', drop);
  assert.equal(direct(row('CN_STOCK', charged(REQUIRED.CN_STOCK))).state, 'PASS');
});

test('反例：A 股 ETF 簿——印花税是 NOT_APPLICABLE 不要求；经手费缺 → NET_PARTIAL；登记里 TRANSFER_FEE 仍是 UNKNOWN，不要求但在结果里列为 registry_unknown_items（不当 0）', () => {
  const ok = direct(row('CN_ETF', charged(REQUIRED.CN_ETF)));
  assert.equal(ok.state, 'PASS');
  assert.deepEqual(ok.cost_coverage.registry_unknown_items, ['TRANSFER_FEE']);
  refuses(() => direct(row('CN_ETF', without(REQUIRED.CN_ETF, 'EXCHANGE_FEE'))), 'NET_PARTIAL', 'EXCHANGE_FEE');
});

test('反例：美股净值行缺 SEC 费 → NET_PARTIAL；TAF、CAT 同理；完整则过', () => {
  refuses(() => direct(row('US', without(REQUIRED.US, 'SEC_FEE'))), 'NET_PARTIAL', 'SEC_FEE');
  refuses(() => direct(row('US', without(REQUIRED.US, 'FINRA_TAF'))), 'NET_PARTIAL', 'FINRA_TAF');
  refuses(() => direct(row('US', without(REQUIRED.US, 'CAT_FEE'))), 'NET_PARTIAL', 'CAT_FEE');
  assert.equal(direct(row('US', charged(REQUIRED.US))).state, 'PASS');
});

test('反例：加密永续净值行资金费 UNKNOWN → NET_PARTIAL；资金费缺项同样；资金费 CHARGED 且金额为 0（实测为零）合法；现货簿不要求资金费', () => {
  refuses(() => direct(row('PERP', withState(REQUIRED.PERP, 'FUNDING', { state: 'UNKNOWN', amount: undefined }))), 'NET_PARTIAL', 'FUNDING');
  refuses(() => direct(row('PERP', without(REQUIRED.PERP, 'FUNDING'))), 'NET_PARTIAL', 'FUNDING');
  refuses(() => direct(row('PERP', withState(REQUIRED.PERP, 'FUNDING', { amount: undefined }))), 'NET_PARTIAL', 'FUNDING'); // 写 CHARGED 却没有金额：读不到，不补零
  assert.equal(direct(row('PERP', withState(REQUIRED.PERP, 'FUNDING', { amount: 0 }))).state, 'PASS');
  assert.equal(direct(row('SPOT', charged(REQUIRED.SPOT))).state, 'PASS');
});

test('其他不算收齐的写法：必收项写成 NOT_APPLICABLE、金额不是数、重复一项、没有 items、没写簿（A 股与加密需要）、市场没登记（HK）', () => {
  refuses(() => direct(row('CN_STOCK', withState(REQUIRED.CN_STOCK, 'STAMP_DUTY', { state: 'NOT_APPLICABLE', reasonCode: 'X' }))), 'NET_PARTIAL', 'STAMP_DUTY');
  refuses(() => direct(row('US', withState(REQUIRED.US, 'SEC_FEE', { amount: '1.5' }))), 'NET_PARTIAL', 'SEC_FEE');
  refuses(() => direct(row('US', withState(REQUIRED.US, 'SEC_FEE', { amount: -1 }))), 'NET_PARTIAL', 'SEC_FEE');
  refuses(() => direct(row('US', [...charged(REQUIRED.US), { item: 'SEC_FEE', state: 'CHARGED', amount: 2 }])), 'NET_PARTIAL', 'SEC_FEE');
  refuses(() => direct(row('US', undefined)), 'NET_PARTIAL');
  refuses(() => direct(row('US', [])), 'NET_PARTIAL');
  refuses(() => direct(row('CN_STOCK', charged(REQUIRED.CN_STOCK), { cost_book: undefined })), 'COVERAGE_BOOK_MISSING');
  refuses(() => direct(row('PERP', charged(REQUIRED.PERP), { cost_book: 'NO_SUCH_BOOK' })), 'COVERAGE_BOOK_MISSING');
  refuses(() => direct({ ...row('US', charged(REQUIRED.US)), config_label: 'T_HK', trial_id: idOf('T_HK'), rule_config_hash: trials.ruleConfigHash(arm('T_HK').rule_config), cost_breakdown: { model: OWN, commission_bps: 50, slippage_bps: 50, items: charged(REQUIRED.US) } }), 'NO_FLOOR');
});

test('条件项：个股簿红利税在 E1 关时不要求；行声明 cost_flags.E1 = true 时必须收（缺则 NET_PARTIAL）', () => {
  assert.equal(direct(row('CN_STOCK', charged(REQUIRED.CN_STOCK))).state, 'PASS');
  refuses(() => direct(row('CN_STOCK', charged(REQUIRED.CN_STOCK), { cost_flags: { E1: true } })), 'NET_PARTIAL', 'DIVIDEND_TAX');
  assert.equal(direct(row('CN_STOCK', charged([...REQUIRED.CN_STOCK, 'DIVIDEND_TAX']), { cost_flags: { E1: true } })).state, 'PASS');
});

test('完整的行：照旧过门，结果多一块 cost_coverage（登记 sha256、合同 sha256、生效时刻、检查行数）；佣金与滑点下限照旧（低于下限仍是 BELOW_FLOOR，先于覆盖面）', () => {
  const r = direct(row('PERP', charged(REQUIRED.PERP)));
  assert.equal(r.state, 'PASS');
  assert.deepEqual(r.cost_coverage, { registry_sha256: '44cdebd53a28d25c195690696bf99050573ef7f647d81c7b65a464c4b4607776', registry_revision: 2,
    contract_sha256: '1be6e0807995a9501e8b3393427c6367af47cd333e5bf89a0a95c03cc21e76fb', effective_from: CUTOFF, checked_runs: 1, registry_unknown_items: [] });
  const low = { ...row('PERP', charged(REQUIRED.PERP)), cost_breakdown: { model: OWN, commission_bps: 1, slippage_bps: 2, items: charged(REQUIRED.PERP) } };
  refuses(() => direct(low), 'BELOW_FLOOR');
  const lowAndPartial = { ...row('PERP', without(REQUIRED.PERP, 'FUNDING')), cost_breakdown: { model: OWN, commission_bps: 1, slippage_bps: 2, items: without(REQUIRED.PERP, 'FUNDING') } };
  refuses(() => direct(lowAndPartial), 'BELOW_FLOOR');
});

test('日期与版本开关：恰在 17:35:16 冻结的 K2 生效（含边界）；早一秒冻结的 K2 与旧行为逐字节相同（缺项照过、结果无 cost_coverage、写不写 items 结果一样）', () => {
  refuses(() => direct(row('US', without(REQUIRED.US, 'SEC_FEE')), { frozenAt: AFTER }), 'NET_PARTIAL', 'SEC_FEE');
  const partial = direct(row('US', without(REQUIRED.US, 'SEC_FEE')), { frozenAt: BEFORE });
  const noItems = direct(row('US', undefined), { frozenAt: BEFORE });
  const complete = direct(row('US', charged(REQUIRED.US)), { frozenAt: BEFORE });
  assert.equal(JSON.stringify(partial), JSON.stringify(noItems));
  assert.equal(JSON.stringify(partial), JSON.stringify(complete));
  assert.equal(partial.cost_coverage, undefined);
  assert.deepEqual(Object.keys(partial), ['applies', 'state', 'effective_from', 'k2_frozen_at', 'freeze', 'cost_gated_runs', 'signal_only_runs', 'other_runs', 'cost_models']);
  assert.deepEqual(partial.cost_models, [{ model_id: OWN, source: 'RUN_LOG_ROW', floor_market: 'US', commission_bps: 0, slippage_bps: 5 }]);
  // 旧门的范围判断不变：冻结早于附录 1 生效时刻的 K2 不过门（覆盖面也不读）
  assert.deepEqual(direct(row('US', undefined), { frozenAt: '2026-10-31T23:59:59+08:00' }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
});

test('开关可注入：测试里把 coverageFrom 提前，行为随之；默认读法（导入器那处调用不带选项）取合同冻结时刻', () => {
  refuses(() => direct(row('US', undefined), { frozenAt: '2026-11-10T10:00:00+08:00', opts: { coverageFrom: '2026-11-05T00:00:00+08:00' } }), 'NET_PARTIAL');
  assert.equal(direct(row('US', undefined), { frozenAt: '2026-11-10T10:00:00+08:00' }).cost_coverage, undefined);
  assert.equal(gate.COVERAGE_EFFECTIVE_FROM, CUTOFF);
});
