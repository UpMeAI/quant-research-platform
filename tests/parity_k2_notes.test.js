'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gate = require('../services/parity-gate');
const datasetRegistry = require('../services/dataset-registry');
const overseas = require('../services/overseas-sealed-verdicts');
const ashare = require('../services/ashare-sealed-verdicts');
const { read } = require('../packages/ledger');

/**
 * G-PARITY 读 K2 的冻结附注（entry.k2_notes）与登记表的四个字段（null = 没写、列表值的 pitSemantics、BASIS、VENDOR）。先红后绿，只用合成文件。
 * 起因：第一份过 G-PARITY 的 K2（R_US_ENTRY_TOUCH_1_K2_V1）冻结在 DATA: 写法之前，记号写在冻结附注里；KG #368（登记表 1.13.0）把没有的字段写成 null。
 */
const AUTH = 'TEST_PARITY_NOTES_AUTHORITY';
const REG = datasetRegistry.pinned();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tok = (id, { pit = 'BAR_CLOSE', vendor = 'Alpaca', basis, version = REG.registry_version } = {}) =>
  `\`DATA:${id}@${version}#${REG.registry_sha256}|PIT=${pit}|VENDOR=${vendor}${basis ? `|BASIS=${basis}` : ''}\``;
const K2_NO_TOKENS = '# 合成 K2（冻结在 DATA: 写法之前）\n\n## 0\n**数据输入**：见冻结附注 1\n';
const note = (lines) => `# 冻结附注 1（合成）\n\n${lines.join('\n')}\n`;
/** 只给门用的合成登记表：给某些数据集加字段（KG 1.13.0 的形状）。 */
const withFields = (fields, extra = {}) => ({ ...REG, ...extra, datasets: new Map([...REG.datasets].map(([id, e]) => [id, fields[id] ? { ...e, ...fields[id] } : e])) });

function direct({ k2 = K2_NO_TOKENS, notes = [], entryPatch = {}, registry = null, passNotes = true } = {}) {
  const k2b = Buffer.from(k2);
  const nb = notes.map((t) => Buffer.from(t));
  const entry = { id: 'US-NOTES', kind: 'RESULT', sealed_on: '2026-11-20', k2: { sha256: sha(k2b) }, k2_frozen_at: '2026-11-17T10:00:00+08:00',
    ...(notes.length ? { k2_notes: nb.map((b, i) => ({ source: 'coordinator', path: `NOTE_${i + 1}.md`, sha256: sha(b) })) } : {}), ...entryPatch };
  return gate.check(entry, { k2Bytes: () => k2b, ...(passNotes ? { noteBytes: () => nb } : {}) }, registry ? { registry } : {});
}
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === `PARITY_${code}`, code);

test('冻结附注：K2 里没有记号、附注里有 → 找得到，锁里记附注；附注按列出的顺序和 K2 一起读，同一数据集写法相同取一次', () => {
  const r = direct({ notes: [note([tok('ALPACA_1M_HISTORY'), tok('SMARTFLOW_US_1M', { vendor: 'Yahoo' })])] });
  assert.equal(r.state, 'PASS');
  assert.deepEqual(r.data_inputs.map((d) => d.dataset_id), ['ALPACA_1M_HISTORY', 'SMARTFLOW_US_1M']);
  assert.deepEqual(r.k2_notes.map((n) => n.path), ['NOTE_1.md']);
  const same = direct({ k2: `${K2_NO_TOKENS}${tok('ALPACA_1M_HISTORY')}\n`, notes: [note([tok('ALPACA_1M_HISTORY')]), note([tok('L1_RISK_BUDGET_BANDS', { pit: 'OBSERVED_AT', vendor: 'Cycle Atlas' })])] });
  assert.deepEqual(same.data_inputs.map((d) => d.dataset_id), ['ALPACA_1M_HISTORY', 'L1_RISK_BUDGET_BANDS']);
});

