'use strict';
/**
 * Research API(§5.2 apps/research-api · §17 研究台信息架构)——
 * 零依赖 HTTP 服务,为研究台提供**只读**投影。
 *
 * 治理(§18 Least Privilege / No Automatic Promotion):
 *   - Research 面不暴露审批、发布或激活；研究只止于锁定报告和 Desk 回链;
 *   - Runtime 独立传输面保留 pull / ack / nack，它不是研究用户的生产写入口;
 *   - 平台不下单、不碰 broker、不写市场仓的 Runtime/参数/交易账本。
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const registry = require('../../services/strategy-registry');
const experiments = require('../../services/experiment-orchestrator');
const races = require('../../services/race-orchestrator');
const shadow = require('../../services/shadow-control');
const controlPlane = require('../../services/strategy-control-plane');
const binding = require('../../services/strategy-control-plane/runtime_binding');
const migration = require('../../services/strategy-control-plane/migration');
const runtimeStatus = require('../../services/runtime-status');
const observability = require('../../services/observability');
const factors = require('../../services/factor-lab');
const runtimeResearchLoop = require('../../services/runtime-research-loop');
const researchWorkspace = require('../../services/research-workspace');
const { listAdapters } = require('../../adapters/registry');
const { registerConfiguredRemoteMarkets } = require('../../adapters/clients/remote_markets');

const WEB_DIR = path.join(__dirname, '..', 'research-web');

// ── 六入口只读投影 ───────────────────────────────────────────────────────────
const views = {
  /** §17 Strategies:Market / Family / Champion / Challenger / Shadow / Active / Retired。 */
  strategies: () => ({
    markets: listAdapters(),
    families: registry.listFamilies(),
    modules: registry.listModules(),
    bundles: registry.listBundles(),
  }),

  /** §17 Experiments:冻结的 Champion/Challenger、样本、成本、changed/fixed components。 */
  experiments: async () => ({
    hypotheses: experiments.listHypotheses(),
    experiments: experiments.listExperiments().map((e) => ({
      ...e,
      backtest: experiments.artifactFor(e.experiment_id)
        ? { result_hash: experiments.artifactFor(e.experiment_id).result_hash, oos: experiments.artifactFor(e.experiment_id).summary?.oos, precision_oos: experiments.artifactFor(e.experiment_id).precision_oos }
        : null,
      wfo: experiments.wfoReportFor(e.experiment_id),
      robustness: experiments.robustnessReportFor(e.experiment_id),
      freeze_verified: experiments.verifyFreeze(e.experiment_id).ok,
    })),
    negative_results: experiments.listNegativeResults(),
    // §9.1 Factor Lab:因子定义与基础指标(因子层无生产动作权,只作研究输入)
    factors: factors.listFactors().map((f) => ({ ...f, evaluations: factors.evaluationsFor(f.factor_id).slice(-3) })),
  }),

  /** §17 Races + §10.1 Race Board:结论优先,曲线次之。 */
  races: () => ({
    races: races.listRaces().map((r) => ({
      race_id: r.race_id, race_type: r.race_type, market: r.market, status: r.status,
      experiment_ref: r.experiment_ref, changed_component: r.changed_component,
      control_declaration: r.control_declaration,
      paired_sample_count: r.paired_sample_count || 0,
      result: r.result || null,
    })),
  }),

  /** §17 Shadow:disagreement、virtual PnL、sample coverage、operational health。 */
  shadow: async () => ({
    runs: await Promise.all(shadow.listShadowRuns().map(async (s) => ({
      ...s,
      sufficiency: await shadow.sufficiency(s.shadow_id),
      forward_metrics: shadow.forwardMetrics(s.shadow_id),
      observations: shadow.listObservations(s.shadow_id).slice(-50),
    }))),
  }),

  /** §17 Promotion:compatibility、risk impact、unresolved gaps、Founder Review。 */
  promotion: () => ({
    candidates: controlPlane.listCandidates(),
    releases: controlPlane.listReleases(),
    activations: controlPlane.listActivations().filter((a) => a.schema === 'ACTIVATION_RECORD_V1'),
    rollbacks: controlPlane.listActivations().filter((a) => a.schema !== 'ACTIVATION_RECORD_V1'),
    migration: migration.listMigrationRecords(),
  }),

  /** §17 Runtime Status(§13.1 只读回读面)。 */
  'runtime-status': async () => ({
    runtimes: await Promise.all(listAdapters().map((m) => runtimeStatus.runtimeStatus(m.market_id))),
    health: await observability.healthReport(),   // §19 运行观测与衰减监控
  }),

  /** V8 M3:运行态、研究态与 Desk 复盘回链。只读引用，不复制三方业务真相。 */
  'runtime-research-loop': () => runtimeResearchLoop.readModel(),

  /** 人类可读 Research 工作台：Desk 市场/策略优先，内部 ID 只作技术披露。 */
  workspace: (q) => researchWorkspace.readModel({
    caseRef: q && q.get('case_ref'),
    strategyRef: q && q.get('strategy_ref'),
  }),
};

