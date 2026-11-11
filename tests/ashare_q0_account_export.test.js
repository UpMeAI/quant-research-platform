'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const adapter = require('../adapters/ashare-local/q0_account_export');
const unified = require('../services/signal-registry/unified');
const legacyRegistry = require('../services/signal-registry');
const { validateRecord } = require('../schemas');

const day = (businessDate, patch = {}) => ({
  schemaVersion: 'ASHARE_V6_Q0_ACCOUNT_DAY_V1', accountId: 'A', role: 'Q0_D', sealed: false,
  phase: { id: 'PHASE_1_OOS_INTERIM', label: '样本外先行', accountStart: '2024-01-02' }, businessDate,
  decisionCutoff: `${businessDate}T07:00:00.000Z`, status: 'SUCCEEDED', reasonCodes: ['ENTRY_BLOCKED:MARKET_STATE'],
  ranking: { state: 'READY' }, shortlistState: { state: 'READY' }, armPoints: [{ arm: 'H' }], klineDecisions: [{ code: 'KLINE_OK' }],
  marketGate: null, q0Events: [], recordId: `record-${businessDate}`, restore: {},
  point: { navCny: 100000, cashCny: 100000, grossExposureCny: 0, peakNavCny: 100000, positions: [], events: [] },
  ...patch,
});

test('A 股 Q0 账户日投影：只复制账户、成交、权益与规则证据，结果和信号登记都通过 schema', () => {
  const rows = [day('2024-01-02'), day('2024-01-03', {
    reasonCodes: [],
    point: {
      navCny: 100120.5, cashCny: 90000, grossExposureCny: 10120.5, peakNavCny: 100120.5, positions: [{ securityId: 'CN.TEST' }],
      events: [{ event: 'FILLED_BUY', securityId: 'CN.TEST', shares: 100, price: 10, decision: { reasonCodes: ['L1_MAINLINE', 'L5_TIMING'], ruleRef: 'A_V6_R1' } }],
    },
  })];
  const { result, registry } = adapter.adaptAccountDays(rows, {
    source: { file: 'A/c000.jsonl', sha256: 'a'.repeat(64) }, generatedAt: '2026-11-10T10:00:00.000Z',
  });

  assert.ok(validateRecord(result, 'ASHARE_Q0_ACCOUNT_RESULT_V1').ok);
  assert.ok(validateRecord(registry, 'ASHARE_Q0_SIGNAL_REGISTRY_V1').ok);
  assert.deepEqual(result.summary, { accountDays: 2, fillCount: 1, endingEquity: 100120.5, endingBusinessDate: '2024-01-03' });
  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].sourceEvent.event, 'FILLED_BUY');
  assert.deepEqual(result.equityCurve[1], {
    businessDate: '2024-01-03', equity: 100120.5, cash: 90000, positionsValue: 10120.5, nav: null, peak: 100120.5,
  });
  assert.equal(result.ruleEvidence[0].reasonCodes[0], 'ENTRY_BLOCKED:MARKET_STATE');
  assert.deepEqual(registry.rows.map((r) => [r.signalKey, r.entries]), [['L1_MAINLINE+L5_TIMING', 1]]);
  assert.equal(registry.productionEffect, 'NONE');
});

test('A 股 Q0 账户日投影：零成交不伪造信号；缺值、错序、混账户与封存账户均失败关闭', () => {
  const base = [day('2024-01-02'), day('2024-01-03')];
  const { result, registry } = adapter.adaptAccountDays(base, { source: { file: 'x', sha256: 'b'.repeat(64) }, generatedAt: 'x' });
  assert.equal(result.summary.fillCount, 0);
  assert.deepEqual(registry.rows, []);
  assert.equal(registry.rowsState, 'NOT_APPLICABLE:NO_ENTRY_FILLS_IN_SOURCE');
  assert.throws(() => adapter.adaptAccountDays([day('2024-01-02', { point: null })], {}), /ACCOUNT_DAY_POINT_MISSING/);
  assert.throws(() => adapter.adaptAccountDays([...base].reverse(), {}), /ACCOUNT_DAY_ORDER_INVALID/);
  assert.throws(() => adapter.adaptAccountDays([base[0], { ...base[1], accountId: 'B' }], {}), /ACCOUNT_DAY_IDENTITY_CHANGED/);
  assert.throws(() => adapter.adaptAccountDays([{ ...base[0], sealed: true }], {}), /SEALED_ACCOUNT_REFUSED/);
});

test('A 股 Q0 CLI：校验期望 sha，拒绝覆盖，输出可复算的总成交数与期末权益', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-q49-a-'));
  const input = path.join(dir, 'c000.jsonl');
  fs.writeFileSync(input, `${JSON.stringify(day('2024-01-02'))}\n${JSON.stringify(day('2024-01-03'))}\n`);
  const sha = adapter.sha256File(input);
  const out = path.join(dir, 'result.json');
  const registry = path.join(dir, 'registry.json');
  const cli = path.join(__dirname, '..', 'apps', 'research-cli', 'adapt_ashare_q0_export.js');
  const args = ['--input', input, '--out', out, '--registry-out', registry, '--expect-sha256', sha, '--generated-at', '2026-11-10T10:00:00.000Z'];
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /accountDays=2 fills=0 endingEquity=100000/);
  assert.equal(JSON.parse(fs.readFileSync(out)).summary.endingEquity, 100000);
  assert.equal(spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, ...args.slice(0, 6), '--expect-sha256', '0'.repeat(64)], { encoding: 'utf8' }).status, 1);
});

test('统一信号登记 V2：美股、加密与 A 股进入同一张表，A 股零成交保持不适用而不是补 0', () => {
  const source = { file: 'A/c000.jsonl', sha256: 'c'.repeat(64) };
  const { registry: ashare } = adapter.adaptAccountDays([day('2024-01-02')], { source, generatedAt: '2026-11-10T10:00:00.000Z' });
  const mkV1 = (market, row) => legacyRegistry.withHash({
    schema: 'SIGNAL_REGISTRY_V1', generatedAt: '2026-11-10T10:00:00.000Z',
    registryVersion: 1, contracts: {}, floors: {}, books: [], interpretation: 'REGISTRY_FACTS_NOT_A_VERDICT', productionEffect: 'NONE',
    rows: [{ rowId: row, ledgerId: row, market, partId: null, signalKey: 'SIGNAL', signalCodes: ['SIGNAL'], ruleRefs: [], entries: 2,
      firstEntryAt: '2026-11-01', lastEntryAt: '2026-11-02', windows: { currentVersion: {} }, stateSplit: { state: 'MEASURED' } }],
  });
  const result = unified.mergeRegistries([
    mkV1('US', 'US_BOOK'), mkV1('CRYPTO', 'CRYPTO_BOOK'), ashare,
  ], { generatedAt: '2026-11-10T10:00:00.000Z' });
  assert.ok(validateRecord(result, 'SIGNAL_REGISTRY_V2').ok);
  assert.deepEqual(result.markets, ['CN_A', 'CRYPTO', 'US']);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.sources.map((s) => [s.market, s.rowsState]), [
    ['CN_A', 'NOT_APPLICABLE:NO_ENTRY_FILLS_IN_SOURCE'], ['CRYPTO', 'MEASURED'], ['US', 'MEASURED'],
  ]);
  assert.equal(result.productionEffect, 'NONE');
});
