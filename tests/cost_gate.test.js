'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gate = require('../services/cost-gate');
const addendum = require('../services/research-framework-amendment-20261112-addendum-1');
const overseas = require('../services/overseas-sealed-verdicts');
const ashare = require('../services/ashare-sealed-verdicts');
const trials = require('../services/trial-ledger');
const { read } = require('../packages/ledger');

/**
 * G-COST（研究框架修订 2026-11-12 附录 1 §2；docs/contracts/COST_MODEL_GATE_V1.md）：不计成本的回放不得作判定。先红后绿，只用合成登记与合成运行日志。
 * 门只会拒绝导入，从不改写结论。附录 1 未冻结（PENDING_FREEZE）：单元测试注入生效时刻与一页合成的已绑定冻结页，冻结前的失败即关另测。
 */
const AUTH = 'TEST_COST_GATE_AUTHORITY';
const EFF = '2026-11-01T00:00:00+08:00';
const BOUND = Object.freeze({ path: 'artifacts/coordinator/SYNTH_ADDENDUM_FREEZE_1.md', sha256: 'a'.repeat(64), state: 'FREEZE_1', texts: [{ id: 'DRAFT_REV_1', sha256: 'b'.repeat(64) }] });
const FAMILY = 'C17_V2_4000USDT';
const STUDY = 'R99-COST-SYNTH';
const GROSS = 'REPLAY_CORE_COSTS_NONE(CLOSE_MARK:按记录 tick 价退出,不另计费用)';
const COSTED = 'REPLAY_CORE_PROFILE_COSTS';
const OWN = 'SYNTH_ENGINE_COSTS_V1';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ARMS = [
  { config_label: 'T', role: 'VERDICT_ARM', stage: 'BOOK', rule_config: { s_m: true } },
  { config_label: 'B', role: 'BASELINE', stage: 'BOOK', rule_config: { s_m: false } },
  { config_label: 'T_WFO', role: 'WFO_FOLD', stage: 'WFO', rule_config: { s_m: true, fold: 1 } },
  { config_label: 'T_VAR', role: 'REPORT_ONLY_VARIANT', stage: 'BOOK', rule_config: { s_m: true, drop_long: true } },
  { config_label: 'T_DIAG', role: 'DIAGNOSTIC_ARM', stage: 'BOOK', rule_config: { s_m: true, diag: 1 } },
  { config_label: 'T_REPRO', role: 'REPRO', stage: 'BOOK', rule_config: { s_m: true, repro: 1 } },
  { config_label: 'S_IC', role: 'SIGNAL_TEST', stage: 'SIGNAL', rule_config: { ic: true } },
  { config_label: 'S_STAGE', role: 'VERDICT_ARM', stage: 'SIGNAL', rule_config: { ic: true, stage: 1 } },
  { config_label: 'T_CN', role: 'VERDICT_ARM', stage: 'BOOK', market: 'CN_A', rule_config: { cn: true } },
  { config_label: 'T_US', role: 'VERDICT_ARM', stage: 'BOOK', market: 'US_EQUITY', rule_config: { us: true } },
  { config_label: 'T_HK', role: 'VERDICT_ARM', stage: 'BOOK', market: 'HK', rule_config: { hk: true } },
];
const arm = (label) => ARMS.find((a) => a.config_label === label);
const isSignal = (label) => arm(label).role === 'SIGNAL_TEST' || arm(label).stage === 'SIGNAL';
const idOf = (label, family = FAMILY) => trials.trialIdOf({ family_id: family, study_ref: STUDY, config_label: label });
const K2_TEXT = '# R99 成本门 K2（合成）\n';
const K2_SHA = sha(K2_TEXT);

function preregister(family = FAMILY, labels = ARMS.map((a) => a.config_label)) {
  return trials.register(labels.map((l) => ({ family_id: family, market: 'CRYPTO_USDM_PERP', study_ref: STUDY, k2_sha256: K2_SHA, ...arm(l) })),
    { registeredBy: AUTH, registeredAt: '2026-11-08T09:00:00+08:00' });
}
/** 一行运行日志：ref 是 cost_model_ref（null = 不写）；读数种类默认按登记（只看信号 → IC，其余 → NET_RETURN_SERIES）。 */
const run = (label, ref, patch = {}) => ({ family_id: FAMILY, config_label: label, trial_id: idOf(label), rule_config_hash: trials.ruleConfigHash(arm(label).rule_config),
  verdict_metric_kind: isSignal(label) ? 'IC' : 'NET_RETURN_SERIES', ...(ref === null ? {} : { cost_model_ref: ref }), ...patch });
