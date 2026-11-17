'use strict';
/**
 * G-MECH、K2 §0 四行、AI 输入检查（研究框架修订 2026-11-12 §4.4、§5、§2.4；冻结审阅 E12–E15 取 (a)），接进海外与 A 股封存结论导入器。
 *   - 只对修订冻结之后才冻结的 K2：EFFECTIVE_FROM 为 null（修订未冻结）时门不适用，锁行逐字节不变；
 *   - 适用时：§0 四个标签都在且不为空；第 1 行的 id = entry.mechanism_ids，且都在冻结时刻那一版登记表里；
 *     先前结论表按 sha256 绑定、写进 K2 正文，用那一版登记表与 as_of 之前的标签重算逐字节相同，as_of 不晚于 K2 冻结；
 *     entry.ai_inputs 必须有，类别只有 EXTRACTED_FACT，与第 4 行一致；
 *   - 门只拒绝导入（失败即关），不改结论。
 * 全部用合成夹具。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const mech = require('../services/research-mechanism-register');
const amendment = require('../services/research-framework-amendment-20261112');
const ashare = require('../services/ashare-sealed-verdicts');
const gate = require('../services/research-mechanism-register/gate');
const overseas = require('../services/overseas-sealed-verdicts');
const trials = require('../services/trial-ledger');
const { read } = require('../packages/ledger');
// G-COST（附录 1）：本文件的合成 K2 在 11-17 之后冻结，在成本门的范围内；附录 1 冻结前门失败即关，本进程换一页合成的已绑定冻结页
require('../services/cost-gate').internals.setDefaults({ freeze: { path: 'synthetic', sha256: 'a'.repeat(64), state: 'FREEZE_1', texts: [{ id: 'DRAFT_REV_1', sha256: 'b'.repeat(64) }] } });

const AUTH = 'TEST_MECH_GATE_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();

const EFFECTIVE = '2026-11-16T12:00:00+08:00';
const FROZEN = '2026-11-17T10:00:00+08:00';
const TABLE_AS_OF = '2026-11-17T09:30:00+08:00';
const PREREG_AT = '2026-11-17T09:00:00+08:00';
const RESULT_AT = '2026-11-25T09:00:00+08:00';
const FAMILY = 'C17_V2_4000USDT';
const ID_A = 'SEL.KLINE_VETO.AT_LEVEL';
const ID_B = 'RISK.MARKET_STATE.DIRECTION_SWITCH';
const COMMIT = 'e'.repeat(40);

const REGISTER_DOC = {
  _comment: '合成夹具',
  contract: mech.CONTRACT,
  contract_ref: { path: mech.AMENDMENT.path, sha256: `${mech.AMENDMENT.sha_prefix}${'0'.repeat(64 - mech.AMENDMENT.sha_prefix.length)}`, state: mech.AMENDMENT.state,
    texts: mech.AMENDMENT.texts.map((t) => ({ id: t.id, path: t.path, sha256: `${t.sha_prefix}${'0'.repeat(56)}` })), ref_zh: '合成' },
  registered_at: '2026-11-16T22:00:00+08:00',
  registered_by: '测试',
  mechanisms: [
    { mechanism_id: ID_A, title_zh: '结构位 K 线否决', layer: 'SELECTION_TIMING', decision_point: 'ENTRY', description_zh: '在结构位出现反向 K 线时不入场' },
    { mechanism_id: ID_B, title_zh: '市场状态方向开关', layer: 'RISK', decision_point: 'SIZING', description_zh: '按市场状态调 k' },
  ],
  entries: [],
};
const REGISTER_BYTES = Buffer.from(`${JSON.stringify(REGISTER_DOC, null, 2)}\n`);
const registerAt = (commit) => (commit === COMMIT ? REGISTER_BYTES : null);

function tableFor({ ids = [ID_A], market = 'CRYPTO', asOf = TABLE_AS_OF, commit = COMMIT, registerBytes = REGISTER_BYTES } = {}) {
  return mech.tableBytes(mech.query({ mechanism_ids: ids, market }, { registerBytes, registerCommit: commit, marks: [], asOf }));
}

/** K2 正文：§0 四行 + 台账 id。lines 可覆盖任一行（null = 删去这一行）。 */
function k2Text({ tableSha, ids = [ID_A], lines = {}, trialIds = [] } = {}) {
  const base = {
    1: `**机制**：结构位反向 K 线否决入场（${ids.join('、')}）`,
    2: '**预期失效方式**：单边趋势市里，结构位频繁被突破时不起作用',
    3: '**可能被哪条现行规则解释**：现行入场过滤（只报重叠交易占比）',
    4: '**AI 输入**：无',
  };
  const merged = { ...base, ...lines };
  const section0 = [1, 2, 3, 4].map((n) => merged[n]).filter((line) => line !== null).map((line, i) => `${i + 1}. ${line}`).join('\n');
  return `# RM K2\n\n## 0 结论先行\n\n${section0}\n\n先前结论表：MECHANISM_PRIOR_TABLE_V1 sha256 ${tableSha}\n\n## 4 候选\n${trialIds.map((id) => `- 台账 ${id}`).join('\n')}\n`;
}

