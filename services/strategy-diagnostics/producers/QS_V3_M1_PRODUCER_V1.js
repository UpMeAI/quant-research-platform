'use strict';

/**
 * QS_V3_M1_PRODUCER_V1（CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE §9.5）：Quick Shot V3 的 M1 诊断。
 *
 * 输入是 HK 只读导出的封存包（QRP_CRYPTO_V1_M1_QS：数据库结果行加文件，m1-manifest.json 记每个文件的 sha256），
 * 原样拷在 QRP 的 var/evidence/ 下；QRP 自己的证据清单（档案的 m1_evidence.manifest_ref，sha256 现场核对）
 * 写明 case、窗口、成本模型参数、输入包摘要与源清单的 sha256。这里只核对：
 *   1. 证据清单、验收文本、源清单与输入包逐文件的 sha256；
 *   2. 每笔的手续费、两边滑点、资金费、毛盈亏、净额、净 R（成本模型 CRYPTO_M1_RESEARCH_COST_V1，残差 ≤ 1e-6）；
 *   3. USDT 账户等式：1,000 + Σ 库内 net_pnl = 证据清单登记的期末值；
 *   4. 一笔决策追踪（K2 §3）：信号 → 开仓 → 出场 → 成本 → 净 R。
 * 不重算、不改写库内值；页面分节另立验收（§9.5 末条），本生产者只给诊断投影。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const profiles = require('../../strategy-profiles');
const costModels = require('../cost_models');

const PRODUCER_ID = 'QS_V3_M1_PRODUCER_V1';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ACCEPTANCE_REF = 'docs/contracts/CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE.md';
const ACCEPTANCE_SHA256 = '001c9041937bef4108d7e1eca903b597b9db66664efe9585073c10bebd64cf36';
const TRADES_FILE = 'db/quick_shot_v3_trades.jsonl';
const SIGNALS_FILE = 'db/quick_shot_signals.jsonl';
const KLINE_FILE = 'db/kline_timing_decisions.jsonl';
const LOSS_BUDGET_STATUS = 'files/reports/crypto-loss-budget/status.json';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
function diagnosticError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}
const assert = (condition, code, details) => { if (!condition) throw diagnosticError(code, details); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonl = (file) => {
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
};
const iso = (ms) => new Date(ms).toISOString();

/** 源清单（m1-manifest.json）逐文件核对：sha256、字节数、数据库行数；标 MISSING 的文件必须不存在。 */
function verifySourcePackage(root, source) {
  const manifestFile = path.join(root, source.manifest_path);
  assert(fs.existsSync(manifestFile), 'QS_V3_M1_SOURCE_MANIFEST_MISSING', { missing_path: manifestFile });
  const bytes = fs.readFileSync(manifestFile);
  assert(sha256(bytes) === source.manifest_sha256, 'QS_V3_M1_SOURCE_MANIFEST_SHA256_MISMATCH', { expected: source.manifest_sha256, actual: sha256(bytes) });
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert(manifest.kind === source.kind, 'QS_V3_M1_SOURCE_KIND_MISMATCH', { expected: source.kind, actual: manifest.kind || null });
  const files = [];
  for (const entry of manifest.files) {
    const file = path.join(root, entry.path);
    if (entry.state === 'MISSING') {
      assert(!fs.existsSync(file), 'QS_V3_M1_SOURCE_FILE_UNEXPECTED', { path: entry.path });
      files.push({ path: entry.path, state: 'MISSING_AT_SOURCE' });
      continue;
    }
    assert(fs.existsSync(file), 'QS_V3_M1_SOURCE_FILE_MISSING', { missing_path: file });
    const data = fs.readFileSync(file);
    assert(sha256(data) === entry.sha256 && data.length === entry.bytes, 'QS_V3_M1_SOURCE_FILE_SHA256_MISMATCH', { path: entry.path });
    if (entry.role === 'DB_ROWS') {
      const rows = data.toString('utf8').trim() ? data.toString('utf8').trim().split('\n').length : 0;
      assert(rows === entry.rows, 'QS_V3_M1_SOURCE_ROW_COUNT_MISMATCH', { path: entry.path, expected: entry.rows, actual: rows });
    }
    files.push({ path: entry.path, state: 'VERIFIED', sha256: entry.sha256, ...(entry.rows !== undefined ? { rows: entry.rows } : {}) });
  }
  return { manifest, files };
}

const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

