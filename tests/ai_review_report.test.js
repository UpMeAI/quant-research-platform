'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderReport } = require('../services/ai-review/report');
test('Q70 report preserves deterministic evidence when model is unavailable', () => {
  const rendered = renderReport({ status: 'BLOCKED:BUDGET', inputPackSha256: 'abc', facts: [
    { id: 'F1', ledger: 'US_CORE', data: { amount: 0, missing: null }, sourceSha256: 'source' },
  ] });
  assert.match(rendered, /F1/);
  assert.match(rendered, /"amount": 0/);
  assert.match(rendered, /"missing": null/);
  assert.match(rendered, /source/);
});
test('Q70 report exposes only accepted checked notes and all direction fields', () => {
  const note = { claims: [{ text: '已核对', refs: ['F1'] }], directions: [
    { question: '是否存在差异？', mechanism: '执行时差', control: '同源记录', requiredData: '成交明细', refs: ['F1'], dedupe: 'DEDUPE_PENDING' },
  ] };
  const accepted = renderReport({ status: 'ACCEPTED', checker: { ok: true }, facts: [], note });
  for (const text of ['已核对', '是否存在差异？', '执行时差', '同源记录', '成交明细']) assert.ok(accepted.includes(text));
  for (const status of ['QUARANTINED', 'BLOCKED:LLM_UNAVAILABLE']) {
    const hidden = renderReport({ status, checker: { ok: false }, facts: [], note });
    assert.ok(!hidden.includes('已核对'));
    assert.ok(!hidden.includes('是否存在差异'));
  }
});
