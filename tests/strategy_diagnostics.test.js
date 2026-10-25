'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const diagnostics = require('../services/strategy-diagnostics');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', diagnostics.MANIFEST_REF), 'utf8'));

function deliveredScan(scanId) {
  const dir = path.join(__dirname, '..', MANIFEST.input_package.relative_root, 'producer', 'decision-inputs', 'us-v5');
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.jsonl.gz'))) {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8').trim();
    const found = text.split('\n').filter(Boolean).map(JSON.parse).find((record) => record.scanId === scanId);
    if (found) return found;
  }
  throw new Error(`scan not found: ${scanId}`);
}

function rehash(record) {
  const { recordHash, ...body } = record;
  return { ...body, recordHash: diagnostics.sha256(JSON.stringify(body)) };
}

test('US_V5 M1 canonical 诊断从 sealed 真实输入重建同一决策、账户与原生回放', () => {
  diagnostics.clearCache();
  const result = diagnostics.readDiagnostic();
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.case_ref, 'RRC-US-V5-3000-V8-1-M0');
  assert.equal(result.strategy_ref, 'US_V5_ETF_3000USD');
  assert.equal(result.frozen_predecessor_ref, 'US_V5_ETF_6000USD');
  assert.notEqual(result.strategy_ref, result.frozen_predecessor_ref);
  assert.deepEqual(result.window, {
    start: '2026-10-08', end: '2026-10-23', sessions: 12,
    label: '2026-10-08 至 2026-10-23（12 个 NYSE session）',
  });
  assert.equal(result.source_status.package.files, 64);
  assert.equal(result.source_status.scans.records, 41);
  assert.equal(result.source_status.benchmark.role, 'REPORT_COMPARATOR_ONLY');
  assert.equal(result.traced_decision.instrument, 'MSFU');
  assert.equal(result.traced_decision.open.state, 'PAPER_FILLED');
  assert.equal(result.traced_decision.open.fee_state, 'NOT_MEASURED');
  assert.deepEqual(result.traced_decision.close.reasons, ['TIME_STOP']);
  assert.equal(result.exception_example.reason_code, 'GATE_RSI_OUTSIDE_BAND');
  assert.equal(result.native_replay.parity, 'MATCHED');
  assert.equal(result.native_replay.ticks, 41);
  assert.equal(result.native_replay.diagnosis.class, 'EVIDENCE_INSUFFICIENT');
  assert.equal(result.native_replay.diagnosis.citable, false);
  assert.deepEqual(result.handover.shared_limit_at_decision, { occupied: 1, cap: 3 });
  assert.equal(result.handover.predecessor_instrument, 'PLTU');
  assert.equal(result.handover.scan_records_with_predecessor, 5);
  assert.equal(result.handover.effect, 'SHARED_LINE_LIMITS_ONLY');
  assert.equal(result.handover.account_inclusion, false);
  assert.equal(result.handover.current_sizing.equity, 3000);
  assert.equal(result.handover.current_sizing.risk_unit, 60);
  assert.equal(result.source_status.identity.current_book_records, 41);
  assert.equal(result.source_status.identity.predecessor_account_inclusion, false);
  assert.equal(result.production_effect, 'NONE');
  assert.deepEqual(result.isolation, {
    research_can_order: false, research_can_activate: false, research_can_write_runtime: false,
    label: 'Research 只读：不使用交易凭证，不下单、不激活、不写生产参数或交易账本。',
  });
});

test('当前簿扫描机械区分共享规则、前身收尾占位与当前账户身份', () => {
  const original = deliveredScan('1455286:1791566585240');
  diagnostics.verifyScanRecord(original, MANIFEST.book_id, MANIFEST.handover);

  const foreign = structuredClone(original);
  foreign.openPositions.find((item) => item.mode === 'paper').metadata.bookId = 'US_V5_ETF_9999USD@2026-10-08T13:30:00.000Z';
  assert.throws(() => diagnostics.verifyScanRecord(rehash(foreign), MANIFEST.book_id, MANIFEST.handover),
    /US_V5_M1_FOREIGN_PAPER_POSITION/);

  const reopened = structuredClone(original);
  reopened.openPositions.find((item) => item.mode === 'paper').createdAt = '2026-10-08T14:00:00.000Z';
  assert.throws(() => diagnostics.verifyScanRecord(rehash(reopened), MANIFEST.book_id, MANIFEST.handover),
    /US_V5_M1_PREDECESSOR_OPENED_AFTER_HANDOVER/);

  const unknownRule = structuredClone(original);
  unknownRule.s17.versions['US_V5_ETF_6000USD.unfrozenRule'] = { version: 1 };
  assert.throws(() => diagnostics.verifyScanRecord(rehash(unknownRule), MANIFEST.book_id, MANIFEST.handover),
    /US_V5_M1_SCAN_S17_KEY_NOT_ALLOWED/);

  const relabelledCurrent = structuredClone(original);
  const predecessor = relabelledCurrent.openPositions.find((item) => item.mode === 'paper');
  predecessor.metadata.bookId = MANIFEST.book_id;
  predecessor.metadata.ledgerId = MANIFEST.strategy_ref;
  assert.throws(() => diagnostics.verifyScanRecord(rehash(relabelledCurrent), MANIFEST.book_id, MANIFEST.handover),
    /US_V5_M1_CURRENT_POSITION_IDENTITY_MISMATCH/);
});

