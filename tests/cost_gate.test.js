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
const overseas = require('../services/overseas-sealed-verdicts');
const ashare = require('../services/ashare-sealed-verdicts');
const trials = require('../services/trial-ledger');
const { read } = require('../packages/ledger');

/**
 * G-COST（docs/contracts/COST_MODEL_GATE_V1.md）：毛收益（不计成本）的回放不得作为「做 / 不做」结论导入。先红后绿，只用合成登记与合成运行日志。
 * 门只会拒绝导入，从不改写结论；单元测试注入生效时刻，默认生效时刻（假设值）另测。
 */
const AUTH = 'TEST_COST_GATE_AUTHORITY';
const EFF = '2026-11-01T00:00:00+08:00';
const FAMILY = 'C17_V2_4000USDT';
const STUDY = 'R99-COST-SYNTH';
const GROSS = 'REPLAY_CORE_COSTS_NONE(CLOSE_MARK:按记录 tick 价退出,不另计费用)';
const COSTED = 'REPLAY_CORE_PROFILE_COSTS';
const ROW_COSTED = { model: 'SYNTH_ENGINE_COSTS_V1', components: { commission: { bps: 5 }, slippage: { bps: 3 } } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ARMS = [
  { config_label: 'T', role: 'VERDICT_ARM', rule_config: { s_m: true } },
  { config_label: 'B', role: 'BASELINE', rule_config: { s_m: false } },
  { config_label: 'T_VAR', role: 'REPORT_ONLY_VARIANT', rule_config: { s_m: true, drop_long: true } },
  { config_label: 'T_DIAG', role: 'DIAGNOSTIC_ARM', rule_config: { s_m: true, diag: 1 } },
  { config_label: 'T_REPRO', role: 'REPRO', rule_config: { s_m: true, repro: 1 } },
];
const arm = (label) => ARMS.find((a) => a.config_label === label);
const idOf = (label) => trials.trialIdOf({ family_id: FAMILY, study_ref: STUDY, config_label: label });
const K2_TEXT = '# R99 成本门 K2（合成）\n';
const K2_SHA = sha(K2_TEXT);

function preregister(k2Sha = K2_SHA, labels = ARMS.map((a) => a.config_label)) {
  return trials.register(labels.map((l) => ({ family_id: FAMILY, market: 'CRYPTO_USDM_PERP', study_ref: STUDY, k2_sha256: k2Sha, stage: 'BOOK', ...arm(l) })),
    { registeredBy: AUTH, registeredAt: '2026-11-08T09:00:00+08:00' });
}
/** 一行运行日志：models[label] 是 cost_model_ref（null = 不写），patch 覆盖任意字段。 */
const run = (label, ref, patch = {}) => ({ family_id: FAMILY, config_label: label, trial_id: idOf(label), rule_config_hash: trials.ruleConfigHash(arm(label).rule_config),
  ...(ref === null ? {} : { cost_model_ref: ref }), ...patch });
const runLog = (runs, extra = {}) => Buffer.from(JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: K2_SHA, runs, ...extra }));
const COSTED_RUNS = () => [run('T', COSTED), run('B', 'SYNTH_ENGINE_COSTS_V1', { cost_breakdown: ROW_COSTED })];

/** 直接调门：一题合成 RESULT，K2 在注入的生效时刻之后冻结。 */
function direct({ runs = COSTED_RUNS(), log, entryPatch = {}, effectiveFrom = EFF } = {}) {
  const bytes = log !== undefined ? log : runLog(runs);
  const entry = { id: 'C17-R99-COST', kind: 'RESULT', strategy_ref: FAMILY, sealed_on: '2026-11-20', k2: { sha256: K2_SHA }, k2_frozen_at: '2026-11-10T10:00:00+08:00', ...entryPatch };
  return gate.check(entry, { runLogBytes: () => bytes }, { effectiveFrom });
}
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === `COST_MODEL_${code}`, code);

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  for (const f of [overseas.LEDGER(), ashare.LEDGER(), trials.TRIALS()]) { try { fs.rmSync(f); } catch { /* 首次 */ } }
  overseas.clearCache();
});

