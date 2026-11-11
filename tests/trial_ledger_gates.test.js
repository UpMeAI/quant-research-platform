'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const overseas = require('../services/overseas-sealed-verdicts');
const ashare = require('../services/ashare-sealed-verdicts');
const trials = require('../services/trial-ledger');
const gates = require('../services/trial-ledger/gates');
const { read } = require('../packages/ledger');

const AUTH = 'TEST_TRIAL_AUTHORITY';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();
const FAMILY = 'C17_V2_4000USDT';
const STUDY = 'R99-SYNTH';
const FROZEN = '2026-11-12T10:00:00+08:00';
const BEFORE = '2026-11-12T09:00:00+08:00';
const AFTER = '2026-11-20T09:00:00+08:00';
const ARMS = [
  { config_label: 'T', role: 'VERDICT_ARM', rule_config: { s_m: true } },
  { config_label: 'T_VAR', role: 'REPORT_ONLY_VARIANT', rule_config: { s_m: true, drop_long: true } },
  { config_label: 'B', role: 'BASELINE', rule_config: { s_m: false } },
];
const idOf = (label) => trials.trialIdOf({ family_id: FAMILY, study_ref: STUDY, config_label: label });
const hashOf = (label) => trials.ruleConfigHash(ARMS.find((a) => a.config_label === label).rule_config);
const months = (c) => Array.from({ length: 30 }, (_, i) => ({ month: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, d: 0.01 * Math.sin(i * 1.3) + c }));

/** 合成 smartflow 仓库 + 协调会话目录；K2 里写出 named 这些台账 id；runLog 为 null 时不登记运行日志。 */
function fixture({ named = ['T', 'T_VAR', 'B'], decision = '做', runs = ['T', 'T_VAR', 'B'], runLog = true, runLogExtra = {}, entryPatch = {} } = {}) {
  const repo = tmp('qrp-tg-sf-'); const art = tmp('qrp-tg-art-');
  const k2Text = `# R99 K2\n\n## 4 候选\n${named.map((l) => `- ${l}：台账 ${idOf(l)}`).join('\n')}\n`;
  const k2Sha = sha(k2Text);
  const files = {
    'trading-system-v2/docs/evidence/r99/RESULT.json': `${JSON.stringify({ verdict: { decision, evidence_strength: '证据不足', allowed_use: '前向影子', text_zh: '合成' } })}\n`,
    'trading-system-v2/docs/R99_K2.md': k2Text,
    'trading-system-v2/docs/evidence/r99/RUN_LOG.json': `${JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: k2Sha, ...runLogExtra, runs: runs.map((l) => ({ family_id: FAMILY, config_label: l, rule_config_hash: typeof l === 'string' && l.startsWith('raw:') ? l.slice(4) : hashOf(l) })) })}\n`,
  };
  git(repo, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seal');
  const commit = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(art, 'R99_FREEZE_1.md'), 'frozen\n');
  const sf = (rel) => ({ source: 'smartflow', commit, path: `trading-system-v2/${rel}`, sha256: sha(files[`trading-system-v2/${rel}`]), ref: `smartflow@x:${rel}` });
  const entry = {
    id: 'C17-R99', label_zh: 'R99', strategy_ref: FAMILY, kind: 'RESULT', sealed_on: '2026-11-20', title_zh: '合成题', k2_frozen_at: FROZEN,
    file: sf('docs/evidence/r99/RESULT.json'), k2: sf('docs/R99_K2.md'), freeze: { source: 'coordinator', path: 'R99_FREEZE_1.md', sha256: sha('frozen\n'), ref: 'artifacts/coordinator/R99_FREEZE_1.md' },
    run_log: runLog ? sf('docs/evidence/r99/RUN_LOG.json') : undefined,
    read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'verdict.text_zh' }, expect: decision, ...entryPatch,
  };
  return { repo, art, entry, k2Sha };
}

