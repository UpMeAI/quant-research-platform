'use strict';
/**
 * G-MINE 骨架（研究框架修订 2026-11-16 草稿 ddeb2eea §4、§7.3 第 7 条；P0）：
 *   - 九项各是一个函数，作用于一个候选结果对象；DSR、PBO 的门槛从 services/trial-ledger/overfit.js 读，不另抄；
 *   - ★e 新门槛（IC、ICIR、单调性、衰减、边际）在一个常量块里，标 PENDING_FREEZE；冻结前门一律失败即关（MINE_THRESHOLDS_UNFROZEN）；
 *   - 九项各一个反例被拒；注入冻结门槛后全过的样例可升 RESEARCH，结果对象一个字都不改；
 *   - P0 不接任何导入器。
 * 全部是合成候选；不读行情，不写台账。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gate = require('../services/mining-gate');
const overfit = require('../services/trial-ledger/overfit');
const lib = require('../services/factor-library');
const mech = require('../services/research-mechanism-register');
const { FLOORS } = require('../services/cost-gate');

const ROOT = path.join(__dirname, '..');
const clone = (v) => JSON.parse(JSON.stringify(v));
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const MECH_ID = 'SEL.TEST_FACTOR.MINED';

/** 合成机制登记表：一个机制，没有先前结论（分诊 NORMAL_NO_PRIOR）；settled = 同机制同市场有一条功效 ≥ 80% 的不做。 */
function registerBytes({ settled = false } = {}) {
  const doc = {
    _comment: '合成夹具', contract: mech.CONTRACT,
    contract_ref: { path: mech.AMENDMENT.path, sha256: `${mech.AMENDMENT.sha_prefix}${'0'.repeat(64 - mech.AMENDMENT.sha_prefix.length)}`, state: mech.AMENDMENT.state,
      texts: mech.AMENDMENT.texts.map((t) => ({ id: t.id, path: t.path, sha256: `${t.sha_prefix}${'0'.repeat(56)}` })), ref_zh: '合成' },
    registered_at: '2026-11-16T23:00:00+08:00', registered_by: '测试',
    mechanisms: [{ mechanism_id: MECH_ID, title_zh: '合成挖掘机制', layer: 'SELECTION_TIMING', decision_point: 'SELECT', description_zh: '合成' }],
    entries: settled ? [{ item_id: 'T1', strategy_ref: 'ASHARE_V6_PAPER', market: 'CN_A', mechanism_ids: [MECH_ID], classified_by: 'test', reason_zh: '合成（§4.2）',
      conclusion: { verdict: 'DONT', strength_zh: '合成', power: { value: 0.9, ge_80: true, effect_zh: '合成', source_zh: '合成 §3' }, family_id: 'ASHARE_V6_PAPER',
        data_window: { from: '2024-01-02', to: '2026-09-30' }, sealed_on: '2026-10-01', seal_sha256: 'a'.repeat(64) } }] : [],
  };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
}

const FROZEN = deepFreeze({ ...clone(gate.THRESHOLDS), state: 'FROZEN',
  frozen_ref: { path: 'artifacts/coordinator/SYNTHETIC_TEST_FREEZE.md', sha256: 'e'.repeat(64), frozen_at: '2026-11-20T10:00:00+08:00' } });
const N_FAMILY = 412;
const ctx = (patch = {}) => ({ thresholds: FROZEN, familyTrialCount: N_FAMILY, registerBytes: registerBytes(), marks: [], ...patch });

