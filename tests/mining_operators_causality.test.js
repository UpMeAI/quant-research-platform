'use strict';
/**
 * 白名单算子的因果证据（研究框架修订 2026-11-16 §3.2「每个白名单算子按 G-CAUSAL 的 T-C1、T-C2 证一次（CAUSALITY_EVIDENCE_V1，role: FEATURE）」；
 * §8.3 第 7 条）。tools/causality-harness 按 docs/evidence/mining-operators-v1/manifest.json 跑出的证据：十二个算子 role FEATURE，
 * T-C1 / T-C2 / T-C3 全 PASS；证据的 code_sha 上 operators.js 的字节与现在一样（改了算子就得重跑证据）。
 * 反例：故意偷看 t+1 的算子（tests/fixtures/mining-sandbox/peek），T-C1 与 T-C2 都必须 FAIL。全部是合成数据。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const gate = require('../services/causality-gate');
const core = require('../tools/causality-harness/lib/core');
const dsl = require('../services/mining-sandbox/dsl');
const space = require('../services/mining-sandbox/space');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'evidence', 'mining-operators-v1');
const SIGNED = 'fd22876f6a690b52b07429f333d2545d8fedb5d285dccd3fd3f5a1ecd9f00c80';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('因果证据：白名单十二个算子 role FEATURE，T-C1 / T-C2 / T-C3 全 PASS；绑定签字文本 fd22876f；证据提交上 operators.js 的字节与现在一致', () => {
  const bytes = fs.readFileSync(path.join(DIR, 'CAUSALITY_EVIDENCE_V1.json'));
  assert.equal(fs.readFileSync(path.join(DIR, 'CAUSALITY_EVIDENCE_V1.json.sha256'), 'utf8').trim().split(/\s+/)[0], sha256(bytes));
  const doc = gate.parseEvidence(bytes, 'mining-operators-v1');
  assert.deepEqual([doc.study_ref, doc.k2_sha256, doc.code_repo, doc.contract_ref], ['MINING_OPERATORS_V1', SIGNED, 'qrp', gate.CONTRACT_REF]);
  assert.match(doc.code_sha || '', /^[0-9a-f]{40}$/);
  assert.deepEqual(doc.unknown, {});
  assert.equal(doc.manifest_sha256, sha256(fs.readFileSync(path.join(DIR, 'manifest.json'))));
  assert.deepEqual(doc.functions.map((f) => f.function_id.split('#ROWS.')[1]).sort(), Object.keys(dsl.OPERATORS).sort());
  for (const f of doc.functions) {
    assert.ok(f.function_id.startsWith(`${space.OPERATORS_PATH}#ROWS.`), f.function_id);
    assert.deepEqual([f.role, f.t_c1, f.t_c2, f.t_c3], ['FEATURE', 'PASS', 'PASS', 'PASS'], f.function_id);
  }
  const now = sha256(fs.readFileSync(path.join(ROOT, 'services', 'mining-sandbox', 'evaluator', 'operators.js')));
  const atEvidence = sha256(execFileSync('git', ['-C', ROOT, 'show', `${doc.code_sha}:services/mining-sandbox/evaluator/operators.js`]));
  assert.equal(atEvidence, now, 'operators.js 改过，证据要重跑');
});

test('反例（§8.3 第 7 条）：故意偷看 t+1 的算子，T-C1 与 T-C2 都 FAIL；它不在白名单里，DSL 也不认', () => {
  const manifest = path.join(ROOT, 'tests', 'fixtures', 'mining-sandbox', 'peek', 'manifest.json');
  const ev = core.runManifest(manifest, { codeRoot: ROOT, registeredBy: 'TEST', registeredAt: '2026-11-17T03:00:00Z', k: 5 });
  const [f] = ev.functions;
  assert.deepEqual([f.function_id.split('#')[1], f.t_c1, f.t_c2], ['ROWS.ts_lead', 'FAIL', 'FAIL']);
  assert.throws(() => dsl.parse('ts_lead(close, 1)', { readings: ['close'], constants: [], lookbacks: [1] }), /MINE_DSL_OPERATOR_NOT_WHITELISTED:ts_lead/);
});
