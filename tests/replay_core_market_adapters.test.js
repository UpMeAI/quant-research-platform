'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter, hasAdapter, listAdapters } = require('../adapters/registry');
const { validateAdapter } = require('../packages/contracts/market_adapter_contract');
const bridge = require('../adapters/replay-core-bridge');
const { coreDirHash } = require('../adapters/replay-core-bridge/core_pin');
const { metricsByDefinition } = require('../adapters/replay-core-bridge/market_adapter');

const US = 'US_EQUITY';
const CRYPTO = 'CRYPTO';
const AXES = ['absolute', 'risk', 'relative', 'trading_quality', 'robustness', 'operational', 'capacity', 'cost_breakdown'];
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-rc-test-'));

function withoutRoot(fn) {
  const saved = process.env[bridge.ROOT_ENV];
  delete process.env[bridge.ROOT_ENV];
  try { return fn(); } finally { if (saved !== undefined) process.env[bridge.ROOT_ENV] = saved; }
}

test('US_EQUITY 与 CRYPTO 两个 replay-core 适配器已注册,合同齐全,manifest 钉住核心哈希', () => {
  for (const m of [US, CRYPTO]) {
    assert.ok(hasAdapter(m), m);
    const a = getAdapter(m);
    assert.deepEqual(validateAdapter(a).problems, []);
    assert.equal(a.manifest.market_id, m);
    assert.equal(a.manifest.replay_core.core_version_hash, bridge.PIN.core.version_hash);
    assert.match(a.manifest.execution_model_version, /^REPLAY_CORE_CONTRACT_V1@5a4808b0:/);
  }
  assert.deepEqual(Object.keys(getAdapter(US).manifest.replay_core.strategies), ['US_V5']);
  assert.deepEqual(Object.keys(getAdapter(CRYPTO).manifest.replay_core.strategies), ['C17', 'CARRY']);
  assert.deepEqual(listAdapters().map((m) => m.market_id).sort(), ['CN_A', CRYPTO, US]);
});

test('钉版口径:pin 里每个策略的 profile 与 hooks 版本都在,核心哈希为 5a4808b0 的完整哈希', () => {
  assert.equal(bridge.PIN.core.version_hash.length, 64);
  assert.ok(bridge.PIN.core.version_hash.startsWith('5a4808b0'));
  assert.deepEqual(Object.fromEntries(Object.entries(bridge.PIN.strategies).map(([s, v]) => [s, v.profile])),
    { US_V5: 'CLOSE_MARK', C17: 'NEXT_BAR_OPEN', CARRY: 'HOURLY_REBALANCE_BAND' });
  for (const v of Object.values(bridge.PIN.strategies)) {
    assert.match(v.hooks_id, /^[a-z0-9-]+-hooks@[0-9a-f]{12}$/);
    assert.match(v.strategy_files_sha256, /^[0-9a-f]{64}$/);
  }
});

test('未接通即显式失败:没有 smartflow 根 / 没有研究缓存 / 影子观察 / 跨市场策略', () => {
  const job = { kind: 'QRP_REPLAY_CORE_JOB_V1', strategy: 'US_V5', payload_file: 'x.v8', payload_sha256: '0'.repeat(64), options: {} };
  withoutRoot(() => {
    assert.throws(() => getAdapter(US).run_backtest({ execution_model: { replay_core_job: job, job_dir: os.tmpdir() } }), /REPLAY_CORE_SOURCE_NOT_CONFIGURED:QRP_SMARTFLOW_ROOT/);
  });
  assert.throws(() => getAdapter(US).run_backtest({}), /BACKTEST_MISSING_REPLAY_CORE_JOB/);
  assert.throws(() => getAdapter(CRYPTO).run_backtest({ execution_model: { replay_core_job: job } }), /STRATEGY_NOT_IN_MARKET:CRYPTO:US_V5/);
  const saved = process.env.QRP_REPLAY_CORE_CACHE_CRYPTO;
  delete process.env.QRP_REPLAY_CORE_CACHE_CRYPTO;
  try { assert.throws(() => getAdapter(CRYPTO).snapshot({}), /REPLAY_CORE_CACHE_NOT_CONFIGURED:QRP_REPLAY_CORE_CACHE_CRYPTO/); } finally {
    if (saved !== undefined) process.env.QRP_REPLAY_CORE_CACHE_CRYPTO = saved;
  }
  assert.throws(() => getAdapter(US).run_shadow({}, '2026-10-30'), /SHADOW_UNSUPPORTED:US_EQUITY/);
});

