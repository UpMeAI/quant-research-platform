'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loop = require('../services/runtime-research-loop');
const workspace = require('../services/research-workspace');

function actualCase() {
  return {
    case_id: 'RRC-US-V5-WORKSPACE', strategy_ref: 'US_V5_ETF_3000USD', market: 'US_EQUITY',
    runtime_lane: {
      source_ref: '/actual/desk/POSITION_LEDGER_SNAPSHOT_2026-10-23.json', source_hash: 'a'.repeat(64),
      version_ref: 'US_V5_ETF_UNIVERSE_V1@2026-10-08', as_of: '2026-10-23T20:50:00Z', mode: 'PAPER', real_order: 0,
    },
    baseline: {
      baseline_id: 'BASELINE-US-V5-WORKSPACE', strategy_ref: 'US_V5_ETF_6000USD', market: 'US_EQUITY',
      version_ref: 'US_V5_ETF_6000USD@frozen', source_ref: '/actual/desk/US_V5_ETF_6000USD.json',
      source_hash: 'b'.repeat(64), expected_baseline: { primary_metric: 'NET_ACCOUNT_RETURN', state: 'UNKNOWN' },
      frozen_at: '2026-10-24T08:00:00Z',
    },
    cycle_context: { state: 'RESEARCH_ONLY', source_ref: null, source_hash: null },
    data_quality: {
      status: 'DEGRADED', as_of: '2026-10-23', known_at: '2026-10-24T08:00:00Z',
      source_refs: [
        '/actual/desk/POSITION_LEDGER_SNAPSHOT_2026-10-23.json',
        '/actual/desk/STRATEGY_REVIEW_2026-10-23.json',
        '/actual/desk/TRADE_LEDGER_2026-10-23.json',
      ],
      freshness: {
        state: 'LAST_CLOSED_NYSE_SESSION', native_scan_bundle: 'MISSING', benchmark_bars: 'MISSING',
        complete_signed_costs: 'MISSING_REGULATORY_FEES',
      },
    },
    isolation: { research_can_order: false, research_can_activate: false, research_can_write_runtime: false },
    status: 'M1_BLOCKED_NATIVE_BUNDLE_AND_COMPLETE_COSTS', production_effect: 'NONE',
    opened_at: '2026-10-24T08:05:00Z',
  };
}

test('无真实 case 时仍显示 Desk 权威策略目录，但研究关联保持未接入', async () => {
  const model = await workspace.readModel();
  assert.equal(model.context.selected, null);
  assert.deepEqual(model.market_coverage.map((item) => item.label), ['A 股', '美股', '加密']);
  assert.ok(model.market_coverage.every((item) => item.state === 'CONNECTED'));
  assert.equal(model.views.strategies.state, 'AVAILABLE');
  assert.equal(model.strategy_directory.strategies.length, 8);
  assert.ok(model.strategy_directory.strategies.every((item) => item.research.code === 'NOT_CONNECTED'));
  assert.match(model.engineering_samples.notice, /不是 Desk 当前首案/);
});

test('全站使用同一真实 Desk 市场/策略上下文，内部 ID 只留在技术引用', async () => {
  loop.openCase(actualCase());
  const model = await workspace.readModel();
  assert.equal(model.schema, 'RESEARCH_HUMAN_WORKSPACE_V2');
  assert.equal(model.read_only, true);
  assert.equal(model.context.title, '美股 / 美股 ETF 主策略账本（US_V5 · 3000 美元）');
  assert.doesNotMatch(model.context.title, /RRC-|US_V5_ETF_3000USD/);
  assert.equal(model.context.selected.runtime.mode_label, '模拟运行');
  assert.equal(model.context.selected.runtime.real_order_label, '不会真实下单');
  assert.equal(model.context.canonical_current_strategy_ref, 'US_V5_ETF_3000USD');
  assert.equal(model.context.selected.baseline.full_label, '美股 ETF 主策略账本（US_V5 · 6000 美元）');
  assert.ok(model.context.selected.technical.some((item) => item.value === 'US_V5_ETF_3000USD'));
  assert.equal(model.market_coverage.find((item) => item.label === '美股').state, 'CONNECTED');
  assert.equal(model.market_coverage.find((item) => item.label === 'A 股').strategies.length, 1);
  assert.equal(model.navigation.length, 5);
  assert.deepEqual(model.navigation.map((item) => item.label),
    ['策略总览', '研究队列', '前向观察', '复盘与采用', '数据与运行状态']);
});