/** 门的单元夹具：entry + 文件字节。 */
function unit({ ids = [ID_A], aiInputs = [], k2 = {}, table = {}, entryPatch = {} } = {}) {
  const tableBytes = table.bytes || tableFor(table);
  const tableSha = table.citeSha || sha(tableBytes);
  const text = k2Text({ tableSha, ids: k2.ids || ids, lines: k2.lines });
  const entry = {
    id: 'C17-RM', strategy_ref: FAMILY, kind: 'RESULT', sealed_on: '2026-11-25', k2_frozen_at: FROZEN, k2: { sha256: sha(text) },
    mechanism_ids: ids, mechanism_prior_table: { source: 'coordinator', path: 'RM_PRIOR_TABLE.json', sha256: sha(tableBytes), ref: 'artifacts/coordinator/RM_PRIOR_TABLE.json' },
    ai_inputs: aiInputs, ...entryPatch,
  };
  return { entry, files: { k2Bytes: () => Buffer.from(text), priorTableBytes: () => tableBytes } };
}
const opts = { effectiveFrom: EFFECTIVE, registerAt, marks: [] };
const run = (fx, o = opts) => gate.check(fx.entry, fx.files, o);

// ── 适用范围 ──────────────────────────────────────────────────────────────────

test('适用范围：生效时刻取冻结页的唯一常量（与 G-CAUSAL 共用）；早于它不适用、等于它适用；草稿不适用；生效日之后封存却没写冻结时刻 → 拒绝', () => {
  assert.equal(gate.EFFECTIVE_FROM, '2026-11-15T22:47:42+08:00', 'FREEZE_1 写出的生效时刻');
  assert.equal(gate.EFFECTIVE_FROM, amendment.EFFECTIVE_FROM, '门不另写常量');
  assert.equal(amendment.FREEZE.path, 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_FREEZE_1.md');
  assert.ok(amendment.FREEZE.sha256.startsWith('c9742ea0'));
  const fx = unit();
  assert.deepEqual(gate.check(fx.entry, fx.files, { effectiveFrom: null }), { applies: false, reason: 'AMENDMENT_NOT_FROZEN' });
  // 默认常量：早一秒不适用；恰好在生效时刻适用（≥）
  const early = unit({ entryPatch: { k2_frozen_at: '2026-11-15T22:47:41+08:00' } });
  assert.deepEqual(gate.check(early.entry, early.files), { applies: false, reason: 'FROZEN_BEFORE_AMENDMENT' });
  const onTime = unit({ entryPatch: { k2_frozen_at: '2026-11-15T22:47:42+08:00' }, table: { asOf: '2026-11-15T22:47:00+08:00' } });
  assert.equal(gate.check(onTime.entry, onTime.files, { registerAt, marks: [] }).applies, true);
  // 回归：QRP 现有的 A 股、海外封存结论都在生效之前冻结，门一条也不适用，也不报错（锁行逐字节不变）；
  // 唯一的例外是 A 股修订 6 的 R-XM-1 两题（K2 2026-11-17 15:42:02 冻结），过门且带门的裁定
  const RXM1 = ['CN-RXM1-M', 'CN-RXM1-B'];
  for (const entry of [...ashare.ENTRIES, ...overseas.ENTRIES]) {
    if (RXM1.includes(entry.id)) continue;
    assert.equal(gate.applies(entry, gate.EFFECTIVE_FROM).applies, false, `${entry.id} 不应过门`);
    assert.equal(entry.mechanism_ruling, undefined, entry.id);
  }
  for (const id of RXM1) {
    const entry = ashare.ENTRIES.find((e) => e.id === id);
    assert.ok(entry, `${id} 缺`);
    assert.deepEqual(gate.applies(entry, gate.EFFECTIVE_FROM), { applies: true, reason: 'FROZEN_AFTER_AMENDMENT' });
    assert.deepEqual(entry.mechanism_ruling.deviations, ['MECHANISM_PRIOR_TABLE_NOT_IN_K2', 'AI_ROLE_K2_LINE4_READ_AS_NONE']);
  }
  assert.deepEqual(run(unit({ entryPatch: { k2_frozen_at: '2026-11-16T11:59:59+08:00' } })), { applies: false, reason: 'FROZEN_BEFORE_AMENDMENT' });
  assert.deepEqual(run(unit({ entryPatch: { kind: 'DRAFT' } })), { applies: false, reason: 'DRAFT_NOT_FROZEN' });
  assert.deepEqual(run(unit({ entryPatch: { k2: null } })), { applies: false, reason: 'NO_K2' });
  assert.throws(() => run(unit({ entryPatch: { k2_frozen_at: undefined } })), /MECHANISM_GATE_K2_FROZEN_AT_MISSING/);
  assert.deepEqual(run(unit({ entryPatch: { k2_frozen_at: undefined, sealed_on: '2026-11-15' } })), { applies: false, reason: 'SEALED_BEFORE_AMENDMENT' });
});

test('全部通过：返回 applies + id、先前结论表、登记表提交、路由读数、AI 输入数；不碰结论', () => {
  const fx = unit();
  const out = run(fx);
  assert.equal(out.applies, true);
  assert.deepEqual(out.mechanism_ids, [ID_A]);
  assert.equal(out.prior_table_sha256, fx.entry.mechanism_prior_table.sha256);
  assert.equal(out.register_commit, COMMIT);
  assert.equal(out.register_sha256, sha(REGISTER_BYTES));
  assert.equal(out.route, 'NORMAL_NO_PRIOR');
  assert.equal(out.ai_inputs, 0);
  assert.equal(out.section0, 'PRESENT');
  assert.equal(out.decision, undefined, '门不产出、不改写结论');
  // 两个 id、两项抽取事实
  const two = unit({ ids: [ID_A, ID_B], table: { ids: [ID_A, ID_B] }, aiInputs: [{ category: 'EXTRACTED_FACT', ref: 'V6 official_url_reading#1', desc_zh: '政策原文引文' }, { category: 'EXTRACTED_FACT', ref: 'V6 official_url_reading#2', desc_zh: '政策原文引文' }],
    k2: { lines: { 4: '**AI 输入**：EXTRACTED_FACT 政策原文引文 #1；EXTRACTED_FACT 政策原文引文 #2' } } });
  const out2 = run(two);
  assert.deepEqual(out2.mechanism_ids, [ID_B, ID_A].sort());
  assert.equal(out2.ai_inputs, 2);
});

// ── K2 §0 四行 ────────────────────────────────────────────────────────────────

test('K2 §0：缺哪一行或那一行为空，报 K2_SECTION0_LINE_MISSING:<n>', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.throws(() => run(unit({ k2: { lines: { [n]: null } } })), new RegExp(`K2_SECTION0_LINE_MISSING:${n}`), `删第 ${n} 行`);
  }
  assert.throws(() => run(unit({ k2: { lines: { 2: '**预期失效方式**：  ' } } })), /K2_SECTION0_LINE_MISSING:2/);
  assert.throws(() => run(unit({ k2: { lines: { 3: '可能被哪条现行规则解释：没加粗' } } })), /K2_SECTION0_LINE_MISSING:3/);
});