test('常量与目录：生效时刻只写一处（假设值 2026-11-17 00:00 CST）；适配器声明的成本模型里 REPLAY_CORE_COSTS_NONE 是毛收益、REPLAY_CORE_PROFILE_COSTS 计成本；现行登记表没有一题过门', () => {
  assert.equal(gate.EFFECTIVE_FROM, '2026-11-17T00:00:00+08:00');
  assert.deepEqual([...gate.GROSS_ALLOWED_ROLES], ['REPORT_ONLY_VARIANT', 'DIAGNOSTIC_ARM', 'REPRO']);
  const none = gate.CATALOGUE.get('REPLAY_CORE_COSTS_NONE');
  assert.equal(none.source, 'adapters/us-replay-core');
  assert.equal(none.counts_costs, false);
  assert.deepEqual(none.not_modelled, ['commission', 'slippage']);
  const profile = gate.CATALOGUE.get('REPLAY_CORE_PROFILE_COSTS');
  assert.equal(profile.source, 'adapters/crypto-replay-core');
  assert.equal(profile.counts_costs, true);
  // 名字里写明不计费用的模型，拆分怎么写都算毛收益
  assert.equal(gate.classify('REPLAY_CORE_COSTS_NONE', ROW_COSTED).counts_costs, false);
  assert.equal(gate.modelIdOf(GROSS), 'REPLAY_CORE_COSTS_NONE');
  for (const entry of [...overseas.ENTRIES, ...ashare.ENTRIES]) assert.equal(gate.applies(entry).applies, false, entry.id);
  const at = (t) => gate.applies({ id: 'x', kind: 'RESULT', k2: { sha256: K2_SHA }, k2_frozen_at: t }).applies;
  assert.equal(at('2026-11-17T00:00:00+08:00'), true);
  assert.equal(at('2026-11-16T23:59:59+08:00'), false);
});

test('过门：判定用的运行（VERDICT_ARM、BASELINE）出自毛收益模型 → 拒绝；用运行日志自带的拆分把毛收益模型「洗」成计成本也拒绝', () => {
  preregister();
  refuses(() => direct({ runs: [run('T', GROSS), run('B', COSTED)] }), 'GROSS_VERDICT');
  refuses(() => direct({ runs: [run('T', COSTED), run('B', 'REPLAY_CORE_COSTS_NONE')] }), 'GROSS_VERDICT');
  refuses(() => direct({ runs: [run('T', GROSS, { cost_breakdown: { model: 'REPLAY_CORE_COSTS_NONE', components: { commission: 'X', slippage: 'Y' } } }), run('B', COSTED)] }), 'GROSS_VERDICT');
  // 适配器之外的模型：拆分里佣金或滑点写 NOT_MODELLED* → 毛收益
  refuses(() => direct({ runs: [run('T', 'SYNTH_GROSS_V1', { cost_breakdown: { components: { commission: { bps: 5 }, slippage: 'NOT_MODELLED_SYNTH' } } }), run('B', COSTED)] }), 'GROSS_VERDICT');
});

test('过门：判定用的运行都出自计成本的模型 → PASS（适配器声明的模型与运行日志自带拆分的模型都可以），结论不改', () => {
  preregister();
  const r = direct();
  assert.equal(r.applies, true);
  assert.equal(r.state, 'PASS');
  assert.equal(r.effective_from, EFF);
  assert.deepEqual([r.verdict_runs, r.other_runs, r.gross_other_runs], [2, 0, 0]);
  assert.deepEqual(r.cost_models, [
    { model_id: 'REPLAY_CORE_PROFILE_COSTS', source: 'adapters/crypto-replay-core', counts_costs: true, verdict_bearing: true },
    { model_id: 'SYNTH_ENGINE_COSTS_V1', source: 'RUN_LOG_ROW', counts_costs: true, verdict_bearing: true },
  ]);
  assert.equal(r.decision, undefined); // 门不读、不写结论
});