function preregister(k2Sha, { labels = ['T', 'T_VAR', 'B'], at = BEFORE } = {}) {
  return trials.register(ARMS.filter((a) => labels.includes(a.config_label)).map((a) => ({ family_id: FAMILY, market: 'CRYPTO_USDM_PERP', study_ref: STUDY, k2_sha256: k2Sha, stage: 'BOOK', ...a })), { registeredBy: AUTH, registeredAt: at });
}
function results({ labels = ['T', 'T_VAR', 'B'] } = {}) {
  for (const l of labels) {
    trials.recordResult(idOf(l), { window: { from: '2024-01-01', to: '2026-06-30' }, eval: { costs: { bp: 5 }, code_sha: 'a'.repeat(40) },
      metrics: { n_trades: 40, delta_g: 0.01 }, ...(l === 'B' ? { unknown: { sr_monthly_delta: 'BASELINE_VS_ITSELF' } } : { months: months(l === 'T' ? 0.004 : 0.001) }), study_verdict: '做' }, { registeredBy: AUTH, registeredAt: AFTER });
  }
}
function disclose(k2Sha) {
  return trials.disclose({ family_id: FAMILY, study_ref: STUDY, k2_sha256: k2Sha, verdict_trial_id: idOf('T'), months: months(0.004), seed: 20261112, original_verdict: { decision: '做', strength: 'INSUFFICIENT' } }, { registeredBy: AUTH, registeredAt: AFTER });
}
const stage = (fx) => { const out = tmp('qrp-tg-ev-'); overseas.stageEvidence({ smartflowRoot: fx.repo, artifactsRoot: fx.art, out, entries: [fx.entry] }); return out; };
const importOne = (fx, out = stage(fx)) => overseas.importVerdicts(out, { registeredBy: AUTH, entries: [fx.entry] });
const fullFlow = (fx) => { preregister(fx.k2Sha); results(); disclose(fx.k2Sha); };
const locksNow = () => read(overseas.LEDGER());

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  for (const f of [overseas.LEDGER(), ashare.LEDGER(), trials.TRIALS(), trials.SEGMENTS(), trials.DISCLOSURES()]) { try { fs.rmSync(f); } catch { /* 首次 */ } }
  overseas.clearCache();
});

test('现行登记表（海外、A 股）：只有修订 4 的七个凯利 m 前推单元和修订 5 的 QS-KDECAY 过门（11-11 冻结），且都带门的裁定；其余都在修订生效前冻结或封存', () => {
  const gated = [...overseas.ENTRIES, ...ashare.ENTRIES].filter((entry) => gates.applies(entry).applies).map((entry) => entry.id);
  assert.deepEqual(gated, ['US5-KWFO', 'UC-KWFO', 'C17-KWFO', 'QS-KWFO', 'US5-KWFO-BUCKET', 'C17-KWFO-PAIR', 'QS-KWFO-PAIR', 'QS-KDECAY']);
  for (const id of gated.filter((x) => x.includes('KWFO'))) {
    const entry = overseas.ENTRIES.find((e) => e.id === id);
    assert.equal(entry.trial_gates_ruling.spec.sha256, '99203316f27d00aff6e5f42f47229ff79ea2617dcdd0a0c3b897ea71d427113f', id);
    assert.deepEqual(entry.trial_gates_ruling.pre.codes, gates.DEVIATION_CODES, id);
    assert.ok(entry.run_log, id);
  }
  // 修订 5：先预登记后冻结，PRE 不放行任何偏差；只有披露行的「不适用」引用 K2 §2
  const qs = overseas.ENTRIES.find((e) => e.id === 'QS-KDECAY');
  assert.equal(qs.trial_gates_ruling.pre, undefined);
  assert.equal(qs.trial_gates_ruling.spec, qs.k2);
  assert.deepEqual([...qs.trial_gates_ruling.disclosure_not_applicable], ['dsr', 'pbo']);
  assert.ok(qs.run_log);
  assert.equal(gates.EFFECTIVE_FROM, '2026-11-11T00:00:00+08:00');
});

test('修订前冻结的题：台账为空照样导入，锁行不带 trial_gates，字段与原导入器一致', () => {
  const fx = fixture({ entryPatch: { k2_frozen_at: '2026-11-09T20:00:00+08:00', sealed_on: '2026-11-10' }, runLog: false });
  const [row] = importOne(fx);
  assert.equal(row.decision, '做');
  assert.equal('trial_gates' in row, false);
  const noFrozen = fixture({ entryPatch: { k2_frozen_at: undefined, sealed_on: '2026-11-10', id: 'C17-R99B' }, runLog: false });
  const [row2] = importOne(noFrozen);
  assert.deepEqual(Object.keys(row2).sort(), Object.keys(row).sort());
});