test('首案缺口、空研究链与安全边界以人类可读状态投影，缺失不伪装成 0', async () => {
  const model = await workspace.readModel();
  const health = model.views['runtime-research-loop'];
  assert.equal(health.state, 'BLOCKED');
  assert.deepEqual(health.blockers.map((item) => item.key), ['native_scan_bundle', 'benchmark_bars', 'complete_signed_costs']);
  assert.equal(model.views.experiments.state, 'EMPTY');
  assert.equal(model.views.races.state, 'EMPTY');
  assert.equal(model.views.shadow.state, 'EMPTY');
  assert.equal(model.views.promotion.state, 'EMPTY');
  assert.match(model.views.experiments.answer, /没有/);
  assert.match(model.views['runtime-status'].isolation.label, /不能下单、不能激活、不能写运行态/);
  assert.equal(model.context.selected.product_stages[0].state_label, '尚未验证');
});

test('按 Desk 策略选择详情：未接入策略保持空态，未知策略 fail closed', async () => {
  let model = await workspace.readModel({ strategyRef: 'C17_V2_4000USDT' });
  assert.equal(model.context.title, '加密 / 加密 C17 账本（C17_V2 · 4000 USDT · BTC、ETH 与高叙事币）');
  assert.equal(model.context.selected, null);
  assert.equal(model.views['strategy-detail'].case_role, 'NOT_CONNECTED');
  assert.equal(model.views['strategy-detail'].research.state, 'NO_ACTUAL_CASE');

  model = await workspace.readModel({ strategyRef: 'NOT_A_DESK_STRATEGY' });
  assert.equal(model.views['strategy-detail'].strategy, null);
  assert.equal(model.views['strategy-detail'].state, 'UNKNOWN_STRATEGY');
  assert.equal(model.context.selected, null);
});

test('研究队列与复盘采用保持冻结上下游：未锁定问题不得提前进入采用页', async () => {
  loop.openCase(actualCase());
  const original = loop.readModel;
  const canonical = original();
  try {
    loop.readModel = () => {
      const model = JSON.parse(JSON.stringify(canonical));
      model.cases[0].links = [
        {
          link_id: 'LINK-UNLOCKED', research_question_label: '尚在研究的问题', conclusion: 'PENDING',
          adoption_state: 'NOT_DECIDED', experiment_freeze_hash: null, result_ref: null, result_hash: null,
        },
        {
          link_id: 'LINK-LOCKED', research_question_label: '锁定待决定', conclusion: 'CHAMPION_WINS',
          adoption_state: 'NOT_DECIDED', experiment_freeze_hash: 'a'.repeat(64),
          result_ref: 'RESULT-LOCKED', result_hash: 'b'.repeat(64),
        },
        {
          link_id: 'LINK-ADOPTED', research_question_label: '用户已采用', conclusion: 'CHALLENGER_WINS',
          adoption_state: 'ADOPTED', experiment_freeze_hash: 'c'.repeat(64),
          result_ref: 'RESULT-ADOPTED', result_hash: 'd'.repeat(64),
        },
        {
          link_id: 'LINK-NOT-ADOPTED', research_question_label: '用户不采用', conclusion: 'CHALLENGER_WINS',
          adoption_state: 'NOT_ADOPTED', experiment_freeze_hash: 'e'.repeat(64),
          result_ref: 'RESULT-NOT-ADOPTED', result_hash: 'f'.repeat(64),
        },
        {
          link_id: 'LINK-OBSERVING', research_question_label: '用户继续观察', conclusion: 'INCONCLUSIVE',
          adoption_state: 'OBSERVING', experiment_freeze_hash: '1'.repeat(64),
          result_ref: 'RESULT-OBSERVING', result_hash: '2'.repeat(64),
        },
      ];
      return model;
    };
    const model = await workspace.readModel({ strategyRef: 'US_V5_ETF_3000USD' });
    assert.deepEqual(model.views.experiments.items.map((item) => item.question_label),
      ['尚在研究的问题', '锁定待决定', '用户已采用', '用户不采用', '用户继续观察']);
    assert.deepEqual(model.views.promotion.items.map((item) => item.question_label),
      ['锁定待决定', '用户已采用', '用户不采用', '用户继续观察']);
    assert.deepEqual(model.views['strategy-detail'].review.items.map((item) => item.question_label),
      ['锁定待决定', '用户已采用', '用户不采用', '用户继续观察']);
    const adoption = Object.fromEntries(model.views.promotion.items.map((item) => [item.question_label, item.adoption_label]));
    assert.deepEqual(adoption, {
      锁定待决定: 'Desk 尚未决定', 用户已采用: 'Desk 已采用', 用户不采用: 'Desk 不采用', 用户继续观察: '继续观察',
    });
    assert.equal(model.views.promotion.items.find((item) => item.question_label === '用户不采用').conclusion_label, '候选方案更优');
    assert.equal(model.views.promotion.state, 'DECIDED');
    assert.equal(model.views['strategy-detail'].review.state, 'DECIDED');
  } finally {
    loop.readModel = original;
  }
});

