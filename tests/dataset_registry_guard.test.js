'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const datasetRegistry = require('../services/dataset-registry');

/**
 * KG 数据集登记表的 QRP 钉版守卫（RESEARCH_LIVE_PARITY_V1 ★5 (a)，签字页 f0fe8e5c，签字文本 ceb35505）。
 * 同 smartflow tests/dataset-registry-guard.test.js（DRS-*）与 V6 的做法：登记表与扫描器按 sha256 钉在 config/dataset-registry/，
 * 与生产两端（V6、smartflow）钉的是同一个 KG 提交、同一组 sha256。
 */
const DIR = path.join(__dirname, '..', 'config', 'dataset-registry');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PIN = JSON.parse(fs.readFileSync(path.join(DIR, 'PIN.json'), 'utf8'));
const scan = require(path.join(DIR, 'dataset-registry-scan.cjs'));

test('DRQ-0 登记表与扫描器是钉住的 KG 副本（322ff69b，登记表 1e32a26c…，1.13.0），与生产钉的相同（smartflow 2e958543；V6 在 #119 合并前仍记 83ab3af1）', () => {
  assert.equal(PIN.repository, 'wendy926/knowledge-graph');
  assert.equal(PIN.commit, '322ff69b28bf05efa3ef7b9ed75cb31504ac35f9');
  assert.equal(PIN.files['datasets.v1.json'], '1e32a26ca509d5dd82ad6123665ed8bb13495fd1f832b78d29b70f5450f8d94d');
  assert.equal(PIN.files['dataset-registry-scan.cjs'], '461611f5467c228850162a6ed677a479f1dc79c426310c2f1ef3fcc9db9c40af');
  for (const [file, hash] of Object.entries(PIN.files)) assert.equal(sha256(fs.readFileSync(path.join(DIR, file))), hash, file);
  const pinned = datasetRegistry.pinned();
  assert.deepEqual([pinned.commit, pinned.registry_version, pinned.registry_sha256, pinned.datasets.size], [PIN.commit, '1.13.0', PIN.files['datasets.v1.json'], 35]);
  assert.deepEqual(PIN.production_pins.map((p) => [p.repository, p.commit]), [
    ['ashare-v6', '83ab3af185c86cd2a21269ce918e49017f8876b3'],
    ['smartflow', '2e9585434853cbd6dc97769e32687ee530125f1c'],
  ]);
});

test('DRQ-1 登记表有效（每个数据集一个所有者、例外类别认得、没有过期的 INTERIM）', () => {
  assert.deepEqual(scan.validateRegistry(datasetRegistry.pinned().registry), []);
});

test('DRQ-2 QRP 不采集、不生产任何不归它的登记数据集（扫描 QRP 仓库，同 smartflow DRS-2；config/ 里的钉版副本不扫）', () => {
  const result = scan.scanRepository({ root: path.join(__dirname, '..'), system: 'QRP', registry: datasetRegistry.pinned().registry });
  assert.equal(scan.describe(result), '');
  assert.deepEqual([result.findings.length, result.uncovered.length, result.stale.length], [0, 0, 0]);
});

test('DRQ-4 钉过的每一份都留在 history/（按 sha，逐个文件复验），并包含现在钉的这一份；历史里的一份被改即拒', () => {
  const history = datasetRegistry.history();
  const pinned = datasetRegistry.pinned();
  assert.ok(history.has(`${pinned.registry_version}#${pinned.registry_sha256}`));
  for (const h of history.values()) assert.equal(h.dir, `${h.registry_version}-${h.registry_sha256.slice(0, 8)}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-drq-h-'));
  fs.cpSync(DIR, dir, { recursive: true });
  const first = [...history.values()][0];
  fs.appendFileSync(path.join(dir, 'history', first.dir, 'dataset-registry-scan.cjs'), '\n// drift\n');
  assert.throws(() => datasetRegistry.history({ dir }), /DATASET_REGISTRY_PIN_DRIFT/);
  fs.rmSync(path.join(dir, 'history', 'HISTORY.json'));
  assert.throws(() => datasetRegistry.history({ dir }), /DATASET_REGISTRY_FILE_MISSING/);
});

test('DRQ-3 副本漂移即拒：登记表或扫描器的字节与 PIN 不符、登记表版本与 PIN 不符、PIN 缺文件', () => {
  const copy = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-drq-')); fs.cpSync(DIR, dir, { recursive: true }); return dir; };
  const drifted = copy();
  const doc = JSON.parse(fs.readFileSync(path.join(drifted, 'datasets.v1.json'), 'utf8'));
  doc.datasets[0].title += ' (edited)';
  fs.writeFileSync(path.join(drifted, 'datasets.v1.json'), JSON.stringify(doc, null, 2));
  assert.throws(() => datasetRegistry.pinned({ dir: drifted }), /DATASET_REGISTRY_PIN_DRIFT:datasets\.v1\.json/);
  const scanner = copy();
  fs.appendFileSync(path.join(scanner, 'dataset-registry-scan.cjs'), '\n// drift\n');
  assert.throws(() => datasetRegistry.pinned({ dir: scanner }), /DATASET_REGISTRY_PIN_DRIFT:dataset-registry-scan\.cjs/);
  const version = copy();
  const pin = JSON.parse(fs.readFileSync(path.join(version, 'PIN.json'), 'utf8'));
  fs.writeFileSync(path.join(version, 'PIN.json'), JSON.stringify({ ...pin, registry_version: '1.12.0' }));
  assert.throws(() => datasetRegistry.pinned({ dir: version }), /DATASET_REGISTRY_VERSION_MISMATCH/);
  const missing = copy();
  fs.rmSync(path.join(missing, 'datasets.v1.json'));
  assert.throws(() => datasetRegistry.pinned({ dir: missing }), /DATASET_REGISTRY_FILE_MISSING/);
});