test('账户对账保持 Desk 毛额与 Research 净额分离，费用不重复、未知不填零', () => {
  const result = diagnostics.readDiagnostic();
  const account = result.account;
  assert.equal(account.reconciliation_state, 'MATCHED');
  assert.deepEqual(account.equations, {
    entry_cash_residual: 0, exit_cash_residual: 0, gross_pnl_residual: 0, final_position_residual_shares: 0,
  });
  assert.ok(diagnostics.closeEnough(account.gross.pnl, 5.019987));
  assert.ok(diagnostics.closeEnough(account.costs.signed_model.entry, 0.6157700065));
  assert.ok(diagnostics.closeEnough(account.costs.signed_model.exit, 0.61828));
  assert.ok(diagnostics.closeEnough(account.costs.regulatory.total, 0.05));
  assert.equal(account.costs.regulatory.taf_sell, 0);
  assert.equal(account.costs.open_fee_gap.state, 'NOT_MEASURED');
  assert.equal(account.costs.open_fee_gap.amount, null);
  assert.ok(diagnostics.closeEnough(account.costs.total, 1.2840500065));
  assert.ok(diagnostics.closeEnough(account.net.pnl, 3.7359369935));
  assert.ok(diagnostics.closeEnough(account.net.end_equity, 3003.7359369935));
  assert.equal(result.traced_decision.slippage.state, 'EMBEDDED_IN_FILL_PRICE');
  assert.throws(() => diagnostics.calculateCosts(
    { notional: 100, quantity: 1 }, { notional: 101, quantity: 1 },
    { strategy_bps_each_side: 5, sec_sell_rate_per_dollar: 0.0000206,
      taf_sell_rate_per_share: undefined, cat_rate_per_equivalent_share_each_side: 0.000003, commission_usd: 0 },
  ), /US_V5_M1_COST_NOT_FINITE/);
});

