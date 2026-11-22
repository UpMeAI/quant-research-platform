'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gate = require('../services/parity-gate');
const parity = require('../services/research-live-parity-v1');
const datasetRegistry = require('../services/dataset-registry');
const overseas = require('../services/overseas-sealed-verdicts');
const ashare = require('../services/ashare-sealed-verdicts');
const { read } = require('../packages/ledger');

/**
 * G-PARITY（RESEARCH_LIVE_PARITY_V1 §3，Owner 2026-11-17 00:23 签字：签字页 f0fe8e5c，签字文本 ceb35505；EFFECTIVE_FROM 2026-11-17T00:24:00+08:00）。
 * 先红后绿，只用合成 K2 与合成登记；登记表是 QRP 钉住的 KG 副本（config/dataset-registry）。
 */
const AUTH = 'TEST_PARITY_AUTHORITY';
// 门的机制测试按没有 pitSemantics / priceBasis / vendor 字段的 1.11.0 写（KG 12afd2fc，从 config/dataset-registry/history 读）；
// 现在钉的那份（1.20.0，KG 36214c21）另测（见末尾两条）。
const REG = [...datasetRegistry.history().values()].find((h) => h.registry_version === '1.11.0');
const CURRENT = datasetRegistry.pinned();
const VERSION = REG.registry_version;
const SHA = REG.registry_sha256;
const AFTER = '2026-11-17T10:00:00+08:00';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const data = (id, { version = VERSION, sha256 = SHA, pit = 'BAR_CLOSE', vendor = 'Tushare' } = {}) => `\`DATA:${id}@${version}#${sha256}|PIT=${pit}|VENDOR=${vendor}\``;
const k2Of = (lines) => `# 合成 K2\n\n## 0\n**数据输入**：${lines.join('；')}\n`;
const PIN = Object.freeze({ schema: 'AI_LOGIC_PIN_V1', provider: 'SYNTH_PROVIDER', model: 'synth-model', model_version: '2026-11-01', prompt_sha256: 'a'.repeat(64),
  output_schema_version: 'SYNTH_OUTPUT_V1', call_params: { json_mode: true, thinking: false } });
const aiInput = (patch = {}) => ({ category: 'EXTRACTED_FACT', ref: 'synth/facts.json', desc_zh: '合成', ai_logic_pin: PIN,
  production_archive: { ref: 'synth/archive.jsonl', sha256: 'b'.repeat(64), ai_logic_pin: PIN }, ...patch });

/** 直接调门：一题合成 RESULT，K2 在生效时刻之后冻结。 */
function direct({ lines = [data('V6_CSI300_INDEX_DAILY')], entryPatch = {}, opts = {} } = {}) {
  const k2 = Buffer.from(k2Of(lines));
  const entry = { id: 'CN-PARITY', kind: 'RESULT', sealed_on: '2026-11-20', k2: { sha256: sha(k2) }, k2_frozen_at: AFTER, ...entryPatch };
  return gate.check(entry, { k2Bytes: () => k2 }, { registry: REG, ...opts });
}
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === `PARITY_${code}`, code);

test('签字页绑定：EFFECTIVE_FROM 取签字页（2026-11-17T00:24:00+08:00），按路径与 sha256 绑定签字页与签的文本；现行登记表只有 R-XM-1 两题过门', () => {
  assert.equal(parity.EFFECTIVE_FROM, '2026-11-17T00:24:00+08:00');
  assert.equal(gate.EFFECTIVE_FROM, parity.EFFECTIVE_FROM);
  assert.deepEqual([parity.SIGNATURE.path, parity.SIGNATURE.sha256, parity.SIGNATURE.texts.map((t) => `${t.id}:${t.sha256.slice(0, 8)}`)],
    ['artifacts/coordinator/RESEARCH_LIVE_PARITY_V1_SIGNATURE_1.md', 'f0fe8e5c38a5e7d78dd101601480e1565ccfdede4c2d1971c6fc3b3a56531bce', ['SIGNED_TEXT:ceb35505']]);
  assert.equal(parity.isBound(), true);
  assert.deepEqual([...gate.PIT_SEMANTICS], ['OBSERVED_AT', 'ANNOUNCEMENT_NEXT_OPEN', 'ACCEPTANCE_TIME', 'BAR_CLOSE', 'NEXT_OPEN_SESSION_CLOSE']);
  // 现行登记表只有 A 股修订 6 的 R-XM-1 两题过门（K2 2026-11-17 15:42:02 冻结），照常 PASS（真导入预演见修订 6 §2）；其余一题也不过门
  const RXM1 = ['CN-RXM1-M', 'CN-RXM1-B'];
  for (const entry of [...overseas.ENTRIES, ...ashare.ENTRIES]) assert.equal(gate.applies(entry).applies, RXM1.includes(entry.id), entry.id);
  assert.deepEqual(ashare.ENTRIES.filter((e) => RXM1.includes(e.id)).map((e) => e.id), RXM1);
  const at = (t) => gate.applies({ id: 'x', kind: 'RESULT', k2: { sha256: 'a'.repeat(64) }, k2_frozen_at: t }).applies;
  assert.deepEqual([at('2026-11-17T00:24:00+08:00'), at('2026-11-17T00:23:59+08:00')], [true, false]);
});

