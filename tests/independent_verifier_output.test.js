'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./_verifier_fixture');
const verifier = require('../services/independent-verifier');

/** 生成方只收到 {通过|不通过, 原因码}（PLAN V1.1 修订 1 §2.2）；同输入逐字节相同（§1.2 / 验收）。 */
const failing = () => fx.build({ v3: (v3) => { v3.overfit.dsr = 0.123456; v3.overfit.pbo = 0.4321; } });

test('生成方输出的键集合固定：candidateId / verdict / reasonCodes，不多不少；原因码只有「阶段_码」', () => {
  const go = (x) => verifier.verify(x.bundle, x.ctx);
  for (const out of [go(fx.build()), go(failing())]) {
    assert.deepEqual(Object.keys(out.generator).sort(), ['candidateId', 'reasonCodes', 'verdict']);
    assert.deepEqual([...verifier.GENERATOR_KEYS].sort(), ['candidateId', 'reasonCodes', 'verdict']);
    assert.ok(['pass', 'fail'].includes(out.generator.verdict));
    for (const c of out.generator.reasonCodes) assert.match(c, /^V[1-6]_[A-Z0-9_]+$/);
  }
});

test('生成方输出里没有任何指标：失败案例里的 DSR / PBO 数值、p 值都不出现在序列化文本里（原因码里的字母不算数值）', () => {
  const { bundle, ctx } = failing();
  const text = verifier.serializeGenerator(verifier.verify(bundle, ctx).generator);
  for (const secret of ['0.123456', '0.4321', '0.97', '0.001', 'sharpe', 'ic_mean']) assert.ok(!text.toLowerCase().includes(secret), secret);
  assert.deepEqual(JSON.parse(text), { candidateId: 'cand-1', reasonCodes: ['V3_MINE_DSR_BELOW_MIN'], verdict: 'fail' });
});

test('原因码来自闸门的错误码，细节（含数值）被丢掉；数字、小数点、空格进不了原因码', () => {
  assert.equal(verifier.reasonCode('V4', { code: 'COST_MODEL_NET_PARTIAL', detail: 'x:missing=EXCHANGE_FEE 0.0123' }), 'V4_COST_MODEL_NET_PARTIAL');
  assert.equal(verifier.reasonCode('V4', { code: 'weird code 0.5' }), 'V4_STAGE_ERROR');
  assert.equal(verifier.reasonCode('V2', new TypeError('boom 0.5')), 'V2_STAGE_ERROR');
});

test('同输入两次输出逐字节相同（内部报告与生成方输出）；内部报告带输入包的 sha256', () => {
  const a = fx.build(); const b = fx.build();
  const ra = verifier.verify(a.bundle, a.ctx); const rb = verifier.verify(b.bundle, b.ctx);
  assert.equal(verifier.serializeInternal(ra.internal), verifier.serializeInternal(rb.internal));
  assert.equal(verifier.serializeGenerator(ra.generator), verifier.serializeGenerator(rb.generator));
  assert.match(ra.internal.bundleSha256, /^[0-9a-f]{64}$/);
  const c = failing();
  assert.notEqual(verifier.serializeInternal(verifier.verify(c.bundle, c.ctx).internal), verifier.serializeInternal(ra.internal));
});

test('验证器不改输入：verify 前后输入包逐字节相同', () => {
  const { bundle, ctx } = fx.build();
  const before = JSON.stringify(bundle);
  verifier.verify(bundle, ctx);
  assert.equal(JSON.stringify(bundle), before);
});
