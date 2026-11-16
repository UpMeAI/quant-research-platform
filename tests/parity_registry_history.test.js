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
const datasetRegistry = require('../services/dataset-registry');
const { repin } = require('../tools/dataset-registry-repin/repin');

/**
 * 登记表的历史与逐数据集的一致性字段（协调会话 2026-11-17 01:2x 裁定；RESEARCH_LIVE_PARITY_V1，签字文本 ceb35505、签字页 f0fe8e5c）。先红后绿。
 * 现行登记表在测试里是 KG #368 的 1.13.0（head b1f29ce9 的 datasets.v1.json，作为测试夹具拷在 tests/fixtures/dataset-registry-kg368/；#368 未合并，生产不钉它）：
 * 用真的重钉工具把 config/dataset-registry 的临时副本从 1.11.0 重钉到它，历史里留下 1.11.0。
 */
const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'dataset-registry-kg368');
const COORDINATOR_DIR = path.resolve(process.env.QRP_COORDINATOR_DIR || path.join(ROOT, '..', 'artifacts', 'coordinator'));
const NOTE = path.join(COORDINATOR_DIR, 'R_US_ENTRY_TOUCH_1_K2_V1_FREEZE_1_NOTE_1.md');
const NOTE_SHA = '93b064b595582cb53e05c0f0931d2ea065c4c27f35fa1ba80c1c28019ab1b538';
const OLD = datasetRegistry.pinned();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 一个合成的 KG 仓库：每次提交一份 datasets.v1.json（扫描器取夹具的）。 */
function kg() {
  const root = tmp('qrp-kg-');
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'data', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'registry'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, 'dataset-registry-scan.cjs'), path.join(root, 'scripts', 'registry', 'dataset-registry-scan.cjs'));
  return { root, commit: (bytes) => { fs.writeFileSync(path.join(root, 'data', 'registry', 'datasets.v1.json'), bytes); git('add', '.'); git('commit', '-q', '-m', 'registry'); return git('rev-parse', 'HEAD'); } };
}
/** config/dataset-registry 的临时副本（含历史）。 */
function copyConfig() {
  const dir = tmp('qrp-dr-');
  fs.cpSync(datasetRegistry.DIR, dir, { recursive: true });
  return dir;
}
const FIXTURE_BYTES = fs.readFileSync(path.join(FIXTURE, 'datasets.v1.json'));
const FIXTURE_SHA = sha(FIXTURE_BYTES);
/** 重钉到 1.13.0（夹具）之后的登记表与历史。 */
function at113() {
  const k = kg();
  const commit = k.commit(FIXTURE_BYTES);
  const dir = copyConfig();
  const r = repin({ kgRoot: k.root, commit, dir });
  return { dir, k, commit, r, registry: datasetRegistry.pinned({ dir }), history: datasetRegistry.history({ dir }) };
}
const tok = (id, { version, sha256, pit = 'BAR_CLOSE', vendor = 'Alpaca', basis } = {}) => `\`DATA:${id}@${version}#${sha256}|PIT=${pit}|VENDOR=${vendor}${basis ? `|BASIS=${basis}` : ''}\``;
function direct(text, { registry, history }) {
  const k2 = Buffer.from(`# 合成 K2\n\n## 0\n**数据输入**：${text}\n`);
  return gate.check({ id: 'US-HIST', kind: 'RESULT', sealed_on: '2026-11-20', k2: { sha256: sha(k2) }, k2_frozen_at: '2026-11-17T10:00:00+08:00' }, { k2Bytes: () => k2 }, { registry, history });
}
const refuses = (fn, code, detail) => assert.throws(fn, (e) => e.code === `PARITY_${code}` && (!detail || String(e.detail).includes(detail)), `${code} ${detail || ''}`);

