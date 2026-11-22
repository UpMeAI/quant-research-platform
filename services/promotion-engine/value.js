'use strict';

/**
 * Information-value ordering and KPI 9 (PLAN_V1_1_AMENDMENT_1 section 4.2 and 1.3). The formula and its weights are a frozen config file
 * (config/promotion_engine_value.v1.json); its canonical sha256 is pinned here as well as written in the file.
 */
const fs = require('fs');
const path = require('path');
const { sha256, canonicalJson, isObj, num, round6, EngineError } = require('./common');

const FILE = path.join(__dirname, '..', '..', 'config', 'promotion_engine_value.v1.json');
const PINNED_VALUE_CONFIG_SHA256 = 'fc9f1259e9ee424315c8d7f0b7f844d6145bedbba092f51595d1c0827b483103';
const configSha = (cfg) => { const { config_sha256: _omit, ...rest } = cfg; return sha256(canonicalJson(rest)); };

function assertPinned(cfg) {
  if (!isObj(cfg) || cfg.schema !== 'PROMOTION_INFORMATION_VALUE_CONFIG_V1') throw new EngineError('PROMOTION_VALUE_CONFIG_INVALID');
  const actual = configSha(cfg);
  if (actual !== PINNED_VALUE_CONFIG_SHA256) throw new EngineError('PROMOTION_VALUE_CONFIG_PIN_MISMATCH', actual.slice(0, 12));
  return cfg;
}
const CONFIG = assertPinned(JSON.parse(fs.readFileSync(FILE, 'utf8')));
const VALUE_CONFIG_SHA256 = PINNED_VALUE_CONFIG_SHA256;

/** The frozen config. With an argument: that config, checked against the pin (used to prove a changed file is refused). */
function valueConfig(candidate) { return candidate === undefined ? CONFIG : assertPinned(candidate); }

const MARKETS = Object.freeze(['CN_A', 'US_EQUITY', 'CRYPTO']);

function ciCrossing(ci, threshold) {
  if (ci.upper <= threshold) return 0;
  if (ci.lower >= threshold) return 1;
  return round6((ci.upper - threshold) / (ci.upper - ci.lower));
}

/**
 * @param {object[]} items { candidate_id, market, mechanism_prior_class, effect_ci{lower,upper}, min_economic_value, p_reach, conclusion? (default 做) }
 * @param {{market: string}} opts one market per ranking (never a cross-market ranking)
 */
function rankInformationValue(items, { market } = {}) {
  if (!MARKETS.includes(market) || !Array.isArray(items)) throw new EngineError('PROMOTION_VALUE_INPUT_INVALID', 'market_or_items');
  const w = CONFIG.weights;
  const ranked = [];
  const excluded = [];
  for (const it of items) {
    if (!isObj(it) || typeof it.candidate_id !== 'string') throw new EngineError('PROMOTION_VALUE_INPUT_INVALID', 'item');
    if (it.market !== market) throw new EngineError('PROMOTION_VALUE_CROSS_MARKET', `${it.candidate_id}:${it.market}`);
    if (it.conclusion !== undefined && it.conclusion !== '做') { excluded.push({ candidate_id: it.candidate_id, reason: 'NOT_A_DO_CONCLUSION' }); continue; }
    const prior = CONFIG.mechanism_prior_weight[it.mechanism_prior_class];
    if (!num(prior)) throw new EngineError('PROMOTION_VALUE_PRIOR_CLASS_UNKNOWN', `${it.candidate_id}:${it.mechanism_prior_class}`);
    const ci = it.effect_ci;
    if (!isObj(ci) || !num(ci.lower) || !num(ci.upper) || ci.lower > ci.upper || !num(it.min_economic_value) || !num(it.p_reach) || it.p_reach < 0 || it.p_reach > 1) throw new EngineError('PROMOTION_VALUE_INPUT_INVALID', it.candidate_id);
    const crossing = ciCrossing(ci, it.min_economic_value);
    const score = round6((prior ** w.prior) * (crossing ** w.ci_crossing) * (it.p_reach ** w.p_reach));
    ranked.push({ candidate_id: it.candidate_id, score, components: { mechanism_prior: prior, ci_crossing: crossing, p_reach: round6(it.p_reach) } });
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0));
  excluded.sort((a, b) => (a.candidate_id < b.candidate_id ? -1 : 1));
  return { schema: 'PROMOTION_INFORMATION_VALUE_RANKING_V1', market, config_sha256: VALUE_CONFIG_SHA256, ranked, excluded, production_effect: 'NONE' };
}

