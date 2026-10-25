'use strict';

/**
 * Canonical, read-only strategy diagnostic projection.
 *
 * The producer files remain authoritative for scans, paper fills and Desk
 * account snapshots. This service verifies the sealed package and reconciles
 * it under the frozen M1 research-cost contract. The browser never recomputes
 * a decision, fee or account value.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const zlib = require('zlib');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_REF = 'docs/evidence/CYCLE_RESEARCH_DESK_US_V5_M1_NATIVE_DIAGNOSTIC_2026-10-24.json';
const MANIFEST_FILE = path.join(REPO_ROOT, MANIFEST_REF);
const MANIFEST_SHA256 = '8429553ddb2f4f9d9e441b23aa1852a310bbcada691ab08eb60fe513a81acf1d';
const ACCEPTANCE_REF = 'docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_3.md';
const ACCEPTANCE_SHA256 = '629c43babef597b7fde669b8ac82244d03e6a6d84b85a7af178136f752deb80b';
const TOLERANCE_USD = 1e-6;
const TOLERANCE_SHARES = 1e-8;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function diagnosticError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assert(condition, code, details) {
  if (!condition) throw diagnosticError(code, details);
}

function closeEnough(left, right, tolerance = TOLERANCE_USD) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function rounded(value, places = 8) {
  const result = Number(Number(value).toFixed(places));
  return Object.is(result, -0) ? 0 : result;
}

function ceilCent(value) {
  if (!Number.isFinite(value) || value < 0) throw diagnosticError('US_V5_M1_COST_NOT_FINITE');
  if (value === 0) return 0;
  return Math.ceil((value - Number.EPSILON) * 100) / 100;
}

function walkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(file) : [file];
  });
}

function packageDigest(root, prefix = '') {
  const files = walkFiles(path.join(root, prefix))
    .sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right)));
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const relative = path.relative(root, file);
    const data = fs.readFileSync(file);
    bytes += data.length;
    hash.update(relative).update('\0').update(data).update('\0');
  }
  return { files: files.length, bytes, sha256: hash.digest('hex') };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function verifyInputPackage(root, expected) {
  assert(fs.existsSync(root), 'US_V5_M1_INPUT_PACKAGE_MISSING', { missing_path: root });
  const whole = packageDigest(root);
  for (const key of ['files', 'bytes', 'sha256']) {
    assert(whole[key] === expected[key], `US_V5_M1_INPUT_PACKAGE_${key.toUpperCase()}_MISMATCH`, {
      expected: expected[key], actual: whole[key], path: root,
    });
  }
  const groups = {};
  for (const [prefix, groupExpected] of Object.entries(expected.groups || {})) {
    const actual = packageDigest(root, prefix);
    groups[prefix] = actual;
    for (const key of ['files', 'bytes', 'sha256']) {
      assert(actual[key] === groupExpected[key], `US_V5_M1_INPUT_GROUP_${key.toUpperCase()}_MISMATCH`, {
        group: prefix, expected: groupExpected[key], actual: actual[key],
      });
    }
  }
  return { ...whole, groups };
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function verifyTrack(record, mode, positions, expectedCap = null) {
  const track = (record.tracks || []).find((item) => item.mode === mode);
  assert(track, 'US_V5_M1_SCAN_TRACK_MISSING', { scan_id: record.scanId || null, mode });
  assert(track.openCount === positions.length, 'US_V5_M1_SCAN_TRACK_COUNT_MISMATCH', {
    scan_id: record.scanId || null, mode, expected: positions.length, actual: track.openCount,
  });
  assert(isDeepStrictEqual(sortedUnique(track.occupied || []), sortedUnique(positions.map((item) => item.symbol))),
    'US_V5_M1_SCAN_TRACK_OCCUPIED_MISMATCH', { scan_id: record.scanId || null, mode });
  if (expectedCap !== null) assert(track.cap === expectedCap, 'US_V5_M1_SCAN_TRACK_CAP_MISMATCH', {
    scan_id: record.scanId || null, mode, expected: expectedCap, actual: track.cap,
  });
  return track;
}

function verifyScanRecord(record, expectedBookId, handover = null) {
  assert(record && record.contract === 'US_V5_SCAN_RECORD_V2', 'US_V5_M1_SCAN_CONTRACT_INVALID');
  assert(record.bookId === expectedBookId, 'US_V5_M1_SCAN_BOOK_MISMATCH', {
    expected: expectedBookId, actual: record.bookId || null,
  });
  const { recordHash, ...body } = record;
  assert(typeof recordHash === 'string' && sha256(JSON.stringify(body)) === recordHash,
    'US_V5_M1_SCAN_RECORD_HASH_MISMATCH', { scan_id: record.scanId || null });
  if (!handover) return;

  const current = handover.current_book;
  const predecessor = handover.predecessor;
  assert(record.ledgerId === current.ledger_id, 'US_V5_M1_SCAN_LEDGER_MISMATCH', { scan_id: record.scanId || null });
  assert(record.bookStartAt === current.start_at, 'US_V5_M1_SCAN_BOOK_START_MISMATCH', { scan_id: record.scanId || null });
  assert(record.cfg && record.cfg.riskUnitUSD === current.risk_unit_usd, 'US_V5_M1_SCAN_RISK_UNIT_MISMATCH', {
    scan_id: record.scanId || null,
  });
  assert(record.s17 && record.s17.state === 'READ', 'US_V5_M1_SCAN_S17_NOT_READ', { scan_id: record.scanId || null });
  for (const [key, value] of Object.entries(record.s17.versions || {})) {
    const allowed = handover.allowed_s17_values[key];
    assert(Array.isArray(allowed), 'US_V5_M1_SCAN_S17_KEY_NOT_ALLOWED', { scan_id: record.scanId || null, key });
    assert(allowed.some((candidate) => isDeepStrictEqual(candidate, value)), 'US_V5_M1_SCAN_S17_VALUE_NOT_ALLOWED', {
      scan_id: record.scanId || null, key, actual: value,
    });
  }

  const positions = Array.isArray(record.openPositions) ? record.openPositions : [];
  const paper = positions.filter((item) => item.mode === 'paper');
  const shadow = positions.filter((item) => item.mode === 'shadow');
  for (const position of paper) {
    const meta = position.metadata || {};
    if (meta.bookId === current.book_id) {
      assert(meta.ledgerId === current.ledger_id && meta.bookStartAt === current.start_at
        && meta.bookEquity === current.book_equity_usd && meta.riskUnitUSD === current.risk_unit_usd,
      'US_V5_M1_CURRENT_POSITION_IDENTITY_MISMATCH', { scan_id: record.scanId || null, lot_id: position.orderId || null });
      assert(Date.parse(position.createdAt) >= Date.parse(current.start_at), 'US_V5_M1_CURRENT_POSITION_BEFORE_BOOK_START', {
        scan_id: record.scanId || null, lot_id: position.orderId || null,
      });
      continue;
    }
    assert(meta.bookId === predecessor.book_id, 'US_V5_M1_FOREIGN_PAPER_POSITION', {
      scan_id: record.scanId || null, lot_id: position.orderId || null, book_id: meta.bookId || null,
    });
    assert(meta.ledgerId === predecessor.ledger_id && meta.bookEquity === predecessor.book_equity_usd
      && meta.riskUnitUSD === predecessor.risk_unit_usd, 'US_V5_M1_PREDECESSOR_POSITION_IDENTITY_MISMATCH', {
      scan_id: record.scanId || null, lot_id: position.orderId || null,
    });
    assert(predecessor.allowed_lots.includes(position.orderId) && predecessor.allowed_symbols.includes(position.symbol),
      'US_V5_M1_PREDECESSOR_POSITION_NOT_FROZEN', { scan_id: record.scanId || null, lot_id: position.orderId || null });
    assert(Date.parse(position.createdAt) < Date.parse(current.start_at), 'US_V5_M1_PREDECESSOR_OPENED_AFTER_HANDOVER', {
      scan_id: record.scanId || null, lot_id: position.orderId || null,
    });
    assert(Date.parse(record.startedAt) < Date.parse(predecessor.closed_at),
      'US_V5_M1_PREDECESSOR_PRESENT_AFTER_CLOSE', { scan_id: record.scanId || null, lot_id: position.orderId || null });
  }
  verifyTrack(record, 'paper', paper, current.paper_track_cap);
  verifyTrack(record, 'shadow', shadow);
}

function verifyHandoverSeries(records, handover) {
  const predecessorPositions = records.flatMap((record) => (record.openPositions || [])
    .filter((item) => item.mode === 'paper' && item.metadata && item.metadata.bookId === handover.predecessor.book_id)
    .map((item) => ({ record, item })));
  assert(predecessorPositions.length === handover.predecessor.scan_records_with_open_lot,
    'US_V5_M1_PREDECESSOR_SCAN_COUNT_MISMATCH', {
      expected: handover.predecessor.scan_records_with_open_lot, actual: predecessorPositions.length,
    });
  assert(isDeepStrictEqual(sortedUnique(predecessorPositions.map(({ item }) => item.orderId)),
    sortedUnique(handover.predecessor.allowed_lots)), 'US_V5_M1_PREDECESSOR_LOT_SET_MISMATCH');
  assert(isDeepStrictEqual(sortedUnique(predecessorPositions.map(({ item }) => item.symbol)),
    sortedUnique(handover.predecessor.allowed_symbols)), 'US_V5_M1_PREDECESSOR_SYMBOL_SET_MISMATCH');
  return {
    state: 'VERIFIED', scan_records_with_predecessor: predecessorPositions.length,
    predecessor_lots: sortedUnique(predecessorPositions.map(({ item }) => item.orderId)),
    predecessor_symbols: sortedUnique(predecessorPositions.map(({ item }) => item.symbol)),
  };
}

function readScanRecords(root, manifest) {
  const dir = path.join(root, 'producer', 'decision-inputs', 'us-v5');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl.gz')).sort();
  const records = [];
  for (const name of files) {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8').trim();
    if (!text) continue;
    for (const line of text.split('\n')) {
      const record = JSON.parse(line);
      verifyScanRecord(record, manifest.book_id, manifest.handover);
      records.push(record);
    }
  }
  assert(records.length === manifest.native_replay.scan_records, 'US_V5_M1_SCAN_COUNT_MISMATCH', {
    expected: manifest.native_replay.scan_records, actual: records.length,
  });
  const sessions = new Set(records.map((record) => record.startedAt.slice(0, 10)));
  assert(sessions.size === manifest.window.sessions, 'US_V5_M1_SCAN_SESSION_COUNT_MISMATCH', {
    expected: manifest.window.sessions, actual: sessions.size,
  });
  const handover = verifyHandoverSeries(records, manifest.handover);
  return { files, records, sessions: [...sessions].sort(), handover };
}

function documentAt(root, relative) {
  return readJson(path.join(root, relative));
}

function ledgerAt(root, date) {
  return documentAt(root, `desk/ledger/POSITION_LEDGER_SNAPSHOT_${date}.json`);
}

function tradeAt(root, date) {
  return documentAt(root, `desk/trades/TRADE_LEDGER_${date}.json`);
}

function eventOf(trade, purpose) {
  return (trade.events || []).find((event) => event.purpose === purpose);
}

function calculateCosts(openEvent, closeEvent, model) {
  const signedEntry = openEvent.notional * model.strategy_bps_each_side / 10000;
  const signedExit = closeEvent.notional * model.strategy_bps_each_side / 10000;
  const secSell = ceilCent(closeEvent.notional * model.sec_sell_rate_per_dollar);
  const tafSell = ceilCent(closeEvent.quantity * model.taf_sell_rate_per_share);
  const catBuy = ceilCent(openEvent.quantity * model.cat_rate_per_equivalent_share_each_side);
  const catSell = ceilCent(closeEvent.quantity * model.cat_rate_per_equivalent_share_each_side);
  const regulatory = secSell + tafSell + catBuy + catSell;
  const signedModel = signedEntry + signedExit;
  const total = signedModel + regulatory + model.commission_usd;
  return {
    signed_model: {
      state: 'MODELLED', entry: signedEntry, exit: signedExit, total: signedModel,
      label: '策略签署成本（双边 5 bps）',
    },
    regulatory: {
      state: 'MODELLED_STANDALONE', sec_sell: secSell, taf_sell: tafSell,
      cat_buy: catBuy, cat_sell: catSell, total: regulatory,
      label: '监管费研究覆盖层（按日、按账户、各费种向上取整）',
    },
    commission: { state: 'MEASURED_ZERO', total: model.commission_usd, label: '普通股票／ETF 佣金' },
    total,
  };
}

function validateIdentity(document, manifest, label) {
  assert(document.ledgerId === manifest.strategy_ref, `US_V5_M1_${label}_LEDGER_MISMATCH`);
}

function buildDiagnostic({ root, manifest } = {}) {
  assert(sha256(fs.readFileSync(path.join(REPO_ROOT, ACCEPTANCE_REF))) === ACCEPTANCE_SHA256,
    'US_V5_M1_ACCEPTANCE_CONTENT_DRIFT');
  if (!manifest) assert(sha256(fs.readFileSync(MANIFEST_FILE)) === MANIFEST_SHA256,
    'US_V5_M1_EVIDENCE_MANIFEST_CONTENT_DRIFT');
  const evidenceManifest = manifest || readJson(MANIFEST_FILE);
  const packageRoot = root || path.join(REPO_ROOT, evidenceManifest.input_package.relative_root);
  assert(evidenceManifest.acceptance_ref === ACCEPTANCE_REF, 'US_V5_M1_ACCEPTANCE_REF_MISMATCH');
  const packageSeal = verifyInputPackage(packageRoot, evidenceManifest.input_package);
  const scans = readScanRecords(packageRoot, evidenceManifest);

  const initial = ledgerAt(packageRoot, evidenceManifest.window.start);
  const afterEntry = ledgerAt(packageRoot, '2026-10-09');
  const afterExit = ledgerAt(packageRoot, '2026-10-14');
  const final = ledgerAt(packageRoot, evidenceManifest.window.end);
  [initial, afterEntry, afterExit, final].forEach((doc) => validateIdentity(doc, evidenceManifest, 'SNAPSHOT'));

  const openLedger = tradeAt(packageRoot, '2026-10-09');
  const closeLedger = tradeAt(packageRoot, '2026-10-14');
  validateIdentity(openLedger, evidenceManifest, 'TRADE');
  validateIdentity(closeLedger, evidenceManifest, 'TRADE');
  const openEvent = eventOf(openLedger, 'OPEN');
  const closeEvent = eventOf(closeLedger, 'CLOSE');
  assert(openEvent && closeEvent, 'US_V5_M1_DECISION_EVENTS_MISSING');
  assert(openEvent.lotId === closeEvent.lotId, 'US_V5_M1_LOT_PATH_MISMATCH');
  assert(openEvent.provenance === 'PAPER_FILL' && closeEvent.provenance === 'PAPER_FILL', 'US_V5_M1_NOT_PAPER_FILL');
  assert(openLedger.executionMode === 'PAPER' && closeLedger.executionMode === 'PAPER', 'US_V5_M1_EXECUTION_MODE_MISMATCH');
  assert(openEvent.fees.state === 'NOT_MEASURED' && openEvent.fees.amount === null,
    'US_V5_M1_OPEN_FEE_MISSING_STATE_LOST');

  const expectedSignal = openEvent.decision && openEvent.decision.signalId;
  const signalScanId = expectedSignal && expectedSignal.split(':').slice(1, 3).join(':');
  const signalRecord = scans.records.find((record) => record.scanId === signalScanId);
  assert(signalRecord, 'US_V5_M1_SIGNAL_SCAN_NOT_FOUND', { signal_id: expectedSignal || null });
  const signalInput = (signalRecord.symbols || []).find((item) => item.symbol === openEvent.instrument.id);
  const signalAttempt = signalInput && (signalInput.attempts || [])
    .find((item) => item.mode === 'paper' && item.outcome && item.outcome.action === 'OPEN');
  assert(signalAttempt, 'US_V5_M1_SIGNAL_ATTEMPT_NOT_FOUND', { signal_id: expectedSignal || null });
  const signalSizing = signalAttempt.gates && signalAttempt.gates.sizing;
  const signalClassCap = signalAttempt.gates && signalAttempt.gates.classCap;
  assert(signalSizing && signalSizing.equity === evidenceManifest.handover.current_book.book_equity_usd
    && signalSizing.riskUnit === evidenceManifest.handover.current_book.risk_unit_usd
    && signalSizing.finalShares === openEvent.quantity, 'US_V5_M1_SIGNAL_SIZING_IDENTITY_MISMATCH');
  assert(signalClassCap && signalClassCap.open === 1 && signalClassCap.cap === evidenceManifest.handover.current_book.paper_track_cap,
    'US_V5_M1_SIGNAL_SHARED_LIMIT_CONTEXT_MISMATCH');
  const signalPredecessor = (signalRecord.openPositions || []).filter((item) => item.mode === 'paper'
    && item.metadata && item.metadata.bookId === evidenceManifest.handover.predecessor.book_id);
  assert(signalPredecessor.length === 1 && signalPredecessor[0].orderId === evidenceManifest.handover.predecessor.allowed_lots[0],
    'US_V5_M1_SIGNAL_PREDECESSOR_CONTEXT_MISMATCH');

  const bookRows = documentAt(packageRoot, 'producer/native/book-rows.json');
  assert(bookRows.strategy_ref === evidenceManifest.strategy_ref && bookRows.book_id === evidenceManifest.book_id,
    'US_V5_M1_NATIVE_BOOK_ROWS_IDENTITY_MISMATCH');
  assert(Array.isArray(bookRows.rows) && bookRows.rows.length === 1, 'US_V5_M1_NATIVE_BOOK_ROWS_COUNT_MISMATCH');
  const nativeRow = bookRows.rows[0];
  assert(nativeRow.order_id === openEvent.lotId, 'US_V5_M1_NATIVE_ROW_LOT_MISMATCH');
  assert(nativeRow.metadata && nativeRow.metadata.bookId === evidenceManifest.handover.current_book.book_id
    && nativeRow.metadata.ledgerId === evidenceManifest.handover.current_book.ledger_id
    && nativeRow.metadata.bookStartAt === evidenceManifest.handover.current_book.start_at
    && nativeRow.metadata.bookEquity === evidenceManifest.handover.current_book.book_equity_usd
    && nativeRow.metadata.riskUnitUSD === evidenceManifest.handover.current_book.risk_unit_usd,
  'US_V5_M1_NATIVE_ROW_CURRENT_BOOK_IDENTITY_MISMATCH');

  const reviewFile = path.join(packageRoot, evidenceManifest.native_replay.document_ref);
  assert(sha256(fs.readFileSync(reviewFile)) === evidenceManifest.native_replay.document_file_sha256,
    'US_V5_M1_NATIVE_REPLAY_FILE_HASH_MISMATCH');
  const review = readJson(reviewFile);
  assert(review.hash === evidenceManifest.native_replay.document_hash, 'US_V5_M1_NATIVE_REPLAY_DOCUMENT_HASH_MISMATCH');
  assert(review.window.start === evidenceManifest.window.start && review.window.end === evidenceManifest.window.end
    && review.window.sessions === evidenceManifest.window.sessions, 'US_V5_M1_NATIVE_REPLAY_WINDOW_MISMATCH');
  for (const arm of ['A', 'B', 'S', 'D']) {
    assert(review.arms[arm].state === evidenceManifest.native_replay.arms[arm].state,
      `US_V5_M1_NATIVE_ARM_${arm}_STATE_MISMATCH`);
  }
  assert(review.frozenStrategy.digest === evidenceManifest.native_replay.frozen_digest,
    'US_V5_M1_NATIVE_FROZEN_DIGEST_MISMATCH');

  const barsManifestFile = path.join(packageRoot, 'producer/native/manifest.json');
  assert(sha256(fs.readFileSync(barsManifestFile)) === evidenceManifest.benchmark.manifest_sha256,
    'US_V5_M1_BENCHMARK_MANIFEST_HASH_MISMATCH');
  const barsManifest = readJson(barsManifestFile);
  const spy = barsManifest.series.find((series) => series.seriesId === evidenceManifest.benchmark.instrument);
  assert(spy && spy.sha256 === evidenceManifest.benchmark.series_sha256 && spy.rowCount === evidenceManifest.window.sessions,
    'US_V5_M1_BENCHMARK_SERIES_MISMATCH');
  assert(sha256(fs.readFileSync(path.join(packageRoot, 'producer/native', spy.file))) === spy.sha256,
    'US_V5_M1_BENCHMARK_FILE_HASH_MISMATCH');

  const pick = documentAt(packageRoot, 'desk/decision/US_STRATEGY_PICK_2026-10-09.json');
  const pickStrategy = pick.etfStrategy;
  assert(pickStrategy.ledgerId === evidenceManifest.strategy_ref, 'US_V5_M1_PICK_LEDGER_MISMATCH');
  const sessionOpen = (pickStrategy.sessionOpens || []).find((item) => item.series === openEvent.instrument.id);
  assert(sessionOpen && sessionOpen.scannedAt === signalRecord.startedAt, 'US_V5_M1_SESSION_OPEN_NOT_LINKED');

  const rejectionWatch = documentAt(packageRoot, 'desk/decision/INTRADAY_WATCH_2026-10-13.json');
  const rejection = (rejectionWatch.events || []).find((event) => event.subject === 'METU 等待 ETF 闸');
  assert(rejection && rejection.lines.some((line) => line.includes('GATE_RSI_OUTSIDE_BAND')),
    'US_V5_M1_REJECTION_EXAMPLE_MISSING');
  const exitWatch = documentAt(packageRoot, 'desk/decision/INTRADAY_WATCH_2026-10-14.json');
  const observedExit = (exitWatch.events || []).find((event) => event.eventId === `${openEvent.lotId}:EXIT_TRIGGER:2026-10-14:OBSERVED`);
  const executedExit = (exitWatch.events || []).find((event) => event.eventId === `${openEvent.lotId}:EXIT_TRIGGER:2026-10-14`);
  assert(observedExit && executedExit, 'US_V5_M1_EXIT_MONITOR_PATH_MISSING');

  const handoverWatch = documentAt(packageRoot, 'desk/decision/INTRADAY_WATCH_2026-10-09.json');
  const predecessorClose = (handoverWatch.events || []).find((event) => event.eventId
    === `${evidenceManifest.handover.predecessor.allowed_lots[0]}:EXIT_TRIGGER:2026-10-09`);
  assert(predecessorClose && predecessorClose.firstSeenAt === evidenceManifest.handover.predecessor.closed_at
    && predecessorClose.positionRef && predecessorClose.positionRef.ledgerId === evidenceManifest.handover.predecessor.ledger_id,
  'US_V5_M1_PREDECESSOR_CLOSE_NOT_LINKED');

  const currentPositionSources = [afterEntry.lots[0], ...['2026-10-09', '2026-10-12', '2026-10-13'].map((date) => {
    const watch = documentAt(packageRoot, `desk/decision/INTRADAY_WATCH_${date}.json`);
    return (watch.events || []).find((event) => event.positionRef && event.positionRef.lotId === openEvent.lotId);
  })];
  for (const source of currentPositionSources) {
    assert(source, 'US_V5_M1_CURRENT_POSITION_SOURCE_MISSING');
    const ledgerId = source.positionRef ? source.positionRef.ledgerId : afterEntry.ledgerId;
    assert(ledgerId === evidenceManifest.handover.current_book.ledger_id, 'US_V5_M1_CURRENT_POSITION_LEDGER_MISMATCH');
    assert(source.signalReference && source.signalReference.strategyVersion === evidenceManifest.handover.shared_universe_version,
      'US_V5_M1_SHARED_UNIVERSE_BINDING_MISMATCH');
  }

  assert(initial.account.state === 'MEASURED' && closeEnough(initial.account.cash, 3000)
    && closeEnough(initial.account.equity, 3000) && initial.lots.length === 0, 'US_V5_M1_INITIAL_ACCOUNT_MISMATCH');
  assert(afterEntry.lots.length === 1 && afterEntry.lots[0].lotId === openEvent.lotId
    && closeEnough(afterEntry.lots[0].units, openEvent.quantity, TOLERANCE_SHARES), 'US_V5_M1_ENTRY_POSITION_MISMATCH');
  assert(closeEnough(afterEntry.account.cash, initial.account.cash - openEvent.notional), 'US_V5_M1_ENTRY_CASH_RECONCILIATION_FAILED');
  assert(afterExit.lots.length === 0 && final.lots.length === 0, 'US_V5_M1_FINAL_POSITION_NOT_FLAT');
  assert(closeEnough(afterExit.account.cash, afterEntry.account.cash + closeEvent.notional)
    && closeEnough(final.account.cash, afterExit.account.cash), 'US_V5_M1_EXIT_CASH_RECONCILIATION_FAILED');
  const grossPnl = closeEvent.notional - openEvent.notional;
  assert(closeEnough(grossPnl, closeEvent.realized.currencyAmount)
    && closeEnough(final.account.equity - initial.account.equity, grossPnl), 'US_V5_M1_GROSS_PNL_RECONCILIATION_FAILED');

  const costs = calculateCosts(openEvent, closeEvent, evidenceManifest.cost_model);
  assert(closeEnough(costs.signed_model.exit, closeEvent.fees.amount), 'US_V5_M1_RECORDED_EXIT_FEE_DRIFT');
  const netPnl = grossPnl - costs.total;
  const netEquity = initial.account.equity + netPnl;
  assert(Number.isFinite(netPnl) && Number.isFinite(netEquity), 'US_V5_M1_NET_RESULT_NOT_FINITE');

  const moduleVersions = {};
  for (const key of Object.keys(scans.records[0].code || {})) {
    moduleVersions[key] = [...new Set(scans.records.map((record) => record.code && record.code[key]).filter(Boolean))];
  }

  return {
    schema: 'US_V5_M1_STRATEGY_DIAGNOSTIC_V1', state: 'VERIFIED',
    acceptance_ref: ACCEPTANCE_REF, manifest_ref: MANIFEST_REF,
    case_ref: evidenceManifest.case_ref, strategy_ref: evidenceManifest.strategy_ref,
    book_id: evidenceManifest.book_id, frozen_predecessor_ref: evidenceManifest.frozen_predecessor_ref,
    window: { ...evidenceManifest.window, label: '2026-10-08 至 2026-10-23（12 个 NYSE session）' },
    mode: 'PAPER', real_order: 0, production_effect: 'NONE',
    source_status: {
      package: { state: 'VALID', ...packageSeal },
      scans: { state: 'VALID', files: scans.files.length, records: scans.records.length, sessions: scans.sessions.length },
      identity: { state: 'VERIFIED', current_book_records: scans.records.length,
        predecessor_context_records: scans.handover.scan_records_with_predecessor,
        predecessor_account_inclusion: evidenceManifest.handover.predecessor.account_inclusion },
      benchmark: { state: 'VALID', role: evidenceManifest.benchmark.role, known_at: evidenceManifest.benchmark.known_at },
      costs: { state: 'COMPLETE_MODELLED', model_ref: evidenceManifest.cost_model.model_ref,
        actual_broker_invoice: evidenceManifest.cost_model.is_actual_broker_invoice },
    },
    rules: {
      universe: `${signalRecord.universeState?.source || signalRecord.cfg.entryChain || 'US_ETF_UNIVERSE_V1'} · ${signalRecord.universeVersion || 'v3'}`,
      signal_series: 'MSFU（本次交易使用自身序列；MSFT 仅作标的说明）',
      regime: signalRecord.regime?.read?.regime || nativeRow.metadata.marketRegime || 'UNKNOWN',
      risk_unit_usd: signalRecord.cfg.riskUnitUSD,
      max_positions: 3,
      max_hold_days: nativeRow.metadata.maxHoldDaysOverride,
      entry_rule: openEvent.decision.ruleRef,
      exit_rule: closeEvent.decision.ruleRef,
      scan_contract: evidenceManifest.native_replay.scan_contract,
      shared_rule_namespace: evidenceManifest.handover.shared_rule_namespace,
    },
    decision_funnel: {
      native_scan_records: scans.records.length,
      linked_open_scan: { scan_id: signalRecord.scanId, scanned_at: signalRecord.startedAt, record_hash: signalRecord.recordHash },
      session_open: { instrument: sessionOpen.series, carrier: sessionOpen.carrier, scanned_at: sessionOpen.scannedAt,
        reasons: sessionOpen.reasonCodes },
      latest_same_day_scan: {
        scanned_at: pickStrategy.scan.scannedAt, scans_in_session: pickStrategy.scan.scansInSession,
        funnel: pickStrategy.funnel,
        note: '该漏斗属于 19:23 的当日最后一次扫描；MSFU 开仓来自 17:23 的较早扫描，二者没有混写。',
      },
      paper_fills: 2,
    },
    handover: {
      state: scans.handover.state,
      authority: evidenceManifest.handover.authority,
      predecessor_ref: evidenceManifest.frozen_predecessor_ref,
      predecessor_book_id: evidenceManifest.frozen_predecessor_book_id,
      predecessor_lot: scans.handover.predecessor_lots[0],
      predecessor_instrument: scans.handover.predecessor_symbols[0],
      scan_records_with_predecessor: scans.handover.scan_records_with_predecessor,
      closed_at: evidenceManifest.handover.predecessor.closed_at,
      shared_limit_at_decision: { occupied: signalClassCap.open, cap: signalClassCap.cap },
      current_sizing: { equity: signalSizing.equity, risk_unit: signalSizing.riskUnit, shares: signalSizing.finalShares },
      rule_namespace: evidenceManifest.handover.shared_rule_namespace,
      rule_namespace_role: 'SHARED_RULE_VERSION_NOT_BOOK_IDENTITY',
      effect: evidenceManifest.handover.predecessor.effect,
      account_inclusion: evidenceManifest.handover.predecessor.account_inclusion,
      label: '前身 PLTU 只进入 AMENDMENT_17 共享线路限额；没有进入当前 3000 美元簿的现金、持仓或损益。',
    },
    traced_decision: {
      instrument: openEvent.instrument.id, lot_id: openEvent.lotId, signal_id: expectedSignal,
      open: {
        state: 'PAPER_FILLED', at: openEvent.executedAt, side: openEvent.side, quantity: openEvent.quantity,
        price: openEvent.price, notional: openEvent.notional, reasons: openEvent.decision.reasonCodes,
        rule_ref: openEvent.decision.ruleRef, fee_state: openEvent.fees.state,
      },
      monitoring: {
        state: 'EXIT_OBSERVED_READ_ONLY', at: observedExit.firstSeenAt,
        reason: 'TIME_STOP 到期；只读监控先观察，执行周期随后完成纸面平仓。',
      },
      close: {
        state: 'PAPER_FILLED', at: closeEvent.executedAt, side: closeEvent.side, quantity: closeEvent.quantity,
        price: closeEvent.price, notional: closeEvent.notional, reasons: closeEvent.decision.reasonCodes,
        rule_ref: closeEvent.decision.ruleRef, realized_gross: closeEvent.realized.currencyAmount,
      },
      slippage: {
        state: 'EMBEDDED_IN_FILL_PRICE', amount: Number(nativeRow.slippage_cost),
        note: '已体现在纸面成交价中，不从净结果再次扣减。',
      },
    },
    exception_example: {
      state: 'REJECTED', instrument: 'METU', at: '2026-10-13', gate: 'ETF 闸',
      reason_code: 'GATE_RSI_OUTSIDE_BAND', reason: 'RSI=65.9 不在 35–65；候选未开仓。',
      source_event_id: rejection.eventId,
    },
    account: {
      currency: 'USD', reconciliation_state: 'MATCHED', tolerance_usd: TOLERANCE_USD,
      checkpoints: [
        { date: evidenceManifest.window.start, label: '窗口起点', cash: initial.account.cash, equity: initial.account.equity, units: 0 },
        { date: '2026-10-09', label: 'MSFU 开仓后', cash: afterEntry.account.cash, equity: afterEntry.account.equity,
          units: afterEntry.lots[0].units, instrument: afterEntry.lots[0].instrument.id },
        { date: evidenceManifest.window.end, label: '窗口终点', cash: final.account.cash, equity: final.account.equity, units: 0 },
      ],
      gross: { start_equity: initial.account.equity, end_equity: final.account.equity, pnl: grossPnl,
        state: 'DESK_PAPER_LEDGER_MEASURED' },
      costs: {
        ...costs,
        total: costs.total,
        open_fee_gap: { state: openEvent.fees.state, amount: openEvent.fees.amount, reason_code: openEvent.fees.reasonCode },
        allocation_limit: '监管费按 stand-alone 策略簿建模；没有全账户账单，不能称为实际扣费。',
      },
      net: { start_equity: initial.account.equity, end_equity: netEquity, pnl: netPnl,
        state: 'RESEARCH_MODELLED_NET', formula: 'Desk 毛额损益 − 双边签署成本 − 监管费研究覆盖层' },
      equations: {
        entry_cash_residual: rounded(afterEntry.account.cash - (initial.account.cash - openEvent.notional), 12),
        exit_cash_residual: rounded(final.account.cash - (afterEntry.account.cash + closeEvent.notional), 12),
        gross_pnl_residual: rounded(grossPnl - closeEvent.realized.currencyAmount, 12),
        final_position_residual_shares: 0,
      },
    },
    native_replay: {
      state: evidenceManifest.native_replay.plan_state, parity: evidenceManifest.native_replay.parity,
      ticks: evidenceManifest.native_replay.plan_ticks, document_hash: review.hash,
      frozen_digest: review.frozenStrategy.digest, arms: review.arms, contrasts: review.contrasts,
      diagnosis: review.diagnosis,
      replay_engine: evidenceManifest.source_provenance.replay_engine_sha256,
      scan_time_module_versions: moduleVersions,
    },
    provenance: {
      actual_records: 'Smartflow 原生产者扫描、Desk 决策／监控、纸面交易与账户快照',
      native_replay: 'Smartflow 原生 runV5Book / plan replay 在隔离 /tmp 中只读运行',
      benchmark: 'SPY 同窗日线，仅作报告比较，不是策略决策输入',
      handover: 'AMENDMENT_17：6000 美元前身保留原身份收尾，并在平仓前参与线路级风险限额。',
      production_commit: evidenceManifest.source_provenance.production_commit,
      captured_at: evidenceManifest.source_provenance.captured_at,
    },
    limitations: [
      '窗口只有 12 个 session，低于原生诊断的 20-session 最低样本，因此研究结论为证据不足。',
      '全部账户均为 PAPER；真实账户臂 A 不适用，不能推断实盘执行质量。',
      '原开仓事件费用为 NOT_MEASURED；Research 以冻结模型补足净核算，但不改写历史记录。',
      '监管费按 stand-alone 策略簿建模，没有全账户正式账单或策略级实际费用分摊。',
      '开仓扫描时前身 PLTU 仍在收尾并占用共享线路 1/3；它影响可用限额，但未计入当前簿账户或损益。',
      'M0/M1 正式产品状态仍由原完成权威和顺序门禁决定；本诊断不会自行置为 PASS。',
    ],
    isolation: {
      research_can_order: false, research_can_activate: false, research_can_write_runtime: false,
      label: 'Research 只读：不使用交易凭证，不下单、不激活、不写生产参数或交易账本。',
    },
    technical: {
      package_root: packageRoot, manifest_ref: MANIFEST_REF, package_sha256: packageSeal.sha256,
      production_repository: evidenceManifest.source_provenance.production_repository,
      production_commit: evidenceManifest.source_provenance.production_commit,
    },
  };
}

function missingDiagnostic(error) {
  const code = error && (error.code || error.message) || 'US_V5_M1_DIAGNOSTIC_UNKNOWN';
  const missing = code === 'ENOENT' || code.includes('MISSING');
  return {
    schema: 'US_V5_M1_STRATEGY_DIAGNOSTIC_V1', state: missing ? 'MISSING' : 'INVALID',
    strategy_ref: 'US_V5_ETF_3000USD', acceptance_ref: ACCEPTANCE_REF,
    reason_code: code, missing_artifact: error && (error.missing_path || error.path) || null,
    producer: 'SMARTFLOW_US', responsible_party: 'Smartflow runtime/data owner',
    can_continue: [
      '保留 Desk 当前纸面策略按原规则运行。',
      '继续只读核对已交付快照、交易和扫描文件；不创建或启用生产账本。',
      '来源恢复后重新执行相同 package seal 与账户对账。',
    ],
    production_effect: 'NONE',
  };
}

let defaultCache = null;

function readDiagnostic(options = {}) {
  const useDefaultCache = Object.keys(options).length === 0;
  if (useDefaultCache && defaultCache) return defaultCache;
  let result;
  try { result = buildDiagnostic(options); } catch (error) { result = missingDiagnostic(error); }
  if (useDefaultCache) defaultCache = result;
  return result;
}

function clearCache() { defaultCache = null; }

module.exports = {
  ACCEPTANCE_REF, ACCEPTANCE_SHA256, MANIFEST_REF, MANIFEST_SHA256, TOLERANCE_USD, TOLERANCE_SHARES,
  sha256, closeEnough, ceilCent, packageDigest, verifyInputPackage,
  verifyScanRecord, calculateCosts, buildDiagnostic, readDiagnostic,
  clearCache,
};