/**
 * Runtime 令牌(§18 Least Privilege:与 Founder 令牌分离)。
 * Runtime 只能拉取自己名下的 Activation 与回 ACK/NACK,**不能**审批或创建 Activation。
 */
function runtimeOk(req) {
  const expected = process.env.QRP_RUNTIME_TOKEN;
  if (!expected) return { ok: false, reason: 'RUNTIME_TOKEN_NOT_CONFIGURED', reasonCn: '未配置 QRP_RUNTIME_TOKEN —— Runtime 拉取/回执一律拒绝(fail-closed)' };
  if (req.headers['x-runtime-token'] !== expected) return { ok: false, reason: 'RUNTIME_TOKEN_INVALID', reasonCn: 'Runtime 令牌不匹配' };
  return { ok: true };
}

function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Host 头主机名是否为本机。无令牌时它是 loopback 绑定之外的第二道门：同机浏览器被 DNS rebinding 欺骗时 Host 不是本机名。 */
function hostIsLoopback(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  const name = (hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]).toLowerCase();
  return ['127.0.0.1', 'localhost', '[::1]'].includes(name);
}

function researchOk(req, opts = {}) {
  const expected = opts.researchToken !== undefined ? opts.researchToken : process.env.QRP_RESEARCH_TOKEN;
  if (!expected) {
    if (!hostIsLoopback(req.headers.host)) return { ok: false, reason: 'RESEARCH_HOST_NOT_LOOPBACK' };
    return { ok: true, scope: 'LOOPBACK_ONLY' };
  }
  if (!tokenMatches(req.headers['x-research-token'], expected)) return { ok: false, reason: 'RESEARCH_TOKEN_INVALID' };
  return { ok: true, scope: 'TOKEN_PROTECTED' };
}

function bindConfiguration(env = process.env) {
  const host = env.QRP_HOST || '127.0.0.1';
  const researchToken = env.QRP_RESEARCH_TOKEN || null;
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
  if (!loopback && !researchToken) throw new Error('RESEARCH_ACCESS_TOKEN_REQUIRED_FOR_NON_LOOPBACK');
  return { host, researchToken, loopback };
}

/**
 * §12.2 Pull-based 激活的**跨仓传输面**(审计缺口:此前只有进程内函数,
 * 远端 Market Runtime 根本拉不到 Activation)。语义即 §13.1 的对偶:
 * Runtime 主动 GET 待生效项 → GET Release 内容自行重算 hash → POST ack/nack。
 * 平台永不 push、永不持有 broker 凭证。
 */
const runtimeRoutes = {
  'pending-activations': (q) => ({
    runtime_id: q.get('runtime_id'),
    business_date: q.get('today') || new Date().toISOString().slice(0, 10),
    activations: binding.runtimePendingActivations(q.get('runtime_id'), q.get('today') ? { today: q.get('today') } : {}),
  }),
  'scheduled-activations': (q) => ({
    runtime_id: q.get('runtime_id'),
    scheduled: binding.runtimeScheduledActivations(q.get('runtime_id'), q.get('today') ? { today: q.get('today') } : {}),
    noteCn: '已批准但未到 effective_from —— 不可加载(批准 ≠ 生效)',
  }),
  release: (q) => {
    const rel = controlPlane.releaseHead(q.get('release_id'));
    if (!rel) return { error: 'RELEASE_NOT_FOUND' };
    return { release: rel, integrity: controlPlane.verifyReleaseIntegrity(rel.release_id) };
  },
};