test('全过：锁的结论等于封存文件原文（做 / 不做都不被改写），锁行记下两道门', () => {
  for (const decision of ['做', '不做']) {
    for (const f of [overseas.LEDGER(), trials.TRIALS(), trials.DISCLOSURES()]) { try { fs.rmSync(f); } catch { /* */ } }
    const fx = fixture({ decision });
    fullFlow(fx);
    const [row] = importOne(fx);
    assert.equal(row.decision, decision);
    assert.equal(row.trial_gates.pre, 'PASS');
    assert.equal(row.trial_gates.seal, 'PASS');
    assert.deepEqual(row.trial_gates.trial_ids, [idOf('T'), idOf('T_VAR'), idOf('B')].sort());
    assert.ok(row.trial_gates.disclosure_id.startsWith('OVD-'));
  }
});

const rejects = (fx, code, setup) => {
  setup(fx);
  const before = locksNow().length;
  assert.throws(() => importOne(fx), (e) => e.code === `TRIAL_LEDGER_${code}`, code);
  assert.equal(locksNow().length, before, '失败即关：不写锁');
};

test('G-TRIAL-PRE：K2 没写台账 id / id 没登记 / 登记晚于冻结 / 预登记行没写进 K2 / 不是 PREREGISTERED → 拒绝', () => {
  rejects(fixture({ named: [] }), 'PRE_NO_TRIAL_ID_IN_K2', () => {});
  rejects(fixture(), 'PRE_NOT_REGISTERED', (fx) => { preregister(fx.k2Sha, { labels: ['T', 'B'] }); });
  for (const f of [trials.TRIALS()]) fs.rmSync(f, { force: true });
  rejects(fixture(), 'PRE_REGISTERED_AFTER_FREEZE', (fx) => { preregister(fx.k2Sha, { at: '2026-11-12T11:00:00+08:00' }); });
  fs.rmSync(trials.TRIALS(), { force: true });
  rejects(fixture({ named: ['T', 'B'] }), 'PRE_TRIAL_NOT_NAMED_IN_K2', (fx) => { preregister(fx.k2Sha); });
  fs.rmSync(trials.TRIALS(), { force: true });
  rejects(fixture(), 'PRE_NOT_PREREGISTERED', (fx) => {
    preregister(fx.k2Sha, { labels: ['T', 'B'] });
    trials.register([{ family_id: FAMILY, market: 'CRYPTO_USDM_PERP', study_ref: STUDY, k2_sha256: fx.k2Sha, stage: 'BOOK', ...ARMS[1] }], { registeredBy: AUTH, registeredAt: BEFORE, mode: 'UNPLANNED_RUN' });
  });
});

test('G-TRIAL-SEAL：缺结果行 / 缺运行日志 / 日志里有未登记的账本 / 缺披露 → 拒绝', () => {
  rejects(fixture(), 'SEAL_RESULT_MISSING', (fx) => { preregister(fx.k2Sha); results({ labels: ['T', 'B'] }); disclose(fx.k2Sha); });
  for (const f of [trials.TRIALS(), trials.DISCLOSURES()]) fs.rmSync(f, { force: true });
  rejects(fixture({ runLog: false }), 'SEAL_RUN_LOG_MISSING', fullFlow);
  for (const f of [trials.TRIALS(), trials.DISCLOSURES()]) fs.rmSync(f, { force: true });
  rejects(fixture({ runs: ['T', 'T_VAR', 'B', `raw:${'e'.repeat(64)}`] }), 'SEAL_UNREGISTERED_RUN', fullFlow);
  for (const f of [trials.TRIALS(), trials.DISCLOSURES()]) fs.rmSync(f, { force: true });
  rejects(fixture(), 'SEAL_DISCLOSURE_MISSING', (fx) => { preregister(fx.k2Sha); results(); });
});