test('冻结附注：同一数据集在 K2 与附注（或两份附注）里写得不一样 → PARITY_DATA_INPUTS_CONFLICT；列了附注却没读到 → PARITY_K2_NOTES_UNREAD', () => {
  refuses(() => direct({ k2: `${K2_NO_TOKENS}${tok('ALPACA_1M_HISTORY')}\n`, notes: [note([tok('ALPACA_1M_HISTORY', { pit: 'OBSERVED_AT' })])] }), 'DATA_INPUTS_CONFLICT');
  refuses(() => direct({ notes: [note([tok('SMARTFLOW_US_1M', { vendor: 'Yahoo' })]), note([tok('SMARTFLOW_US_1M', { vendor: 'Alpaca' })])] }), 'DATA_INPUTS_CONFLICT');
  refuses(() => direct({ notes: [note([tok('ALPACA_1M_HISTORY')])], passNotes: false }), 'K2_NOTES_UNREAD');
  refuses(() => direct({}), 'DATA_INPUTS_MISSING'); // 没有附注、K2 里也没有
});

test('没有 k2_notes 的题：结果与列空附注、不传附注字节的结果逐字节相同，不带 k2_notes 字段', () => {
  const k2 = `${K2_NO_TOKENS}${tok('ALPACA_1M_HISTORY')}\n`;
  const plain = direct({ k2 });
  assert.equal('k2_notes' in plain, false);
  assert.equal(JSON.stringify(direct({ k2, passNotes: false })), JSON.stringify(plain));
  assert.equal(JSON.stringify(direct({ k2, entryPatch: { k2_notes: [] } })), JSON.stringify(plain));
});

test('登记表字段为 null 当「没写」：PIT、价格口径、供应方都记 PENDING_REGISTRY_FIELD，不拒', () => {
  const reg = withFields({ ALPACA_1M_HISTORY: { pitSemantics: null, priceBasis: null, vendor: null } });
  const [row] = direct({ k2: `${K2_NO_TOKENS}${tok('ALPACA_1M_HISTORY', { pit: 'ACCEPTANCE_TIME', vendor: 'Anyone' })}\n`, registry: reg }).data_inputs;
  assert.deepEqual([row.pit_check, row.basis_check, row.vendor_check], ['PENDING_REGISTRY_FIELD', 'PENDING_REGISTRY_FIELD', 'PENDING_REGISTRY_FIELD']);
});

test('pitSemantics 可以是列表：记号的 PIT 是其中之一才过，否则 PARITY_PIT_SEMANTICS_MISMATCH', () => {
  const reg = withFields({ ALPACA_1M_HISTORY: { pitSemantics: ['BAR_CLOSE', 'OBSERVED_AT'] } });
  assert.equal(direct({ k2: `${K2_NO_TOKENS}${tok('ALPACA_1M_HISTORY', { pit: 'OBSERVED_AT' })}\n`, registry: reg }).data_inputs[0].pit_check, 'CHECKED');
  refuses(() => direct({ k2: `${K2_NO_TOKENS}${tok('ALPACA_1M_HISTORY', { pit: 'ACCEPTANCE_TIME' })}\n`, registry: reg }), 'PIT_SEMANTICS_MISMATCH');
});