test('重钉工具：换下来的 1.11.0 原样留在历史里，新的 1.13.0 也记进历史；PIN.json 换成新提交、新 sha 与版本，生产两端的钉版没给就照旧', () => {
  const { dir, commit, r, registry, history } = at113();
  assert.deepEqual([r.outgoing, r.incoming], [`1.11.0-${OLD.registry_sha256.slice(0, 8)}`, `1.13.0-${FIXTURE_SHA.slice(0, 8)}`]);
  assert.deepEqual([registry.commit, registry.registry_version, registry.registry_sha256], [commit, '1.13.0', FIXTURE_SHA]);
  assert.deepEqual([...history.keys()], [`1.11.0#${OLD.registry_sha256}`, `1.13.0#${FIXTURE_SHA}`]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'history', `1.11.0-${OLD.registry_sha256.slice(0, 8)}`, 'datasets.v1.json')), fs.readFileSync(path.join(datasetRegistry.DIR, 'datasets.v1.json')));
  assert.deepEqual(registry.production_pins, OLD.production_pins);
  // 历史里的一份被改了字节 → 读历史即失败即关
  fs.appendFileSync(path.join(dir, 'history', `1.11.0-${OLD.registry_sha256.slice(0, 8)}`, 'datasets.v1.json'), ' ');
  assert.throws(() => datasetRegistry.history({ dir }), /DATASET_REGISTRY_PIN_DRIFT/);
});

test('R_US_ENTRY_TOUCH_1 的真实冻结附注 NOTE_1：三个记号钉在 1.11.0，对现行 1.13.0 → 通过（历史里有、一致性字段没变；BASIS、VENDOR 不适用）',
  { skip: fs.existsSync(NOTE) ? false : `协调会话目录里没有 ${path.basename(NOTE)}（QRP_COORDINATOR_DIR=${COORDINATOR_DIR}）` }, () => {
    const bytes = fs.readFileSync(NOTE);
    assert.equal(sha(bytes), NOTE_SHA);
    const { registry, history } = at113();
    const k2 = Buffer.from('# R_US_ENTRY_TOUCH_1_K2_V1（合成的 K2 正文；记号只在冻结附注里）\n');
    const r = gate.check({ id: 'US-R-ENTRY-TOUCH-1', kind: 'RESULT', sealed_on: '2026-11-20', k2: { sha256: sha(k2) }, k2_frozen_at: '2026-11-17T10:00:00+08:00',
      k2_notes: [{ source: 'coordinator', path: path.basename(NOTE), sha256: NOTE_SHA }] }, { k2Bytes: () => k2, noteBytes: () => [bytes] }, { registry, history });
    assert.equal(r.state, 'PASS');
    assert.deepEqual(r.data_inputs.map((d) => [d.dataset_id, d.registry_version, d.pin_check, d.pit_check, d.basis_check, d.vendor_check]), [
      ['ALPACA_1M_HISTORY', '1.11.0', 'HISTORY_UNCHANGED', 'CHECKED', 'NOT_APPLICABLE_PRE_FIELD', 'NOT_APPLICABLE_PRE_FIELD'],
      ['SMARTFLOW_US_1M', '1.11.0', 'HISTORY_UNCHANGED', 'CHECKED', 'NOT_APPLICABLE_PRE_FIELD', 'NOT_APPLICABLE_PRE_FIELD'],
      ['L1_RISK_BUDGET_BANDS', '1.11.0', 'HISTORY_UNCHANGED', 'CHECKED', 'NOT_APPLICABLE_PRE_FIELD', 'NOT_APPLICABLE_PRE_FIELD'],
    ]);
    assert.deepEqual(r.registry, { commit: registry.commit, registry_version: '1.13.0', registry_sha256: FIXTURE_SHA });
  });

