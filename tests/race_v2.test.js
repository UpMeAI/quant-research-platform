'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');

const v2 = require('../services/race-orchestrator/v2');
const races = require('../services/race-orchestrator');
const trials = require('../services/trial-ledger');
const overfit = require('../services/trial-ledger/overfit');
const costGate = require('../services/cost-gate');
const { validateRecord } = require('../schemas');

/**
 * RACE_V2（研究框架修订 2026-11-16 §4，签字 fd22876f / 39f8c17c，★g）：先红后绿，只用合成样本与合成台账。
 * 一个市场一个榜、榜内跨账本、按层分区、同引擎同窗口同成本（G-COST）、本市场 N 的 DSR、分区 CSCV PBO、风控层 BHY、入场线、淘汰线、最多 2 名晋级、清单冻结。
 */
const AUTH = 'TEST_RACE_V2_AUTHORITY';
const FAMILY = 'CN_A_ACCOUNT';
const ENGINE = Object.freeze({ id: 'SYNTH_REPLAY', version: '1.0.0' });
const WINDOW = Object.freeze({ from: '2023-01-01', to: '2025-12-31' });
const COST = Object.freeze({ cost_model_ref: 'SYNTH_CN_COSTS_V1', cost_breakdown: { commission_bps: 2.5, slippage_bps: 10 } });
const EV = 'e'.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, code);

/** 36 个月 × 每月 20 个交易日（YYYY-MM-01 … YYYY-MM-20）。 */
const DAYS = (() => { const out = []; for (let m = 0; m < 36; m += 1) { const y = 2023 + Math.floor(m / 12); const mm = String((m % 12) + 1).padStart(2, '0'); for (let d = 1; d <= 20; d += 1) out.push(`${y}-${mm}-${String(d).padStart(2, '0')}`); } return out; })();
const series = (f) => DAYS.map((date, i) => ({ date, logret: f(i, date) }));
const noise = (seed, amp) => { const r = overfit.mulberry32(seed); return () => (r() - 0.5) * 2 * amp; };
/** 冠军：正漂移加一个慢周期（有像样的回撤）。 */
const CHAMP = (() => { const n = noise(7, 0.004); return series((i) => 0.0003 + 0.01 * Math.sin((2 * Math.PI * i) / 120) + n()); })();
/** 挑战者 = 冠军 + 月度配对差 (mu ± 0.01 隔月交替) / 20 摊到每天：月度 ŜR ≈ mu / 0.01（偏度 0、峰度 1），各块排名持续，PBO 低。 */
const ALT = (m) => (m % 2 ? -0.01 : 0.01);
const challengerOf = (mu) => CHAMP.map((x, i) => ({ date: x.date, logret: x.logret + (mu + ALT(Math.floor(i / 20))) / 20 }));

const idOf = (study, label, family = FAMILY) => trials.trialIdOf({ family_id: family, study_ref: study, config_label: label });
const entrant = (study, label, patch = {}) => ({ entrant_id: label, trial_id: idOf(study, label, patch.family || FAMILY), market: 'CN_A', layer: 'SELECTION_TIMING', book_ref: 'STOCK_BOOK',
  origin: 'HUMAN', k2: { sha256: 'a'.repeat(64), frozen_at: '2026-11-17T08:00:00+08:00' }, causality: { state: 'PASS', evidence_sha256: EV }, ...patch });

