'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const directory = require('../services/desk-strategy-directory');

function fakeSource() {
  return {
    books: {
      CN: { USER: 'USER_MONITOR_ONLY', CN_PAPER: 'PAPER' },
      US: { US_CURRENT: 'PAPER', US_RUN_OFF: 'PAPER', US_CLOSED: 'PAPER' },
      CRYPTO: { CRYPTO_SHADOW: 'SHADOW' },
    },
    effectiveFrom: {},
    closedBooks: { US_RUN_OFF: { successor: 'US_CURRENT' }, US_CLOSED: { successor: 'US_CURRENT' } },
    notYetEffective: () => null,
    closedBook: (id) => id === 'US_CLOSED' ? { since: '2026-10-01' } : null,
    runOffBook: (id) => id === 'US_RUN_OFF' ? { since: '2026-10-01' } : null,
    bookLifecycle: (_report, id) => id === 'US_CLOSED' ? { state: 'CLOSED' }
      : id === 'US_RUN_OFF' ? { state: 'RUN_OFF' } : { state: 'OPEN' },
    explain: (id) => `可读策略 ${id}`,
    provenance: { files: [] },
  };
}

test('Desk 策略目录排除个人监控账本，并分开运行、观察、收尾与关闭', () => {
  const model = directory.readModel({
    source: fakeSource(), asOf: '2026-10-24T00:00:00Z',
    cases: [{ case_id: 'CURRENT-CASE', strategy_ref: 'US_CURRENT', links: [] }, {
      case_id: 'BASELINE-CASE', strategy_ref: 'US_CURRENT',
      baseline: { strategy_ref: 'US_RUN_OFF' }, links: [],
    }],
  });
  assert.equal(model.state, 'AVAILABLE');
  assert.equal(model.strategies.some((item) => item.strategy_ref === 'USER'), false);
  assert.deepEqual(model.counts, { current: 3, history: 2, research_connected: 2 });
  assert.equal(model.strategies.find((item) => item.strategy_ref === 'CRYPTO_SHADOW').lifecycle.code, 'OBSERVING');
  assert.equal(model.strategies.find((item) => item.strategy_ref === 'US_RUN_OFF').lifecycle.code, 'RUN_OFF');
  assert.equal(model.strategies.find((item) => item.strategy_ref === 'US_CLOSED').lifecycle.code, 'CLOSED');
  assert.equal(model.strategies.find((item) => item.strategy_ref === 'US_CURRENT').research.code, 'CONNECTED');
  assert.equal(model.strategies.find((item) => item.strategy_ref === 'US_RUN_OFF').research.code, 'FROZEN_BASELINE');
});

test('Desk 权威源不可读取时明确失败，不退回硬编码目录', () => {
  const model = directory.readModel({ deskRoot: '/definitely/not/a/desk/root', asOf: '2026-10-24T00:00:00Z' });
  assert.equal(model.state, 'UNAVAILABLE');
  assert.deepEqual(model.strategies, []);
  assert.equal(model.counts.current, null);
  assert.match(model.error, /DESK_STRATEGY_SOURCE_MISSING/);
});

test('Desk 生命周期权威导出缺项时整目录 fail closed，不把未知误报为运行中', () => {
  const model = directory.readModel({
    source: { books: { US: { X: 'PAPER' } }, explain: () => '策略 X' },
    asOf: '2026-10-24T00:00:00Z',
  });
  assert.equal(model.state, 'UNAVAILABLE');
  assert.deepEqual(model.strategies, []);
  assert.match(model.error, /DESK_STRATEGY_SOURCE_INVALID/);
  assert.match(model.error, /effectiveFrom/);
  assert.match(model.error, /bookLifecycle/);
});

test('默认适配真实 Desk 权威模块并保留文件哈希来源', () => {
  const model = directory.readModel({ asOf: '2026-10-24T00:00:00Z', cases: [] });
  assert.equal(model.state, 'AVAILABLE');
  assert.equal(model.strategies.length, 8);
  assert.ok(model.strategies.some((item) => item.name === 'A 股系统选股账本（模拟盘）'));
  assert.ok(model.strategies.some((item) => item.lifecycle.code === 'OBSERVING'));
  assert.ok(model.history.some((item) => item.lifecycle.code === 'RUN_OFF'));
  assert.equal(model.history.find((item) => item.strategy_ref === 'US_CORE_6000USD_3X_GATEOBS').lifecycle.final_delivery_pending, true);
  assert.ok(model.provenance.files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
});