test('过门、数据输入齐全 → PASS：数据集在钉住的登记表里，PIN = QRP 钉的登记表（= 生产两端），PIT 在枚举里；登记表还没有 PIT 字段时记「待登记表字段」', () => {
  const r = direct({ lines: [data('V6_CSI300_INDEX_DAILY'), data('SMARTFLOW_U11_UNDERLYING_FACTS', { pit: 'ACCEPTANCE_TIME', vendor: 'SEC EDGAR' })], entryPatch: { ai_inputs: [aiInput()] } });
  assert.equal(r.state, 'PASS');
  assert.deepEqual(r.registry, { commit: REG.commit, registry_version: VERSION, registry_sha256: SHA });
  assert.deepEqual(r.data_inputs, [
    { dataset_id: 'V6_CSI300_INDEX_DAILY', registry_version: VERSION, registry_sha256: SHA, pit_semantics: 'BAR_CLOSE', vendor: 'Tushare', pin_check: 'CURRENT', pit_check: 'PENDING_REGISTRY_FIELD', basis_check: 'NOT_APPLICABLE_PRE_FIELD', vendor_check: 'NOT_APPLICABLE_PRE_FIELD' },
    { dataset_id: 'SMARTFLOW_U11_UNDERLYING_FACTS', registry_version: VERSION, registry_sha256: SHA, pit_semantics: 'ACCEPTANCE_TIME', vendor: 'SEC EDGAR', pin_check: 'CURRENT', pit_check: 'PENDING_REGISTRY_FIELD', basis_check: 'NOT_APPLICABLE_PRE_FIELD', vendor_check: 'NOT_APPLICABLE_PRE_FIELD' },
  ]);
  assert.deepEqual(r.ai_inputs, [{ ref: 'synth/facts.json', archive_ref: 'synth/archive.jsonl', archive_sha256: 'b'.repeat(64), ai_logic_pin_sha256: gate.pinHash(PIN) }]);
  assert.equal(r.decision, undefined); // 门不读、不写结论
});

test('K2 没写数据输入 → PARITY_DATA_INPUTS_MISSING；写了但格式不对 → PARITY_DATA_INPUT_INVALID', () => {
  refuses(() => direct({ lines: [] }), 'DATA_INPUTS_MISSING');
  refuses(() => direct({ lines: ['`DATA:V6_CSI300_INDEX_DAILY@1.11.0`'] }), 'DATA_INPUT_INVALID');
});

test('数据集不在钉住的 KG 登记表里 → PARITY_DATASET_UNREGISTERED', () => {
  refuses(() => direct({ lines: [data('V6_CSI300_INDEX_DAILY'), data('TUSHARE_FINA_INDICATOR_UNREGISTERED')] }), 'DATASET_UNREGISTERED');
});

test('PIN 和 QRP 钉的登记表（= 生产两端钉的）不同 → PARITY_PIN_MISMATCH：版本不同、sha 不同', () => {
  refuses(() => direct({ lines: [data('V6_CSI300_INDEX_DAILY', { version: '1.10.0' })] }), 'PIN_MISMATCH');
  refuses(() => direct({ lines: [data('V6_CSI300_INDEX_DAILY', { sha256: 'c'.repeat(64) })] }), 'PIN_MISMATCH');
});