test('未计划的运行登记为 UNPLANNED_RUN 后，运行日志里的这本账就过门（照样计入 N）', () => {
  const extra = { s_m: true, ad_hoc: 1 };
  const fx = fixture({ runs: ['T', 'T_VAR', 'B', `raw:${trials.ruleConfigHash(extra)}`] });
  fullFlow(fx);
  trials.register([{ family_id: FAMILY, market: 'CRYPTO_USDM_PERP', study_ref: STUDY, k2_sha256: fx.k2Sha, stage: 'BOOK', role: 'REPORT_ONLY_VARIANT', config_label: 'ADHOC', rule_config: extra }], { registeredBy: AUTH, registeredAt: AFTER, mode: 'UNPLANNED_RUN' });
  assert.equal(importOne(fx)[0].trial_gates.run_log_runs, 4);
  assert.equal(trials.count(FAMILY).n_raw, 3, 'T、T_VAR、ADHOC；基线不计');
});

test('封存日在生效日及以后却没写 k2_frozen_at → 拒绝（判断不了就失败即关）；时间不带时区 → 拒绝', () => {
  rejects(fixture({ entryPatch: { k2_frozen_at: undefined } }), 'K2_FROZEN_AT_MISSING', () => {});
  rejects(fixture({ entryPatch: { k2_frozen_at: '2026-11-12 10:00' } }), 'K2_FROZEN_AT_INVALID', () => {});
});

test('两道门不放松已有的门：过门的题照样先过 sha256、结论期望值等原有校验，错误码不变', () => {
  const fx = fixture({ entryPatch: { expect: '不做' } });
  fullFlow(fx);
  assert.throws(() => importOne(fx), (e) => e.code === 'OVERSEAS_VERDICT_VERDICT_NOT_AS_REGISTERED');
  const fx2 = fixture();
  const out = stage(fx2);
  fs.appendFileSync(path.join(out, 'smartflow', fx2.entry.file.commit.slice(0, 12), fx2.entry.file.path), ' ');
  assert.throws(() => importOne(fx2, out), (e) => e.code === 'OVERSEAS_VERDICT_SHA256_MISMATCH');
  // 运行日志也按 sha256 复验
  for (const f of [trials.TRIALS(), trials.DISCLOSURES()]) fs.rmSync(f, { force: true });
  const fx3 = fixture();
  fullFlow(fx3);
  const out3 = stage(fx3);
  fs.appendFileSync(path.join(out3, 'smartflow', fx3.entry.run_log.commit.slice(0, 12), fx3.entry.run_log.path), ' ');
  assert.throws(() => importOne(fx3, out3), (e) => e.code === 'OVERSEAS_VERDICT_SHA256_MISMATCH');
});

test('A 股导入器走同一套门', () => {
  const fx = fixture();
  const entry = { ...fx.entry, id: 'CN-R99', strategy_ref: 'INDEX_BOOK' };
  const repoV6 = fx.repo; // 同一个合成仓库，按 ashare-v6 来源取字节
  const swap = (spec) => (spec && spec.source === 'smartflow' ? { ...spec, source: 'ashare-v6' } : spec);
  const cn = { ...entry, file: swap(entry.file), k2: swap(entry.k2), run_log: swap(entry.run_log) };
  const out = tmp('qrp-tg-cn-');
  ashare.stageEvidence({ ashareV6Root: repoV6, artifactsRoot: fx.art, out, entries: [cn] });
  assert.throws(() => ashare.importVerdicts(out, { registeredBy: AUTH, entries: [cn] }), (e) => e.code === 'TRIAL_LEDGER_PRE_NOT_REGISTERED');
});

// ── 导入规格修订 4：门的裁定（凯利 m 前推门裁定，99203316…） ─────────────────────────

const LATE = '2026-11-12T10:20:00+08:00';
const FIRST_RUN = '2026-11-12T10:30:00+08:00';
const CODES = ['PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN', 'PRE_NO_TRIAL_ID_IN_K2'];
const RULING_TEXT = '# R99 门的裁定\n\nG-TRIAL-PRE 记 DEVIATION_ACCEPTED：PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN、PRE_NO_TRIAL_ID_IN_K2。披露行 DSR、PBO 写 NOT_APPLICABLE。\n';
const reset = () => { for (const f of [overseas.LEDGER(), trials.TRIALS(), trials.DISCLOSURES()]) fs.rmSync(f, { force: true }); };