/** 清单（RACE_MANIFEST_V1）；labels 是挑战者名；patch 覆盖清单字段。 */
function manifestOf({ study = 'R2-SYNTH', labels = ['C1', 'C2', 'C3'], partition = 'SELECTION_TIMING', market = 'CN_A', patch = {}, challengerPatch = {} } = {}) {
  const layer = partition;
  return {
    schema: 'RACE_MANIFEST_V1', race_ref: study, market, partition, periods_per_year: 242, engine: ENGINE, window: WINDOW, cost_model: COST,
    primary_metric: v2.PRIMARY[partition],
    guardrails: partition === 'RISK' ? { bhy_alpha: v2.DEFAULTS.RISK.bhy_alpha } : { ...v2.DEFAULTS.SELECTION_TIMING },
    pbo_max: v2.DEFAULTS.pbo_max, promotion_slots: 2,
    champion: entrant(study, 'CHAMP', { market, layer, origin: undefined, k2: undefined, causality: undefined, book_ref: 'ACCOUNT' }),
    challengers: labels.map((l) => entrant(study, l, { market, layer, ...(partition === 'RISK' ? { return_loss_max: 0.1 } : {}), ...(challengerPatch[l] || {}) })),
    ...patch,
  };
}
/** 冻结：清单字节、冻结页字节（原文写出清单 sha256、RACE_MANIFEST_V1、FROZEN）。 */
function frozen(m, { pageText } = {}) {
  const bytes = Buffer.from(JSON.stringify(m));
  const msha = sha(bytes);
  const page = Buffer.from(pageText !== undefined ? pageText : `# 赛马清单冻结页（合成）\n\nRACE_MANIFEST_V1 ${msha} FROZEN\n`);
  return { manifestBytes: bytes, msha, freeze: { path: 'artifacts/coordinator/SYNTH_RACE_FREEZE_1.md', sha256: sha(page), bytes: page } };
}
/** 按清单预登记参赛者（k2_sha256 = 清单 sha；冠军 BASELINE、挑战者 VERDICT_ARM；阶段 BOOK）。 */
function register(m, msha, { market = 'CN_A', overrides = {} } = {}) {
  const all = [m.champion, ...m.challengers];
  return trials.register(all.map((e) => ({ family_id: FAMILY, market, study_ref: m.race_ref, config_label: e.entrant_id, k2_sha256: msha, stage: 'BOOK',
    role: e === m.champion ? 'BASELINE' : 'VERDICT_ARM', rule_config: { entrant: e.entrant_id, study: m.race_ref }, ...(overrides[e.entrant_id] || {}) })),
  { registeredBy: AUTH, registeredAt: '2026-11-17T08:30:00+08:00' });
}
/** 本市场已有的账本级试验（给 DSR 的 V 至少 5 个已知 ŜR）。 */
function background(market = 'CN_A', family = 'CN_A_BG', n = 5) {
  const specs = Array.from({ length: n }, (_, i) => ({ family_id: family, market, study_ref: 'BG', config_label: `BG${i}`, k2_sha256: 'b'.repeat(64), stage: 'BOOK', role: 'VERDICT_ARM', rule_config: { bg: i, family } }));
  trials.register(specs, { registeredBy: AUTH, registeredAt: '2026-11-01T00:00:00+08:00' });
  specs.forEach((s, i) => trials.recordResult(trials.trialIdOf(s), { window: { from: '2024-01-01', to: '2026-06-30' }, metrics: { n_trades: 40 },
    months: Array.from({ length: 30 }, (_, k) => ({ month: `${2024 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`, d: ALT(k) + 0.009 + 0.0005 * i })), study_verdict: '做' },
  { registeredBy: AUTH, registeredAt: '2026-11-02T00:00:00+08:00' }));
}
const result = (daily, patch = {}) => ({ engine: ENGINE, window: WINDOW, cost_model_ref: COST.cost_model_ref, daily, participation_max: 0.05, ...patch });
/** 开赛并收赛（daily 是各挑战者的日序列）。 */
function run(m, daily, { champ = CHAMP, resultPatch = {}, market = 'CN_A', library } = {}) {
  const f = frozen(m);
  register(m, f.msha, { market });
  const open = v2.openRace({ ...f, ...(library ? { library } : {}) });
  const ref = { cost_model_ref: m.cost_model.cost_model_ref };
  const closed = v2.closeRace(open.race_id, { champion: result(champ, ref), challengers: Object.fromEntries(Object.entries(daily).map(([k, s]) => [k, result(s, { ...ref, ...(resultPatch[k] || {}) })])) });
  return { open, closed, outcome: closed.outcome };
}
const THREE = () => ({ C1: challengerOf(0.009), C2: challengerOf(0.010), C3: challengerOf(0.011) });

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  for (const f of [trials.TRIALS(), v2.LEDGER(), races.RACES_LEDGER(), races.PAIRED_SAMPLES_LEDGER()]) { try { fs.rmSync(f); } catch { /* 首次 */ } }
});

