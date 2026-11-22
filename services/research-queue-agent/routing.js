'use strict';
/**
 * 市场 → 代理主机（AQ-36）与 FACTOR_IDEA 的确定性路由（§2.1、§5.10）。
 * 顺序：TRIAGE_QUERY 读数先行（「不做（已判）」带封存 sha 关闭）；NEW 机制 → 机制准入队列；只重组已登记因子 → AI_PREREG；其余 → 生成方视野。加密货币的生成方路径暂停（RF1116 ★a）。
 * 读不到 TRIAGE_QUERY 读数 = TRIAGE_PENDING，不是「没有先验」。纯函数；默认的 triageViaRegister 才读机制登记表（QRP 一侧，需要试验台账）。
 */
const { isObj } = require('./canon');
const { checkPack } = require('./facts');

const MARKET_HOST = Object.freeze({ CN_A: 'LINUX', US_EQUITY: 'HK', CRYPTO: 'HK' });
const err = (code, detail) => Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });

function agentHostFor(market) {
  if (!Object.prototype.hasOwnProperty.call(MARKET_HOST, market)) throw err('RQ_AGENT_MARKET_INVALID', String(market));
  return MARKET_HOST[market];
}

/** 任务的 agent_host 必须是它的 market 对应的那个主机，并且正在运行的就是这个主机。 */
function assertAgentHost(task, running) {
  const want = agentHostFor(task.market);
  if (task.agent_host !== want || running !== want) throw err('RQ_AGENT_HOST_MISMATCH', `${task.market} needs ${want}; task.agent_host=${task.agent_host}, running on ${running}`);
}

function triageViaRegister({ mechanism_id, market }, { marks = null, now = new Date() } = {}) {
  const mech = require('../research-mechanism-register');
  const asOf = new Date(now.getTime() + 8 * 3600e3).toISOString().replace(/\.\d+Z$/, '+08:00');
  const t = mech.query({ market, mechanism_ids: [mechanism_id] }, { asOf, ...(marks ? { marks } : {}) });
  return { route: t.route, cite_seal_sha256: t.cite_seal_sha256 };
}

const isNew = (rec) => isObj(rec.mechanism);
const mechanismIdOf = (rec) => (isNew(rec) ? rec.mechanism.NEW.proposed_id : rec.mechanism);

function routeIdea(rec, { registry, triage } = {}) {
  const base = { idea_id: rec.idea_id, market: rec.market, mechanism_id: mechanismIdOf(rec) };
  const crypto = rec.market === 'CRYPTO';
  if (isNew(rec)) {
    if (crypto) return { ...base, route: 'GENERATOR', state: 'GENERATOR_HELD_CRYPTO', reason: 'RF1116: the generator path is held for crypto' };
    return { ...base, route: 'MECHANISM_ADMISSION', state: 'WAITING_MECHANISM_ADMISSION', wait_code: 'WAITING_EXTERNAL:MECHANISM_ADMISSION' };
  }
  const t = triage ? triage({ mechanism_id: rec.mechanism, market: rec.market }) : null;
  if (!t || typeof t.route !== 'string') return { ...base, route: 'TRIAGE', state: 'TRIAGE_PENDING', wait_code: 'WAITING_EXTERNAL:TRIAGE_QUERY' };
  if (t.route === 'NOT_DO_SETTLED') return { ...base, route: 'CLOSED', state: 'CLOSED_NOT_DO_SETTLED', cite_seal_sha256: t.cite_seal_sha256 || [] };
  const recombines = rec.readings.length > 0 && rec.readings.every((r) => registry.readings[r.id] && registry.readings[r.id].origin === 'FACTOR_LIBRARY');
  if (recombines) return { ...base, route: 'AI_PREREG', state: 'PREREG_PROPOSED', triage_route: t.route };
  if (crypto) return { ...base, route: 'GENERATOR', state: 'GENERATOR_HELD_CRYPTO', reason: 'RF1116: the generator path is held for crypto', triage_route: t.route };
  return { ...base, route: 'GENERATOR', state: 'GENERATOR_VIEW_PENDING', triage_route: t.route };
}

/** AI_PREREG 提案（只是提案；起草与冻结是 Q3 / 冻结程序的事）。 */
function preregProposal(rec) {
  return { schema: 'AI_PREREG_PROPOSAL_V1', idea_id: rec.idea_id, market: rec.market, week_id: rec.week_id, mechanism_id: mechanismIdOf(rec),
    reading_ids: rec.readings.map((r) => r.id), fact_pack_sha256: rec.fact_pack_sha256, card_sha256: rec.card_sha256, state: 'PROPOSED' };
}

/**
 * 下一轮 AI_MINED_LLM 的想法视野（AQ-46）：路由在生成方路径上、机制 id 已在（合并后的）登记表里、且出处包没碰防火墙的想法。
 * 出处不明或碰防火墙的进 refused，不进视野。
 */
function buildIdeasInView({ ideas, routes, packsBySha, registerIds }) {
  const routeById = new Map(routes.map((r) => [r.idea_id, r]));
  const view = [];
  const refused = [];
  for (const idea of ideas) {
    const r = routeById.get(idea.idea_id);
    if (!r || !['GENERATOR_VIEW_PENDING', 'WAITING_MECHANISM_ADMISSION'].includes(r.state)) continue;
    const mid = mechanismIdOf(idea);
    if (!registerIds.has(mid)) continue;
    const pack = packsBySha[idea.fact_pack_sha256];
    if (!pack) { refused.push({ idea_id: idea.idea_id, code: 'IDEA_PROVENANCE_UNKNOWN' }); continue; }
    const bad = checkPack(pack, { purpose: 'GENERATOR_VIEW', maxTokens: Infinity }).errors.some((e) => e.code === 'PACK_FIREWALL_SOURCE' || e.code === 'PACK_CHECK_REPORT_AS_INPUT');
    if (bad) { refused.push({ idea_id: idea.idea_id, code: 'IDEA_PROVENANCE_FIREWALL' }); continue; }
    view.push({ idea_id: idea.idea_id, market: idea.market, week_id: idea.week_id, mechanism_id: mid, reading_ids: idea.readings.map((x) => x.id),
      card_sha256: idea.card_sha256, fact_pack_sha256: idea.fact_pack_sha256 });
  }
  return { schema: 'IDEAS_IN_VIEW_V1', ideas_in_view: view, mechanism_ids_in_view: [...new Set(view.map((v) => v.mechanism_id))].sort(), refused };
}

module.exports = { MARKET_HOST, agentHostFor, assertAgentHost, triageViaRegister, routeIdea, preregProposal, buildIdeasInView, mechanismIdOf, isNew, err };