test('M1 就绪展示消费 canonical 状态并 fail closed：未知、无效或新值绝不提升为 READY', async () => {
  const original = loop.readModel;
  const canonical = original();
  const withCase = (mutate) => {
    const model = JSON.parse(JSON.stringify(canonical));
    mutate(model.cases[0]);
    return model;
  };
  try {
    loop.readModel = () => withCase((item) => {
      item.status = 'M1_BLOCKED_NATIVE_BUNDLE_AND_COMPLETE_COSTS';
      item.data_quality.status = 'DEGRADED';
      item.data_quality.freshness = {
        native_scan_bundle: 'UNKNOWN', benchmark_bars: 'STALE', complete_signed_costs: 'NEW_UNRECOGNIZED_STATE',
      };
    });
    let model = await workspace.readModel();
    assert.equal(model.views['runtime-research-loop'].state, 'BLOCKED');
    assert.deepEqual(model.views['runtime-research-loop'].blockers.map((item) => item.key),
      ['native_scan_bundle', 'benchmark_bars', 'complete_signed_costs']);
    assert.doesNotMatch(model.views['strategy-detail'].health.answer, /已具备进入完整 M1 体检/);

    loop.readModel = () => withCase((item) => {
      item.status = 'M1_READY';
      item.data_quality.status = 'INVALID';
      item.data_quality.freshness = {
        native_scan_bundle: 'AVAILABLE', benchmark_bars: 'AVAILABLE', complete_signed_costs: 'COMPLETE_SIGNED_MODEL_COSTS',
      };
    });
    model = await workspace.readModel();
    assert.equal(model.views['runtime-research-loop'].state, 'BLOCKED');
    assert.deepEqual(model.views['runtime-research-loop'].blockers.map((item) => item.key), ['data_quality']);

    loop.readModel = () => withCase((item) => {
      item.status = 'M1_READY';
      item.data_quality.status = 'VALID';
      item.data_quality.freshness = {
        native_scan_bundle: 'AVAILABLE', benchmark_bars: 'AVAILABLE', complete_signed_costs: 'COMPLETE_SIGNED_MODEL_COSTS',
      };
    });
    model = await workspace.readModel();
    assert.equal(model.views['runtime-research-loop'].state, 'READY');
    assert.equal(model.views['runtime-research-loop'].blockers.length, 0);
    assert.match(model.views['strategy-detail'].health.answer, /已具备进入完整 M1 体检/);
  } finally {
    loop.readModel = original;
  }
});