/** K2 §3 的一笔决策追踪：只把封存行里已有的值按链条排好，不推算。 */
function traceDecision(trade, signal, klineRows) {
  const raw = parsed(signal.raw_data) || {};
  const detail = trade.detail;
  return {
    symbol: trade.symbol, trade_id: trade.id, signal_id: signal.id,
    signal: {
      hour_open: iso(signal.timestamp), vol_ratio: signal.vol_ratio, price_change: signal.price_change, premium: signal.premium,
      quote24h: raw.quote24h, rules_version: raw.rulesVersion || null, prev_kline_open: Array.isArray(raw.prevKline) ? iso(raw.prevKline[0]) : null,
      current_kline_open: Array.isArray(raw.currentKline) ? iso(raw.currentKline[0]) : null,
      filters: { volume: signal.passed_volume_filter === 1, quote_volume: signal.passed_quote_volume_filter === 1, premium: signal.passed_premium_filter === 1 },
    },
    decision: { decision: trade.decision, decided_at: iso(trade.decided_at_ms), trade_type: trade.trade_type, strategy_version: trade.strategy_version },
    entry: { price: trade.entry_price, time: iso(trade.entry_time_ms), source: trade.entry_price_source, notional: trade.notional, margin: trade.margin_used, leverage: trade.leverage },
    exit: { reason: trade.exit_reason, price: trade.exit_price, time: iso(trade.exit_time_ms), observation: detail.exit && detail.exit.observation || null },
    costs: {
      fee_entry: trade.fee_entry_usdt, fee_exit: trade.fee_exit_usdt, slippage_entry: trade.slippage_entry_usdt, slippage_exit: trade.slippage_exit_usdt,
      funding: trade.funding_usdt, funding_state: trade.funding_state,
    },
    result: { gross_pnl: trade.gross_pnl, net_pnl: trade.net_pnl, net_r: trade.net_r },
    kline_timing_records: klineRows.filter((row) => row.symbol === trade.symbol).map((row) => ({ role: row.role, as_of: row.as_of, pattern: row.pattern })),
  };
}