test('数据集变了（两版之间 pitSemantics 改了）→ PARITY_PIN_MISMATCH「DATASET_CHANGED:pitSemantics」；那一版没写的字段不算变', () => {
  const { dir, k } = at113();
  const changed = JSON.parse(FIXTURE_BYTES.toString('utf8'));
  changed.version = '1.14.0';
  changed.datasets.find((d) => d.id === 'ALPACA_1M_HISTORY').pitSemantics = 'OBSERVED_AT';
  changed.datasets.find((d) => d.id === 'SMARTFLOW_US_1M').owner = 'CYCLE_ATLAS';
  repin({ kgRoot: k.root, commit: k.commit(Buffer.from(JSON.stringify(changed, null, 2))), dir });
  const registry = datasetRegistry.pinned({ dir });
  const history = datasetRegistry.history({ dir });
  const v113 = { version: '1.13.0', sha256: FIXTURE_SHA };
  refuses(() => direct(tok('ALPACA_1M_HISTORY', { ...v113, basis: 'PRICE/RAW' }), { registry, history }), 'PIN_MISMATCH', 'DATASET_CHANGED:pitSemantics');
  refuses(() => direct(tok('SMARTFLOW_US_1M', { ...v113, vendor: 'Yahoo' }), { registry, history }), 'PIN_MISMATCH', 'DATASET_CHANGED:owner');
  // 钉在 1.11.0 的同一个数据集：1.11.0 没有 pitSemantics，不算变；PIT 照现行登记表核（现在是 OBSERVED_AT）
  const old = { version: '1.11.0', sha256: OLD.registry_sha256 };
  assert.equal(direct(tok('ALPACA_1M_HISTORY', { ...old, pit: 'OBSERVED_AT' }), { registry, history }).data_inputs[0].pin_check, 'HISTORY_UNCHANGED');
  refuses(() => direct(tok('ALPACA_1M_HISTORY', { ...old, pit: 'BAR_CLOSE' }), { registry, history }), 'PIT_SEMANTICS_MISMATCH');
  assert.deepEqual(datasetRegistry.changedFields({ id: 'X', owner: 'A', vendor: null }, { id: 'X', owner: 'A', vendor: 'B', pitSemantics: 'BAR_CLOSE' }), []);
  assert.deepEqual(datasetRegistry.changedFields({ id: 'X', producer: 'P1' }, { id: 'X', producedBy: 'P2' }), ['producedBy']);
});

test('记号钉的版本不在历史里 → PARITY_PIN_MISMATCH「VERSION_NOT_IN_HISTORY」', () => {
  const { registry, history } = at113();
  refuses(() => direct(tok('ALPACA_1M_HISTORY', { version: '1.12.0', sha256: 'c'.repeat(64) }), { registry, history }), 'PIN_MISMATCH', 'VERSION_NOT_IN_HISTORY');
  refuses(() => direct(tok('ALPACA_1M_HISTORY', { version: '1.11.0', sha256: 'c'.repeat(64) }), { registry, history }), 'PIN_MISMATCH', 'VERSION_NOT_IN_HISTORY');
});

test('钉在现行版本上的记号照旧：不读历史；VENDOR 不符只记不拒；BASIS 在 1.13.0 的记号上数据集有 priceBasis 就必须带，钉在 1.11.0 的记号不要求', () => {
  const { registry, history } = at113();
  const cur = { version: '1.13.0', sha256: FIXTURE_SHA };
  const same = direct(tok('SMARTFLOW_US_1M', { ...cur, vendor: 'Yahoo' }), { registry, history: new Map() });
  assert.deepEqual([same.state, same.data_inputs[0].pin_check, same.data_inputs[0].vendor_check, same.data_inputs[0].basis_check], ['PASS', 'CURRENT', 'MATCH', 'PENDING_REGISTRY_FIELD']);
  assert.equal(JSON.stringify(direct(tok('SMARTFLOW_US_1M', { ...cur, vendor: 'Yahoo' }), { registry, history })), JSON.stringify(same));
  const vendor = direct(tok('ALPACA_1M_HISTORY', { ...cur, vendor: 'Alpaca SIP', basis: 'PRICE/RAW' }), { registry, history });
  assert.deepEqual([vendor.state, vendor.data_inputs[0].vendor_check, vendor.data_inputs[0].registry_vendor], ['PASS', 'MISMATCH', ['Alpaca']]);
  assert.equal(gate.VENDOR_ENFORCED, false);
  refuses(() => direct(tok('ALPACA_1M_HISTORY', cur), { registry, history }), 'PRICE_BASIS_MISSING');
  const pre = direct(tok('ALPACA_1M_HISTORY', { version: '1.11.0', sha256: OLD.registry_sha256 }), { registry, history });
  assert.deepEqual([pre.state, pre.data_inputs[0].basis_check, pre.data_inputs[0].vendor_check], ['PASS', 'NOT_APPLICABLE_PRE_FIELD', 'NOT_APPLICABLE_PRE_FIELD']);
});
