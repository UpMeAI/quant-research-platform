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

test('DRQ-0 登记表与扫描器是钉住的 KG 副本（12afd2fc，登记表 d8a17a3e…，1.11.0），与生产两端钉的相同', () => {
  assert.equal(PIN.repository, 'wendy926/knowledge-graph');
  assert.equal(PIN.commit, '12afd2fcb23f274630e01aad13d84f26f6c407f4');
  assert.equal(PIN.files['datasets.v1.json'], 'd8a17a3ee6e23e59494176eb818d7dc46fde382da032878eeb729af0855ba687');
  for (const [file, hash] of Object.entries(PIN.files)) assert.equal(sha256(fs.readFileSync(path.join(DIR, file))), hash, file);
  const pinned = datasetRegistry.pinned();
  assert.deepEqual([pinned.commit, pinned.registry_version, pinned.registry_sha256, pinned.datasets.size], [PIN.commit, '1.11.0', PIN.files['datasets.v1.json'], 24]);
  assert.deepEqual(PIN.production_pins.map((p) => p.repository), ['ashare-v6', 'smartflow']);
});

test('DRQ-1 登记表有效（每个数据集一个所有者、例外类别认得、没有过期的 INTERIM）', () => {
  assert.deepEqual(scan.validateRegistry(datasetRegistry.pinned().registry), []);
});

test('DRQ-2 QRP 还不是登记表里的系统（KG 消费方登记的 PR 合并、重钉之后，本条改为扫描 QRP 仓库，同 DRS-2）', () => {
  assert.throws(() => scan.scanRepository({ root: path.join(__dirname, '..'), system: 'QRP', registry: datasetRegistry.pinned().registry }), /DATASET_REGISTRY_UNKNOWN_SYSTEM:QRP/);
});

test('DRQ-3 副本漂移即拒：登记表或扫描器的字节与 PIN 不符、登记表版本与 PIN 不符、PIN 缺文件', () => {
  const copy = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-drq-')); for (const f of fs.readdirSync(DIR)) fs.copyFileSync(path.join(DIR, f), path.join(dir, f)); return dir; };
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