/** 一个九项全过的合成候选（冻结门槛下）。 */
function candidate() {
  const sameMarket = lib.LIBRARY.factors.filter((f) => f.market === 'CN_A');
  return {
    candidate_id: 'R001-C017', factor_id: 'CN_A.MINED.R001_C017', market: 'CN_A', layer: 'SELECTION_CROSS_SECTION', origin: 'AI_MINED_GP',
    round_id: 'R001', family_id: 'CN_A.SELECTION_CROSS_SECTION.H20', horizon_trading_days: 20, status: 'CANDIDATE',
    overfit: { dsr: 0.97, n_trials: N_FAMILY, pbo: 0.31, pbo_scope: 'ROUND_CANDIDATE_SET' },
    holdout: { scored_at: '2026-12-01T10:00:00+08:00', ic_mean: 0.035, icir: 0.42, icir_non_overlapping: true, ic_double_horizon: 0.022,
      quintile_mean_returns: [-0.01, -0.002, 0.003, 0.008, 0.015] },
    net_of_cost: { long_only: true, top_fraction: 0.2, cost: { commission_bps: 2.5, slippage_bps: 10, stamp_duty_on_sell: true },
      benchmark: 'EQUAL_WEIGHT_UNIVERSE', annualized_excess: 0.031 },
    marginal: { book_factor_ids: gate.bookFactorIds(lib.LIBRARY, 'CN_A'), wfo_net_ir_delta: 0.05, intercept_t: 1.1 },
    correlation: { orthogonalised_against: [], pairs: sameMarket.map((f, i) => ({ factor_id: f.factor_id, rho_cross_section: 0.1 + i / 100, rho_returns: -0.2 })) },
    mechanism: { mechanism_id: MECH_ID, economic_logic_zh: '合成：经济逻辑', failure_mode_zh: '合成：预期失效方式', written_at: '2026-11-30T09:00:00+08:00' },
    verdict: { label: '合成结论', note: '门不改写这一块' },
  };
}
const itemOf = (result, key) => result.items.find((x) => x.key === key);

// ── 常量来源与冻结状态 ────────────────────────────────────────────────────────

test('DSR、PBO 的门槛读 overfit.js 的常量，不另抄；★e 门槛在一个块里，标 PENDING_FREEZE', () => {
  assert.equal(gate.DSR_MIN, overfit.DSR_MIN);
  assert.equal(gate.PBO_MAX, overfit.PBO_MAX);
  const src = fs.readFileSync(path.join(ROOT, 'services', 'mining-gate', 'index.js'), 'utf8');
  assert.match(src, /require\('\.\.\/trial-ledger\/overfit'\)/);
  assert.doesNotMatch(src, /0\.95/);
  assert.equal(gate.THRESHOLDS.state, 'PENDING_FREEZE');
  assert.ok(Object.isFrozen(gate.THRESHOLDS));
  for (const k of ['ic_mean_min', 'icir_min', 'monotonicity_min', 'decay_ratio_min', 'marginal_ir_delta_min', 'marginal_intercept_t_min']) {
    assert.equal(typeof gate.THRESHOLDS[k], 'number', k);
  }
  assert.deepEqual([gate.THRESHOLDS.ic_mean_min, gate.THRESHOLDS.icir_min, gate.THRESHOLDS.monotonicity_min, gate.THRESHOLDS.decay_ratio_min],
    [0.02, 0.3, 0.9, 0.5]);
  assert.equal(gate.THRESHOLDS.dsr_min, undefined);
  assert.equal(gate.THRESHOLDS.pbo_max, undefined);
  assert.equal(gate.ITEMS.length, 9);
  assert.equal(new Set(gate.ITEMS.map((i) => i.key)).size, 9);
});

test('冻结前失败即关：默认门槛下，连全过的样例也被拒（MINE_THRESHOLDS_UNFROZEN），不跑任何一项', () => {
  const c = candidate();
  const r = gate.evaluate(c, ctx({ thresholds: undefined }));
  assert.equal(r.pass, false);
  assert.deepEqual(r.codes, ['MINE_THRESHOLDS_UNFROZEN']);
  assert.deepEqual(r.items, []);
  assert.equal(r.eligible_status, null);
  assert.equal(gate.evaluate(c, ctx({ thresholds: gate.THRESHOLDS })).codes[0], 'MINE_THRESHOLDS_UNFROZEN');
  // 写了 FROZEN 却没有冻结页 sha256、或某个数不是有限数：同样拒绝
  assert.equal(gate.evaluate(c, ctx({ thresholds: { ...FROZEN, frozen_ref: null } })).codes[0], 'MINE_THRESHOLDS_INVALID');
  assert.equal(gate.evaluate(c, ctx({ thresholds: { ...FROZEN, icir_min: '0.3' } })).codes[0], 'MINE_THRESHOLDS_INVALID');
  // 单项函数也不在冻结前判 ★e 项
  assert.deepEqual(gate.checkIcIcir(c, ctx({ thresholds: gate.THRESHOLDS })).codes, ['MINE_THRESHOLDS_UNFROZEN']);
});

