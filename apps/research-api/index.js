'use strict';
/**
 * Research API(§5.2 apps/research-api · §17 研究台信息架构)——
 * 零依赖 HTTP 服务,为研究台六个 MVP 入口提供**只读**投影 + 两个受治理写操作。
 *
 * 治理(§18 Least Privilege / No Automatic Promotion):
 *   - 除「Founder 审批」与「请求激活」外全部只读;
 *   - 这两个写操作必须携带 Founder 令牌(环境变量 QRP_FOUNDER_TOKEN);
 *     未配置令牌 = 一律 403(fail-closed,绝不因为「本地开发」放行);
 *   - 平台不下单、不碰 broker、不写 Runtime 状态 —— 激活仍走 Runtime 主动拉取(§12.2)。
 */
const http = require('http');
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
const { listAdapters } = require('../../adapters/registry');

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
  }),
};

// ── 受治理写操作(Founder 令牌;fail-closed)────────────────────────────────
function founderOk(req) {
  const expected = process.env.QRP_FOUNDER_TOKEN;
  if (!expected) return { ok: false, reason: 'FOUNDER_TOKEN_NOT_CONFIGURED', reasonCn: '未配置 QRP_FOUNDER_TOKEN —— 审批与激活一律拒绝(fail-closed)' };
  const got = req.headers['x-founder-token'];
  if (got !== expected) return { ok: false, reason: 'FOUNDER_TOKEN_INVALID', reasonCn: 'Founder 令牌不匹配' };
  return { ok: true };
}

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

const actions = {
  /** §12.1 一键发布的第一步:Founder 审批(仅 APPROVE_PAPER / REJECT)。 */
  review: async (body) => {
    const r = controlPlane.reviewCandidate(body.candidate_id, body.decision, {
      reviewer: 'FOUNDER', decisionCn: body.decisionCn, approvedByUserId: body.approvedByUserId,
    });
    return { review_status: r.review_status, candidate_id: r.candidate_id };
  },
  /** §12.1 第二步:创建 Activation(仍需 Runtime 到生效日拉取并验哈希才 ACTIVE)。 */
  activate: async (body) => {
    const a = await controlPlane.requestActivation(body.release_id, {
      target_runtime_id: body.target_runtime_id, environment: body.environment || 'PAPER',
      effective_from: body.effective_from, approvedByUserId: body.approvedByUserId,
    });
    return { activation_id: a.activation_id, activation_status: a.activation_status, effective_from: a.effective_from };
  },
};

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

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
      .then(() => views[view]())
      .then((v) => send(res, 200, v))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
    return undefined;
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    const action = p.slice(5);
    if (!actions[action]) return send(res, 404, { error: 'UNKNOWN_ACTION', available: Object.keys(actions) });
    const gate = founderOk(req);
    if (!gate.ok) return send(res, 403, { error: gate.reason, reasonCn: gate.reasonCn });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      Promise.resolve()
        .then(() => actions[action](JSON.parse(raw || '{}')))
        .then((v) => send(res, 200, v))
        .catch((e) => send(res, 400, { error: String(e.message || e) }));
    });
    return undefined;
  }
  return send(res, 404, { error: 'NOT_FOUND' });
}

function createServer() { return http.createServer(handle); }

if (require.main === module) {
  const port = Number(process.env.QRP_PORT || 4310);
  createServer().listen(port, () => {
    console.log(`Research API + Web: http://localhost:${port}`);
    console.log(`只读视图:${Object.keys(views).map((v) => `/api/${v}`).join(' · ')}`);
    console.log(process.env.QRP_FOUNDER_TOKEN
      ? 'Founder 审批/激活:已配置令牌(仍需 X-Founder-Token 头)'
      : '⚠ 未配置 QRP_FOUNDER_TOKEN —— 审批与激活将一律 403(fail-closed)');
    console.log(process.env.QRP_RUNTIME_TOKEN
      ? `Runtime 拉取面:已配置令牌 · ${['GET /api/runtime/pending-activations', 'GET /api/runtime/release', 'POST /api/runtime/ack'].join(' · ')}`
      : '⚠ 未配置 QRP_RUNTIME_TOKEN —— Runtime 拉取/回执将一律 403(fail-closed)');
  });
}

module.exports = { createServer, views, actions, runtimeRoutes, runtimeActions, founderOk, runtimeOk };