// ── G-MECH ───────────────────────────────────────────────────────────────────

test('G-MECH：id 缺失、第 1 行与 entry 不符、id 不在那一版登记表里', () => {
  assert.throws(() => run(unit({ entryPatch: { mechanism_ids: undefined } })), /MECHANISM_IDS_MISSING/);
  assert.throws(() => run(unit({ entryPatch: { mechanism_ids: [] } })), /MECHANISM_IDS_MISSING/);
  assert.throws(() => run(unit({ k2: { ids: [ID_A, ID_B] } })), /MECHANISM_K2_IDS_MISMATCH/);
  assert.throws(() => run(unit({ k2: { lines: { 1: '**机制**：没写 id' } } })), /MECHANISM_K2_IDS_MISMATCH/);
  // 表本身照写了这个 id（手造），但那一版登记表里没有它
  const ghost = 'SEL.GHOST.NOT_REGISTERED';
  const ghostTable = JSON.parse(tableFor().toString());
  ghostTable.query.mechanism_ids = [ghost];
  assert.throws(() => run(unit({ ids: [ghost], table: { bytes: Buffer.from(`${trials.canonicalJson(ghostTable)}\n`) } })), /MECHANISM_ID_NOT_REGISTERED/);
});

test('G-MECH：先前结论表的六种失败各报对应的码', () => {
  assert.throws(() => run(unit({ entryPatch: { mechanism_prior_table: undefined } })), /MECHANISM_PRIOR_TABLE_MISSING/);
  assert.throws(() => run(unit({ table: { citeSha: 'f'.repeat(64) } })), /MECHANISM_PRIOR_TABLE_NOT_IN_K2/);
  assert.throws(() => run(unit({ table: { bytes: Buffer.from('not json') } })), /MECHANISM_PRIOR_TABLE_INVALID/);
  assert.throws(() => run(unit({ table: { ids: [ID_B] } })), /MECHANISM_PRIOR_TABLE_QUERY_MISMATCH/);
  assert.throws(() => run(unit({ table: { market: 'US_EQUITY' } })), /MECHANISM_PRIOR_TABLE_QUERY_MISMATCH/);
  assert.throws(() => run(unit({ table: { asOf: '2026-11-17T10:00:01+08:00' } })), /MECHANISM_PRIOR_TABLE_AFTER_FREEZE/);
  assert.throws(() => run(unit({ table: { commit: null } })), /MECHANISM_PRIOR_TABLE_NO_COMMIT/);
  assert.throws(() => run(unit({ table: { commit: 'd'.repeat(40) } })), /MECHANISM_PRIOR_TABLE_REGISTER_MISMATCH/);
  // 冻结时刻之后，那一版登记表里多了一条结论：表与重算不一致
  const later = JSON.parse(JSON.stringify(REGISTER_DOC));
  later.entries.push({ item_id: 'C99', strategy_ref: FAMILY, market: 'CRYPTO', mechanism_ids: [ID_A], classified_by: 'test', reason_zh: '合成（§4.2）',
    conclusion: { verdict: 'DONT', strength_zh: '合成', power: { value: 0.9, ge_80: true, effect_zh: '判定效应', source_zh: '合成 §3' }, family_id: FAMILY, data_window: { from: '2024-01-01', to: '2026-09-30' }, sealed_on: '2026-11-01', seal_sha256: 'a'.repeat(64) } });
  const laterBytes = Buffer.from(`${JSON.stringify(later, null, 2)}\n`);
  const forged = unit({ table: { registerBytes: laterBytes } });
  assert.throws(() => run(forged), /MECHANISM_PRIOR_TABLE_REGISTER_MISMATCH/);
  // 表里的登记表 sha 对得上，但路由被手改：重算不一致
  const honest = JSON.parse(tableFor().toString());
  honest.route = 'NOT_DO_SETTLED';
  const tampered = Buffer.from(`${trials.canonicalJson(honest)}\n`);
  assert.throws(() => run(unit({ table: { bytes: tampered } })), /MECHANISM_PRIOR_TABLE_NOT_REPRODUCIBLE/);
  // as_of 之后登记的标签不进重算；之前登记的进
  const markAfter = { schema: 'DATA_SEGMENT_MARK_V1', mark_id: 'SEG-0000000000000099', family_id: FAMILY, market: 'CRYPTO_USDM_PERP', from: '2026-10-01', to: '2026-11-09', label: 'UNSEEN',
    seen_kind: null, shadow_ref: null, reason: '合成', source_refs: [], supersedes: null, defect_ref: null, production_effect: 'NONE', registered_by: 'T', registered_at: '2026-11-18T00:00:00+08:00', record_hash: 'x' };
  assert.equal(run(unit(), { ...opts, marks: [markAfter] }).applies, true);
  assert.throws(() => run(unit(), { ...opts, marks: [{ ...markAfter, registered_at: '2026-11-17T09:00:00+08:00' }] }), /MECHANISM_PRIOR_TABLE_NOT_REPRODUCIBLE/);
  // 族的市场读不出来
  assert.throws(() => run(unit({ entryPatch: { strategy_ref: 'UNKNOWN_FAMILY' } })), /MECHANISM_MARKET_UNKNOWN/);
});