test('BASIS：数据集写了 priceBasis（字符串或列表）时记号必须带、且是其中之一；没写时只记；写法要合登记表的 priceBasisVocabulary', () => {
  const reg = withFields({ ALPACA_1M_HISTORY: { priceBasis: ['PRICE/RAW', 'TOTAL_RETURN/FULL_ADJ'] }, SMARTFLOW_US_1M: { priceBasis: 'PRICE/RAW' } });
  const k2 = (t) => `${K2_NO_TOKENS}${t}\n`;
  refuses(() => direct({ k2: k2(tok('ALPACA_1M_HISTORY')), registry: reg }), 'PRICE_BASIS_MISSING');
  refuses(() => direct({ k2: k2(tok('SMARTFLOW_US_1M', { basis: 'TOTAL_RETURN/FULL_ADJ' })), registry: reg }), 'PRICE_BASIS_MISMATCH');
  const ok = direct({ k2: k2(tok('ALPACA_1M_HISTORY', { basis: 'TOTAL_RETURN/FULL_ADJ' })), registry: reg }).data_inputs[0];
  assert.deepEqual([ok.price_basis, ok.basis_check], ['TOTAL_RETURN/FULL_ADJ', 'CHECKED']);
  const pending = direct({ k2: k2(tok('L1_RISK_BUDGET_BANDS', { pit: 'OBSERVED_AT', vendor: 'Cycle Atlas', basis: 'PRICE/RAW' })), registry: reg }).data_inputs[0];
  assert.deepEqual([pending.price_basis, pending.basis_check], ['PRICE/RAW', 'PENDING_REGISTRY_FIELD']);
  refuses(() => direct({ k2: k2(tok('ALPACA_1M_HISTORY', { basis: 'PRICE' })), registry: reg }), 'DATA_INPUT_INVALID');
  refuses(() => direct({ k2: k2(tok('ALPACA_1M_HISTORY', { basis: 'PRICE/DIV_ADJ' })), registry: reg }), 'DATA_INPUT_INVALID');
  // 登记表的口径说明（KG 1.13.0 是对象，format 写两组）加了新值，记号就能用它
  const vocab = withFields({ ALPACA_1M_HISTORY: { priceBasis: 'PRICE/DIV_ADJ' } }, { registry: { ...REG.registry, priceBasisVocabulary: { format: '<PRICE|TOTAL_RETURN>/<RAW|SPLIT_ADJ|FULL_ADJ|DIV_ADJ>; …' } } });
  assert.equal(direct({ k2: k2(tok('ALPACA_1M_HISTORY', { basis: 'PRICE/DIV_ADJ' })), registry: vocab }).data_inputs[0].basis_check, 'CHECKED');
  assert.deepEqual(gate.DEFAULT_BASIS_GROUPS.map((g) => [...g]), [['PRICE', 'TOTAL_RETURN'], ['RAW', 'SPLIT_ADJ', 'FULL_ADJ']]);
});

test('VENDOR：记号的供应方必须是数据集 vendor 按逗号拆开、去空白后的一项，否则 PARITY_VENDOR_MISMATCH；没写时只记', () => {
  const reg = withFields({ SMARTFLOW_U11_UNDERLYING_FACTS: { vendor: 'SEC EDGAR, Alpaca' }, ALPACA_1M_HISTORY: { vendor: 'Alpaca' } });
  const k2 = (t) => `${K2_NO_TOKENS}${t}\n`;
  assert.equal(direct({ k2: k2(tok('SMARTFLOW_U11_UNDERLYING_FACTS', { pit: 'ACCEPTANCE_TIME', vendor: 'Alpaca' })), registry: reg }).data_inputs[0].vendor_check, 'CHECKED');
  assert.equal(direct({ k2: k2(tok('SMARTFLOW_U11_UNDERLYING_FACTS', { pit: 'ACCEPTANCE_TIME', vendor: 'SEC EDGAR' })), registry: reg }).data_inputs[0].vendor_check, 'CHECKED');
  refuses(() => direct({ k2: k2(tok('ALPACA_1M_HISTORY', { vendor: 'Alpaca SIP' })), registry: reg }), 'VENDOR_MISMATCH');
  assert.equal(direct({ k2: k2(tok('SMARTFLOW_US_1M', { vendor: 'Yahoo' })), registry: reg }).data_inputs[0].vendor_check, 'PENDING_REGISTRY_FIELD');
});

// ── 导入器：附注按 sha256 复验（readBound），两个导入器同一条路 ─────────────────────

function fixture({ store = 'overseas', noteText }) {
  const art = tmp('qrp-notes-art-');
  const files = { 'R99_RESULT.json': `${JSON.stringify({ verdict: { decision: '做', evidence_strength: '证据不足', allowed_use: '前向影子', text_zh: '合成' } })}\n`,
    'R99_K2.md': K2_NO_TOKENS, 'R99_K2_FREEZE_1_NOTE_1.md': noteText };
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(art, f), body);
  const coord = (f) => ({ source: 'coordinator', path: f, sha256: sha(files[f]), ref: `artifacts/coordinator/${f}` });
  const entry = { id: 'R99-NOTES', label_zh: 'R99', strategy_ref: store === 'overseas' ? 'C17_V2_4000USDT' : 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-10',
    title_zh: '合成题（冻结附注）', k2_frozen_at: '2026-11-09T20:00:00+08:00', file: coord('R99_RESULT.json'), k2: coord('R99_K2.md'), freeze: null,
    k2_notes: [coord('R99_K2_FREEZE_1_NOTE_1.md')],
    read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'verdict.text_zh' }, expect: '做' };
  const out = tmp('qrp-notes-ev-');
  overseas.stageEvidence({ artifactsRoot: art, out, entries: [entry], roots: {} });
  return { entry, out };
}
const inScope = (fn) => gate.internals.withDefaults({ effectiveFrom: '2026-11-01T00:00:00+08:00' }, fn);
const count = (file) => (fs.existsSync(file) ? read(file).length : 0);