const LAYERS = Object.freeze(['ALPHA', 'RISK', 'EXECUTION']);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const bad = (d) => new EngineError('PROMOTION_KPI_INPUT_INVALID', d);

/**
 * KPI 9 (AMENDMENT_1 section 1.3): per month, market and layer, mechanism-deduplicated S4-passing candidates per model cost (per 10 000 CNY) and
 * per core-hour. Negative conclusions are counted in their own column: not in the numerator, not taken out of the denominator.
 * A zero denominator is N/A (null with a reason), never 0.
 */
function kpi9({ month_cst: month, s4_passes: passes = [], costs = [], negatives = [] } = {}) {
  if (typeof month !== 'string' || !MONTH.test(month)) throw bad('month_cst');
  const rows = new Map();
  const row = (market, layer) => {
    if (!MARKETS.includes(market) || !LAYERS.includes(layer)) throw bad(`${market}/${layer}`);
    const key = `${market}\0${layer}`;
    if (!rows.has(key)) rows.set(key, { market, layer, mechanisms: new Map(), model_cost_cny: 0, core_hours: 0, negative_conclusions: 0 });
    return rows.get(key);
  };
  for (const p of passes) {
    if (!isObj(p) || typeof p.s4_passed_at !== 'string' || !Array.isArray(p.mechanism_ids) || !p.mechanism_ids.length || typeof p.candidate_id !== 'string') throw bad('s4_pass');
    if (p.s4_passed_at.slice(0, 7) !== month) continue;
    const r = row(p.market, p.layer);
    const key = [...new Set(p.mechanism_ids)].sort().join(',');
    const kept = r.mechanisms.get(key);
    if (!kept || p.s4_passed_at < kept.at || (p.s4_passed_at === kept.at && p.candidate_id < kept.id)) r.mechanisms.set(key, { at: p.s4_passed_at, id: p.candidate_id });
  }
  for (const c of costs) {
    if (!isObj(c) || !num(c.model_cost_cny) || !num(c.core_hours) || c.model_cost_cny < 0 || c.core_hours < 0) throw bad('cost');
    if (c.month_cst !== month) continue;
    const r = row(c.market, c.layer); r.model_cost_cny += c.model_cost_cny; r.core_hours += c.core_hours;
  }
  for (const n of negatives) {
    if (!isObj(n) || !Number.isInteger(n.count) || n.count < 0) throw bad('negative');
    if (n.month_cst !== month) continue;
    row(n.market, n.layer).negative_conclusions += n.count;
  }
  const out = [...rows.values()].map((r) => {
    const passesN = r.mechanisms.size;
    const cny = round6(r.model_cost_cny); const hours = round6(r.core_hours);
    const o = { market: r.market, layer: r.layer, independent_s4_passes: passesN, counted_candidate_ids: [...r.mechanisms.values()].map((m) => m.id).sort(), model_cost_cny: cny, core_hours: hours, negative_conclusions: r.negative_conclusions };
    if (cny > 0) { o.per_10k_cny = round6((passesN / cny) * 10000); o.per_10k_cny_reason = null; } else { o.per_10k_cny = null; o.per_10k_cny_reason = 'DENOMINATOR_ZERO'; }
    if (hours > 0) { o.per_core_hour = round6(passesN / hours); o.per_core_hour_reason = null; } else { o.per_core_hour = null; o.per_core_hour_reason = 'DENOMINATOR_ZERO'; }
    return o;
  });
  out.sort((a, b) => (a.market < b.market ? -1 : a.market > b.market ? 1 : (a.layer < b.layer ? -1 : 1)));
  return { schema: 'PROMOTION_KPI9_V1', month_cst: month, rows: out, production_effect: 'NONE' };
}

module.exports = { FILE, PINNED_VALUE_CONFIG_SHA256, VALUE_CONFIG_SHA256, configSha, valueConfig, rankInformationValue, kpi9, ciCrossing, LAYERS, MARKETS };