// ── AI 输入（§2.4 / §5 第 4 行） ─────────────────────────────────────────────

test('AI 输入：缺字段、形状不对、类别不是 EXTRACTED_FACT、与第 4 行不一致', () => {
  // entryPatch 才能真的去掉字段（aiInputs: undefined 会落到默认值 []）
  assert.throws(() => run(unit({ entryPatch: { ai_inputs: undefined } })), /AI_ROLE_INPUTS_MISSING/);
  assert.throws(() => run(unit({ aiInputs: 'none' })), /AI_ROLE_INPUTS_MISSING/);
  assert.throws(() => run(unit({ aiInputs: [{ category: 'EXTRACTED_FACT' }], k2: { lines: { 4: '**AI 输入**：EXTRACTED_FACT 一项' } } })), /AI_ROLE_INPUT_INVALID/);
  assert.throws(() => run(unit({ aiInputs: [{ category: 'MODEL_SUMMARY', ref: 'r', desc_zh: '模型归纳' }], k2: { lines: { 4: '**AI 输入**：MODEL_SUMMARY 一项' } } })), /AI_ROLE_CATEGORY_NOT_ALLOWED/);
  assert.throws(() => run(unit({ aiInputs: [{ category: 'EXTRACTED_FACT', ref: 'r', desc_zh: 'd' }] })), /AI_ROLE_K2_LINE_MISMATCH/);
  assert.throws(() => run(unit({ aiInputs: [], k2: { lines: { 4: '**AI 输入**：EXTRACTED_FACT 一项' } } })), /AI_ROLE_K2_LINE_MISMATCH/);
  assert.throws(() => run(unit({ aiInputs: [{ category: 'EXTRACTED_FACT', ref: 'r', desc_zh: 'd' }], k2: { lines: { 4: '**AI 输入**：EXTRACTED_FACT 一项；EXTRACTED_FACT 两项' } } })), /AI_ROLE_K2_LINE_MISMATCH/);
  assert.doesNotThrow(() => run(unit({ k2: { lines: { 4: '**AI 输入**：无。' } } })));
});

// ── 接进导入器 ────────────────────────────────────────────────────────────────

const ARMS = [
  { config_label: 'T', role: 'VERDICT_ARM', rule_config: { veto: true } },
  { config_label: 'B', role: 'BASELINE', rule_config: { veto: false } },
];
const idOf = (label, study) => trials.trialIdOf({ family_id: FAMILY, study_ref: study, config_label: label });
const hashOf = (label) => trials.ruleConfigHash(ARMS.find((a) => a.config_label === label).rule_config);
const months = (c) => Array.from({ length: 30 }, (_, i) => ({ month: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, d: 0.01 * Math.sin(i * 1.3) + c }));

