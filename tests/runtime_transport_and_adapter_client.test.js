'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const registry = require('../services/strategy-registry');
const controlPlane = require('../services/strategy-control-plane');
const experiments = require('../services/experiment-orchestrator');
const shadow = require('../services/shadow-control');
const api = require('../apps/research-api');
const local = require('../adapters/ashare-local');
const { registerAdapter, getAdapter } = require('../adapters/registry');
const { createHttpMarketAdapterClient } = require('../adapters/clients/http_market_adapter_client');
const { RUNTIME_ID } = require('../adapters/ashare-local/market_facts');
const { setupExperiment } = require('./_fixture');

const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
}
async function req(base, path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 造一个已批准、待生效的 Activation。 */
async function pendingActivation() {
  const fx = await setupExperiment({ min_forward_evidence: 2 });
  experiments.recordResult(fx.exp.experiment_id, { verdict: 'CHALLENGER_WINS' });
  const run = shadow.openShadowRun({
    champion_ref: fx.champRef, challenger_ref: fx.chalRef, race_ref: 'R', experiment_ref: fx.exp.experiment_id,
  });
  shadow.recordObservation(run.shadow_id, { key: 'a', business_date: 'a', champion_output: [], challenger_output: [] });
  shadow.recordObservation(run.shadow_id, { key: 'b', business_date: 'b', champion_output: [], challenger_output: ['600001.SH'] });
  const cand = await controlPlane.createPromotionCandidate({
    release_candidate_ref: fx.chalRef, market: 'CN_A', experiment_ref: fx.exp.experiment_id,
    research_evidence_refs: ['ev'], shadow_forward_refs: [run.shadow_id], rollback_ref: fx.champRef,
  });
  await controlPlane.runCompatibilityCheck(cand.candidate_id);
  const release = controlPlane.createRelease(cand.candidate_id);
  controlPlane.reviewCandidate(cand.candidate_id, 'APPROVE_PAPER', { reviewer: 'FOUNDER' });
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'CHALLENGER', {});
  registry.transitionBundle(fx.chalBundle.bundle_id, fx.chalBundle.bundle_version, 'SHADOW', {});
  const act = await controlPlane.requestActivation(release.release_id, { target_runtime_id: RUNTIME_ID, effective_from: TOMORROW });
  return { release, act };
}

test('§12.2 跨仓 pull 传输面:远端 Runtime 能拉取、取 Release 自验哈希、回 ACK 生效', async () => {
  const { release, act } = await pendingActivation();
  process.env.QRP_RUNTIME_TOKEN = 'rt-secret';
  const server = api.createServer();
  const base = await listen(server);
  try {
    const RT = { 'X-Runtime-Token': 'rt-secret' };

    // 令牌 fail-closed:错令牌 403
    assert.equal((await req(base, `/api/runtime/pending-activations?runtime_id=${RUNTIME_ID}`, { headers: { 'X-Runtime-Token': 'wrong' } })).status, 403);
    // Founder 令牌不能当 Runtime 令牌用(§18 Least Privilege)
    assert.equal((await req(base, `/api/runtime/pending-activations?runtime_id=${RUNTIME_ID}`, { headers: { 'X-Founder-Token': 'rt-secret' } })).status, 403);

    // 生效日前:pending 拉不到,只在 scheduled 可见
    const today = new Date().toISOString().slice(0, 10);
    const early = await req(base, `/api/runtime/pending-activations?runtime_id=${RUNTIME_ID}&today=${today}`, { headers: RT });
    assert.equal(early.json.activations.some((a) => a.activation_id === act.activation_id), false);
    const sched = await req(base, `/api/runtime/scheduled-activations?runtime_id=${RUNTIME_ID}&today=${today}`, { headers: RT });
    assert.ok(sched.json.scheduled.some((a) => a.activation_id === act.activation_id));

    // 到生效日:拉得到,并能取 Release 内容自行校验完整性
    const pend = await req(base, `/api/runtime/pending-activations?runtime_id=${RUNTIME_ID}&today=${TOMORROW}`, { headers: RT });
    const mine = pend.json.activations.find((a) => a.activation_id === act.activation_id);
    assert.ok(mine);
    const rel = await req(base, `/api/runtime/release?release_id=${mine.release_id}`, { headers: RT });
    assert.equal(rel.json.integrity.ok, true);
    assert.equal(rel.json.release.release_hash, release.release_hash);

    // 健康检查不合格 → 远端也 fail-closed
    const bad = await req(base, '/api/runtime/ack', {
      method: 'POST', headers: RT,
      body: { activation_id: act.activation_id, runtime_id: RUNTIME_ID, today: TOMORROW, verified_release_hash: release.release_hash, health_check: { status: 'DEGRADED' } },
    });
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.reason, 'HEALTH_CHECK_FAILED');
    assert.equal(controlPlane.activationHead(act.activation_id).activation_status, 'ACK_REJECTED');

    // 正常 ACK → ACTIVE
    const { release: r2, act: a2 } = await pendingActivation();
    const ok = await req(base, '/api/runtime/ack', {
      method: 'POST', headers: RT,
      body: {
        activation_id: a2.activation_id, runtime_id: RUNTIME_ID, today: TOMORROW,
        verified_release_hash: r2.release_hash,
        health_check: { status: 'HEALTHY', real_order: 0, broker_connection: false },
      },
    });
    assert.equal(ok.json.ok, true);
    assert.equal(controlPlane.activationHead(a2.activation_id).activation_status, 'ACTIVE');
  } finally {
    delete process.env.QRP_RUNTIME_TOKEN;
    server.close();
  }
});

test('§5.2 adapters/clients:远程 Market Adapter 客户端满足同一 §14.1 合同(真实 HTTP)', async () => {
  // 模拟"市场仓库侧"暴露的 adapter 服务(等价于 Ashare-V5 research-adapter 的传输封装)
  const remoteManifest = { ...local.manifest, market_id: 'CN_A_REMOTE', optional_capabilities: ['regime_labels'] };
  const remote = http.createServer((rq, rs) => {
    let raw = '';
    rq.on('data', (c) => { raw += c; });
    rq.on('end', async () => {
      const fn = rq.url.slice(1);
      const { args = [] } = JSON.parse(raw || '{}');
      try {
        const result = fn === 'manifest' ? remoteManifest : await local[fn](...args);
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ result }));
      } catch (e) {
        rs.writeHead(500, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
  });
  const base = await listen(remote);
  try {
    const client = await createHttpMarketAdapterClient({ baseUrl: base, token: 'adapter-secret' });
    registerAdapter(client);                                   // 合同校验在注册处 fail-closed
    assert.equal(getAdapter('CN_A_REMOTE').manifest.market_id, 'CN_A_REMOTE');

    // 平台经远程适配器完成一次真实 snapshot(异步 → 平台 await → 不再写出 {})
    const snap = await experiments.captureDatasetSnapshot('CN_A_REMOTE');
    assert.match(snap.snapshot_id, /^DSS-/);
    assert.equal(snap.schema, 'DATASET_SNAPSHOT_V1');

    // 未声明的可选能力不挂载 → 平台显式降级,不是调用后 404
    assert.equal(typeof client.regime_labels, 'function');
    assert.equal(typeof client.runtime_positions_readonly, 'undefined');

    // 远端报错 → 抛错,绝不返回半成品
    await assert.rejects(() => client.run_backtest({}), /ADAPTER_REMOTE_ERROR/);
  } finally { remote.close(); }
});