test('PIT 语义 → PARITY_PIT_SEMANTICS_MISMATCH：不在枚举里（登记表也没登记新语义）；登记表的数据集写了 PIT 语义时和它不同', () => {
  refuses(() => direct({ lines: [data('V6_CSI300_INDEX_DAILY', { pit: 'SAME_DAY_CLOSE_GUESS' })] }), 'PIT_SEMANTICS_MISMATCH');
  // 登记表以后加了 pitSemantics 字段（合成一份带这个字段的登记表，只给门用）：按它核
  const withField = { ...REG, datasets: new Map([...REG.datasets].map(([id, e]) => [id, id === 'V6_CSI300_INDEX_DAILY' ? { ...e, pitSemantics: 'BAR_CLOSE' } : e])), pit_semantics: [] };
  refuses(() => direct({ lines: [data('V6_CSI300_INDEX_DAILY', { pit: 'OBSERVED_AT' })], opts: { registry: withField } }), 'PIT_SEMANTICS_MISMATCH');
  assert.equal(direct({ lines: [data('V6_CSI300_INDEX_DAILY')], opts: { registry: withField } }).data_inputs[0].pit_check, 'CHECKED');
  // 新语义只能出自登记表：登记表登记了，枚举外的值才认
  const newSemantic = { ...REG, pit_semantics: ['SETTLEMENT_PRINT'] };
  assert.equal(direct({ lines: [data('V6_CSI300_INDEX_DAILY', { pit: 'SETTLEMENT_PRINT' })], opts: { registry: newSemantic } }).state, 'PASS');
});

test('AI 输入的钉值 → PARITY_AI_LOGIC_MISMATCH：没带 AI_LOGIC_PIN_V1、钉值不完整、没有存档输出可核、和生产存档的钉值不同', () => {
  const ai = (item) => direct({ entryPatch: { ai_inputs: [item] } });
  refuses(() => ai(aiInput({ ai_logic_pin: undefined })), 'AI_LOGIC_MISMATCH');
  refuses(() => ai(aiInput({ ai_logic_pin: { ...PIN, model_version: '' } })), 'AI_LOGIC_MISMATCH');
  refuses(() => ai(aiInput({ ai_logic_pin: { ...PIN, prompt_sha256: undefined } })), 'AI_LOGIC_MISMATCH'); // 提示词或代码 sha 至少一个
  refuses(() => ai(aiInput({ production_archive: undefined })), 'AI_LOGIC_MISMATCH');
  refuses(() => ai(aiInput({ production_archive: { ref: 'synth/archive.jsonl', sha256: 'b'.repeat(64), ai_logic_pin: { ...PIN, model_version: '2026-12-01' } } })), 'AI_LOGIC_MISMATCH');
  refuses(() => ai(aiInput({ production_archive: { ref: 'synth/archive.jsonl', sha256: 'b'.repeat(64), ai_logic_pin: { ...PIN, call_params: { json_mode: true, thinking: true } } } })), 'AI_LOGIC_MISMATCH');
  const code = { ...PIN, prompt_sha256: undefined, code_sha256: 'd'.repeat(64) };
  assert.equal(ai(aiInput({ ai_logic_pin: code, production_archive: { ref: 'x', sha256: 'b'.repeat(64), ai_logic_pin: code } })).state, 'PASS');
  assert.equal(direct({ entryPatch: { ai_inputs: [] } }).ai_inputs.length, 0);
});

test('只管以后：K2 在生效时刻之前冻结的不过门（缺数据输入也不拒）；DRAFT、STATUS 不读；READING 过门', () => {
  assert.deepEqual(direct({ lines: [], entryPatch: { k2_frozen_at: '2026-11-17T00:23:59+08:00' } }), { applies: false, reason: 'FROZEN_BEFORE_EFFECTIVE' });
  assert.deepEqual(direct({ lines: [], entryPatch: { kind: 'DRAFT' } }), { applies: false, reason: 'DRAFT_NOT_FROZEN' });
  assert.deepEqual(direct({ lines: [], entryPatch: { kind: 'STATUS' } }), { applies: false, reason: 'NOT_A_SEAL' });
  assert.deepEqual(direct({ lines: [], entryPatch: { k2_frozen_at: undefined, sealed_on: '2026-11-16' } }), { applies: false, reason: 'SEALED_BEFORE_EFFECTIVE' });
  refuses(() => direct({ lines: [], entryPatch: { k2_frozen_at: undefined, sealed_on: '2026-11-17' } }), 'K2_FROZEN_AT_MISSING');
  refuses(() => direct({ lines: [], entryPatch: { kind: 'READING' } }), 'DATA_INPUTS_MISSING');
});