/** 完整的合成封存题：G-TRIAL 全过（K2 冻结在 11-11 之后），再加 G-MECH 所需的字段。 */
function importFixture({ k2Lines = {}, study, citeTable = true, rulingPage = null, ruling = null }) {
  const repo = tmp('qrp-mg-sf-'); const art = tmp('qrp-mg-art-');
  const tableBytes = tableFor();
  // K2 在修订生效之后冻结，G-CAUSAL（§3）也过门：这道题不新增或重算特征，§0 写明不适用（G12）
  // K2 冻结在 RESEARCH_LIVE_PARITY_V1 生效（11-17 00:24）之后，G-PARITY 也过门：§0 写一行「数据输入」（QRP 钉住的 KG 登记表）
  // citeTable = false：K2 正文不写先前结论表的 sha256（A 股修订 6 的情形，要门的裁定）
  const text = `${k2Text({ tableSha: citeTable ? sha(tableBytes) : '（K2 未写）', lines: k2Lines, trialIds: ['T', 'B'].map((l) => idOf(l, study)) })}G-CAUSAL N/A: DESCRIPTIVE_NO_PERFORMANCE\n**数据输入**：\`DATA:SMARTFLOW_BTCUSDT_PERP_DAILY@1.11.0#d8a17a3ee6e23e59494176eb818d7dc46fde382da032878eeb729af0855ba687|PIT=BAR_CLOSE|VENDOR=Binance\`\n`;
  const k2Sha = sha(text);
  const files = {
    'trading-system-v2/docs/evidence/rm/RESULT.json': `${JSON.stringify({ verdict: { decision: '不做', evidence_strength: '有反对证据', allowed_use: '不进生产', text_zh: '合成' } })}\n`,
    'trading-system-v2/docs/RM_K2.md': text,
    'trading-system-v2/docs/evidence/rm/RUN_LOG.json': `${JSON.stringify({ schema: 'RESEARCH_RUN_LOG_V1', k2_sha256: k2Sha, runs: ['T', 'B'].map((l) => ({ family_id: FAMILY, config_label: l, trial_id: idOf(l, study), rule_config_hash: hashOf(l), verdict_metric_kind: 'IC', cost_model_ref: 'REPLAY_CORE_PROFILE_COSTS' })) })}\n`, // K2 冻结在 11-17 之后，G-COST 也过门：两行登记为只看信号（下面 stage SIGNAL），A1 不适用，本文件只测 G-MECH
  };
  git(repo, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seal');
  const commit = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(art, 'RM_PRIOR_TABLE.json'), tableBytes);
  if (rulingPage !== null) fs.writeFileSync(path.join(art, 'RM_RULING.md'), rulingPage);
  const sf = (rel) => ({ source: 'smartflow', commit, path: `trading-system-v2/${rel}`, sha256: sha(files[`trading-system-v2/${rel}`]), ref: `smartflow@x:${rel}` });
  const entry = {
    id: 'C17-RM', label_zh: 'RM', strategy_ref: FAMILY, kind: 'RESULT', sealed_on: '2026-11-25', title_zh: '合成题', k2_frozen_at: FROZEN,
    file: sf('docs/evidence/rm/RESULT.json'), k2: sf('docs/RM_K2.md'), run_log: sf('docs/evidence/rm/RUN_LOG.json'),
    read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'verdict.text_zh' }, expect: '不做',
    mechanism_ids: [ID_A], ai_inputs: [],
    mechanism_prior_table: { source: 'coordinator', path: 'RM_PRIOR_TABLE.json', sha256: sha(tableBytes), ref: 'artifacts/coordinator/RM_PRIOR_TABLE.json（不在 git 里，按 sha256 绑定）' },
    ...(rulingPage !== null ? { mechanism_ruling: { spec: { source: 'coordinator', path: 'RM_RULING.md', sha256: sha(rulingPage), ref: 'artifacts/coordinator/RM_RULING.md' }, ...ruling } } : {}),
  };
  // G-TRIAL：预登记（冻结之前）、结果、披露
  // stage SIGNAL：没有 G-COST 门内的行，A1（附录 1 §1.1）不适用，本文件只测 G-MECH
  trials.register(ARMS.map((a) => ({ family_id: FAMILY, market: 'CRYPTO_USDM_PERP', study_ref: study, k2_sha256: k2Sha, stage: 'SIGNAL', ...a })), { registeredBy: AUTH, registeredAt: PREREG_AT });
  for (const l of ['T', 'B']) {
    trials.recordResult(idOf(l, study), { window: { from: '2024-01-01', to: '2026-06-30' }, eval: { costs: { bp: 5 }, code_sha: 'a'.repeat(40) },
      metrics: { n_trades: 40, delta_g: -0.01 }, ...(l === 'B' ? { unknown: { sr_monthly_delta: 'BASELINE_VS_ITSELF' } } : { months: months(-0.004) }), study_verdict: '不做' }, { registeredBy: AUTH, registeredAt: RESULT_AT });
  }
  trials.disclose({ family_id: FAMILY, study_ref: study, k2_sha256: k2Sha, verdict_trial_id: idOf('T', study), months: months(-0.004), seed: 20261112, original_verdict: { decision: '不做', strength: '有反对证据' } }, { registeredBy: AUTH, registeredAt: RESULT_AT });
  const out = tmp('qrp-mg-ev-');
  overseas.stageEvidence({ smartflowRoot: repo, artifactsRoot: art, out, entries: [entry] });
  return { entry, out, tableBytes };
}