test('导入器：附注按 sha256 复验后把字节交给门（海外与 A 股同一条路）；附注字节被改 → readBound 拒绝、台账不写', () => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  for (const f of [overseas.LEDGER(), ashare.LEDGER()]) { try { fs.rmSync(f); } catch { /* 首次 */ } }
  const noteText = note([tok('ALPACA_1M_HISTORY'), tok('SMARTFLOW_US_1M', { vendor: 'Yahoo' })]);
  const fx = fixture({ noteText });
  const [lock] = inScope(() => overseas.importVerdicts(fx.out, { registeredBy: AUTH, entries: [fx.entry] }));
  assert.deepEqual([lock.parity_gate.state, lock.parity_gate.data_inputs.map((d) => d.dataset_id)], ['PASS', ['ALPACA_1M_HISTORY', 'SMARTFLOW_US_1M']]);
  assert.deepEqual(lock.refs.filter((r) => r.role === 'K2_NOTE').map((r) => r.sha256), [fx.entry.k2_notes[0].sha256]);
  const cn = fixture({ store: 'ashare', noteText });
  const [cnLock] = inScope(() => ashare.importVerdicts(cn.out, { registeredBy: AUTH, entries: [cn.entry] }));
  assert.deepEqual(cnLock.parity_gate.k2_notes, [{ path: 'R99_K2_FREEZE_1_NOTE_1.md', sha256: cn.entry.k2_notes[0].sha256 }]);
  fs.rmSync(overseas.LEDGER());
  const bad = fixture({ noteText });
  fs.appendFileSync(path.join(bad.out, 'coordinator', 'R99_K2_FREEZE_1_NOTE_1.md'), tok('L1_RISK_BUDGET_BANDS', { pit: 'OBSERVED_AT', vendor: 'Cycle Atlas' }));
  assert.throws(() => inScope(() => overseas.importVerdicts(bad.out, { registeredBy: AUTH, entries: [bad.entry] })), /OVERSEAS_VERDICT_SHA256_MISMATCH/);
  assert.equal(count(overseas.LEDGER()), 0);
});

test('导入器：没有 k2_notes 的题照旧——锁里没有 K2_NOTE、parity_gate 不带 k2_notes', () => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  try { fs.rmSync(overseas.LEDGER()); } catch { /* 首次 */ }
  const fx = fixture({ noteText: note([]) });
  const entry = { ...fx.entry, k2: { ...fx.entry.k2 } };
  delete entry.k2_notes;
  // K2 自己带记号：重新取一份 K2 正文带记号的夹具
  const art = tmp('qrp-notes-plain-');
  const k2 = `${K2_NO_TOKENS}${tok('ALPACA_1M_HISTORY')}\n`;
  for (const [f, body] of [['R99_RESULT.json', fs.readFileSync(path.join(fx.out, 'coordinator', 'R99_RESULT.json'))], ['R99_K2.md', k2]]) fs.writeFileSync(path.join(art, f), body);
  entry.k2 = { source: 'coordinator', path: 'R99_K2.md', sha256: sha(k2), ref: 'artifacts/coordinator/R99_K2.md' };
  const out = tmp('qrp-notes-plain-ev-');
  overseas.stageEvidence({ artifactsRoot: art, out, entries: [entry], roots: {} });
  const [lock] = inScope(() => overseas.importVerdicts(out, { registeredBy: AUTH, entries: [entry] }));
  assert.equal(lock.refs.some((r) => r.role === 'K2_NOTE'), false);
  assert.equal('k2_notes' in lock.parity_gate, false);
});