// ── 导入器（海外与 A 股共用同一个 checkEntry，G-COST 之后一处调用） ────────────────

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();

/** 合成仓库：封存结果与 K2；K2 冻结在 11-09（其余各门都不适用），G-PARITY 按注入的生效时刻过门。 */
function importerFixture(lines) {
  const repo = tmp('qrp-par-repo-'); const art = tmp('qrp-par-art-');
  const files = {
    'trading-system-v2/docs/evidence/r99/RESULT.json': `${JSON.stringify({ verdict: { decision: '做', evidence_strength: '证据不足', allowed_use: '前向影子', text_zh: '合成' } })}\n`,
    'trading-system-v2/docs/R99_K2.md': k2Of(lines),
  };
  git(repo, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seal');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const sf = (rel) => ({ source: 'smartflow', commit, path: `trading-system-v2/${rel}`, sha256: sha(files[`trading-system-v2/${rel}`]), ref: `smartflow@x:${rel}` });
  const entry = { id: 'R99-PARITY', label_zh: 'R99', strategy_ref: 'C17_V2_4000USDT', kind: 'RESULT', sealed_on: '2026-11-10', title_zh: '合成题（一致性门）', k2_frozen_at: '2026-11-09T20:00:00+08:00',
    file: sf('docs/evidence/r99/RESULT.json'), k2: sf('docs/R99_K2.md'), freeze: null,
    read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'verdict.text_zh' }, expect: '做' };
  const out = tmp('qrp-par-ev-');
  overseas.stageEvidence({ smartflowRoot: repo, artifactsRoot: art, out, entries: [entry] });
  return { entry, out };
}
const count = () => (fs.existsSync(overseas.LEDGER()) ? read(overseas.LEDGER()).length : 0);

test('导入器：默认生效时刻下（K2 早于 11-17 00:24）照原样导入，锁行不带 parity_gate；注入生效时刻后缺数据输入整批拒绝、台账不写，齐全的锁里记 PASS、结论不变', () => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  try { fs.rmSync(overseas.LEDGER()); } catch { /* 首次 */ }
  overseas.clearCache();
  const missing = importerFixture(['无']);
  const [plain] = overseas.importVerdicts(missing.out, { registeredBy: AUTH, entries: [missing.entry] });
  assert.equal(plain.parity_gate, undefined);
  fs.rmSync(overseas.LEDGER());
  const opts = (fx) => ({ registeredBy: AUTH, entries: [fx.entry] });
  assert.throws(() => gate.internals.withDefaults({ effectiveFrom: '2026-11-01T00:00:00+08:00' }, () => overseas.importVerdicts(missing.out, opts(missing))), /PARITY_DATA_INPUTS_MISSING/);
  assert.equal(count(), 0);
  const ok = importerFixture([data('SMARTFLOW_BTCUSDT_PERP_DAILY', { pit: 'BAR_CLOSE', vendor: 'Binance' })]);
  const [lock] = gate.internals.withDefaults({ effectiveFrom: '2026-11-01T00:00:00+08:00' }, () => overseas.importVerdicts(ok.out, opts(ok)));
  assert.equal(lock.decision, '做');
  assert.deepEqual([lock.parity_gate.applies, lock.parity_gate.state, lock.parity_gate.data_inputs[0].dataset_id], [true, 'PASS', 'SMARTFLOW_BTCUSDT_PERP_DAILY']);
  assert.equal(count(), 1);
});