test('导入器：门不适用时照原样锁（没有 mechanism_gate 字段）；按冻结页的生效时刻过门，锁行带 mechanism_gate，结论不变；不过门就整批不写', () => {
  const fx = importFixture({ study: 'RM-1' });
  // 先在生效时刻注入、第 2 行缺失时拒收，什么也不写
  const broken = importFixture({ k2Lines: { 2: null }, study: 'RM-0' });
  broken.entry.id = 'C17-RM-BROKEN';
  const before = read(overseas.LEDGER()).length;
  assert.throws(() => overseas.importVerdicts(broken.out, { registeredBy: AUTH, entries: [broken.entry], mechanismGate: opts }), /K2_SECTION0_LINE_MISSING:2/);
  assert.equal(read(overseas.LEDGER()).length, before);
  // 门不适用（注入 null）：锁行不加字段；先前结论表照样作为绑定文件复验并列进 refs
  const [plain] = overseas.importVerdicts(fx.out, { registeredBy: AUTH, entries: [fx.entry], lockedAt: '2026-11-25T10:00:00+08:00', mechanismGate: { effectiveFrom: null } });
  assert.equal(plain.decision, '不做');
  assert.equal(plain.mechanism_gate, undefined);
  assert.ok(plain.refs.some((r) => r.role === 'MECH_PRIOR' && r.sha256 === sha(fx.tableBytes)));
  // 默认生效时刻（冻结页常量，只注入登记表读法与空标签）：K2 在它之后冻结 → 过门（另一份证据、换 id 以免撞锁）
  const fx2 = importFixture({ study: 'RM-2' });
  fx2.entry.id = 'C17-RM-2';
  const [gated] = overseas.importVerdicts(fx2.out, { registeredBy: AUTH, entries: [fx2.entry], mechanismGate: { registerAt, marks: [] }, lockedAt: '2026-11-25T10:00:00+08:00' });
  assert.equal(gated.mechanism_gate.effective_from, '2026-11-15T22:47:42+08:00');
  assert.equal(gated.decision, '不做');
  assert.equal(gated.mechanism_gate.applies, true);
  assert.deepEqual(gated.mechanism_gate.mechanism_ids, [ID_A]);
  assert.equal(gated.mechanism_gate.prior_table_sha256, sha(fx2.tableBytes));
  assert.equal(gated.trial_gates.applies, true, 'G-TRIAL 照旧先跑');
  // 绑定的先前结论表被改：按 sha256 复验失败
  const fx3 = importFixture({ study: 'RM-3' });
  fx3.entry.id = 'C17-RM-3';
  fs.writeFileSync(path.join(fx3.out, 'coordinator', 'RM_PRIOR_TABLE.json'), '{}\n');
  assert.throws(() => overseas.importVerdicts(fx3.out, { registeredBy: AUTH, entries: [fx3.entry], mechanismGate: opts }), /SHA256_MISMATCH|SHA_MISMATCH/);
});

// ── 门的裁定（A 股导入规格 V1 修订 6；R-XM-1 ★IMP1 (a)，协调会话 2026-11-17）──────────────────────────────
// K2 冻结之后才补的先前结论表（sha256 不在 K2 正文里），以及第 4 行「无。……」读作「无」：只能出自按 sha256 绑定的裁定页，
// 锁里记 DEVIATION_ACCEPTED（不记 PASS）；页上缺字、事实不成立都拒绝；没有裁定的题照旧拒绝、照旧返回。

const RULED_LINE4 = '无。只用封存回放与实盘账本里抽取的事实。';
const NOT_IN_K2 = 'MECHANISM_PRIOR_TABLE_NOT_IN_K2';
const LINE4_AS_NONE = 'AI_ROLE_K2_LINE4_READ_AS_NONE';

/** 裁定的单元夹具：K2 不写表的 sha256、第 4 行写 line4；页上写 words（drop 去掉其中一个），entry 带 mechanism_ruling。 */
function ruledFx({ deviations = [NOT_IN_K2, LINE4_AS_NONE], line4 = RULED_LINE4, citeTable = false, drop = null, extraWords = [], rulingPatch = {}, aiInputs = [], page = undefined } = {}) {
  const tableBytes = tableFor();
  const tableSha = sha(tableBytes);
  const text = k2Text({ tableSha: citeTable ? tableSha : '（K2 未写）', lines: { 4: `**AI 输入**：${line4}` } });
  const words = ['DEVIATION_ACCEPTED', ...deviations, tableSha, COMMIT, TABLE_AS_OF, RULED_LINE4, ...extraWords].filter((w) => w !== drop);
  const pageText = page !== undefined ? page : `# 门的裁定（合成）\n\n${words.map((w) => `- ${w}`).join('\n')}\n`;
  const entry = {
    id: 'C17-RM-RULED', strategy_ref: FAMILY, kind: 'RESULT', sealed_on: '2026-11-25', k2_frozen_at: FROZEN, k2: { sha256: sha(text) },
    mechanism_ids: [ID_A], mechanism_prior_table: { source: 'coordinator', path: 'RM_PRIOR_TABLE.json', sha256: tableSha, ref: 'artifacts/coordinator/RM_PRIOR_TABLE.json' },
    ai_inputs: aiInputs,
    mechanism_ruling: { spec: { source: 'coordinator', path: 'RM_RULING.md', sha256: sha(pageText || ''), ref: 'artifacts/coordinator/RM_RULING.md' },
      deviations, ...(deviations.includes(LINE4_AS_NONE) ? { line4_text: RULED_LINE4 } : {}), ...rulingPatch },
  };
  return { entry, files: { k2Bytes: () => Buffer.from(text), priorTableBytes: () => tableBytes, rulingBytes: () => (pageText === null ? null : Buffer.from(pageText)) }, tableSha };
}

