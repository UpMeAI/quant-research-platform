'use strict';

/**
 * US_CORE_M1_PRODUCER_V1（US_CORE_Q0_RESULT_V1_IMPORT_PROFILE §9）：美股核心轮动的 M1 诊断。
 *
 * 输入是 HK 只读导出的封存包（QRP_US_CORE_V1_M1：账本 JSON 加决策输入，MANIFEST.sha256 记每个文件的 sha256），
 * 原样拷在 QRP 的 var/evidence/ 下；QRP 自己的证据清单（档案的 m1_evidence.manifest_ref，sha256 现场核对）
 * 写明 case、窗口、成本模型参数、输入包摘要与源清单的 sha256。这里只核对：
 *   1. 证据清单、验收文本、源清单与输入包逐文件的 sha256；
 *   2. 每笔成交（窗口内只有交接买入）：签署成本 = 买入前现金 × 5 bp，units = (现金 − 签署成本) ÷ 开盘价（12 位小数），
 *      与账本相等（1e-6）；成本模型 US_V5_M1_RESEARCH_COST_V1 复用，不另写——没有已平仓的来回，只列入场侧，CAT 买入侧单列；
 *   3. USD 账户等式：每个 mark 的 Σ 袖 (cash + units × 收盘价)（8 位小数规范化）等于 mark.equity，终点等于证据清单登记值；
 *   4. 一次决策追踪（K2 §3）：前身簿 10-07 的决定 → 10-08 开盘交接 → 之后逐日的持有读数 → 期末权益。
 * 不重算、不改写账本值；页面分节另立验收（同 QS §9.5 末条），本生产者只给诊断投影。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const profiles = require('../../strategy-profiles');
const costModels = require('../cost_models');

const PRODUCER_ID = 'US_CORE_M1_PRODUCER_V1';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ACCEPTANCE_REF = 'docs/contracts/US_CORE_Q0_RESULT_V1_IMPORT_PROFILE.md';
const ACCEPTANCE_SHA256 = 'dd04742a617cf380226f608a2278897981d48ec513674954718e22e32de39a2b';
const HANDOVER_CODE = 'BOOK_HANDOVER_OPEN';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
function diagnosticError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}
const assert = (condition, code, details) => { if (!condition) throw diagnosticError(code, details); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const near = (a, b, tolerance) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;

/** 源清单（MANIFEST.sha256，`<sha256>  ./<path>` 每行一个文件）逐文件核对；清单文件自身的 sha256 等于证据清单登记值。 */
function verifySourcePackage(root, source) {
  const manifestFile = path.join(root, source.manifest_path);
  assert(fs.existsSync(manifestFile), 'US_CORE_M1_SOURCE_MANIFEST_MISSING', { missing_path: manifestFile });
  const bytes = fs.readFileSync(manifestFile);
  assert(sha256(bytes) === source.manifest_sha256, 'US_CORE_M1_SOURCE_MANIFEST_SHA256_MISMATCH', { expected: source.manifest_sha256, actual: sha256(bytes) });
  const files = bytes.toString('utf8').trim().split('\n').map((line) => {
    const match = /^([0-9a-f]{64})\s+\.?\/?(.+)$/.exec(line.trim());
    assert(match, 'US_CORE_M1_SOURCE_MANIFEST_LINE_INVALID', { line });
    const file = path.join(root, match[2]);
    assert(fs.existsSync(file), 'US_CORE_M1_SOURCE_FILE_MISSING', { missing_path: match[2] });
    assert(sha256(fs.readFileSync(file)) === match[1], 'US_CORE_M1_SOURCE_FILE_SHA256_MISMATCH', { path: match[2] });
    return { path: match[2], state: 'VERIFIED', sha256: match[1] };
  });
  return { files };
}

/** 决策输入（每个 session 一个 .jsonl.gz，取最后一行）。 */
function decisionInputs(dir) {
  const out = new Map();
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl.gz')).sort()) {
    const lines = zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8').trim().split('\n');
    const record = JSON.parse(lines[lines.length - 1]);
    out.set(record.session, record);
  }
  return out;
}

