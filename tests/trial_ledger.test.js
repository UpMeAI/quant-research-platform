'use strict';
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const trials = require('../services/trial-ledger');
const overfit = require('../services/trial-ledger/overfit');
const backRegister = require('../services/trial-ledger/back_register');
const { validateRecord } = require('../schemas');
const { read, dataDir } = require('../packages/ledger');

const AUTH = 'TEST_TRIAL_AUTHORITY';
const K2 = 'a'.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const opts = (extra = {}) => ({ registeredBy: AUTH, registeredAt: '2026-11-12T01:00:00Z', ...extra });
const spec = (label, extra = {}) => ({ family_id: 'US_V5_ETF_3000USD', market: 'US_EQUITY', study_ref: 'R99', k2_sha256: K2, stage: 'BOOK', role: 'VERDICT_ARM', config_label: label, rule_config: { arm: label }, ...extra });
const months = (n, c, phase = 0) => Array.from({ length: n }, (_, i) => ({ month: `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, d: 0.01 * Math.sin(i * 1.3 + phase) + c }));
const ALL_FILES = () => [trials.TRIALS(), trials.SEGMENTS(), trials.DISCLOSURES(), ...backRegister.LOCK_SOURCES.map((s) => path.join(dataDir('research'), s.file))];

test.beforeEach(() => { process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH; for (const f of ALL_FILES()) fs.rmSync(f, { force: true }); });

test('登记：只有完成权威能写；PREREGISTERED 要 K2 sha256；rule_config 不许含成本、时点、引擎；整批先校验', () => {
  assert.throws(() => trials.register(spec('T'), { registeredBy: 'someone' }), (e) => e.code === 'TRIAL_LEDGER_REGISTERED_BY_NOT_AUTHORIZED');
  assert.throws(() => trials.register(spec('T', { k2_sha256: null }), opts()), (e) => e.code === 'TRIAL_LEDGER_PREREGISTERED_NEEDS_K2_SHA256');
  assert.throws(() => trials.register(spec('T', { rule_config: { arm: 'T', costs: { bp: 15 } } }), opts()), (e) => e.code === 'TRIAL_LEDGER_RULE_CONFIG_HAS_EVAL_KEY');
  assert.throws(() => trials.register([spec('T'), spec('X', { role: 'NOPE' })], opts()), (e) => e.code === 'TRIAL_LEDGER_ROLE_INVALID');
  assert.equal(read(trials.TRIALS()).length, 0, '整批失败不写任何行');
});

test('登记幂等；同 id 不同内容拒绝；规范 JSON 与键顺序无关', () => {
  const [a] = trials.register(spec('T', { rule_config: { b: 1, a: [1, { y: 2, x: 1 }] } }), opts());
  const [again] = trials.register(spec('T', { rule_config: { a: [1, { x: 1, y: 2 }], b: 1 } }), opts({ registeredAt: '2026-11-13T00:00:00Z' }));
  assert.equal(again.replayHit, true);
  assert.equal(again.trial_id, a.trial_id);
  assert.throws(() => trials.register(spec('T', { rule_config: { a: 2 } }), opts()), (e) => e.code === 'TRIAL_LEDGER_ALREADY_REGISTERED');
  assert.equal(read(trials.TRIALS()).length, 1);
  assert.match(a.trial_id, trials.TRIAL_ID);
  assert.equal(a.trial_id, trials.trialIdOf(spec('T')), 'trial_id 在 K2 写出之前就能算');
});

test('N（★2）：计入 N 的角色里不同 rule_config_hash 的个数；压力、基线、复现、零信息、WFO 折不计；UNCOUNTED_HISTORY 加下限并标「下限」', () => {
  trials.register([
    spec('T'), spec('T_VAR', { role: 'REPORT_ONLY_VARIANT' }), spec('DIAG', { role: 'DIAGNOSTIC_ARM' }), spec('SIG', { role: 'SIGNAL_TEST', stage: 'SIGNAL' }),
    spec('T@15bp', { role: 'STRESS', rule_config: { arm: 'T' } }), spec('B', { role: 'BASELINE' }), spec('REPRO', { role: 'REPRO' }), spec('NULL', { role: 'NULL_DRAW' }), spec('F1', { role: 'WFO_FOLD', stage: 'WFO' }),
    spec('T-again-in-R100', { study_ref: 'R100', rule_config: { arm: 'T' } }),
  ], opts());
  let n = trials.count('US_V5_ETF_3000USD');
  assert.equal(n.n_raw, 4, 'T（R99 与 R100 同配置只算一次）、T_VAR、DIAG、SIG');
  assert.equal(n.n_is_lower_bound, false);
  trials.register([{ ...spec('UNCOUNTED'), role: 'UNCOUNTED_HISTORY', rule_config: { uncounted: 'smartflow-2026-09' }, uncounted_lower_bound: 7, source_refs: [{ ref: 'smartflow docs' }] }], opts({ mode: 'BACK_REGISTERED' }));
  n = trials.count('US_V5_ETF_3000USD');
  assert.equal(n.n_raw, 11);
  assert.equal(n.n_is_lower_bound, true);
  assert.deepEqual(n.lower_bound_reasons, ['UNCOUNTED_HISTORY×1']);
  assert.equal(trials.count('US_V5_ETF_3000USD', { asOf: '2026-11-01T00:00:00Z' }).n_raw, 0, 'as_of 之前没有登记');
  assert.throws(() => trials.register([{ ...spec('U2'), role: 'UNCOUNTED_HISTORY', uncounted_lower_bound: 1, source_refs: [{}] }], opts()), (e) => e.code === 'TRIAL_LEDGER_UNCOUNTED_HISTORY_ONLY_BACK_REGISTERED');
});

test('记结果：月度序列算出 ŜR、γ3、γ4、T；账本级试验没有序列必须写原因；只记一次；更正追加并带缺陷引用', () => {
  const [t] = trials.register([spec('T'), spec('T_VAR', { role: 'REPORT_ONLY_VARIANT' })], opts());
  const res = { window: { from: '2020-01-01', to: '2022-06-30' }, eval: { costs: { bp: 5 }, timing: 'SCAN_MAIN', code_sha: 'c'.repeat(40) }, metrics: { n_trades: 31, delta_g: 0.012 }, months: months(30, 0.003), study_verdict: '不做' };
  const row = trials.recordResult(t.trial_id, res, opts());
  const m = overfit.moments(res.months.map((x) => x.d));
  assert.equal(row.sr_monthly_delta, m.sr);
  assert.equal(row.t_months, 30);
  assert.deepEqual(row.segments, ['SEEN'], '没有标签的日期一律当 SEEN');
  assert.equal(row.unknown['metrics.mdd'], 'NOT_REPORTED');
  assert.throws(() => trials.recordResult(t.trial_id, res, opts()), (e) => e.code === 'TRIAL_LEDGER_RESULT_ALREADY_RECORDED');
  assert.throws(() => trials.recordResult(trials.trialIdOf(spec('T_VAR')), { window: res.window, metrics: {} }, opts()), (e) => e.code === 'TRIAL_LEDGER_BOOK_TRIAL_NEEDS_SERIES_OR_UNKNOWN_REASON');
  assert.throws(() => trials.recordResult(trials.trialIdOf(spec('T_VAR')), { ...res, metrics: { sharpe: 1 } }, opts()), (e) => e.code === 'TRIAL_LEDGER_METRIC_KEY_UNKNOWN');
  assert.throws(() => trials.correct(t.trial_id, res, opts()), (e) => e.code === 'TRIAL_LEDGER_CORRECTION_NEEDS_DEFECT_REF');
  const fixed = trials.correct(t.trial_id, { ...res, metrics: { n_trades: 32, delta_g: 0.012 } }, opts({ defectRef: 'DEFECT-1' }));
  assert.equal(fixed.supersedes, row.record_hash);
  assert.equal(read(trials.TRIALS()).filter((r) => r.trial_id === t.trial_id).length, 3, '历史行全在');
  for (const r of read(trials.TRIALS())) assert.equal(validateRecord(r).ok, true, JSON.stringify(validateRecord(r).problems));
});

test('数据段：没标的当 SEEN；后写的覆盖先写的；前向保留只对该影子的候选写出', () => {
  trials.markSegments([
    { family_id: 'C17_V2_4000USDT', market: 'CRYPTO_USDM_PERP', from: '2020-01-01', to: '2026-11-10', label: 'SEEN', seen_kind: 'SEEN_DATA', reason: 'test' },
    { family_id: 'C17_V2_4000USDT', market: 'CRYPTO_USDM_PERP', from: '2019-01-01', to: '2019-12-31', label: 'UNSEEN', reason: 'test' },
    { family_id: 'C17_V2_4000USDT', market: 'CRYPTO_USDM_PERP', from: '2026-11-04', to: '2027-04-30', label: 'FORWARD_RESERVED', shadow_ref: 'C17-N8-SHADOW', reason: 'test' },
  ], opts());
  const s = trials.segmentsFor('C17_V2_4000USDT', '2018-12-30', '2026-11-12');
  assert.deepEqual(s.pieces.map((p) => [p.from, p.to, p.label]), [['2018-12-30', '2018-12-31', 'SEEN'], ['2019-01-01', '2019-12-31', 'UNSEEN'], ['2020-01-01', '2026-11-10', 'SEEN'], ['2026-11-11', '2026-11-12', 'SEEN']]);
  assert.equal(s.pieces[0].source, 'UNMARKED_DEFAULT_SEEN');
  assert.deepEqual(trials.segmentLabels('C17_V2_4000USDT', '2026-11-01', '2026-11-12'), ['SEEN:SEEN_DATA', 'SEEN']);
  assert.deepEqual(trials.segmentLabels('C17_V2_4000USDT', '2026-11-01', '2026-11-12', { shadowRef: 'C17-N8-SHADOW' }), ['SEEN:SEEN_DATA', 'SEEN', 'FORWARD_RESERVED:C17-N8-SHADOW']);
  assert.throws(() => trials.markSegments({ family_id: 'X', market: 'Y', from: '2020-01-01', to: '2020-02-01', label: 'FORWARD_RESERVED', reason: 'r' }, opts()), (e) => e.code === 'TRIAL_LEDGER_SHADOW_REF_ONLY_FOR_FORWARD_LABELS');
});

/** 一族：判定臂 T 加 n 个别的账本级试验，各有月度序列。 */
function familyWithResults(nOthers, tShift = 0.004) {
  const labels = ['T', ...Array.from({ length: nOthers }, (_, i) => `V${i}`)];
  trials.register(labels.map((l) => spec(l, { role: l === 'T' ? 'VERDICT_ARM' : 'REPORT_ONLY_VARIANT' })), opts());
  labels.forEach((l, i) => trials.recordResult(trials.trialIdOf(spec(l)), { window: { from: '2020-01-01', to: '2022-12-31' }, metrics: {}, months: l === 'T' ? months(36, tShift) : months(36, 0.001 * i, i) }, opts()));
  return months(36, tShift);
}

test('披露：已知 ŜR ≥ 5 → DSR 有数，与 overfit.js 复算一致；DSR < 0.95 的「做 · 有支持证据」降为「做 · 证据不足」，不判不做', () => {
  const m = familyWithResults(5, 0.0005);
  const row = trials.disclose({ family_id: 'US_V5_ETF_3000USD', study_ref: 'R99', k2_sha256: K2, verdict_trial_id: trials.trialIdOf(spec('T')), months: m, seed: 1, original_verdict: { decision: '做', strength: 'SUPPORTED' } }, opts());
  const sharpes = trials.familySharpes('US_V5_ETF_3000USD').map((s) => s.sr);
  const re = overfit.deflatedSharpe({ d: m.map((x) => x.d), N: 6, familySharpes: sharpes });
  assert.equal(row.n_raw, 6);
  assert.equal(row.dsr, re.dsr);
  assert.ok(row.dsr < 0.95);
  assert.equal(row.fallback, null, 'DSR 有数时不用回退');
  assert.equal(row.pbo, 'NOT_APPLICABLE');
  assert.deepEqual([row.evidence_gate.decision, row.evidence_gate.strength, row.evidence_gate.downgraded], ['做', 'INSUFFICIENT', true]);
  assert.equal(row.new_configs, 6);
  assert.equal(validateRecord(row).ok, true, JSON.stringify(validateRecord(row).problems));
  assert.throws(() => trials.disclose({ family_id: 'US_V5_ETF_3000USD', study_ref: 'R99', k2_sha256: K2, verdict_trial_id: trials.trialIdOf(spec('T')), months: m, seed: 1, original_verdict: { decision: '做', strength: 'SUPPORTED' } }, opts()), (e) => e.code === 'TRIAL_LEDGER_DISCLOSURE_EXISTS_SUPERSEDE_WITH_DEFECT');
});

test('披露：已知 ŜR < 5（★5）→ DSR 为 UNKNOWN，改用按族 N 的 Bonferroni；「不做」原样', () => {
  const m = familyWithResults(2, 0.02);
  const row = trials.disclose({ family_id: 'US_V5_ETF_3000USD', study_ref: 'R99', k2_sha256: K2, verdict_trial_id: trials.trialIdOf(spec('T')), months: m, seed: 20261110, original_verdict: { decision: '不做', strength: null } }, opts());
  assert.equal(row.dsr, 'UNKNOWN');
  assert.equal(row.unknown.dsr, 'KNOWN_SR_LT_5');
  assert.deepEqual([row.fallback.method, row.fallback.N, row.fallback.B], ['BONFERRONI_BY_FAMILY_N', 3, 10000]);
  assert.equal(row.fallback.pass, true);
  assert.deepEqual([row.evidence_gate.decision, row.evidence_gate.downgraded], ['不做', false]);
  assert.throws(() => trials.disclose({ family_id: 'US_V5_ETF_3000USD', study_ref: 'R99', k2_sha256: K2, verdict_trial_id: trials.trialIdOf(spec('T')), months: months(36, 0.5), seed: 1, original_verdict: { decision: '做' }, supersedes: row.record_hash, defect_ref: 'D' }, opts()), (e) => e.code === 'TRIAL_LEDGER_SERIES_DOES_NOT_MATCH_TRIAL_ROW');
});

// ── 补登记 ──────────────────────────────────────────────────────────────────────

function writeLocks() {
  const dir = dataDir('research');
  fs.mkdirSync(dir, { recursive: true });
  const w = (file, rows) => fs.writeFileSync(path.join(dir, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ref = (role, s) => ({ role, ref: role, sha256: s.repeat(64).slice(0, 64), file_ref: '/x' });
  w('overseas_sealed_verdicts.jsonl', [
    { schema: 'OVERSEAS_SEALED_VERDICT_LOCK_V1', result_id: 'OSV-C17-N9-old', entry_id: 'C17-N9', kind: 'STATUS', strategy_ref: 'C17_V2_4000USDT', decision: '运行中', file_sha256: '1'.repeat(64), refs: [ref('FILE', '1')] },
    { schema: 'OVERSEAS_SEALED_VERDICT_LOCK_V1', result_id: 'OSV-C17-N9-new', entry_id: 'C17-N9', kind: 'RESULT', strategy_ref: 'C17_V2_4000USDT', decision: '不做', file_sha256: '2'.repeat(64), refs: [ref('FILE', '2'), ref('K2', '3'), ref('FREEZE', '4')] },
    { schema: 'OVERSEAS_SEALED_VERDICT_LOCK_V1', result_id: 'OSV-US5-Q0X', entry_id: 'US5-Q0X', kind: 'RESULT', strategy_ref: 'US_V5_ETF_3000USD', decision: '做', file_sha256: '5'.repeat(64), refs: [ref('FILE', '5')] },
    { schema: 'OVERSEAS_SEALED_VERDICT_LOCK_V1', result_id: 'OSV-SHADOW', entry_id: 'US5-SH', kind: 'STATUS', strategy_ref: 'US_V5_ETF_3000USD', decision: '前向影子运行中', file_sha256: '6'.repeat(64), refs: [ref('FILE', '6')] },
  ]);
  w('baseline_evaluations.jsonl', [{ schema: 'BASELINE_EVALUATION_LOCK_V1', result_id: 'Q0-x', strategy_ref: 'US_V5_ETF_3000USD', verdict_state: 'INSUFFICIENT', file_sha256: '7'.repeat(64) }]);
}
function writeMaster(items) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-mt-')), 'MASTER.json');
  fs.writeFileSync(file, JSON.stringify({ revision: 56, items }));
  return { file, sha: sha(fs.readFileSync(file)) };
}
const ITEMS = [
  { id: 'C99', market: '加密', status: '已出结论', layer: '诊断', auth: ['x 2222222222 y'] },
  { id: 'U99', market: '美股', status: '已出结论', layer: '诊断（全策略基线）', auth: ['y 55555555'] },
  { id: 'R6', market: '跨市场', status: '已出结论', layer: '选股择时层', auth: ['no sha here'] },
  { id: 'X02', market: '跨市场', status: '已出结论', layer: '不适用（工程）', auth: [] },
  { id: 'Z1', market: '美股', status: '未跑', layer: '选股择时层', auth: [] },
];

test('补登记：锁 head 与总表配对；STATUS 与被取代的锁不登记；总表自立单元按族各登记一份；工程行跳过；N 标下限', () => {
  writeLocks();
  const mt = writeMaster(ITEMS);
  const out = backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH, registeredAt: '2026-11-12T00:00:00Z' });
  const byStudy = Object.fromEntries(out.rows.map((r) => [`${r.study_ref}|${r.family_id}`, r]));
  assert.deepEqual(Object.keys(byStudy).sort(), ['MASTER:R6|C17_V2_4000USDT', 'MASTER:R6|US_V5_ETF_3000USD', 'OSV:C17-N9|C17_V2_4000USDT', 'OSV:US5-Q0X|US_V5_ETF_3000USD', 'Q0:US_V5_ETF_3000USD|US_V5_ETF_3000USD'].sort());
  assert.equal(byStudy['OSV:C17-N9|C17_V2_4000USDT'].role, 'DIAGNOSTIC_ARM', '总表层「诊断」');
  assert.equal(byStudy['OSV:C17-N9|C17_V2_4000USDT'].k2_sha256, '3'.repeat(64));
  assert.equal(byStudy['OSV:US5-Q0X|US_V5_ETF_3000USD'].role, 'BASELINE', '总表层「诊断（全策略基线）」');
  assert.equal(byStudy['Q0:US_V5_ETF_3000USD|US_V5_ETF_3000USD'].role, 'BASELINE');
  for (const r of out.rows) { assert.equal(r.registration_mode, 'BACK_REGISTERED'); assert.ok(r.unknown.arms); assert.equal(validateRecord(r).ok, true); }
  assert.deepEqual(out.skipped.map((s) => s.id), ['X02']);
  const us5 = out.counts.find((c) => c.family_id === 'US_V5_ETF_3000USD');
  assert.deepEqual([us5.n_raw, us5.n_is_lower_bound], [1, true]);
  assert.equal(out.segmentRows.length, backRegister.SEGMENT_PLAN.length);
  const again = backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH });
  assert.ok(again.rows.every((r) => r.replayHit), '重跑是幂等重放');
  assert.equal(again.segmentRows.length, 0, '段标签不重复写');
});

test('补登记：dry run 不写；总表 sha256 不符、未配对且未登记族的行 → 拒绝', () => {
  writeLocks();
  const mt = writeMaster(ITEMS);
  const dry = backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH, dryRun: true });
  assert.equal(dry.rows.length, 5);
  assert.equal(read(trials.TRIALS()).length, 0);
  assert.equal(read(trials.SEGMENTS()).length, 0);
  assert.throws(() => backRegister.run({ masterTable: mt.file, masterTableSha256: 'b'.repeat(64), registeredBy: AUTH, dryRun: true }), (e) => e.code === 'TRIAL_LEDGER_BACKREG_MASTER_TABLE_SHA256_MISMATCH');
  const bad = writeMaster([...ITEMS, { id: 'Q77', market: '美股', status: '已出结论', layer: '选股择时层', auth: [] }]);
  assert.throws(() => backRegister.run({ masterTable: bad.file, masterTableSha256: bad.sha, registeredBy: AUTH, dryRun: true }), (e) => e.code === 'TRIAL_LEDGER_BACKREG_MASTER_ROW_UNMAPPED');
});

test('补登记：K2 臂目录给出的题按臂登记，每个臂的 k2_quote 必须逐字出现在 sha256 复验过的 K2 里；N 不再因这题标下限', () => {
  writeLocks();
  const mt = writeMaster(ITEMS.filter((i) => i.id !== 'R6'));
  const k2File = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-k2-')), 'K2.md');
  fs.writeFileSync(k2File, '| `T` | BASE + S_M | 候选 |\n| `T_E200` | 只报 |\n');
  const k2 = sha(fs.readFileSync(k2File));
  const dir = dataDir('research');
  const lines = fs.readFileSync(path.join(dir, 'overseas_sealed_verdicts.jsonl'), 'utf8').replace(/3{64}/g, k2);
  fs.writeFileSync(path.join(dir, 'overseas_sealed_verdicts.jsonl'), lines);
  const arms = { studies: [{ study_ref: 'OSV:C17-N9', family_id: 'C17_V2_4000USDT', k2_sha256: k2, k2_file: k2File, arms: [
    { config_label: 'T', role: 'VERDICT_ARM', stage: 'BOOK', line_start: 1, line_end: 1, k2_quote: '| `T` | BASE + S_M | 候选 |' },
    { config_label: 'T_E200', role: 'REPORT_ONLY_VARIANT', stage: 'BOOK', line_start: 2, line_end: 2, k2_quote: '| `T_E200` | 只报 |' }] }] };
  const out = backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH, arms, dryRun: true });
  const c17 = out.rows.filter((r) => r.family_id === 'C17_V2_4000USDT');
  assert.deepEqual(c17.map((r) => r.config_label).sort(), ['T', 'T_E200']);
  const n = out.counts.find((c) => c.family_id === 'C17_V2_4000USDT');
  assert.deepEqual([n.n_raw, n.n_is_lower_bound], [2, false]);
  arms.studies[0].arms[1].k2_quote = '| `T_E300` |';
  assert.throws(() => backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH, arms, dryRun: true }), (e) => e.code === 'TRIAL_LEDGER_BACKREG_ARM_NOT_IN_K2_TEXT');
});

test('补登记：K2 臂必须钉住有效原文行号，引用只能来自该行段', () => {
  writeLocks();
  const mt = writeMaster(ITEMS.filter((i) => i.id !== 'R6'));
  const k2File = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-k2-lines-')), 'K2.md');
  fs.writeFileSync(k2File, '标题\n| `T` | 判定候选 |\n| `RO-1` | 只报 |\n');
  const k2 = sha(fs.readFileSync(k2File));
  const lockFile = path.join(dataDir('research'), 'overseas_sealed_verdicts.jsonl');
  fs.writeFileSync(lockFile, fs.readFileSync(lockFile, 'utf8').replace(/3{64}/g, k2));
  const entry = { study_ref: 'OSV:C17-N9', family_id: 'C17_V2_4000USDT', k2_sha256: k2, k2_file: k2File, arms: [
    { config_label: 'T', role: 'VERDICT_ARM', stage: 'BOOK', line_start: 2, line_end: 2, k2_quote: '| `T` | 判定候选 |' },
  ] };
  assert.doesNotThrow(() => backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH, arms: { studies: [entry] }, dryRun: true }));
  for (const invalid of [
    { line_start: 0, line_end: 2, k2_quote: '| `T` | 判定候选 |' },
    { line_start: 3, line_end: 2, k2_quote: '| `T` | 判定候选 |' },
    { line_start: 3, line_end: 3, k2_quote: '| `T` | 判定候选 |' },
  ]) {
    entry.arms[0] = { ...entry.arms[0], ...invalid };
    assert.throws(() => backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH, arms: { studies: [entry] }, dryRun: true }), (e) => e.code === 'TRIAL_LEDGER_BACKREG_ARM_SOURCE_LINES_INVALID' || e.code === 'TRIAL_LEDGER_BACKREG_ARM_NOT_IN_SOURCE_LINES');
  }
});

test('补登记：读不准的 K2 可显式 REVIEW，但仍复验文件哈希且不提升为已完整臂目录', () => {
  writeLocks();
  const mt = writeMaster(ITEMS.filter((i) => i.id !== 'R6'));
  const k2File = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-k2-review-')), 'K2.md');
  fs.writeFileSync(k2File, '候选组合边界仍待协调裁定\n');
  const k2 = sha(fs.readFileSync(k2File));
  const lockFile = path.join(dataDir('research'), 'overseas_sealed_verdicts.jsonl');
  fs.writeFileSync(lockFile, fs.readFileSync(lockFile, 'utf8').replace(/3{64}/g, k2));
  const catalogue = { studies: [{
    study_ref: 'OSV:C17-N9', family_id: 'C17_V2_4000USDT', k2_sha256: k2, k2_file: k2File,
    status: 'REVIEW', review_reason: '组合是否构成独立判定臂无法从冻结文本唯一确定',
  }] };
  const out = backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH, arms: catalogue, dryRun: true });
  const row = out.rows.find((r) => r.study_ref === 'OSV:C17-N9');
  assert.match(row.unknown.arms, /K2_ARMS_NOT_CATALOGUED/);
  assert.deepEqual(out.catalogueReview, [{ study_ref: 'OSV:C17-N9', family_id: 'C17_V2_4000USDT', reason: '组合是否构成独立判定臂无法从冻结文本唯一确定' }]);
  catalogue.studies[0].k2_sha256 = '0'.repeat(64);
  assert.throws(() => backRegister.run({ masterTable: mt.file, masterTableSha256: mt.sha, registeredBy: AUTH, arms: catalogue, dryRun: true }), (e) => e.code === 'TRIAL_LEDGER_BACKREG_ARMS_K2_MISMATCH');
});

test('命令行：hash、trial-id、count 只读；写命令要完成权威', () => {
  const cli = path.join(__dirname, '..', 'apps', 'research-cli', 'trial_ledger.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-cli-')), 'rc.json');
  fs.writeFileSync(file, JSON.stringify({ b: 1, a: 2 }));
  const env = { ...process.env, QRP_DATA_DIR: dataRoot };
  assert.equal(JSON.parse(execFileSync('node', [cli, 'hash', '--rule-config', file], { env })).rule_config_hash, trials.ruleConfigHash({ a: 2, b: 1 }));
  assert.equal(JSON.parse(execFileSync('node', [cli, 'trial-id', '--family', 'F', '--study', 'S', '--label', 'L'], { env })).trial_id, trials.trialIdOf({ family_id: 'F', study_ref: 'S', config_label: 'L' }));
  assert.equal(JSON.parse(execFileSync('node', [cli, 'count', '--family', 'NONE'], { env })).n_raw, 0);
  assert.throws(() => execFileSync('node', [cli, 'register', '--spec', file, '--registered-by', 'x'], { env: { ...env, QRP_PRODUCT_MILESTONE_AUTHORITY: 'y' }, stdio: 'pipe' }), /REGISTERED_BY_NOT_AUTHORIZED/);
});

test('命令行：每个子命令遇到未声明参数都 fail closed 且不写台账', async (t) => {
  const cli = path.join(__dirname, '..', 'apps', 'research-cli', 'trial_ledger.js');
  const env = { ...process.env, QRP_DATA_DIR: dataRoot, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH };
  const commands = ['register', 'record', 'correct', 'mark-segment', 'disclose', 'disclose-na', 'back-register', 'count', 'segments', 'hash', 'trial-id'];
  for (const command of commands) {
    await t.test(command, () => {
      const before = ALL_FILES().map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
      const run = spawnSync(process.execPath, [cli, command, '--not-a-real-flag', 'x'], { env, encoding: 'utf8' });
      assert.notEqual(run.status, 0);
      assert.equal(run.stderr.trim(), 'UNKNOWN_FLAG:not-a-real-flag');
      const after = ALL_FILES().map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
      assert.deepEqual(after, before);
    });
  }
});

test('命令行：mark-segment --dry-run true 打印含 mark_id 的计划且台账字节不变', () => {
  const cli = path.join(__dirname, '..', 'apps', 'research-cli', 'trial_ledger.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-cli-mark-dry-'));
  const input = path.join(dir, 'marks.json');
  fs.writeFileSync(input, JSON.stringify([{ family_id: 'C17_V2_4000USDT', market: 'CRYPTO_USDM_PERP', from: '2026-11-15', to: '2026-11-16', label: 'SEEN', seen_kind: 'SEEN_DATA', reason: 'test dry run' }]));
  const env = { ...process.env, QRP_DATA_DIR: dataRoot, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH };
  const file = trials.SEGMENTS();
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const run = spawnSync(process.execPath, [cli, 'mark-segment', '--spec', input, '--registered-by', AUTH, '--dry-run', 'true'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.match(rows[0].mark_id, /^SEG-/);
  const after = fs.existsSync(file) ? fs.readFileSync(file) : null;
  assert.deepEqual(after, before);
});

test('命令行：record / correct 不提供 dry run，显式拒绝 --dry-run 且不写台账', async (t) => {
  const cli = path.join(__dirname, '..', 'apps', 'research-cli', 'trial_ledger.js');
  const env = { ...process.env, QRP_DATA_DIR: dataRoot, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH };
  for (const command of ['record', 'correct']) {
    await t.test(command, () => {
      const before = ALL_FILES().map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
      const run = spawnSync(process.execPath, [cli, command, '--dry-run', 'true'], { env, encoding: 'utf8' });
      assert.notEqual(run.status, 0);
      assert.equal(run.stderr.trim(), 'UNKNOWN_FLAG:dry-run');
      const after = ALL_FILES().map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
      assert.deepEqual(after, before);
    });
  }
});

test('命令行：back-register 只要带 --arms 就必须钉住 --arms-sha256，缺失或不符都在读总表前关停', () => {
  const cli = path.join(__dirname, '..', 'apps', 'research-cli', 'trial_ledger.js');
  const arms = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-cli-arms-')), 'arms.json');
  fs.writeFileSync(arms, JSON.stringify({ schema: 'K2_ARMS_CATALOGUE_V2', studies: [] }));
  const common = ['back-register', '--master-table', '/not/read/master.json', '--master-table-sha256', 'a'.repeat(64), '--registered-by', AUTH, '--arms', arms, '--dry-run', 'true'];
  const env = { ...process.env, QRP_DATA_DIR: dataRoot, QRP_PRODUCT_MILESTONE_AUTHORITY: AUTH };
  assert.throws(() => execFileSync('node', [cli, ...common], { env, stdio: 'pipe' }), /MISSING_FLAG:arms-sha256/);
  assert.throws(() => execFileSync('node', [...[cli, ...common.slice(0, -2)], '--arms-sha256', '0'.repeat(64), '--dry-run', 'true'], { env, stdio: 'pipe' }), /ARMS_SHA256_MISMATCH/);
});