test('门的裁定：没有裁定时照旧拒绝（表的 sha256 不在 K2 → MECHANISM_PRIOR_TABLE_NOT_IN_K2；第 4 行「无。……」→ AI_ROLE_K2_LINE_MISMATCH）', () => {
  const noTable = ruledFx();
  delete noTable.entry.mechanism_ruling;
  assert.throws(() => run(noTable), /MECHANISM_PRIOR_TABLE_NOT_IN_K2/);
  const line4Only = ruledFx({ citeTable: true });
  delete line4Only.entry.mechanism_ruling;
  assert.throws(() => run(line4Only), /AI_ROLE_K2_LINE_MISMATCH/);
  // 没有裁定、全部通过的题：返回值不带 state / deviations / 裁定字段（锁行逐字节不变）
  const plain = run(unit());
  for (const key of ['state', 'deviations', 'ruling_ref', 'ruling_sha256']) assert.equal(plain[key], undefined, key);
});

test('门的裁定：页对、事实都成立 → DEVIATION_ACCEPTED，记两条偏差、裁定页 sha256；表照旧逐字节重算、登记表照旧核对；不碰结论', () => {
  const fx = ruledFx();
  const out = run(fx);
  assert.equal(out.applies, true);
  assert.equal(out.state, 'DEVIATION_ACCEPTED');
  assert.deepEqual(out.deviations, [NOT_IN_K2, LINE4_AS_NONE]);
  assert.equal(out.ruling_sha256, fx.entry.mechanism_ruling.spec.sha256);
  assert.equal(out.ruling_ref, 'artifacts/coordinator/RM_RULING.md');
  assert.equal(out.prior_table_sha256, fx.tableSha);
  assert.equal(out.register_commit, COMMIT);
  assert.equal(out.route, 'NORMAL_NO_PRIOR');
  assert.equal(out.ai_inputs, 0);
  assert.equal(out.decision, undefined);
  // 只裁一条也行：表写进了 K2、只有第 4 行要读作「无」
  const one = run(ruledFx({ deviations: [LINE4_AS_NONE], citeTable: true }));
  assert.deepEqual([one.state, one.deviations], ['DEVIATION_ACCEPTED', [LINE4_AS_NONE]]);
  const other = run(ruledFx({ deviations: [NOT_IN_K2], line4: '无' }));
  assert.deepEqual([other.state, other.deviations], ['DEVIATION_ACCEPTED', [NOT_IN_K2]]);
});

test('门的裁定：页上缺任何一个字（DEVIATION_ACCEPTED、偏差码、表的 sha256、登记表提交、as_of、第 4 行原文）→ MECHANISM_RULING_TEXT_DOES_NOT_STATE；页的字节缺失 → MECHANISM_RULING_FILE_MISSING', () => {
  const fx = ruledFx();
  for (const w of ['DEVIATION_ACCEPTED', NOT_IN_K2, LINE4_AS_NONE, fx.tableSha, COMMIT, TABLE_AS_OF, RULED_LINE4]) {
    assert.throws(() => run(ruledFx({ drop: w })), /MECHANISM_RULING_TEXT_DOES_NOT_STATE/, w);
  }
  assert.throws(() => run(ruledFx({ page: null })), /MECHANISM_RULING_FILE_MISSING/);
});

test('门的裁定：事实不成立一律拒绝——表其实写进了 K2、第 4 行与裁定原文不同、第 4 行本来就是「无」或不以「无」开头、行内有类别记号、ai_inputs 不空；表本身的六种失败照旧', () => {
  assert.throws(() => run(ruledFx({ deviations: [NOT_IN_K2, LINE4_AS_NONE], citeTable: true })), /MECHANISM_RULING_FACT_NOT_HOLD:.*MECHANISM_PRIOR_TABLE_NOT_IN_K2/);
  assert.throws(() => run(ruledFx({ line4: '无。只用回放里抽取的事实。' })), /MECHANISM_RULING_FACT_NOT_HOLD:.*line4/);
  assert.throws(() => run(ruledFx({ line4: '无', rulingPatch: { line4_text: '无' } })), /MECHANISM_RULING_FACT_NOT_HOLD:.*line4/);
  assert.throws(() => run(ruledFx({ line4: '有：只用抽取的事实。', rulingPatch: { line4_text: '有：只用抽取的事实。' }, extraWords: ['有：只用抽取的事实。'] })), /MECHANISM_RULING_FACT_NOT_HOLD:.*line4/);
  assert.throws(() => run(ruledFx({ line4: '无。EXTRACTED_FACT 一项。', rulingPatch: { line4_text: '无。EXTRACTED_FACT 一项。' }, extraWords: ['无。EXTRACTED_FACT 一项。'] })), /MECHANISM_RULING_FACT_NOT_HOLD:.*line4/);
  assert.throws(() => run(ruledFx({ aiInputs: [{ category: 'EXTRACTED_FACT', ref: 'x', desc_zh: 'y' }] })), /MECHANISM_RULING_FACT_NOT_HOLD:.*ai_inputs/);
  // 表照旧：as_of 晚于冻结、换了登记表提交（页上照写那个提交）、表字节与绑定不符
  const late = ruledFx();
  const lateTable = tableFor({ asOf: '2026-11-17T10:30:00+08:00' });
  late.entry.mechanism_prior_table.sha256 = sha(lateTable);
  late.files.priorTableBytes = () => lateTable;
  late.files.rulingBytes = () => Buffer.from(`DEVIATION_ACCEPTED ${NOT_IN_K2} ${LINE4_AS_NONE} ${sha(lateTable)} ${COMMIT} 2026-11-17T10:30:00+08:00 ${RULED_LINE4}`);
  assert.throws(() => run(late), /MECHANISM_PRIOR_TABLE_AFTER_FREEZE/);
  const other = ruledFx();
  const otherTable = tableFor({ commit: 'f'.repeat(40) });
  other.entry.mechanism_prior_table.sha256 = sha(otherTable);
  other.files.priorTableBytes = () => otherTable;
  other.files.rulingBytes = () => Buffer.from(`DEVIATION_ACCEPTED ${NOT_IN_K2} ${LINE4_AS_NONE} ${sha(otherTable)} ${'f'.repeat(40)} ${TABLE_AS_OF} ${RULED_LINE4}`);
  assert.throws(() => run(other), /MECHANISM_PRIOR_TABLE_REGISTER_MISMATCH/);
  const swapped = ruledFx();
  swapped.files.priorTableBytes = () => Buffer.from('{}');
  assert.throws(() => run(swapped), /MECHANISM_PRIOR_TABLE_MISSING/);
});