function build({ root, manifest, strategyRef = null } = {}) {
  const profile = strategyRef ? profiles.mustGet(strategyRef) : profiles.defaultProfile();
  const costModel = costModels.resolve(profile.cost_model_id);
  assert(costModel.MODEL_ID === 'CRYPTO_M1_RESEARCH_COST_V1', 'DIAGNOSTIC_COST_MODEL_MISMATCH', { cost_model_id: profile.cost_model_id });
  assert(sha256(fs.readFileSync(path.join(REPO_ROOT, ACCEPTANCE_REF))) === ACCEPTANCE_SHA256, 'QS_V3_M1_ACCEPTANCE_CONTENT_DRIFT');
  const manifestFile = path.join(REPO_ROOT, profile.m1_evidence.manifest_ref);
  if (!manifest) {
    assert(fs.existsSync(manifestFile), 'QS_V3_M1_EVIDENCE_MANIFEST_MISSING', { missing_path: manifestFile });
    assert(sha256(fs.readFileSync(manifestFile)) === profile.m1_evidence.manifest_sha256, 'QS_V3_M1_EVIDENCE_MANIFEST_CONTENT_DRIFT');
  }
  const evidence = manifest || readJson(manifestFile);
  assert(evidence.strategy_ref === profile.strategy_ref && evidence.case_ref === profile.case_ref, 'DIAGNOSTIC_PROFILE_MISMATCH', { strategy_ref: profile.strategy_ref });
  assert(evidence.cost_model && evidence.cost_model.model_ref === profile.cost_model_id, 'DIAGNOSTIC_COST_MODEL_MISMATCH', { cost_model_id: profile.cost_model_id });
  assert(evidence.acceptance_ref === ACCEPTANCE_REF, 'QS_V3_M1_ACCEPTANCE_REF_MISMATCH');
  const packageRoot = root || path.join(REPO_ROOT, evidence.input_package.relative_root);
  assert(fs.existsSync(packageRoot), 'QS_V3_M1_INPUT_PACKAGE_MISSING', { missing_path: packageRoot });
  const { packageDigest } = require('..');
  const seal = packageDigest(packageRoot);
  for (const key of ['files', 'bytes', 'sha256']) {
    assert(seal[key] === evidence.input_package[key], `QS_V3_M1_INPUT_PACKAGE_${key.toUpperCase()}_MISMATCH`, { expected: evidence.input_package[key], actual: seal[key] });
  }
  const source = verifySourcePackage(packageRoot, evidence.source_package);
  assert(source.manifest.ledger === profile.strategy_ref, 'QS_V3_M1_LEDGER_MISMATCH', { actual: source.manifest.ledger || null });

  const trades = jsonl(path.join(packageRoot, TRADES_FILE)).map((row) => ({ ...row, detail: parsed(row.detail) }));
  assert(trades.length && trades.every((trade) => trade.ledger_id === profile.strategy_ref), 'QS_V3_M1_TRADE_LEDGER_MISMATCH');
  const open = trades.filter((trade) => trade.status !== 'CLOSED');
  const model = evidence.cost_model;
  const rows = trades.map((trade) => ({
    trade_id: trade.id, symbol: trade.symbol, trade_type: trade.trade_type, exit_reason: trade.exit_reason,
    signal_hour_open: iso(trade.signal_hour_open_ms), items: costModel.reconcileTrade(trade, model),
  }));
  const closed = trades.filter((trade) => trade.status === 'CLOSED');
  const account = costModel.accountEquation(closed, model, evidence.account.expected_end_usdt);
  const missingFunding = rows.filter((row) => row.items.funding.state === 'MISSING').length;

  const spec = evidence.decision_trace;
  const traced = trades.find((trade) => trade.id === spec.trade_id);
  assert(traced && traced.symbol === spec.symbol && iso(traced.signal_hour_open_ms) === spec.signal_hour_open
    && traced.exit_reason === spec.exit_reason && traced.net_r === spec.net_r, 'QS_V3_M1_TRACED_DECISION_MISMATCH', { trade_id: spec.trade_id });
  const signal = jsonl(path.join(packageRoot, SIGNALS_FILE)).find((row) => row.id === traced.signal_id);
  assert(signal && signal.symbol === traced.symbol, 'QS_V3_M1_TRACED_SIGNAL_MISSING', { signal_id: traced.signal_id });
  const budget = readJson(path.join(packageRoot, LOSS_BUDGET_STATUS));

  return {
    schema: profile.m1_evidence.diagnostic_schema, state: 'VERIFIED', producer: PRODUCER_ID,
    acceptance_ref: ACCEPTANCE_REF, case_ref: evidence.case_ref, strategy_ref: evidence.strategy_ref,
    window: { ...evidence.window },
    package: { ...seal, source_manifest_sha256: evidence.source_package.manifest_sha256, files: source.files },
    cost_model: { model_ref: model.model_ref, rule_refs: model.rule_refs },
    trades: rows,
    funding: { measured: rows.length - missingFunding, missing: missingFunding, measured_label: '资金费：已测', missing_label: '资金费：缺失' },
    account: {
      ...account, open_positions: open.length, currency: profile.currency,
      equation_zh: `起点 ${model.initial_capital_usdt} ${profile.currency}、持仓 0；每笔 net = gross − 两边手续费 − 两边滑点 − 资金费（以库内列为准）；终点 = 起点 + Σ net_pnl，未平仓按市值单列。`,
    },
    traced_decision: traceDecision(traced, signal, jsonl(path.join(packageRoot, KLINE_FILE))),
    // §9.3 / §10：A19 共享预算只显示状态与引用，C17_V2 的盈亏不进本等式，也不显示预算数字
    shared_constraints: (profile.shared_constraints || []).map((item) => ({
      key: item.key, label_zh: item.label_zh, display_zh: item.display_zh, rule_ref: item.rule_ref,
      status_state: typeof budget.state === 'string' ? budget.state : null, status_ref: LOSS_BUDGET_STATUS,
    })),
    limitations: [...evidence.limitations_zh],
    product_status_note: 'M0/M1 正式产品状态仍由原完成权威和顺序门禁决定；本诊断不会自行置为 PASS。',
    isolation: {
      research_can_order: false, research_can_activate: false, research_can_write_runtime: false,
      label: 'Research 只读：不使用交易凭证，不下单、不激活、不写生产参数或交易账本。',
    },
    technical: {
      package_root: packageRoot, manifest_ref: profile.m1_evidence.manifest_ref, package_sha256: seal.sha256,
      production_commit: source.manifest.productionHead || null, captured_at: source.manifest.capturedAt || null,
    },
  };
}

module.exports = { PRODUCER_ID, ACCEPTANCE_REF, ACCEPTANCE_SHA256, build, verifySourcePackage };