test('核心哈希不符即拒跑(独立复算,不信任被校验代码自报)', () => {
  const root = tmpDir();
  const core = path.join(root, bridge.PIN.smartflow.package_dir, bridge.PIN.core.dir);
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(path.join(core, 'index.js'), "'use strict';\nmodule.exports = { coreVersion: () => ({ hash: process.argv[0] }) };\n");
  const cache = tmpDir();
  const job = bridge.writeJob(cache, 'US_V5', { input: {} });
  assert.throws(() => bridge.runJob(job, cache, { smartflowRoot: root }), /REPLAY_CORE_RUN_FAILED:CORE_VERSION_MISMATCH:pin=5a4808b0:core=/);
  assert.notEqual(coreDirHash(core).hash, bridge.PIN.core.version_hash);
});

test('子进程环境只有 PATH / TZ,不透传任何其它变量', () => {
  process.env.QRP_TEST_SECRET_SHOULD_NOT_PASS = 'x';
  try {
    const env = bridge.childEnv();
    assert.deepEqual(Object.keys(env).filter((k) => k !== 'TZ'), ['PATH']);
  } finally { delete process.env.QRP_TEST_SECRET_SHOULD_NOT_PASS; }
});

test('snapshot 只读研究缓存:作业与载荷 sha256 对不上的如实标出', () => {
  const cache = tmpDir();
  const good = bridge.writeJob(cache, 'CARRY', { data: { spotBars: [] }, win: { start: 0, end: 1 }, capital: 1, opts: {} });
  fs.writeFileSync(path.join(cache, 'a.job.json'), JSON.stringify(good));
  fs.writeFileSync(path.join(cache, 'b.job.json'), JSON.stringify({ ...good, payload_sha256: 'f'.repeat(64) }));
  const s = getAdapter(CRYPTO).snapshot({ cache_dir: cache, as_of: '2026-10-31' });
  assert.equal(s.schema, 'DATASET_SNAPSHOT_V1');
  assert.equal(s.market, CRYPTO);
  assert.deepEqual(s.coverage, { jobs: 2, payload_ok: 1, strategies: ['CARRY'] });
  assert.equal(getAdapter(US).snapshot({ cache_dir: cache }).coverage.jobs, 0); // 美股适配器看不到加密作业
});

test('normalize_result 八轴齐全;空样本保持 null,未报告的指标显式标注,不冒充 0', () => {
  const output = {
    profile: 'NEXT_BAR_OPEN',
    metrics: {
      totalReturn: { value: null, definitionId: 'TOTAL_RETURN_V1' },
      feesPaid: { value: 1.5, definitionId: 'FEES_PAID_V1' },
      fundingNet: { value: -0.25, definitionId: 'FUNDING_NET_V1' },
    },
    fills: [], gaps: [],
  };
  assert.deepEqual(metricsByDefinition(output), { TOTAL_RETURN_V1: null, FEES_PAID_V1: 1.5, FUNDING_NET_V1: -0.25 });
  const art = { output, result_hash: 'h', replay_core: { core_version_hash: bridge.PIN.core.version_hash, hooks_id: 'c17-hooks@x', input_hash: null } };
  const n = getAdapter(CRYPTO).normalize_result(art);
  assert.deepEqual(Object.keys(n), AXES);
  assert.equal(n.absolute.total_return, null);
  assert.equal(n.absolute.trade_count, 'NOT_REPORTED_BY_PROFILE');
  assert.equal(n.cost_breakdown.components.fees.value, 1.5);
  assert.equal(n.cost_breakdown.components.funding.value, -0.25);
  const u = getAdapter(US).normalize_result(art);
  assert.deepEqual(Object.keys(u), AXES);
  assert.equal(u.cost_breakdown.components.borrow_fee, 'NOT_MODELLED_CLOSE_MARK');
});

test('validate_release:市场 / 适配器版本 / 执行合同 / 核心哈希 / 策略逐项核对', () => {
  const a = getAdapter(US);
  const ok = a.validate_release({ market: US, adapter_version: a.manifest.adapter_version, code_hash: 'c', parameter_hash: 'p',
    execution_contract: { mode: 'REPLAY_CORE_CONTRACT_V1', core_version_hash: bridge.PIN.core.version_hash, strategy: 'US_V5' } });
  assert.equal(ok.compatible, true);
  const bad = a.validate_release({ market: CRYPTO, adapter_version: 'x', execution_contract: { mode: 'OTHER', core_version_hash: 'y', strategy: 'C17' } });
  assert.deepEqual(bad.reasons.map((r) => r.split(':')[0]),
    ['MARKET_MISMATCH', 'ADAPTER_VERSION_MISMATCH', 'RELEASE_HASH_MISSING', 'EXECUTION_CONTRACT_UNSUPPORTED', 'CORE_VERSION_MISMATCH', 'STRATEGY_UNSUPPORTED']);
  const caps = a.runtime_capabilities();
  assert.equal(caps.broker_connection, false);
  assert.equal(caps.real_order, 0);
  assert.deepEqual(caps.environments_supported, []);
});