test('门的裁定：形状不对 → MECHANISM_RULING_INVALID（没有偏差、偏差码不认得、重复、读作「无」却不写原文）；不过门的题带裁定 → MECHANISM_RULING_ON_UNGATED_ENTRY', () => {
  assert.throws(() => run(ruledFx({ rulingPatch: { deviations: [] } })), /MECHANISM_RULING_INVALID/);
  assert.throws(() => run(ruledFx({ rulingPatch: { deviations: ['LOOKS_FINE'] } })), /MECHANISM_RULING_INVALID/);
  assert.throws(() => run(ruledFx({ rulingPatch: { deviations: [NOT_IN_K2, NOT_IN_K2] } })), /MECHANISM_RULING_INVALID/);
  assert.throws(() => run(ruledFx({ rulingPatch: { line4_text: undefined } })), /MECHANISM_RULING_INVALID/);
  assert.throws(() => run(ruledFx({ deviations: [NOT_IN_K2], line4: '无', rulingPatch: { line4_text: '无' } })), /MECHANISM_RULING_INVALID/);
  assert.throws(() => run(ruledFx({ rulingPatch: { spec: { sha256: 'nope' } } })), /MECHANISM_RULING_INVALID/);
  const early = ruledFx();
  early.entry.k2_frozen_at = '2026-11-16T11:00:00+08:00';
  assert.throws(() => run(early), /MECHANISM_RULING_ON_UNGATED_ENTRY/);
});

test('导入器：门的裁定页按 sha256 绑定、列进 refs（MECH_RULING），锁里记 DEVIATION_ACCEPTED；裁定页被改 → 复验失败；没有裁定 → 照旧拒绝、台账不写', () => {
  const words = (fxTableSha) => ['DEVIATION_ACCEPTED', NOT_IN_K2, fxTableSha, COMMIT, TABLE_AS_OF].join('\n');
  const tableSha = sha(tableFor());
  const fx = importFixture({ study: 'RM-R1', citeTable: false, rulingPage: `${words(tableSha)}\n`, ruling: { deviations: [NOT_IN_K2] } });
  fx.entry.id = 'C17-RM-R1';
  const [lock] = overseas.importVerdicts(fx.out, { registeredBy: AUTH, entries: [fx.entry], mechanismGate: { registerAt, marks: [] }, lockedAt: '2026-11-25T10:00:00+08:00' });
  assert.equal(lock.decision, '不做');
  assert.equal(lock.mechanism_gate.state, 'DEVIATION_ACCEPTED');
  assert.deepEqual(lock.mechanism_gate.deviations, [NOT_IN_K2]);
  assert.equal(lock.mechanism_gate.ruling_sha256, fx.entry.mechanism_ruling.spec.sha256);
  assert.ok(lock.refs.some((r) => r.role === 'MECH_RULING' && r.sha256 === fx.entry.mechanism_ruling.spec.sha256));
  // 裁定页被改：按 sha256 复验失败
  const fx2 = importFixture({ study: 'RM-R2', citeTable: false, rulingPage: `${words(tableSha)}\n`, ruling: { deviations: [NOT_IN_K2] } });
  fx2.entry.id = 'C17-RM-R2';
  fs.writeFileSync(path.join(fx2.out, 'coordinator', 'RM_RULING.md'), `${words(tableSha)}\n改过\n`);
  const before = read(overseas.LEDGER()).length;
  assert.throws(() => overseas.importVerdicts(fx2.out, { registeredBy: AUTH, entries: [fx2.entry], mechanismGate: { registerAt, marks: [] } }), /SHA256_MISMATCH|SHA_MISMATCH/);
  // 没有裁定：照旧拒绝
  const fx3 = importFixture({ study: 'RM-R3', citeTable: false });
  fx3.entry.id = 'C17-RM-R3';
  assert.throws(() => overseas.importVerdicts(fx3.out, { registeredBy: AUTH, entries: [fx3.entry], mechanismGate: { registerAt, marks: [] } }), /MECHANISM_PRIOR_TABLE_NOT_IN_K2/);
  assert.equal(read(overseas.LEDGER()).length, before);
});