test('过门：只报、诊断、复现的运行可以用毛收益模型；判定用的运行计成本 → PASS，只报行记数', () => {
  preregister();
  const r = direct({ runs: [...COSTED_RUNS(), run('T_VAR', GROSS), run('T_DIAG', 'REPLAY_CORE_COSTS_NONE'), run('T_REPRO', 'SYNTH_GROSS_V1', { cost_breakdown: { components: { commission: 'NOT_MODELLED_SYNTH', slippage: 'NOT_MODELLED_SYNTH' } } })] });
  assert.equal(r.state, 'PASS');
  assert.deepEqual([r.verdict_runs, r.other_runs, r.gross_other_runs], [2, 3, 3]);
  assert.ok(r.cost_models.some((m) => m.model_id === 'REPLAY_CORE_COSTS_NONE' && !m.counts_costs && !m.verdict_bearing));
});

test('不过门：K2 在生效时刻之前冻结、READING / DRAFT / STATUS 不读，毛收益或没有运行日志都原样放过；默认生效时刻（11-17）之前冻结的同样不过门', () => {
  preregister();
  const gross = runLog([run('T', GROSS), run('B', GROSS)]);
  assert.deepEqual(direct({ log: gross, entryPatch: { k2_frozen_at: '2026-10-31T23:59:59+08:00' } }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
  assert.deepEqual(direct({ log: null, entryPatch: { k2_frozen_at: '2026-10-31T23:59:59+08:00' } }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
  assert.deepEqual(direct({ log: gross, entryPatch: { kind: 'READING' } }), { applies: false, reason: 'NOT_A_VERDICT' });
  assert.deepEqual(direct({ log: gross, entryPatch: { kind: 'DRAFT' } }), { applies: false, reason: 'DRAFT_NOT_FROZEN' });
  assert.deepEqual(direct({ log: gross, entryPatch: { k2_frozen_at: undefined, sealed_on: '2026-10-30' } }), { applies: false, reason: 'SEALED_BEFORE_EFFECTIVE' });
  assert.deepEqual(direct({ log: gross, effectiveFrom: gate.EFFECTIVE_FROM }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
});

test('过门、字段缺失即关：没有运行日志、行里没写 cost_model_ref 或 trial_id、模型既不在适配器目录也没自带拆分、拆分缺滑点、k2_frozen_at 缺失、台账对不上、没有判定用的运行', () => {
  preregister();
  refuses(() => direct({ log: null }), 'RUN_LOG_MISSING');
  refuses(() => direct({ log: Buffer.from('{') }), 'RUN_LOG_NOT_JSON');
  refuses(() => direct({ log: runLog(COSTED_RUNS(), { k2_sha256: 'f'.repeat(64) }) }), 'RUN_LOG_K2_MISMATCH');
  refuses(() => direct({ runs: [run('T', null), run('B', COSTED)] }), 'REF_MISSING');
  refuses(() => direct({ runs: [run('T', COSTED), run('T_VAR', null)] }), 'REF_MISSING'); // 只报行也必须写出模型
  refuses(() => direct({ runs: [run('T', COSTED, { trial_id: undefined })] }), 'RUN_TRIAL_ID_MISSING');
  refuses(() => direct({ runs: [run('T', 'SYNTH_ENGINE_COSTS_V1'), run('B', COSTED)] }), 'UNKNOWN');
  refuses(() => direct({ runs: [...COSTED_RUNS(), run('T_VAR', 'SYNTH_GROSS_V1')] }), 'UNKNOWN'); // 只报行的模型也要判得出（计成本与否记进锁）
  refuses(() => direct({ runs: [run('T', 'SYNTH_ENGINE_COSTS_V1', { cost_breakdown: { components: { commission: { bps: 5 } } } }), run('B', COSTED)] }), 'BREAKDOWN_INCOMPLETE');
  refuses(() => direct({ runs: [run('T', 'SYNTH_ENGINE_COSTS_V1', { cost_breakdown: { ...ROW_COSTED, model: 'OTHER_V1' } }), run('B', COSTED)] }), 'BREAKDOWN_MODEL_MISMATCH');
  refuses(() => direct({ entryPatch: { k2_frozen_at: undefined, sealed_on: '2026-11-20' } }), 'K2_FROZEN_AT_MISSING');
  refuses(() => direct({ runs: [run('T', COSTED, { role: 'REPORT_ONLY_VARIANT' }), run('B', COSTED)] }), 'ROLE_MISMATCH'); // 角色取预登记行，运行日志改不了
  refuses(() => direct({ runs: [run('T', COSTED, { trial_id: 'TRL-0000000000000000' }), run('B', COSTED)] }), 'TRIAL_NOT_REGISTERED');
  refuses(() => direct({ runs: [run('T', COSTED, { rule_config_hash: 'e'.repeat(64) }), run('B', COSTED)] }), 'RUN_TRIAL_MISMATCH');
  refuses(() => direct({ runs: [run('T_VAR', COSTED), run('T_REPRO', COSTED)] }), 'NO_VERDICT_RUN');
  refuses(() => direct({ runs: [] }), 'NO_VERDICT_RUN');
});

// ── 导入器（海外与 A 股共用同一套 checkEntry） ──────────────────────────────────

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
/** 导入器不带门的选项（只有一处调用）：测试期间临时把门的生效时刻换成注入值，结束即还原。 */
function withEffective(effectiveFrom, fn) {
  const original = gate.check;
  gate.check = (entry, files, opts = {}) => original(entry, files, { effectiveFrom, ...opts });
  try { return fn(); } finally { gate.check = original; }
}

test('导入器：默认生效时刻下（K2 早于 11-17）毛收益题照原样导入，锁行不带 cost_gate；注入生效时刻后毛收益判定整批拒绝、台账不写，计成本的锁里记 PASS、结论不变', () => {
  preregister();
  const gross = importerFixture({ runs: [run('T', GROSS), run('B', COSTED)] });
  const [plain] = overseas.importVerdicts(gross.out, { registeredBy: AUTH, entries: [gross.entry] });
  assert.equal(plain.cost_gate, undefined);
  fs.rmSync(overseas.LEDGER());
  const opts = (fx) => ({ registeredBy: AUTH, entries: [fx.entry] });
  assert.throws(() => withEffective(EFF, () => overseas.importVerdicts(gross.out, opts(gross))), /COST_MODEL_GROSS_VERDICT/);
  assert.equal(count(overseas.LEDGER()), 0);
  const ok = importerFixture({ runs: [...COSTED_RUNS(), run('T_VAR', GROSS)] });
  const [lock] = withEffective(EFF, () => overseas.importVerdicts(ok.out, opts(ok)));
  assert.equal(lock.decision, '做');
  assert.deepEqual([lock.cost_gate.applies, lock.cost_gate.state, lock.cost_gate.verdict_runs, lock.cost_gate.gross_other_runs], [true, 'PASS', 2, 1]);
  assert.equal(count(overseas.LEDGER()), 1);
});

test('导入器：A 股导入器走同一个 checkEntry，过同一道门（毛收益判定拒绝，A 股台账不写）', () => {
  trials.register(['T', 'B'].map((l) => ({ family_id: 'ASHARE_V6_PAPER', market: 'CN_A', study_ref: STUDY, k2_sha256: K2_SHA, stage: 'BOOK', ...arm(l) })),
    { registeredBy: AUTH, registeredAt: '2026-11-08T09:00:00+08:00' });
  const cnRun = (label, ref) => ({ ...run(label, ref), trial_id: trials.trialIdOf({ family_id: 'ASHARE_V6_PAPER', study_ref: STUDY, config_label: label }) });
  const fx = importerFixture({ runs: [cnRun('T', GROSS), cnRun('B', COSTED)], source: 'ashare-v6', strategyRef: 'ASHARE_V6_PAPER' });
  assert.throws(() => withEffective(EFF, () => ashare.importVerdicts(fx.out, { registeredBy: AUTH, entries: [fx.entry] })), /COST_MODEL_GROSS_VERDICT/);
  assert.equal(count(ashare.LEDGER()), 0);
});