/** 合成题加门的裁定：K2 不写台账 id，冻结后、首次计算前预登记。 */
function ruled({ text = RULING_TEXT, pre = {}, na = ['dsr', 'pbo'], fixtureOpts = {} } = {}) {
  const fx = fixture({ named: [], ...fixtureOpts });
  fs.writeFileSync(path.join(fx.art, 'R99_RULING.md'), text);
  const spec = { source: 'coordinator', path: 'R99_RULING.md', sha256: sha(text), ref: 'artifacts/coordinator/R99_RULING.md' };
  fx.rulingSha = spec.sha256;
  fx.entry = { ...fx.entry, trial_gates_ruling: { spec, pre: { status: 'DEVIATION_ACCEPTED', codes: CODES, preregistered_at: LATE, first_run_at: FIRST_RUN, ...pre }, ...(na ? { disclosure_not_applicable: na } : {}) } };
  return fx;
}
function discloseNa(k2Sha, rulingSha, patch = {}) {
  return trials.discloseNotApplicable({ family_id: FAMILY, study_ref: STUDY, k2_sha256: k2Sha, verdict_trial_id: idOf('T'), original_verdict: { decision: '做', strength: 'INSUFFICIENT' },
    not_applicable: { fields: ['dsr', 'pbo'], reason_zh: '不比收益，没有收益序列', ruling: { ref: 'artifacts/coordinator/R99_RULING.md', sha256: rulingSha } }, ...patch }, { registeredBy: AUTH, registeredAt: AFTER });
}
const ruledFlow = (fx, { at = LATE } = {}) => { preregister(fx.k2Sha, { at }); results(); discloseNa(fx.k2Sha, fx.rulingSha); };

test('修订 4：K2 没写 id、冻结后首次计算前预登记 → PRE 记 DEVIATION_ACCEPTED（不记 PASS），锁里写裁定页 sha 与三个时刻；披露行 DSR、PBO 不适用', () => {
  const fx = ruled({ fixtureOpts: { runLogExtra: { first_run_at: FIRST_RUN } } });
  ruledFlow(fx);
  const [row] = importOne(fx);
  assert.equal(row.decision, '做');
  assert.equal(row.trial_gates.pre, 'DEVIATION_ACCEPTED');
  assert.equal(row.trial_gates.seal, 'PASS');
  assert.deepEqual(row.trial_gates.pre_deviation, { codes: CODES, k2_frozen_at: FROZEN, preregistered_at: LATE, first_run_at: FIRST_RUN, late_registrations: 3 });
  assert.deepEqual(row.trial_gates.disclosure_not_applicable, ['dsr', 'pbo']);
  assert.equal(row.trial_gates.ruling_sha256, fx.rulingSha);
  assert.ok(row.refs.some((r) => r.role === 'RULING' && r.sha256 === fx.rulingSha));
  const [d] = trials.disclosures({ family_id: FAMILY });
  assert.equal(d.dsr, 'NOT_APPLICABLE');
  assert.equal(d.pbo, 'NOT_APPLICABLE');
  assert.equal(d.n_raw, 2, 'T、T_VAR；基线不计');
  assert.equal(d.new_configs, 2);
  assert.equal(d.unknown.sr_hat, 'NO_RETURN_SERIES_DSR_NOT_APPLICABLE');
  assert.equal(d.inputs.not_applicable.ruling_sha256, fx.rulingSha);
  assert.equal(d.evidence_gate.applied, false, '「做 · 证据不足」本来就不过证据闸门');
});