/** 第 2 条：每笔买入只列入场侧（窗口内没有已平仓的来回）；签署成本与 units 与账本相等，CAT 买入侧按同一组费率单列。 */
function reconcileFill(row, before, model, ceilCent) {
  assert(row.sellPrice === null && row.buyPrice > 0, 'US_CORE_M1_FILL_NOT_A_BUY', { session: row.asOf, sleeve: row.sleeve });
  const signed = before.cash * model.strategy_bps_each_side / 10000;
  const units = +(((before.cash - signed) / row.buyPrice).toFixed(12));
  const tol = model.tolerance_usd;
  assert(near(signed, row.buyFee, tol), 'US_CORE_M1_COST_MISMATCH', { session: row.asOf, sleeve: row.sleeve, item: 'buyFee', expected: signed, actual: row.buyFee });
  assert(near(units, row.unitsAfter, 1e-12), 'US_CORE_M1_COST_MISMATCH', { session: row.asOf, sleeve: row.sleeve, item: 'unitsAfter', expected: units, actual: row.unitsAfter });
  assert(near(row.cashAfter, 0, tol), 'US_CORE_M1_COST_MISMATCH', { session: row.asOf, sleeve: row.sleeve, item: 'cashAfter', expected: 0, actual: row.cashAfter });
  return {
    session: row.asOf, sleeve: row.sleeve, action: row.action, reason_code: row.reasonCode || null, buy_price: row.buyPrice, units: row.unitsAfter,
    signed_model: { state: 'MODELLED', entry: signed, label: '策略签署成本（每边 5 bp，已含在成交里）' },
    regulatory: { state: 'MODELLED_STANDALONE_ENTRY_ONLY', cat_buy: ceilCent(row.unitsAfter * model.cat_rate_per_equivalent_share_each_side), label: '监管费研究覆盖层：未平仓，只计入场侧' },
    exit_side: { state: 'NOT_OCCURRED', label: '未平仓：卖出侧未发生' },
    commission: { state: 'MEASURED_ZERO', total: model.commission_usd },
  };
}

/** 第 3 条：每个 mark 的规范化权益（同 worker canonicalSleeveMark：units 12 位、价格 8 位、权益 8 位）。 */
function reconcileMarks(ledger, sleeves, model) {
  return ledger.marks.map((mark) => {
    let total = 0;
    for (const { sleeve } of sleeves) {
      const s = mark.sleeves[sleeve];
      const equity = s.held === null ? s.cash : +(s.units * s.price).toFixed(8);
      assert(near(equity, s.equity, model.tolerance_usd), 'US_CORE_M1_MARK_MISMATCH', { session: mark.asOf, sleeve, expected: equity, actual: s.equity });
      total += equity;
    }
    assert(near(+total.toFixed(8), mark.equity, model.tolerance_usd), 'US_CORE_M1_MARK_MISMATCH', { session: mark.asOf, expected: total, actual: mark.equity });
    return { session: mark.asOf, equity: mark.equity, residual: +(total - mark.equity).toFixed(12) };
  });
}