const runtimeActions = {
  ack: (body) => binding.runtimeAck(body.activation_id, {
    runtime_id: body.runtime_id, today: body.today,
    verified_release_hash: body.verified_release_hash, health_check: body.health_check,
  }),
  nack: (body) => binding.runtimeNack(body.activation_id, {
    runtime_id: body.runtime_id, reasonCn: body.reasonCn,
  }),
};

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function handle(req, res, opts = {}) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (!p.startsWith('/api/runtime/') && (p === '/' || p === '/index.html' || p.startsWith('/api/'))) {
    const gate = researchOk(req, opts);
    if (!gate.ok) return send(res, 403, { error: gate.reason });
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch { return send(res, 500, { error: 'RESEARCH_WEB_NOT_FOUND' }); }
  }

  // ── Runtime 面(§12.2 跨仓 pull;独立令牌)────────────────────────────────
  if (p.startsWith('/api/runtime/')) {
    const name = p.slice('/api/runtime/'.length);
    const gate = runtimeOk(req);
    if (!gate.ok) return send(res, 403, { error: gate.reason, reasonCn: gate.reasonCn });
    if (req.method === 'GET' && runtimeRoutes[name]) {
      try { return send(res, 200, runtimeRoutes[name](url.searchParams)); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }
    if (req.method === 'POST' && runtimeActions[name]) {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        Promise.resolve()
          .then(() => runtimeActions[name](JSON.parse(raw || '{}')))
          .then((v) => send(res, 200, v))
          .catch((e) => send(res, 400, { error: String(e.message || e) }));
      });
      return undefined;
    }
    return send(res, 404, {
      error: 'UNKNOWN_RUNTIME_ROUTE',
      get: Object.keys(runtimeRoutes), post: Object.keys(runtimeActions),
    });
  }

  if (req.method === 'GET' && p.startsWith('/api/')) {
    const view = p.slice(5);
    if (!views[view]) return send(res, 404, { error: 'UNKNOWN_VIEW', available: Object.keys(views) });
    // 视图可同步可异步(适配器 IO):统一 resolve,绝不把 Promise 序列化成 {}
    Promise.resolve()
      .then(() => views[view](url.searchParams))
      .then((v) => send(res, 200, v))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
    return undefined;
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    return send(res, 405, {
      error: 'RESEARCH_API_READ_ONLY',
      reasonCn: 'Research 入口止于报告和复盘回链；审批、发布、激活继续由原采用流程负责',
    });
  }
  return send(res, 404, { error: 'NOT_FOUND' });
}

function createServer(opts = {}) { return http.createServer((req, res) => handle(req, res, opts)); }

/**
 * 启动前注册部署中明确配置的市场 Adapter。未配置会显式 skipped；一旦配置却
 * 不可达/错市场/合同不齐，Promise 失败，HTTP 服务不会先启动后偷偷降级。
 */
async function bootstrapAdapters(opts = {}) {
  const register = opts.registerConfiguredRemoteMarkets || registerConfiguredRemoteMarkets;
  return register(opts.remoteOptions || {});
}

if (require.main === module) {
  const port = Number(process.env.QRP_PORT || 4310);
  let bind;
  try { bind = bindConfiguration(); } catch (error) {
    console.error(JSON.stringify({ error: 'RESEARCH_API_BIND_REJECTED', detail: String(error.message || error) }));
    process.exitCode = 1;
  }
  if (bind) bootstrapAdapters()
    .then((adapterRegistration) => {
      createServer({ researchToken: bind.researchToken }).listen(port, bind.host, () => {
        console.log(`Research API + Web: http://${bind.host}:${port}`);
        console.log(`Research 读取面:${bind.loopback ? 'LOOPBACK_ONLY' : 'TOKEN_PROTECTED'}`);
        console.log(`只读视图:${Object.keys(views).map((v) => `/api/${v}`).join(' · ')}`);
        console.log(`远程 Adapter:registered=${adapterRegistration.registered.join(',') || 'none'} skipped=${adapterRegistration.skipped.join(',') || 'none'}`);
        console.log('Research 写入口:DISABLED(报告止步；采用沿用原 Desk/Owner 流程)');
        console.log(process.env.QRP_RUNTIME_TOKEN
          ? `Runtime 拉取面:已配置令牌 · ${['GET /api/runtime/pending-activations', 'GET /api/runtime/release', 'POST /api/runtime/ack'].join(' · ')}`
          : '⚠ 未配置 QRP_RUNTIME_TOKEN —— Runtime 拉取/回执将一律 403(fail-closed)');
      });
    })
    .catch((error) => {
      console.error(JSON.stringify({ error: 'RESEARCH_API_BOOTSTRAP_FAILED', detail: String(error.message || error) }));
      process.exitCode = 1;
    });
}

module.exports = { createServer, bootstrapAdapters, views, runtimeRoutes, runtimeActions, runtimeOk, researchOk, bindConfiguration, hostIsLoopback };