test('适配器代码里没有新的回放引擎(与 smartflow check-replay-core-usage 同一命名口径)', () => {
  const NAME = '(?:simulate|replay|runLine)[A-Za-z0-9_]*';
  const patterns = [
    new RegExp(`(?:^|\\s)(?:async\\s+)?function\\s+(${NAME})\\s*\\(`, 'g'),
    new RegExp(`(?:^|\\s)(?:const|let|var)\\s+(${NAME})\\s*=\\s*(?:async\\s*)?(?:function|\\()`, 'g'),
  ];
  const dirs = ['replay-core-bridge', 'us-replay-core', 'crypto-replay-core'].map((d) => path.join(__dirname, '..', 'adapters', d));
  const found = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const code = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const re of patterns) for (const m of code.matchAll(re)) found.push(`${f}:${m[1]}`);
    }
  }
  assert.deepEqual(found, []);
});

// ---- 跨仓:与 replay-core 自己的 golden 用例逐字节一致(需要钉住的 smartflow 检出) -----------------------------------------
// QRP_SMARTFLOW_ROOT 指向 pin.json 的 smartflow 提交(含 node_modules);未设置即跳过并写明原因。
// QRP_REPLAY_CORE_GOLDENS 选 golden(缺省 G3,G2,G1);QRP_REPLAY_CORE_PROOF_OUT 给出时写只含哈希的证明回执。
const ROOT = process.env[bridge.ROOT_ENV];
const GOLDENS = (process.env.QRP_REPLAY_CORE_GOLDENS || 'G3,G2,G1').split(',').filter(Boolean);
const MARKET_OF = { US_V5: US, C17: CRYPTO, CARRY: CRYPTO };
const CAPTURE = path.join(__dirname, '..', 'adapters', 'replay-core-bridge', 'golden_capture.js');

test('跨仓 golden:适配器输出与 replay-core golden 用例逐字节一致,golden 新侧投影与已提交回执一致',
  { skip: !ROOT && `${bridge.ROOT_ENV} 未设置(跨仓测试需要钉住的 smartflow 检出)` }, () => {
    const proof = { kind: 'QRP_REPLAY_CORE_ADAPTERS_GOLDEN_PROOF_V1', core_version_hash: bridge.PIN.core.version_hash,
      smartflow_commit: bridge.PIN.smartflow.commit, env: { node: process.versions.node, platform: process.platform, arch: process.arch }, goldens: [] };
    for (const golden of GOLDENS) {
      const dir = tmpDir();
      try {
        const r = spawnSync(process.execPath, [CAPTURE, '--root', path.resolve(ROOT), '--golden', golden, '--out', dir],
          { cwd: dir, env: bridge.childEnv(), encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 1 << 26 });
        assert.equal(r.status, 0, `capture ${golden}: ${r.stderr}`);
        const m = JSON.parse(fs.readFileSync(path.join(dir, `capture-${golden}.json`), 'utf8'));
        assert.equal(m.cases.length, m.committed_cases, `${golden} 用例数与已提交回执一致`);
        const adapter = getAdapter(MARKET_OF[m.strategy]);
        const rows = [];
        for (const c of m.cases) {
          assert.equal(c.harness_verdict, 'BYTE_IDENTICAL', c.case_id);
          assert.equal(c.harness_new_sha256, c.committed_new_sha256, `${c.case_id} golden 新侧投影 = 已提交回执`);
          assert.ok(c.runs.length > 0, c.case_id);
          const outputs = [];
          for (const run of c.runs) {
            const art = adapter.run_backtest({ execution_model: { replay_core_job: run.job, job_dir: dir } });
            assert.equal(art.result_hash, run.harness_output_sha256, `${c.case_id} 适配器输出 = golden 自跑输出`);
            assert.equal(art.replay_core.core_version_hash, bridge.PIN.core.version_hash);
            assert.equal(art.output.profile, bridge.PIN.strategies[m.strategy].profile);
            outputs.push({ output_sha256: art.result_hash, input_hash: art.replay_core.input_hash, payload_sha256: run.job.payload_sha256 });
          }
          rows.push({ case_id: c.case_id, committed_new_sha256: c.committed_new_sha256, verdict: 'BYTE_IDENTICAL', core_runs: outputs });
        }
        proof.goldens.push({ golden, strategy: m.strategy, profile: bridge.PIN.strategies[m.strategy].profile, market: MARKET_OF[m.strategy],
          committed_receipt_sha256: m.committed_receipt_sha256, cases: rows.length, core_runs: rows.reduce((s, x) => s + x.core_runs.length, 0), rows });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    if (process.env.QRP_REPLAY_CORE_PROOF_OUT) fs.writeFileSync(process.env.QRP_REPLAY_CORE_PROOF_OUT, `${JSON.stringify(proof, null, 1)}\n`);
  });