test('常量：签字文本与签字页的 sha、§4.4 的默认值（DSR 0.95、回撤 1.2 倍、参与率 10%、BHY 5%、PBO 0.5、最多 2 名）、三个市场、两个分区', () => {
  assert.equal(v2.SIGNED.text.sha256, 'fd22876f6a690b52b07429f333d2545d8fedb5d285dccd3fd3f5a1ecd9f00c80');
  assert.equal(v2.SIGNED.signature.sha256, '39f8c17cd569f8eadf7bd18102997cc19b421959aec36fae98c1b1a20fbcd3fb');
  assert.deepEqual([v2.DEFAULTS.SELECTION_TIMING, v2.DEFAULTS.RISK, v2.DEFAULTS.pbo_max, v2.DEFAULTS.promotion_slots_max],
    [{ dsr_min: 0.95, mdd_max_ratio: 1.2, participation_cap: 0.1 }, { bhy_alpha: 0.05 }, 0.5, 2]);
  assert.deepEqual([[...v2.MARKETS], [...v2.PARTITIONS]], [['CN_A', 'US', 'CRYPTO'], ['SELECTION_TIMING', 'RISK']]);
  assert.equal(validateRecord(manifestOf(), 'RACE_MANIFEST_V1').ok, true);
});

test('清单未冻结 → 拒绝：没有冻结页、冻结页 sha 对不上、冻结页原文没写清单 sha', () => {
  const m = manifestOf();
  const f = frozen(m);
  register(m, f.msha);
  refuses(() => v2.openRace({ manifestBytes: f.manifestBytes }), 'RACE_MANIFEST_NOT_FROZEN');
  refuses(() => v2.openRace({ ...f, freeze: { ...f.freeze, sha256: 'c'.repeat(64) } }), 'RACE_MANIFEST_NOT_FROZEN');
  const notStated = frozen(m, { pageText: 'RACE_MANIFEST_V1 FROZEN（没写清单 sha）\n' });
  refuses(() => v2.openRace(notStated), 'RACE_MANIFEST_NOT_FROZEN');
  assert.equal(v2.openRace(f).status, 'OPEN');
});

test('跨市场的参赛者 → 拒绝（清单里的市场、台账行的市场、因子库里因子的市场）；同一市场内跨账本 → 允许', () => {
  refuses(() => { const m = manifestOf({ study: 'X1', challengerPatch: { C2: { market: 'US' } } }); const f = frozen(m); v2.openRace(f); }, 'RACE_CROSS_MARKET');
  const m = manifestOf({ study: 'X2' });
  const f = frozen(m);
  register(m, f.msha, { overrides: { C1: { market: 'CRYPTO_USDM_PERP' } } });
  refuses(() => v2.openRace(f), 'RACE_CROSS_MARKET');
  const lib = { factors: [{ factor_id: 'FCT-US-1', market: 'US_EQUITY', status: 'RESEARCH' }] };
  const mf = manifestOf({ study: 'X3', challengerPatch: { C1: { origin: 'FACTOR', factor_ref: 'FCT-US-1', k2: undefined } } });
  const ff = frozen(mf);
  register(mf, ff.msha);
  refuses(() => v2.openRace({ ...ff, library: lib }), 'RACE_CROSS_MARKET');
  // 跨账本：指数簿与个股簿的候选同上 A 股榜，各自和冠军在账户层配对
  background();
  const cross = manifestOf({ study: 'X4', challengerPatch: { C1: { book_ref: 'INDEX_BOOK' }, C2: { book_ref: 'STOCK_BOOK' }, C3: { book_ref: 'STOCK_BOOK' } } });
  const { outcome } = run(cross, THREE());
  assert.equal(outcome.state, 'RANKED');
  assert.deepEqual(outcome.entrants.map((e) => e.book_ref), ['INDEX_BOOK', 'STOCK_BOOK', 'STOCK_BOOK']);
  assert.ok(outcome.promoted.includes('C3'));
});