test('同一真实 case 的 sealed 诊断可用时展示完整体检，但不提升 M0/M1 产品状态', async () => {
  const original = loop.readModel;
  const canonical = original();
  const caseRef = 'RRC-US-V5-3000-V8-1-M0';
  const mocked = JSON.parse(JSON.stringify(canonical));
  mocked.cases[0].case_id = caseRef;
  mocked.product_delivery.cases[0].case_ref = caseRef;
  const diagnostic = {
    state: 'VERIFIED', case_ref: caseRef, strategy_ref: 'US_V5_ETF_3000USD',
    window: { label: '2026-10-08 至 2026-10-23（12 个 NYSE session）' },
    source_status: {
      package: { files: 64, groups: { desk: { files: 48 } } },
      scans: { files: 12, records: 41 },
    },
    native_replay: { parity: 'MATCHED', frozen_digest: 'a'.repeat(64), document_hash: 'b'.repeat(64) },
    technical: { package_sha256: 'c'.repeat(64) },
  };
  try {
    loop.readModel = () => mocked;
    const model = await workspace.readModel({ caseRef, diagnostic });
    const health = model.views['runtime-research-loop'];
    assert.equal(health.state, 'DIAGNOSTIC_AVAILABLE');
    assert.equal(health.blockers.length, 0);
    assert.equal(health.diagnostic, diagnostic);
    assert.equal(health.product_stage.state, 'NOT_VERIFIED');
    assert.equal(health.delivery_truth.preparation.state, 'EVIDENCE_AVAILABLE_NOT_PASS');
    assert.equal(health.delivery_truth.owner_confirmation.state_label, '完成权威尚未登记');
    assert.equal(health.delivery_truth.m1_capability.state_label, '本地受控环境可用');
    assert.equal(health.delivery_truth.m1_product.state, 'NOT_VERIFIED');
    assert.equal(health.delivery_truth.release.state, 'NOT_RELEASED');
    assert.match(health.answer, /原版策略诊断已可用/);
    assert.match(health.answer, /M1 产品状态仍为尚未验证/);
    assert.equal(model.views['runtime-status'].sources.length, 3);
    assert.match(model.views['runtime-status'].answer, /64 个文件、41 条原生扫描记录/);
    assert.equal(model.views['runtime-status'].milestones[0].state, 'NOT_VERIFIED');
    assert.equal(model.views['runtime-status'].milestones[1].state, 'NOT_VERIFIED');
  } finally {
    loop.readModel = original;
  }
});

test('Research Web 以五个顶层任务和统一策略详情组织，并保留旧路由兼容', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'apps', 'research-web', 'index.html'), 'utf8');
  for (const text of ['本页要回答', '平台工程与历史样例', '不属于 Desk 当前策略', '暂时无法读取 Research 数据', '重试',
    '查看完整策略详情', '运行概览', '体检与证据完整性', '研究问题与方案对比', '前向观察', '复盘与采用', '只读安全模式']) assert.match(html, new RegExp(text));
  for (const route of ['strategies', 'strategy-detail', 'runtime-research-loop', 'experiments', 'races', 'shadow', 'promotion', 'runtime-status']) {
    assert.match(html, new RegExp(`['\"]${route}['\"]`));
  }
  for (const rawHeading of ['策略族(Family)', 'Bundle(Champion', 'changed_component', 'freeze_hash']) {
    assert.equal(html.includes(rawHeading), false);
  }
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
  assert.doesNotMatch(html, /\/api\/(review|activate|product-milestone)/);
  assert.equal((html.match(/engineeringDisclosure\(model\.engineering_samples\)/g) || []).length, 1);
  assert.match(html, /info\.name==='runtime-research-loop'/);
  assert.match(html, /canonical_current_strategy_ref/);
  assert.doesNotMatch(html, /\.read-only\{font-size:0/);
  for (const text of ['真实研究问题', '锁定方案对比', '用户决定与系统结论分开',
    'Research 不能下单', '系统不能代替用户采用', '不写生产参数', '最近实际运行（纸面交易，真实行情）', // UX 修订 3 C4 改名
    '节点表与费用逐项核对（明细）', '历史真实记录', // A4 D3.10：最近实际运行只留摘要，节点表与费用逐项收进折叠
    '原生历史回放', '报告比较基准',
    '准备、验收和发布不是同一个状态']) assert.match(html, new RegExp(text));
});