function build({ root, manifest, strategyRef = null } = {}) {
  const profile = strategyRef ? profiles.mustGet(strategyRef) : profiles.defaultProfile();
  const costModel = costModels.resolve(profile.cost_model_id);
  assert(costModel.MODEL_ID === 'US_V5_M1_RESEARCH_COST_V1', 'DIAGNOSTIC_COST_MODEL_MISMATCH', { cost_model_id: profile.cost_model_id });
  assert(sha256(fs.readFileSync(path.join(REPO_ROOT, ACCEPTANCE_REF))) === ACCEPTANCE_SHA256, 'US_CORE_M1_ACCEPTANCE_CONTENT_DRIFT');
  const manifestFile = path.join(REPO_ROOT, profile.m1_evidence.manifest_ref);
  if (!manifest) {
    assert(fs.existsSync(manifestFile), 'US_CORE_M1_EVIDENCE_MANIFEST_MISSING', { missing_path: manifestFile });
    assert(sha256(fs.readFileSync(manifestFile)) === profile.m1_evidence.manifest_sha256, 'US_CORE_M1_EVIDENCE_MANIFEST_CONTENT_DRIFT');
  }
  const evidence = manifest || readJson(manifestFile);
  assert(evidence.strategy_ref === profile.strategy_ref && evidence.case_ref === profile.case_ref, 'DIAGNOSTIC_PROFILE_MISMATCH', { strategy_ref: profile.strategy_ref });
  assert(evidence.cost_model && evidence.cost_model.model_ref === profile.cost_model_id, 'DIAGNOSTIC_COST_MODEL_MISMATCH', { cost_model_id: profile.cost_model_id });
  assert(evidence.acceptance_ref === ACCEPTANCE_REF, 'US_CORE_M1_ACCEPTANCE_REF_MISMATCH');
  const packageRoot = root || path.join(REPO_ROOT, evidence.input_package.relative_root);
  assert(fs.existsSync(packageRoot), 'US_CORE_M1_INPUT_PACKAGE_MISSING', { missing_path: packageRoot });
  const { packageDigest, ceilCent } = require('..');
  const seal = packageDigest(packageRoot);
  for (const key of ['files', 'bytes', 'sha256']) {
    assert(seal[key] === evidence.input_package[key], `US_CORE_M1_INPUT_PACKAGE_${key.toUpperCase()}_MISMATCH`, { expected: evidence.input_package[key], actual: seal[key] });
  }
  const source = verifySourcePackage(packageRoot, evidence.source_package);

  const book = evidence.book;
  const ledger = readJson(path.join(packageRoot, book.ledger_file));
  assert(ledger.initialization && ledger.initialization.bookId === book.book_id && book.book_id.startsWith(`${profile.strategy_ref}@`),
    'US_CORE_M1_LEDGER_MISMATCH', { actual: ledger.initialization && ledger.initialization.bookId });
  assert(ledger.initialEquity === book.initial_equity_usd, 'US_CORE_M1_LEDGER_MISMATCH', { item: 'initialEquity' });
  const model = evidence.cost_model;
  const perSleeve = book.initial_equity_usd / book.sleeves.length;
  const cashBefore = Object.fromEntries(book.sleeves.map(({ sleeve }) => [sleeve, perSleeve]));
  const fills = ledger.history.map((row) => {
    const out = reconcileFill(row, { cash: cashBefore[row.sleeve] }, model, ceilCent);
    cashBefore[row.sleeve] = row.cashAfter;
    return out;
  });
  const marks = reconcileMarks(ledger, book.sleeves, model);
  const last = ledger.marks[ledger.marks.length - 1];
  assert(last.asOf === evidence.account.expected_end_session && near(last.equity, evidence.account.expected_end_usd, model.tolerance_usd),
    'US_CORE_M1_ACCOUNT_END_MISMATCH', { expected: evidence.account.expected_end_usd, actual: last.equity, session: last.asOf });

  // 第 4 条：一次决策追踪——交接（前身簿的决定）→ 开盘成交 → 逐日持有读数 → 期末
  const spec = evidence.decision_trace;
  const handover = ledger.initialization.handover;
  assert(handover && handover.decidedAtSession === spec.decided_at_session && handover.predecessorBookId === spec.predecessor_book_id
    && JSON.stringify(handover.targets) === JSON.stringify(spec.targets), 'US_CORE_M1_TRACED_DECISION_MISMATCH', { item: 'handover' });
  const handoverFills = fills.filter((fill) => fill.session === spec.fill_session && fill.reason_code === spec.fill_reason_code);
  assert(handoverFills.length === book.sleeves.length, 'US_CORE_M1_TRACED_DECISION_MISMATCH', { item: 'fills' });
  const inputs = decisionInputs(path.join(packageRoot, book.decision_inputs_dir));
  const holds = ledger.marks.map((mark) => {
    const input = inputs.get(mark.asOf);
    assert(input, 'US_CORE_M1_DECISION_INPUT_MISSING', { session: mark.asOf });
    return {
      session: mark.asOf, equity: mark.equity, macro: input.macro.state,
      carry_gate: { state: input.carryGate.state || null, effect: mark.carryGate ? mark.carryGate.effect : null },
      halted: input.halt.halted,
      sleeves: Object.fromEntries(book.sleeves.map(({ sleeve }) => {
        const s = input.sleeves[sleeve];
        return [sleeve, { held: s.held, pending: s.pendingTarget, trend: s.trend ? { close: s.trend.close, sma200: s.trend.slow.value, sma50: s.trend.fast.value, rule_target: s.trend.ruleTarget } : null }];
      })),
    };
  });

  return {
    schema: profile.m1_evidence.diagnostic_schema, state: 'VERIFIED', producer: PRODUCER_ID,
    acceptance_ref: ACCEPTANCE_REF, case_ref: evidence.case_ref, strategy_ref: evidence.strategy_ref,
    window: { ...evidence.window },
    package: { ...seal, source_manifest_sha256: evidence.source_package.manifest_sha256, files: source.files },
    cost_model: { model_ref: model.model_ref, reuse_ref: model.reuse_ref },
    fills,
    closed_round_trips: 0,
    account: {
      start: book.initial_equity_usd, end: last.equity, end_session: last.asOf, currency: profile.currency, marks,
      equation_zh: `起点 ${book.initial_equity_usd.toLocaleString('en-US')} ${profile.currency}，两袖各一半现金；每笔买入 units = 现金 × (1 − 5 bp) ÷ 开盘价；每天权益 = Σ 袖 (现金 + units × 收盘价)；只用本簿的行，前身簿的盈亏不进等式。`,
    },
    traced_decision: { handover: { ...handover }, fills: handoverFills, holds, end: { session: last.asOf, equity: last.equity } },
    limitations: [...evidence.limitations_zh],
    product_status_note: 'M0/M1 正式产品状态仍由原完成权威和顺序门禁决定；本诊断不会自行置为 PASS。',
    isolation: {
      research_can_order: false, research_can_activate: false, research_can_write_runtime: false,
      label: 'Research 只读：不使用交易凭证，不下单、不激活、不写生产参数或交易账本。',
    },
    technical: { package_root: packageRoot, manifest_ref: profile.m1_evidence.manifest_ref, package_sha256: seal.sha256, production_commit: evidence.source_package.production_commit },
  };
}

module.exports = { PRODUCER_ID, ACCEPTANCE_REF, ACCEPTANCE_SHA256, build, verifySourcePackage, reconcileFill };