test('同一分区里混入别的层 → 拒绝', () => {
  const m = manifestOf({ challengerPatch: { C2: { layer: 'RISK' } } });
  refuses(() => v2.openRace(frozen(m)), 'RACE_MIXED_LAYER');
});

test('不计成本的参赛者 → 拒绝（G-COST：目录里的毛收益模型、自报低于下限）；在下限上的自报成本 → 允许；结果的引擎、窗口、成本模型与清单不一致 → 拒绝', () => {
  const gross = manifestOf({ study: 'G1', patch: { cost_model: { cost_model_ref: 'REPLAY_CORE_COSTS_NONE(CLOSE_MARK)' } } });
  const fg = frozen(gross); register(gross, fg.msha);
  refuses(() => v2.openRace(fg), 'COST_MODEL_GROSS_VERDICT');
  const below = manifestOf({ study: 'G2', patch: { cost_model: { cost_model_ref: 'SYNTH_CN_COSTS_V1', cost_breakdown: { commission_bps: 2.5, slippage_bps: 9 } } } });
  const fb = frozen(below); register(below, fb.msha);
  refuses(() => v2.openRace(fb), 'COST_MODEL_BELOW_FLOOR');
  const ok = manifestOf({ study: 'G3' });
  const fo = frozen(ok); register(ok, fo.msha);
  const open = v2.openRace(fo);
  assert.deepEqual(open.cost_model, { model_id: 'SYNTH_CN_COSTS_V1', source: 'RUN_LOG_ROW', floor_market: 'CN_A', commission_bps: 2.5, slippage_bps: 10 });
  const close = (patch) => v2.closeRace(open.race_id, { champion: result(CHAMP), challengers: { ...Object.fromEntries(Object.entries(THREE()).map(([k, s]) => [k, result(s)])), C2: result(THREE().C2, patch) } });
  refuses(() => close({ cost_model_ref: 'REPLAY_CORE_PROFILE_COSTS' }), 'RACE_COST_MODEL_MISMATCH');
  refuses(() => close({ engine: { id: 'OTHER', version: '1.0.0' } }), 'RACE_ENGINE_MISMATCH');
  refuses(() => close({ window: { from: '2023-01-01', to: '2024-12-31' } }), 'RACE_WINDOW_MISMATCH');
  refuses(() => close({ daily: THREE().C2.slice(1) }), 'RACE_PAIRED_SAMPLE_MISSING');
});

test('入场线：因子要在库里是 RESEARCH；人工候选要有冻结 K2；都要声明 G-CAUSAL（不适用只认 RISK_K_OR_ACCOUNT_LAYER）；台账行要按清单预登记', () => {
  const lib = { factors: [{ factor_id: 'FCT-CN-1', market: 'CN_A', status: 'CANDIDATE' }, { factor_id: 'FCT-CN-2', market: 'CN_A', status: 'RESEARCH' }] };
  const open = (study, patch, opts = {}) => { const m = manifestOf({ study, challengerPatch: { C1: patch } }); const f = frozen(m); register(m, f.msha, opts); return v2.openRace({ ...f, library: lib }); };
  refuses(() => open('E1', { origin: 'FACTOR', factor_ref: 'FCT-CN-1', k2: undefined }), 'RACE_ENTRY_FACTOR_NOT_RESEARCH');
  assert.equal(open('E2', { origin: 'FACTOR', factor_ref: 'FCT-CN-2', k2: undefined }).entry[0].status, 'RESEARCH');
  refuses(() => open('E3', { k2: undefined }), 'RACE_ENTRY_K2_NOT_FROZEN');
  refuses(() => open('E4', { causality: undefined }), 'RACE_ENTRY_CAUSALITY');
  refuses(() => open('E5', { causality: { state: 'NOT_APPLICABLE', not_applicable_code: 'ABLATION' } }), 'RACE_ENTRY_CAUSALITY');
  assert.equal(open('E6', { causality: { state: 'NOT_APPLICABLE', not_applicable_code: 'RISK_K_OR_ACCOUNT_LAYER' } }).status, 'OPEN');
  const m = manifestOf({ study: 'E7' }); const f = frozen(m);
  refuses(() => v2.openRace({ ...f, library: lib }), 'RACE_LEDGER_ROW_MISSING');
  register(m, 'd'.repeat(64));
  refuses(() => v2.openRace({ ...f, library: lib }), 'RACE_LEDGER_ROW_INVALID'); // 台账行的 k2_sha256 不是这份清单
  const m8 = manifestOf({ study: 'E8' }); const f8 = frozen(m8);
  register(m8, f8.msha, { overrides: { CHAMP: { role: 'VERDICT_ARM' } } });
  refuses(() => v2.openRace({ ...f8, library: lib }), 'RACE_LEDGER_ROW_INVALID');
});

