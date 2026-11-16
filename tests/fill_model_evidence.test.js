'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const gate = require('../services/causality-gate');
const fm = require('../packages/fill-model');

/**
 * 统一成交模型库的因果证据（ENGINE_MODELING_ACCEPTANCE_V1 §2.2 第 3 条；附录 1 A1：成交函数 role: FILL）：
 * tools/causality-harness 按 docs/evidence/fill-model-v1/manifest.json 跑出的 CAUSALITY_EVIDENCE_V1。十二条规则（packages/fill-model/series.js 的逐行用法）
 * 都标 FILL，T-C1、T-C2、T-C3 全 PASS；证据的 code_sha 上 index.js 与 series.js 的字节和现在的一样（改了库就得重跑证据）。
 */
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'evidence', 'fill-model-v1');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SPEC_SHA = '90814c6075b7c7e3609b87f6a7e8fac3fd34698a5f32ee250c174fd602e062ac';

test('因果证据：十二条规则 role: FILL，T-C1 / T-C2 / T-C3 全 PASS；绑定规格 90814c60；证据的提交上库的字节与现在一致', () => {
  const bytes = fs.readFileSync(path.join(DIR, 'CAUSALITY_EVIDENCE_V1.json'));
  assert.equal(fs.readFileSync(path.join(DIR, 'CAUSALITY_EVIDENCE_V1.json.sha256'), 'utf8').trim().split(/\s+/)[0], sha256(bytes));
  const doc = gate.parseEvidence(bytes, 'fill-model-v1');
  assert.deepEqual([doc.study_ref, doc.k2_sha256, doc.code_repo, doc.contract_ref], ['FILL_MODEL_LIBRARY_V1', SPEC_SHA, 'qrp', gate.CONTRACT_REF]);
  assert.match(doc.code_sha || '', /^[0-9a-f]{40}$/);
  assert.deepEqual(doc.unknown, {});
  assert.equal(doc.manifest_sha256, sha256(fs.readFileSync(path.join(DIR, 'manifest.json'))));
  assert.deepEqual(doc.functions.map((f) => f.function_id), fm.RULES.map((r) => `qrp:packages/fill-model/series.js#${r}`));
  for (const f of doc.functions) assert.deepEqual([f.function_id, f.role, f.t_c1, f.t_c2, f.t_c3], [f.function_id, 'FILL', 'PASS', 'PASS', 'PASS']);
  for (const file of ['index.js', 'series.js']) {
    const now = sha256(fs.readFileSync(path.join(ROOT, 'packages', 'fill-model', file)));
    const atEvidence = sha256(execFileSync('git', ['-C', ROOT, 'show', `${doc.code_sha}:packages/fill-model/${file}`]));
    assert.equal(atEvidence, now, `${file} 改过，证据要重跑`);
  }
});