test('修订 4：没有裁定时同样的事实照旧拒绝；裁定写的事实不成立、越界或与披露行不一致 → 拒绝', () => {
  rejects(fixture({ named: [] }), 'PRE_NO_TRIAL_ID_IN_K2', (fx) => { preregister(fx.k2Sha, { at: LATE }); });
  reset();
  rejects(fixture(), 'SEAL_DISCLOSURE_NOT_APPLICABLE_WITHOUT_RULING', (fx) => { preregister(fx.k2Sha); results(); discloseNa(fx.k2Sha, 'a'.repeat(64)); });
  reset();
  rejects(ruled(), 'PRE_REGISTERED_AFTER_FIRST_RUN', (fx) => ruledFlow(fx, { at: '2026-11-12T10:40:00+08:00' }));
  reset();
  rejects(ruled({ fixtureOpts: { named: ['T', 'T_VAR', 'B'] } }), 'RULING_FACT_NOT_HOLD', ruledFlow);
  reset();
  rejects(ruled({ pre: { preregistered_at: BEFORE } }), 'RULING_FACT_NOT_HOLD', (fx) => ruledFlow(fx, { at: BEFORE }));
  reset();
  rejects(ruled({ pre: { preregistered_at: '2026-11-12T10:21:00+08:00' } }), 'RULING_FACT_NOT_HOLD', ruledFlow);
  reset();
  rejects(ruled({ fixtureOpts: { runLogExtra: { first_run_at: '2026-11-12T10:31:00+08:00' } } }), 'RULING_FACT_NOT_HOLD', ruledFlow);
  reset();
  rejects(ruled({ text: '# 裁定\n\nDEVIATION_ACCEPTED PRE_NO_TRIAL_ID_IN_K2 NOT_APPLICABLE\n' }), 'RULING_TEXT_DOES_NOT_STATE', ruledFlow);
  reset();
  rejects(ruled({ pre: { codes: ['PRE_NOT_REGISTERED'] } }), 'RULING_PRE_CODE_INVALID', ruledFlow);
  reset();
  rejects(ruled({ pre: { status: 'PASS' } }), 'RULING_PRE_STATUS_INVALID', ruledFlow);
  reset();
  rejects(ruled({ na: null }), 'SEAL_DISCLOSURE_NOT_APPLICABLE_WITHOUT_RULING', ruledFlow);
  reset();
  rejects(ruled(), 'SEAL_DISCLOSURE_RULING_MISMATCH', (fx) => { preregister(fx.k2Sha, { at: LATE }); results(); discloseNa(fx.k2Sha, 'f'.repeat(64)); });
  reset();
  rejects(ruled({ fixtureOpts: { entryPatch: { k2_frozen_at: '2026-11-09T20:00:00+08:00', sealed_on: '2026-11-10' } } }), 'RULING_ON_UNGATED_ENTRY', () => {});
});

test('修订 4：disclose-na 只放行 dsr、pbo，必须引用按 sha256 绑定的裁定；「做 · 有支持证据」照样被证据闸门降级', () => {
  const fx = ruled();
  preregister(fx.k2Sha, { at: LATE });
  results();
  const ruling = { ref: 'artifacts/coordinator/R99_RULING.md', sha256: fx.rulingSha };
  const bad = (notApplicable, code) => assert.throws(() => discloseNa(fx.k2Sha, fx.rulingSha, { not_applicable: notApplicable }), (e) => e.code === `TRIAL_LEDGER_${code}`, code);
  bad({ fields: ['dsr', 'pbo', 'n_hat'], reason_zh: 'x', ruling }, 'DISCLOSURE_NOT_APPLICABLE_FIELDS');
  bad({ fields: ['dsr'], reason_zh: 'x', ruling }, 'DISCLOSURE_NOT_APPLICABLE_FIELDS');
  bad({ fields: ['dsr', 'pbo'], reason_zh: 'x', ruling: { ref: 'r', sha256: 'abc' } }, 'DISCLOSURE_NOT_APPLICABLE_NEEDS_RULING');
  bad({ fields: ['dsr', 'pbo'], reason_zh: '', ruling }, 'DISCLOSURE_NOT_APPLICABLE_REASON_REQUIRED');
  assert.equal(trials.disclosures().length, 0, '失败即关：不写披露行');
  const row = discloseNa(fx.k2Sha, fx.rulingSha, { original_verdict: { decision: '做', strength: 'SUPPORTED' } });
  assert.equal(row.evidence_gate.downgraded, true);
  assert.equal(row.evidence_gate.strength, 'INSUFFICIENT');
});