test('DSR 用本市场自己的累计 N：同一个挑战者按 A 股 N 过 0.95，按 A 股加加密合并的 N 就不过（反例）；结果记下所用的 N', () => {
  background('CN_A', 'CN_A_BG', 5);
  trials.register(Array.from({ length: 300 }, (_, i) => ({ family_id: 'CRYPTO_BG', market: 'CRYPTO_USDM_PERP', study_ref: 'BGX', config_label: `X${i}`, k2_sha256: 'c'.repeat(64), stage: 'BOOK', role: 'VERDICT_ARM', rule_config: { x: i } })),
    { registeredBy: AUTH, registeredAt: '2026-11-01T00:00:00+08:00' });
  const nCn = 5 + 1; // 5 个背景试验 + 本场 1 个挑战者（冠军是 BASELINE，不计入 N）
  const nPooled = nCn + 300;
  const bgSr = trials.marketSharpes('CN_A', { marketOf: costGate.floorMarketOf }).map((s) => s.sr);
  // 月度配对差 d_m = μ ± σ 交替（偏度 0、峰度 1）：扫 ŜR，取按本市场 N 过、按合并 N 不过的第一个
  const monthsOf = (srTarget) => Array.from({ length: 36 }, (_, k) => 0.01 * srTarget + ALT(k));
  const dsrOf = (d, N) => overfit.deflatedSharpe({ d, N, familySharpes: [...bgSr, overfit.moments(d).sr] }).dsr;
  const band = [];
  for (let s = 0.2; s < 2; s += 0.01) { const d = monthsOf(s); if (dsrOf(d, nCn) >= 0.95 && dsrOf(d, nPooled) < 0.95) band.push(s); }
  assert.ok(band.length >= 3, '找得到落在两个 N 之间的 ŜR');
  const target = band[Math.floor(band.length / 2)]; // 取区间中间，避开边界上的浮点误差
  const d = monthsOf(target);
  const daily = { C1: CHAMP.map((x, i) => ({ date: x.date, logret: x.logret + d[Math.floor(i / 20)] / 20 })) };
  const { outcome } = run(manifestOf({ study: 'N1', labels: ['C1'] }), daily);
  const e = outcome.entrants[0];
  assert.equal(e.dsr_n, nCn);
  assert.notEqual(e.dsr_n, trials.countMarket('CRYPTO', { marketOf: costGate.floorMarketOf }).n_raw + nCn);
  assert.ok(e.dsr >= 0.95, `本市场 N 下 DSR ${e.dsr}`);
  assert.equal(e.reasons.includes('DSR_BELOW_MIN'), false);
  assert.ok(dsrOf(d, nPooled) < 0.95, '合并 N 会把它淘汰（反例）');
  assert.deepEqual(outcome.promoted, ['C1']);
});