test('扫描记录内容漂移、输入包漂移和来源缺失分别 fail closed', () => {
  const record = {
    contract: 'US_V5_SCAN_RECORD_V2', bookId: MANIFEST.book_id,
    scanId: 'scan-1', startedAt: '2026-10-08T13:30:00.000Z', payload: { value: 1 },
  };
  record.recordHash = diagnostics.sha256(JSON.stringify(record));
  diagnostics.verifyScanRecord(record, MANIFEST.book_id);
  assert.throws(() => diagnostics.verifyScanRecord({ ...record, payload: { value: 2 } }, MANIFEST.book_id),
    /US_V5_M1_SCAN_RECORD_HASH_MISMATCH/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-us-v5-seal-'));
  fs.writeFileSync(path.join(temp, 'one.txt'), 'actual');
  assert.throws(() => diagnostics.verifyInputPackage(temp, {
    files: 1, bytes: 6, sha256: '0'.repeat(64), groups: {},
  }), /US_V5_M1_INPUT_PACKAGE_SHA256_MISMATCH/);

  const missingRoot = path.join(temp, 'not-delivered');
  const missing = diagnostics.readDiagnostic({ root: missingRoot, manifest: MANIFEST });
  assert.equal(missing.state, 'MISSING');
  assert.equal(missing.missing_artifact, missingRoot);
  assert.equal(missing.producer, 'SMARTFLOW_US');
  assert.match(missing.can_continue.join(' '), /不创建或启用生产账本/);
  assert.equal(missing.production_effect, 'NONE');
});

test('ceilCent 对整分金额不因二进制浮点噪声多进一分，真正超过整分的金额仍向上取整', () => {
  for (let cents = 1; cents <= 200000; cents += 1) {
    assert.equal(Math.round(diagnostics.ceilCent(cents / 100) * 100), cents, `exact cent ${cents / 100}`);
  }
  assert.equal(diagnostics.ceilCent(0), 0);
  assert.equal(diagnostics.ceilCent(0.000087), 0.01);
  assert.equal(diagnostics.ceilCent(0.0300000001), 0.04);
  assert.equal(diagnostics.ceilCent(2.2000000206), 2.21);
  assert.throws(() => diagnostics.ceilCent(-0.01), /US_V5_M1_COST_NOT_FINITE/);
  assert.throws(() => diagnostics.ceilCent(NaN), /US_V5_M1_COST_NOT_FINITE/);
});

test('诊断缓存只在 TTL 内有效：输入包事后漂移会在到期后重新校验，失败也不永久粘住', () => {
  let clock = 1000;
  let calls = 0;
  let mode = 'OK';
  const reader = diagnostics.createDiagnosticReader({
    ttlMs: 30000, now: () => clock,
    build: () => {
      calls += 1;
      if (mode === 'DRIFT') throw Object.assign(new Error('US_V5_M1_INPUT_PACKAGE_SHA256_MISMATCH'), { code: 'US_V5_M1_INPUT_PACKAGE_SHA256_MISMATCH' });
      return { state: 'VERIFIED' };
    },
  });
  assert.equal(reader.read().state, 'VERIFIED');
  clock += 29000;
  mode = 'DRIFT';
  assert.equal(reader.read().state, 'VERIFIED');
  assert.equal(calls, 1);
  clock += 1000;
  const drifted = reader.read();
  assert.equal(drifted.state, 'INVALID');
  assert.equal(drifted.reason_code, 'US_V5_M1_INPUT_PACKAGE_SHA256_MISMATCH');
  assert.equal(calls, 2);
  mode = 'OK';
  clock += 30000;
  assert.equal(reader.read().state, 'VERIFIED');
  assert.equal(calls, 3);
  assert.equal(reader.read({ root: '/nowhere' }).state, 'VERIFIED');
  assert.equal(calls, 4);
  reader.clear();
  reader.read();
  assert.equal(calls, 5);
  assert.equal(diagnostics.DIAGNOSTIC_CACHE_TTL_MS, 30000);
});

test('窗口内未追踪的成交事件和缺 mode 的仓位都让诊断失败关闭', () => {
  const original = deliveredScan('1455286:1791566585240');
  const unlabelled = structuredClone(original);
  delete unlabelled.openPositions.find((item) => item.mode === 'paper').mode;
  assert.throws(() => diagnostics.verifyScanRecord(rehash(unlabelled), MANIFEST.book_id, MANIFEST.handover),
    /US_V5_M1_SCAN_POSITION_MODE_UNKNOWN/);

  const source = path.join(__dirname, '..', MANIFEST.input_package.relative_root);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-us-v5-untraced-'));
  fs.cpSync(source, root, { recursive: true });
  const target = path.join(root, 'desk', 'trades', 'TRADE_LEDGER_2026-10-12.json');
  const document = JSON.parse(fs.readFileSync(target, 'utf8'));
  document.events = [...(document.events || []), { purpose: 'OPEN', lotId: 'UNTRACED', side: 'BUY' }];
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  const resealed = diagnostics.packageDigest(root);
  const groups = Object.fromEntries(Object.keys(MANIFEST.input_package.groups)
    .map((prefix) => [prefix, diagnostics.packageDigest(root, prefix)]));
  const manifest = { ...MANIFEST, input_package: { ...MANIFEST.input_package, ...resealed, groups } };
  assert.throws(() => diagnostics.buildDiagnostic({ root, manifest }), /US_V5_M1_UNTRACED_TRADE_EVENTS/);
});

test('封印排序与环境无关：固定比较器复现已封印包的 ICU en-US 顺序', () => {
  const names = ['producer/native/SPY.ndjson', 'producer/native/book-rows.json', 'producer/native/REVIEW_DECOMPOSITION_2026-10-23.json',
    'producer/native/manifest.json', 'desk/ledger/POSITION_LEDGER_SNAPSHOT_2026-10-08.json'];
  assert.deepEqual([...names].sort(diagnostics.comparePackagePaths), [
    'desk/ledger/POSITION_LEDGER_SNAPSHOT_2026-10-08.json', 'producer/native/book-rows.json', 'producer/native/manifest.json',
    'producer/native/REVIEW_DECOMPOSITION_2026-10-23.json', 'producer/native/SPY.ndjson',
  ]);
  assert.deepEqual([...names].sort(diagnostics.comparePackagePaths), [...names].sort(new Intl.Collator('en-US').compare));
  assert.equal(diagnostics.comparePackagePaths('a', 'A'), 1);
  assert.equal(diagnostics.comparePackagePaths('A', 'a'), -1);
  assert.equal(diagnostics.comparePackagePaths('x', 'x'), 0);
});