const own = (commission, slippage, extra = {}) => ({ cost_breakdown: { model: OWN, commission_bps: commission, slippage_bps: slippage, ...extra } });
const runLog = (runs, extra = {}) => Buffer.from(JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: K2_SHA, runs, ...extra }));
const COSTED_RUNS = () => [run('T', COSTED), run('B', OWN, own(2, 2))];

/** 直接调门：一题合成 RESULT，K2 在注入的生效时刻之后冻结，冻结页已绑定（合成）。 */
function direct({ runs = COSTED_RUNS(), log, entryPatch = {}, effectiveFrom = EFF, freeze = BOUND } = {}) {
  const bytes = log !== undefined ? log : runLog(runs);
  const entry = { id: 'C17-R99-COST', kind: 'RESULT', strategy_ref: FAMILY, sealed_on: '2026-11-20', k2: { sha256: K2_SHA }, k2_frozen_at: '2026-11-10T10:00:00+08:00', ...entryPatch };
  return gate.check(entry, { runLogBytes: () => bytes }, { effectiveFrom, freeze });
}
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === `COST_MODEL_${code}`, code);

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  for (const f of [overseas.LEDGER(), ashare.LEDGER(), trials.TRIALS()]) { try { fs.rmSync(f); } catch { /* 首次 */ } }
  overseas.clearCache();
});