test('分区 PBO > 0.5 → INCONCLUSIVE，谁都不晋级', () => {
  background();
  // 每列在 16 块上的和为 0（整数频率的余弦）：训练段最好的列在检验段必然最差 → PBO ≈ 1
  const block = (i) => Math.floor(i / 45);
  const wave = (c) => (i) => ((0.001 * (c + 1)) * Math.cos((2 * Math.PI * (c + 1) * block(i)) / 16 + c * 0.7)) / 45;
  const champ = series(wave(0));
  const daily = { C1: series(wave(1)), C2: series(wave(2)), C3: series(wave(3)) };
  const { outcome } = run(manifestOf({ study: 'P1' }), daily, { champ });
  assert.ok(outcome.pbo.value > 0.5, `PBO ${outcome.pbo.value}`);
  assert.equal(outcome.state, 'INCONCLUSIVE');
  assert.deepEqual(outcome.promoted, []);
});

test('每场最多 2 名晋级：四个挑战者都过淘汰线，只按配对 g 取前 2；清单写 3 个名额 → 拒绝', () => {
  background();
  const daily = { ...THREE(), C4: challengerOf(0.012) };
  const { outcome } = run(manifestOf({ study: 'S1', labels: ['C1', 'C2', 'C3', 'C4'] }), daily);
  assert.equal(outcome.state, 'RANKED');
  assert.deepEqual(outcome.ranking, ['C4', 'C3', 'C2', 'C1']);
  assert.deepEqual(outcome.promoted, ['C4', 'C3']);
  refuses(() => v2.openRace(frozen(manifestOf({ study: 'S2', patch: { promotion_slots: 3 } }))), 'RACE_PROMOTION_SLOTS_INVALID');
});

test('选股择时层的淘汰线：不胜冠军、回撤超过冠军 1.2 倍、换手扣成本后超额 ≤ 0、参与率超过上限，各记负结果', () => {
  background();
  const worse = challengerOf(-0.004);
  const deep = CHAMP.map((x, i) => ({ date: x.date, logret: x.logret * 1.8 + 0.0006 }));
  const daily = { C1: worse, C2: deep, C3: challengerOf(0.011) };
  const { outcome } = run(manifestOf({ study: 'L1' }), daily, { resultPatch: { C3: { participation_max: 0.12 } } });
  const by = Object.fromEntries(outcome.entrants.map((e) => [e.entrant_id, e]));
  assert.ok(by.C1.reasons.includes('NOT_BEATING_CHAMPION') && by.C1.reasons.includes('EXCESS_NOT_POSITIVE'));
  assert.ok(by.C2.reasons.includes('MDD_OVER_RATIO'), JSON.stringify(by.C2.reasons));
  assert.ok(by.C3.reasons.includes('PARTICIPATION_OVER_CAP'), JSON.stringify(by.C3.reasons));
  assert.deepEqual(outcome.promoted, []);
  assert.deepEqual(outcome.negative_results.sort(), ['C1', 'C2', 'C3']);
  assert.ok(Number.isFinite(by.C3.tail_cvar5) && Number.isFinite(by.C3.mdd)); // 另报回撤和尾部亏损
});