test('注入冻结门槛后全过：九项全过，可升 RESEARCH；结果对象一个字都不改（深冻结的输入也照跑）', () => {
  const c = candidate();
  const snapshot = clone(c);
  const r = gate.evaluate(deepFreeze(c), ctx());
  assert.deepEqual(r.codes, [], JSON.stringify(r.items.filter((i) => !i.pass)));
  assert.equal(r.pass, true);
  assert.equal(r.eligible_status, 'RESEARCH');
  assert.equal(r.items.length, 9);
  assert.ok(r.items.every((i) => i.pass));
  assert.deepEqual(c, snapshot);
  assert.equal(c.status, 'CANDIDATE');
  assert.equal(r.production_effect, 'NONE');
  assert.equal(r.thresholds.state, 'FROZEN');
  assert.equal(r.thresholds.frozen_ref.sha256, 'e'.repeat(64));
});

// ── 九项各一个反例 ────────────────────────────────────────────────────────────

const COUNTER = [
  ['DSR', 'MINE_DSR_BELOW_MIN', (c) => { c.overfit.dsr = 0.949; }],
  ['DSR', 'MINE_DSR_N_NOT_CUMULATIVE', (c) => { c.overfit.n_trials = 200; }],
  ['DSR', 'MINE_DSR_UNKNOWN', (c) => { c.overfit.dsr = { value: 'UNKNOWN', reason: 'T_LT_24' }; }],
  ['PBO', 'MINE_PBO_ABOVE_MAX', (c) => { c.overfit.pbo = 0.51; }],
  ['PBO', 'MINE_PBO_SCOPE', (c) => { c.overfit.pbo_scope = 'SINGLE_CONFIG'; }],
  ['IC_ICIR', 'MINE_IC_BELOW_MIN', (c) => { c.holdout.ic_mean = 0.019; c.holdout.ic_double_horizon = 0.019; }],
  ['IC_ICIR', 'MINE_ICIR_BELOW_MIN', (c) => { c.holdout.icir = 0.29; }],
  ['IC_ICIR', 'MINE_ICIR_OVERLAPPING', (c) => { c.holdout.icir_non_overlapping = false; }],
  ['MONOTONICITY', 'MINE_MONOTONICITY_BELOW_MIN', (c) => { c.holdout.quintile_mean_returns = [-0.01, 0.008, 0.003, -0.002, 0.015]; }],
  ['MONOTONICITY', 'MINE_MONOTONICITY_INPUT', (c) => { c.holdout.quintile_mean_returns = [0.01, 0.02, 0.03, 0.04]; }],
  ['DECAY', 'MINE_DECAY_BELOW_HALF', (c) => { c.holdout.ic_double_horizon = 0.0174; }],
  ['NET_OF_COST', 'MINE_NET_EXCESS_NOT_POSITIVE', (c) => { c.net_of_cost.annualized_excess = 0; }],
  ['NET_OF_COST', 'MINE_NET_COST_BELOW_FLOOR', (c) => { c.net_of_cost.cost.slippage_bps = 5; }],
  ['NET_OF_COST', 'MINE_NET_COST_BELOW_FLOOR', (c) => { c.net_of_cost.cost.stamp_duty_on_sell = false; }],
  ['NET_OF_COST', 'MINE_NET_SCOPE', (c) => { c.net_of_cost.long_only = false; }],
  ['MARGINAL', 'MINE_MARGINAL_NOT_POSITIVE', (c) => { c.marginal.wfo_net_ir_delta = 0; c.marginal.intercept_t = 1.99; }],
  ['MARGINAL', 'MINE_MARGINAL_BOOK_MISMATCH', (c) => { c.marginal.book_factor_ids = c.marginal.book_factor_ids.slice(1); }],
  ['CORRELATION', 'MINE_CORRELATION_ABOVE_MAX', (c) => { c.correlation.pairs[0].rho_cross_section = 0.71; }],
  ['CORRELATION', 'MINE_CORRELATION_LIBRARY_INCOMPLETE', (c) => { c.correlation.pairs.pop(); }],
  ['CORRELATION', 'MINE_CORRELATION_UNKNOWN', (c) => { c.correlation.pairs[1].rho_returns = 'UNKNOWN'; }],
  ['MECHANISM', 'MINE_MECHANISM_UNKNOWN', (c) => { c.mechanism.mechanism_id = 'SEL.NOPE.NOPE'; }],
  ['MECHANISM', 'MINE_MECHANISM_FIELDS', (c) => { c.mechanism.failure_mode_zh = ''; }],
  ['MECHANISM', 'MINE_MECHANISM_AFTER_HOLDOUT', (c) => { c.mechanism.written_at = '2026-12-01T10:00:01+08:00'; }],
];

