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

test('DRQ-0 登记表与扫描器是钉住的 KG 副本（f4b24f41，登记表 930bae16…，1.17.0，45 个数据集，R-XM-1）；生产两端照旧：V6 85d188ec（1.14.0），smartflow 2e958543（1.13.0）', () => {
  assert.equal(PIN.repository, 'wendy926/knowledge-graph');
  assert.equal(PIN.commit, 'f4b24f41befe4f31f72824915ead28355d542cd5');
  assert.equal(PIN.files['datasets.v1.json'], '930bae16786398496d730540677aeb2294f0ceab09fea18c285aab99f59059cb');
  assert.equal(PIN.files['dataset-registry-scan.cjs'], '461611f5467c228850162a6ed677a479f1dc79c426310c2f1ef3fcc9db9c40af');
  for (const [file, hash] of Object.entries(PIN.files)) assert.equal(sha256(fs.readFileSync(path.join(DIR, file))), hash, file);
  const pinned = datasetRegistry.pinned();
  assert.deepEqual([pinned.commit, pinned.registry_version, pinned.registry_sha256, pinned.datasets.size], [PIN.commit, '1.17.0', PIN.files['datasets.v1.json'], 45]);
  assert.deepEqual(PIN.production_pins.map((p) => [p.repository, p.commit]), [
    ['ashare-v6', '85d188ec7294962a45b71632a3684d913b2f28c2'],
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
  // 1.13.0、1.14.0 留着：K2 里可能已有钉在这两版的记号（1.15.0、1.16.0 QRP 没钉过，不在历史里）
  assert.deepEqual([...history.values()].map((h) => h.registry_version), ['1.11.0', '1.13.0', '1.14.0', '1.17.0']);
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