test('风控层用 BHY，不用 DSR：三项都不劣于冠军才往下看，收益损失是约束，BHY 校正后不显著的淘汰；同一市场已关闭的风控分区一起校正，不跨市场', () => {
  // 冠军：正漂移，每 60 天一次 −3% 的冲击；挑战者是冠军的缩放（敞口 0.6 / 0.7 / 0.8），回撤、最差月、CVaR 都更好
  const champ = series((i) => 0.001 + (i % 60 === 30 ? -0.03 : 0));
  const scaled = (k) => champ.map((x) => ({ date: x.date, logret: x.logret * k }));
  const m = manifestOf({ study: 'K1', partition: 'RISK' });
  const resultPatch = { C1: { p_one_sided: 0.001, p_method_ref: 'K2 §4（合成）' }, C2: { p_one_sided: 0.02, p_method_ref: 'K2 §4（合成）' }, C3: { p_one_sided: 0.04, p_method_ref: 'K2 §4（合成）' } };
  const { outcome } = run(m, { C1: scaled(0.6), C2: scaled(0.7), C3: scaled(0.8) }, { champ, resultPatch });
  const by = Object.fromEntries(outcome.entrants.map((e) => [e.entrant_id, e]));
  for (const e of outcome.entrants) {
    assert.equal('dsr' in e, false);
    assert.equal(e.bhy_m, 3);
    assert.ok(e.cvar5_improvement > 0 && e.mdd < e.champion.mdd && e.worst_month > e.champion.worst_month);
  }
  assert.deepEqual(outcome.entrants.map((e) => Number(e.p_bhy.toFixed(4))), overfit.bhy([0.001, 0.02, 0.04]).map((p) => Number(p.toFixed(4))));
  assert.deepEqual([by.C1.reasons, by.C2.reasons, by.C3.reasons], [[], ['BHY_NOT_SIGNIFICANT'], ['BHY_NOT_SIGNIFICANT']]); // 原始 p 都 < 0.05
  assert.deepEqual(outcome.promoted, ['C1']);
  // 三项里有一项劣于冠军、或收益损失超过约束 → 淘汰
  const tail = scaled(0.6).map((x, i) => (i === 100 ? { ...x, logret: -0.05 } : x));
  const m2 = manifestOf({ study: 'K2', partition: 'RISK', challengerPatch: { C2: { return_loss_max: 0.01 } } });
  const o2 = run(m2, { C1: tail, C2: scaled(0.5), C3: scaled(0.7) }, { champ, resultPatch }).outcome;
  const b2 = Object.fromEntries(o2.entrants.map((e) => [e.entrant_id, e]));
  assert.ok(b2.C1.reasons.includes('WORSE_CVAR5') || b2.C1.reasons.includes('WORSE_WORST_MONTH'), JSON.stringify(b2.C1.reasons));
  assert.ok(b2.C2.reasons.includes('RETURN_LOSS_OVER_CONSTRAINT'));
  assert.equal(b2.C1.bhy_m, 6); // 同一市场第一场的 3 个 p 一起校正
  // 加密的风控分区不和 A 股的一起校正
  const mc = manifestOf({ study: 'K3', partition: 'RISK', market: 'CRYPTO', patch: { cost_model: { cost_model_ref: 'REPLAY_CORE_PROFILE_COSTS' } } });
  const oc = run(mc, { C1: scaled(0.6), C2: scaled(0.7), C3: scaled(0.8) }, { champ, resultPatch, market: 'CRYPTO_USDM_PERP' });
  assert.equal(oc.outcome.entrants[0].bhy_m, 3);
  assert.equal(oc.open.cost_model.source, 'adapters/crypto-replay-core');
});

test('台账：RACE_V2 只写 races_v2.jsonl（OPEN、CLOSED 两行都过 schema），旧赛马台账不碰；按 N 计数的旧函数 count 输出不变', () => {
  background();
  const { open, closed } = run(manifestOf({ study: 'T1' }), THREE());
  assert.equal(validateRecord(open, 'RACE_V2').ok, true);
  assert.equal(validateRecord(closed, 'RACE_V2').ok, true);
  assert.equal(closed.record_hash, trials.recordHash(closed));
  assert.equal(fs.existsSync(races.RACES_LEDGER()), false);
  assert.equal(fs.existsSync(races.PAIRED_SAMPLES_LEDGER()), false);
  refuses(() => v2.closeRace(open.race_id, {}), 'RACE_NOT_OPEN');
  assert.deepEqual(Object.keys(trials.count('CN_A_BG')), ['family_id', 'as_of', 'n_raw', 'n_distinct_configs', 'n_uncounted_lower_bound', 'n_is_lower_bound', 'lower_bound_reasons', 'rows', 'by_role', 'by_mode', 'studies']);
  assert.equal(trials.count('CN_A_BG').n_raw, 5);
  assert.equal(trials.countMarket('CN_A', { marketOf: costGate.floorMarketOf }).n_raw, 5 + 3);
});