for (const [key, code, mutate] of COUNTER) {
  test(`G-MINE ${key} 反例被拒：${code}`, () => {
    const c = candidate(); mutate(c);
    const snapshot = clone(c);
    const r = gate.evaluate(c, ctx());
    assert.equal(r.pass, false);
    assert.equal(r.eligible_status, null);
    const item = itemOf(r, key);
    assert.equal(item.pass, false);
    assert.ok(item.codes.includes(code), `${key}: ${JSON.stringify(item.codes)}`);
    assert.ok(r.codes.includes(code));
    // 只有被改的这一项失败
    assert.deepEqual(r.items.filter((i) => !i.pass).map((i) => i.key), [key]);
    assert.deepEqual(c, snapshot);
  });
}

test('G-MINE MECHANISM 反例被拒：同机制同市场已判不做（G-MECH 分诊 NOT_DO_SETTLED）', () => {
  const r = gate.evaluate(candidate(), ctx({ registerBytes: registerBytes({ settled: true }) }));
  assert.equal(r.pass, false);
  assert.ok(itemOf(r, 'MECHANISM').codes.includes('MINE_MECHANISM_NOT_DO_SETTLED'));
});

test('G-MINE CORRELATION：正交化过的版本，冲突的已有因子都在已正交化名单里时通过', () => {
  const c = candidate();
  c.correlation.pairs[0].rho_cross_section = 0.9;
  c.correlation.orthogonalised_against = [c.correlation.pairs[0].factor_id];
  c.correlation.new_attempt = true;
  assert.equal(itemOf(gate.evaluate(c, ctx()), 'CORRELATION').pass, true);
  c.correlation.new_attempt = false;
  assert.ok(itemOf(gate.evaluate(c, ctx()), 'CORRELATION').codes.includes('MINE_CORRELATION_ORTHOGONALISED_NOT_COUNTED'));
});

test('G-MINE MARGINAL：净信息比提高或截距 t ≥ 2，任一即过', () => {
  const c = candidate(); c.marginal.wfo_net_ir_delta = -0.01; c.marginal.intercept_t = 2;
  assert.equal(itemOf(gate.evaluate(c, ctx()), 'MARGINAL').pass, true);
});

test('成本下限读 cost-gate 的 FLOORS（CN_A 佣金 2.5、滑点 10 bps），不另抄', () => {
  assert.equal(FLOORS.CN_A.commission_bps_min, 2.5);
  assert.equal(FLOORS.CN_A.slippage_bps_min, 10);
  const c = candidate(); c.net_of_cost.cost.commission_bps = 2.4;
  assert.ok(itemOf(gate.evaluate(c, ctx()), 'NET_OF_COST').codes.includes('MINE_NET_COST_BELOW_FLOOR'));
});

test('P0 不接任何导入器：除测试外没有模块 require mining-gate', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'var', '.git', 'tests'].includes(e.name)) walk(p); }
      else if (e.name.endsWith('.js') && !p.includes(`${path.sep}mining-gate${path.sep}`) && /mining-gate/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p));
    }
  };
  for (const d of ['services', 'apps', 'packages', 'adapters', 'tools']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  assert.deepEqual(hits, []);
});