test('冻结页绑定与目录：生效时刻与冻结页只在附录 1 模块写一处（未冻结 PENDING_FREEZE）；门内角色与阶段按 §2.2；目录里 REPLAY_CORE_COSTS_NONE 是毛收益；现行登记表没有一题过门', () => {
  assert.equal(addendum.EFFECTIVE_FROM, '2026-11-17T00:00:00+08:00');
  assert.equal(gate.EFFECTIVE_FROM, addendum.EFFECTIVE_FROM);
  assert.equal(gate.FREEZE, addendum.FREEZE);
  assert.deepEqual([gate.FREEZE.path, gate.FREEZE.sha256, gate.FREEZE.state, gate.FREEZE.texts.map((t) => `${t.id}:${t.sha256}`)],
    ['artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_ADDENDUM_1_FREEZE_1.md', 'PENDING_FREEZE', 'PENDING_FREEZE', ['DRAFT_REV_1:PENDING_FREEZE']]);
  assert.equal(gate.FREEZE.texts[0].path, 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_ADDENDUM_1_FILL_COST.draft.md');
  assert.equal(addendum.isBound(), false);
  assert.equal(addendum.isBound(BOUND), true);
  assert.deepEqual([[...gate.IN_SCOPE_ROLES], [...gate.IN_SCOPE_STAGES]], [['VERDICT_ARM', 'BASELINE', 'WFO_FOLD', 'STRESS'], ['BOOK', 'ABLATION', 'WFO', 'FORWARD']]);
  const none = gate.CATALOGUE.get('REPLAY_CORE_COSTS_NONE');
  assert.deepEqual([none.source, none.counts_costs, none.not_modelled], ['adapters/us-replay-core', false, ['commission', 'slippage']]);
  assert.deepEqual([gate.CATALOGUE.get(COSTED).source, gate.CATALOGUE.get(COSTED).counts_costs], ['adapters/crypto-replay-core', true]);
  assert.equal(gate.modelIdOf(GROSS), 'REPLAY_CORE_COSTS_NONE');
  for (const entry of [...overseas.ENTRIES, ...ashare.ENTRIES]) assert.equal(gate.applies(entry).applies, false, entry.id);
  const at = (t) => gate.applies({ id: 'x', kind: 'RESULT', k2: { sha256: K2_SHA }, k2_frozen_at: t }).applies;
  assert.equal(at('2026-11-17T00:00:00+08:00'), true);
  assert.equal(at('2026-11-16T23:59:59+08:00'), false);
});

test('冻结前（PENDING_FREEZE）：在范围内的题一律拒绝 FREEZE_UNBOUND，哪怕成本全对；不在范围内的题照常放过', () => {
  preregister();
  refuses(() => direct({ freeze: gate.FREEZE }), 'FREEZE_UNBOUND');
  refuses(() => gate.check({ id: 'x', kind: 'RESULT', strategy_ref: FAMILY, k2: { sha256: K2_SHA }, k2_frozen_at: '2026-11-17T10:00:00+08:00' }, { runLogBytes: () => runLog(COSTED_RUNS()) }), 'FREEZE_UNBOUND');
  assert.deepEqual(direct({ freeze: gate.FREEZE, entryPatch: { k2_frozen_at: '2026-10-31T23:59:59+08:00' } }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
  assert.deepEqual(gate.check({ id: 'x', kind: 'RESULT', k2: { sha256: K2_SHA }, k2_frozen_at: '2026-11-16T10:00:00+08:00' }, {}), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
});

test('门内：VERDICT_ARM、BASELINE、WFO_FOLD 出自毛收益模型 → 拒绝；行里另写拆分把目录里的毛收益模型「洗」成计成本也拒绝', () => {
  preregister();
  refuses(() => direct({ runs: [run('T', GROSS), run('B', COSTED)] }), 'GROSS_VERDICT');
  refuses(() => direct({ runs: [run('T', COSTED), run('B', 'REPLAY_CORE_COSTS_NONE')] }), 'GROSS_VERDICT');
  refuses(() => direct({ runs: [...COSTED_RUNS(), run('T_WFO', GROSS)] }), 'GROSS_VERDICT');
  refuses(() => direct({ runs: [run('T', GROSS, own(5, 5, { model: 'REPLAY_CORE_COSTS_NONE' })), run('B', COSTED)] }), 'GROSS_VERDICT');
});

test('门内：计成本 → PASS（目录模型，或目录外自报不低于下限），结论不改；只报、诊断、复现可以用毛收益模型，也不必写 cost_model_ref', () => {
  preregister();
  const r = direct({ runs: [...COSTED_RUNS(), run('T_VAR', GROSS), run('T_DIAG', null), run('T_REPRO', 'REPLAY_CORE_COSTS_NONE')] });
  assert.deepEqual([r.applies, r.state, r.effective_from, r.cost_gated_runs, r.signal_only_runs, r.other_runs], [true, 'PASS', EFF, 2, 0, 3]);
  assert.deepEqual(r.freeze, { path: BOUND.path, sha256: BOUND.sha256, state: 'FREEZE_1' });
  assert.deepEqual(r.cost_models, [
    { model_id: COSTED, source: 'adapters/crypto-replay-core' },
    { model_id: OWN, source: 'RUN_LOG_ROW', floor_market: 'CRYPTO', commission_bps: 2, slippage_bps: 2 },
  ]);
  assert.equal(r.decision, undefined); // 门不读、不写结论
});

test('只看信号（§2.3）：IC 的 SIGNAL_TEST 行用毛收益模型照过；只看信号的行报收益读数 → 拒绝；全是只看信号的题 → SIGNAL_ONLY（通过）', () => {
  preregister();
  const mixed = direct({ runs: [...COSTED_RUNS(), run('S_IC', GROSS)] });
  assert.deepEqual([mixed.state, mixed.cost_gated_runs, mixed.signal_only_runs], ['PASS', 2, 1]);
  refuses(() => direct({ runs: [...COSTED_RUNS(), run('S_IC', GROSS, { verdict_metric_kind: 'NET_RETURN_SERIES' })] }), 'SIGNAL_RETURN_CLAIM');
  refuses(() => direct({ runs: [...COSTED_RUNS(), run('S_STAGE', null, { verdict_metric_kind: 'NET_PNL_SERIES' })] }), 'SIGNAL_RETURN_CLAIM'); // 阶段 SIGNAL 的 VERDICT_ARM 也只看信号
  const only = direct({ runs: [run('S_IC', GROSS, { verdict_metric_kind: 'RANK_IC' }), run('S_STAGE', null, { verdict_metric_kind: 'HIT_RATE' })] });
  assert.deepEqual([only.applies, only.state, only.cost_gated_runs, only.signal_only_runs, only.cost_models], [true, 'SIGNAL_ONLY', 0, 2, []]);
  // 门内没有行、又不全是只看信号的（例如只报行）→ 拒绝；只看信号的角色由预登记决定，运行行改不了
  refuses(() => direct({ runs: [run('S_IC', GROSS), run('T_VAR', GROSS)] }), 'NO_VERDICT_RUN');
  refuses(() => direct({ runs: [run('T', GROSS, { verdict_metric_kind: 'IC' })] }), 'METRIC_KIND_MISMATCH'); // 门内的行只能报收益读数
  refuses(() => direct({ runs: [...COSTED_RUNS(), run('T_DIAG', null, { verdict_metric_kind: 'EVENT_STUDY' })] }), 'METRIC_KIND_MISMATCH');
  refuses(() => direct({ runs: [run('T', COSTED, { verdict_metric_kind: undefined }), run('B', COSTED)] }), 'METRIC_KIND_INVALID');
  refuses(() => direct({ runs: [run('T', COSTED, { verdict_metric_kind: 'SHARPE' }), run('B', COSTED)] }), 'METRIC_KIND_INVALID');
  refuses(() => direct({ runs: [run('T', COSTED, { role: 'SIGNAL_TEST' }), run('B', COSTED)] }), 'ROLE_MISMATCH');
  refuses(() => direct({ runs: [run('T', COSTED, { stage: 'SIGNAL' }), run('B', COSTED)] }), 'ROLE_MISMATCH');
});

test('目录外引擎自报成本（§2.4）：不低于下限才认——低于下限、不是数字、市场没有下限、没自报都拒绝；美股按佣金加滑点的合计比', () => {
  preregister();
  const ok = (label, c, s) => direct({ runs: [run(label, OWN, own(c, s))] });
  assert.equal(ok('T', 2, 2).state, 'PASS'); // CRYPTO 下限 2 / 2（恰好等于）
  refuses(() => ok('T', 1.9, 2), 'BELOW_FLOOR');
  refuses(() => ok('T', 2, 1.99), 'BELOW_FLOOR');
  assert.equal(ok('T_CN', 2.5, 10).cost_models[0].floor_market, 'CN_A'); // CN_A 下限 2.5 / 10
  refuses(() => ok('T_CN', 2.5, 9.99), 'BELOW_FLOOR');
  refuses(() => ok('T_US', 1, 3), 'BELOW_FLOOR'); // US 合计下限 5：1 + 3 = 4
  assert.equal(ok('T_US', 0, 5).state, 'PASS');
  refuses(() => ok('T', '5', 2), 'BREAKDOWN_NOT_NUMERIC');
  refuses(() => ok('T', 2, 'NOT_MODELLED_SYNTH'), 'BREAKDOWN_NOT_NUMERIC');
  refuses(() => ok('T', 2, -1), 'BREAKDOWN_NOT_NUMERIC');
  refuses(() => direct({ runs: [run('T', OWN, { cost_breakdown: { model: OWN, commission_bps: 5 } })] }), 'BREAKDOWN_NOT_NUMERIC');
  refuses(() => ok('T_HK', 50, 50), 'NO_FLOOR');
  refuses(() => direct({ runs: [run('T', OWN)] }), 'UNKNOWN');
  refuses(() => direct({ runs: [run('T', OWN, own(5, 5, { model: 'OTHER_V1' }))] }), 'BREAKDOWN_MODEL_MISMATCH');
  assert.deepEqual(Object.keys(gate.FLOORS).sort(), ['CN_A', 'CRYPTO', 'US']);
  assert.deepEqual([gate.floorMarketOf('CRYPTO_USDM_PERP'), gate.floorMarketOf('US_EQUITY'), gate.floorMarketOf('CN_A'), gate.floorMarketOf('CN_B'), gate.floorMarketOf('HK')], ['CRYPTO', 'US', 'CN_A', null, null]);
});

test('下限的来源：每个数都写来源文件与 sha256；美股合计取 QRP 证据文件 US_V5_M1_RESEARCH_COST_V1 的原值（文件 sha256 复验）', () => {
  for (const [market, floor] of Object.entries(gate.FLOORS)) {
    assert.ok(Object.keys(floor.sources).length, market);
    for (const s of Object.values(floor.sources)) assert.match(s.sha256, /^[0-9a-f]{64}$/, market);
  }
  const us = gate.FLOORS.US.sources.total;
  const bytes = fs.readFileSync(path.join(__dirname, '..', us.path));
  assert.equal(sha(bytes), us.sha256);
  const model = JSON.parse(bytes.toString('utf8')).cost_model;
  assert.deepEqual([model.model_ref, model.strategy_bps_each_side, model.commission_usd], ['US_V5_M1_RESEARCH_COST_V1', gate.FLOORS.US.total_bps_min, 0]);
});

test('不过门：K2 在生效时刻之前冻结、READING / DRAFT 不读，毛收益或没有运行日志都原样放过；默认生效时刻（11-17）之前冻结的同样不过门', () => {
  preregister();
  const gross = runLog([run('T', GROSS), run('B', GROSS)]);
  assert.deepEqual(direct({ log: gross, entryPatch: { k2_frozen_at: '2026-10-31T23:59:59+08:00' } }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
  assert.deepEqual(direct({ log: null, entryPatch: { k2_frozen_at: '2026-10-31T23:59:59+08:00' } }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
  assert.deepEqual(direct({ log: gross, entryPatch: { kind: 'READING' } }), { applies: false, reason: 'NOT_A_VERDICT' });
  assert.deepEqual(direct({ log: gross, entryPatch: { kind: 'DRAFT' } }), { applies: false, reason: 'DRAFT_NOT_FROZEN' });
  assert.deepEqual(direct({ log: gross, entryPatch: { k2_frozen_at: undefined, sealed_on: '2026-10-30' } }), { applies: false, reason: 'SEALED_BEFORE_EFFECTIVE' });
  assert.deepEqual(direct({ log: gross, effectiveFrom: gate.EFFECTIVE_FROM }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
});

test('过门、字段缺失即关：没有运行日志、本族一行都没有、门内行没写 cost_model_ref、行没写 trial_id、k2_frozen_at 缺失、台账对不上', () => {
  preregister();
  refuses(() => direct({ log: null }), 'RUN_LOG_MISSING');
  refuses(() => direct({ log: Buffer.from('{') }), 'RUN_LOG_NOT_JSON');
  refuses(() => direct({ log: runLog(COSTED_RUNS(), { k2_sha256: 'f'.repeat(64) }) }), 'RUN_LOG_K2_MISMATCH');
  refuses(() => direct({ runs: [] }), 'NO_RUNS');
  refuses(() => direct({ runs: [{ ...run('T', COSTED), family_id: 'OTHER_FAMILY' }] }), 'NO_RUNS');
  refuses(() => direct({ runs: [run('T', null), run('B', COSTED)] }), 'REF_MISSING');
  refuses(() => direct({ runs: [run('T', COSTED, { trial_id: undefined })] }), 'RUN_TRIAL_ID_MISSING');
  refuses(() => direct({ entryPatch: { k2_frozen_at: undefined, sealed_on: '2026-11-20' } }), 'K2_FROZEN_AT_MISSING');
  refuses(() => direct({ runs: [run('T', COSTED, { role: 'REPORT_ONLY_VARIANT' }), run('B', COSTED)] }), 'ROLE_MISMATCH');
  refuses(() => direct({ runs: [run('T', COSTED, { trial_id: 'TRL-0000000000000000' }), run('B', COSTED)] }), 'TRIAL_NOT_REGISTERED');
  refuses(() => direct({ runs: [run('T', COSTED, { rule_config_hash: 'e'.repeat(64) }), run('B', COSTED)] }), 'RUN_TRIAL_MISMATCH');
});

// ── 导入器（海外与 A 股共用同一个 checkEntry，一处调用、不带选项） ──────────────────

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();

/** 合成仓库：封存结果、K2、运行日志一次提交。K2 冻结早于 G-TRIAL / G-MECH / G-CAUSAL 的生效时刻，只有注入生效时刻的 G-COST 过门。 */
function importerFixture({ runs, source = 'smartflow', strategyRef = FAMILY } = {}) {
  const repo = tmp('qrp-cost-repo-'); const art = tmp('qrp-cost-art-');
  const prefix = source === 'smartflow' ? 'trading-system-v2/' : '';
  const files = {
    [`${prefix}docs/evidence/r99/RESULT.json`]: `${JSON.stringify({ verdict: { decision: '做', evidence_strength: '证据不足', allowed_use: '前向影子', text_zh: '合成' } })}\n`,
    [`${prefix}docs/R99_K2.md`]: K2_TEXT,
    [`${prefix}docs/evidence/r99/RUN_LOG.json`]: `${runLog(runs.map((r) => ({ ...r, family_id: strategyRef }))).toString()}\n`,
  };
  git(repo, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seal');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const spec = (rel) => ({ source, commit, path: `${prefix}${rel}`, sha256: sha(files[`${prefix}${rel}`]), ref: `${source}@x:${rel}` });
  const entry = {
    id: 'R99-COST', label_zh: 'R99', strategy_ref: strategyRef, kind: 'RESULT', sealed_on: '2026-11-10', title_zh: '合成题（成本门）', k2_frozen_at: '2026-11-09T20:00:00+08:00',
    file: spec('docs/evidence/r99/RESULT.json'), k2: spec('docs/R99_K2.md'), freeze: null, run_log: spec('docs/evidence/r99/RUN_LOG.json'),
    read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'verdict.text_zh' }, expect: '做',
  };
  const out = tmp('qrp-cost-ev-');
  overseas.stageEvidence({ artifactsRoot: art, out, entries: [entry], roots: { [source]: repo } });
  return { entry, out };
}
const count = (ledgerFile) => (fs.existsSync(ledgerFile) ? read(ledgerFile).length : 0);
const gated = (fn, patch = { effectiveFrom: EFF, freeze: BOUND }) => gate.internals.withDefaults(patch, fn);

test('导入器：默认读法下（K2 早于 11-17）毛收益题照原样导入，锁行不带 cost_gate；注入生效时刻后：冻结页未绑定 → 拒绝，毛收益判定 → 拒绝，台账都不写；计成本的锁里记 PASS、结论不变', () => {
  preregister();
  const gross = importerFixture({ runs: [run('T', GROSS), run('B', COSTED)] });
  const [plain] = overseas.importVerdicts(gross.out, { registeredBy: AUTH, entries: [gross.entry] });
  assert.equal(plain.cost_gate, undefined);
  fs.rmSync(overseas.LEDGER());
  const opts = (fx) => ({ registeredBy: AUTH, entries: [fx.entry] });
  const ok = importerFixture({ runs: [...COSTED_RUNS(), run('T_VAR', GROSS), run('S_IC', GROSS)] });
  assert.throws(() => gated(() => overseas.importVerdicts(ok.out, opts(ok)), { effectiveFrom: EFF }), /COST_MODEL_FREEZE_UNBOUND/);
  assert.throws(() => gated(() => overseas.importVerdicts(gross.out, opts(gross))), /COST_MODEL_GROSS_VERDICT/);
  assert.equal(count(overseas.LEDGER()), 0);
  const [lock] = gated(() => overseas.importVerdicts(ok.out, opts(ok)));
  assert.equal(lock.decision, '做');
  assert.deepEqual([lock.cost_gate.applies, lock.cost_gate.state, lock.cost_gate.cost_gated_runs, lock.cost_gate.signal_only_runs, lock.cost_gate.other_runs], [true, 'PASS', 2, 1, 1]);
  assert.equal(count(overseas.LEDGER()), 1);
  assert.equal(gate.check({ id: 'x', kind: 'RESULT', k2: { sha256: K2_SHA }, k2_frozen_at: '2026-11-09T20:00:00+08:00' }, {}).applies, false); // withDefaults 结束即还原
});

test('导入器：A 股导入器走同一个 checkEntry，过同一道门（毛收益判定拒绝，A 股台账不写）', () => {
  trials.register(['T', 'B'].map((l) => ({ family_id: 'ASHARE_V6_PAPER', market: 'CN_A', study_ref: STUDY, k2_sha256: K2_SHA, ...arm(l) })),
    { registeredBy: AUTH, registeredAt: '2026-11-08T09:00:00+08:00' });
  const cnRun = (label, ref) => ({ ...run(label, ref), trial_id: idOf(label, 'ASHARE_V6_PAPER') });
  const fx = importerFixture({ runs: [cnRun('T', GROSS), cnRun('B', COSTED)], source: 'ashare-v6', strategyRef: 'ASHARE_V6_PAPER' });
  assert.throws(() => gated(() => ashare.importVerdicts(fx.out, { registeredBy: AUTH, entries: [fx.entry] })), /COST_MODEL_GROSS_VERDICT/);
  assert.equal(count(ashare.LEDGER()), 0);
});