test('现在钉的 1.20.0（KG 36214c21）：记号按它的字段写 → PASS（PIT、BASIS 核过，VENDOR 相符）；钉在 1.11.0 的旧记号照现行字段核 PIT', () => {
  assert.deepEqual([CURRENT.commit, CURRENT.registry_version], ['36214c21fd4e79d3ef4e3b9ab79d584dadfa5723', '1.20.0']);
  const cur = { version: CURRENT.registry_version, sha256: CURRENT.registry_sha256 };
  const tok = `\`DATA:V6_CSI300_INDEX_DAILY@${cur.version}#${cur.sha256}|PIT=OBSERVED_AT|VENDOR=Tushare|BASIS=PRICE/RAW\``;
  const r = direct({ lines: [tok], opts: { registry: CURRENT } });
  assert.deepEqual([r.state, r.registry.registry_version], ['PASS', '1.20.0']);
  const [row] = r.data_inputs;
  assert.deepEqual([row.pin_check, row.pit_check, row.basis_check, row.vendor_check], ['CURRENT', 'CHECKED', 'CHECKED', 'MATCH']);
  refuses(() => direct({ lines: [tok.replace('|BASIS=PRICE/RAW', '')], opts: { registry: CURRENT } }), 'PRICE_BASIS_MISSING');
  // 1.11.0 的记号：数据集一致性字段没变（HISTORY_UNCHANGED），PIT 照现行登记表核：OBSERVED_AT 过，BAR_CLOSE 不过
  const old = direct({ lines: [data('V6_CSI300_INDEX_DAILY', { pit: 'OBSERVED_AT' })], opts: { registry: CURRENT } }).data_inputs[0];
  assert.deepEqual([old.pin_check, old.pit_check, old.basis_check], ['HISTORY_UNCHANGED', 'CHECKED', 'NOT_APPLICABLE_PRE_FIELD']);
  refuses(() => direct({ lines: [data('V6_CSI300_INDEX_DAILY')], opts: { registry: CURRENT } }), 'PIT_SEMANTICS_MISMATCH');
});

test('现在钉的 1.20.0 的两个新数据集（R-US-ENTRY-TOUCH-1 运行前置 ③ SMARTFLOW_US_REGIME_INDICES_HISTORY、④ SMARTFLOW_FOMC_CALENDAR）：③ 的记号要写登记表的 PIT（VISIBLE_PARTIAL_BAR，实盘盘中读当天未收完的日线，研究只有收盘值是登记表写明的缺口）加 BASIS=PRICE/RAW 才过；写成研究读到的 BAR_CLOSE 被拒；④ OBSERVED_AT 过', () => {
  assert.equal(CURRENT.registry_version, '1.20.0');
  const ds3 = CURRENT.datasets.get('SMARTFLOW_US_REGIME_INDICES_HISTORY');
  const ds4 = CURRENT.datasets.get('SMARTFLOW_FOMC_CALENDAR');
  assert.deepEqual([ds3.owner, ds3.pitSemantics, ds3.pitParity.research, ds3.vendor, ds3.priceBasis], ['SMARTFLOW', 'VISIBLE_PARTIAL_BAR', 'BAR_CLOSE', 'Yahoo', 'PRICE/RAW']);
  assert.deepEqual([ds4.owner, ds4.pitSemantics, ds4.vendor], ['SMARTFLOW', 'OBSERVED_AT', 'federalreserve.gov']);
  const at = `@${CURRENT.registry_version}#${CURRENT.registry_sha256}`;
  const t3 = (pit, basis = '|BASIS=PRICE/RAW') => `\`DATA:SMARTFLOW_US_REGIME_INDICES_HISTORY${at}|PIT=${pit}|VENDOR=Yahoo${basis}\``;
  const t4 = `\`DATA:SMARTFLOW_FOMC_CALENDAR${at}|PIT=OBSERVED_AT|VENDOR=federalreserve.gov\``;
  const r = direct({ lines: [t3('VISIBLE_PARTIAL_BAR'), t4], opts: { registry: CURRENT } });
  assert.equal(r.state, 'PASS');
  assert.deepEqual(r.data_inputs.map((d) => [d.dataset_id, d.pin_check, d.pit_check, d.basis_check, d.vendor_check]), [
    ['SMARTFLOW_US_REGIME_INDICES_HISTORY', 'CURRENT', 'CHECKED', 'CHECKED', 'MATCH'],
    ['SMARTFLOW_FOMC_CALENDAR', 'CURRENT', 'CHECKED', 'PENDING_REGISTRY_FIELD', 'MATCH']]);
  refuses(() => direct({ lines: [t3('BAR_CLOSE')], opts: { registry: CURRENT } }), 'PIT_SEMANTICS_MISMATCH');
  refuses(() => direct({ lines: [t3('VISIBLE_PARTIAL_BAR', '')], opts: { registry: CURRENT } }), 'PRICE_BASIS_MISSING');
});
