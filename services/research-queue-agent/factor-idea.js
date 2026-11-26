'use strict';
/**
 * FACTOR_IDEA_V1（§5.10，AQ-45，RF1116：公式只在沙盒里）。想法引用事实 id，点名机制与读数，不带公式、方向、数字或市场预测。
 *   validateIdeaDraft  模型给的那部分（6 个键）；  buildIdeaRecords  代码补 id、哈希、读数的 PIT 可得时刻（从注册表抄）；  validateIdeaRecord  整条记录。
 * 失败即关，错误码 FACTOR_IDEA_*。注册表视图（registry）由主机侧的构建器给（./registries.js），本模块不读文件。
 */
const { canonicalJson, sha256, isObj, SHA64 } = require('./canon');
const { firewallHit, factsMap, numericTokens } = require('./facts');
const { textErrors } = require('./text-rules');

const MAX_IDEAS_PER_WEEK = 5;
const DRAFT_KEYS = ['expected_failure_zh', 'fact_ids', 'holding_periods', 'mechanism', 'question_zh', 'readings'];
const NEW_KEYS = ['decision_point', 'description_zh', 'layer', 'proposed_id', 'title_zh'];
const NEW_DECISION_POINTS = ['SELECT', 'DIRECTION', 'ENTRY'];
const NEW_ID = /^SEL\.[A-Z0-9_]+\.[A-Z0-9_]+$/;
const RECORD_KEYS = ['card_sha256', 'expected_failure_zh', 'fact_ids', 'fact_pack_sha256', 'holding_periods', 'idea_id', 'market', 'mechanism', 'model',
  'prompt_admission_sha256', 'question_zh', 'readings', 'schema', 'week_id'];
const IDEA_ID = /^FI-(CN_A|US_EQUITY|CRYPTO)-(\d{4}-W\d{2})-(\d+)$/;
const SPACE_MARKET = Object.freeze({ CN_A: 'CN_A', US_EQUITY: 'US', CRYPTO: 'CRYPTO' });

/** 公式或算子记号：函数调用、算子名、读数之间的算术、比较符。 */
const FORMULA = [
  /[A-Za-z_][A-Za-z0-9_]*\s*[(（]/,
  /\b(rank|zscore|ts_[a-z0-9_]+|neutralize_[a-z0-9_]+|decay_linear|delta)\b/i,
  /[A-Za-z_][\w.]*\s*[+*/^×÷]\s*[A-Za-z_(][\w.]*|[A-Za-z_][\w.]*\s+-\s+[A-Za-z_(][\w.]*/,
  /[<>=≥≤≠]/,
];
const INTERROGATIVE = /[?？]\s*$|是否|吗|么\s*[?？]?$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function validateIdeaDraft(d, ctx) {
  const errors = [];
  const add = (code, detail) => errors.push({ code, detail });
  if (!isObj(d) || Object.keys(d).sort().join() !== DRAFT_KEYS.join()) { add('FACTOR_IDEA_KEYS', isObj(d) ? Object.keys(d).join() : typeof d); return { ok: false, errors }; }
  const reg = ctx.registry;
  const byId = factsMap(ctx.pack);
  const texts = [];

  const ids = Array.isArray(d.fact_ids) && d.fact_ids.every((x) => typeof x === 'string') ? d.fact_ids : null;
  if (!ids) add('FACTOR_IDEA_FACTS_MIN', 'fact_ids');
  else {
    for (const id of ids) if (!byId.has(id)) add('FACTOR_IDEA_FACT_UNKNOWN', id);
    const valid = new Set(ids.filter((id) => byId.has(id)));
    if (valid.size < 2) add('FACTOR_IDEA_FACTS_MIN', valid.size);
    for (const id of valid) if (firewallHit(byId.get(id))) add('FACTOR_IDEA_FIREWALL_SOURCE', id);
  }

  const m = d.mechanism;
  if (typeof m === 'string') {
    const hit = reg.mechanisms.find((x) => x.mechanism_id === m);
    if (!hit || hit.layer !== 'SELECTION_TIMING') add('FACTOR_IDEA_MECHANISM_UNREGISTERED', m);
  } else if (isObj(m) && Object.keys(m).join() === 'NEW' && isObj(m.NEW)) {
    const n = m.NEW;
    const ok = Object.keys(n).sort().join() === NEW_KEYS.join() && NEW_ID.test(n.proposed_id || '') && !reg.mechanisms.some((x) => x.mechanism_id === n.proposed_id)
      && n.layer === 'SELECTION_TIMING' && NEW_DECISION_POINTS.includes(n.decision_point)
      && typeof n.title_zh === 'string' && n.title_zh.trim() !== '' && typeof n.description_zh === 'string' && n.description_zh.trim() !== '';
    if (!ok) add('FACTOR_IDEA_MECHANISM_NEW_INVALID');
    if (typeof n.title_zh === 'string') texts.push(['mechanism.NEW.title_zh', n.title_zh]);
    if (typeof n.description_zh === 'string') texts.push(['mechanism.NEW.description_zh', n.description_zh]);
  } else add('FACTOR_IDEA_MECHANISM_NEW_INVALID', 'shape');

  const registeredReadings = Array.isArray(d.readings) && d.readings.length
    && d.readings.every((r) => typeof r === 'string' && own(reg.readings, r));
  if (!registeredReadings) add('FACTOR_IDEA_READING_UNREGISTERED');
  const space = reg.mining_space;
  const frozenSpace = isObj(space) && space.schema === 'MINING_SPACE_V1' && SHA64.test(space.sha256 || '')
    && SHA64.test(space.freeze_sha256 || '') && space.market === SPACE_MARKET[ctx.market];
  if (!frozenSpace) add('FACTOR_IDEA_NO_FROZEN_SPACE', ctx.market);
  else if (registeredReadings) {
    for (const id of d.readings) if (reg.readings[id].origin !== 'SPACE') add('FACTOR_IDEA_READING_NOT_IN_MINING_SPACE', `${id}@${space.sha256}`);
  }
  if (!(Array.isArray(d.holding_periods) && d.holding_periods.length && d.holding_periods.every((h) => Number.isInteger(h) && reg.holding_periods.includes(h)))) add('FACTOR_IDEA_HOLDING_PERIOD_UNREGISTERED');

  for (const k of ['question_zh', 'expected_failure_zh']) {
    if (typeof d[k] !== 'string' || d[k].trim() === '') add('FACTOR_IDEA_KEYS', k); else texts.push([k, d[k]]);
  }
  if (typeof d.question_zh === 'string' && d.question_zh.trim() !== '' && !INTERROGATIVE.test(d.question_zh.trim())) add('FACTOR_IDEA_QUESTION_NOT_INTERROGATIVE');

  const cited = ids || [];
  for (const [path, t] of texts) {
    if (FORMULA.some((re) => re.test(t))) add('FACTOR_IDEA_FORMULA_TOKEN', path);
    if (numericTokens(t).length) add('FACTOR_IDEA_NUMERIC_PARAM', path);
    for (const e of textErrors(t, { prefix: 'FACTOR_IDEA', lists: ['PREDICTION', 'VERDICT', 'DIRECTION'], cited, factsById: byId, checkNumbers: false }, path)) errors.push({ code: e.code, detail: e.detail });
  }
  const seen = new Set();
  const uniq = errors.filter((e) => { const k = `${e.code}|${e.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ok: uniq.length === 0, errors: uniq };
}

const packSha = (pack) => sha256(canonicalJson(pack));

function buildIdeaRecords(card, ctx, { card_sha256, prompt_admission_sha256, model }) {
  const base = ctx.existing_idea_count || 0;
  const fact_pack_sha256 = packSha(ctx.pack);
  return (card.factor_ideas || []).map((d, i) => ({
    schema: 'FACTOR_IDEA_V1',
    idea_id: `FI-${ctx.market}-${ctx.week_id}-${base + i + 1}`,
    market: ctx.market, week_id: ctx.week_id, card_sha256, fact_pack_sha256,
    fact_ids: [...new Set(d.fact_ids)],
    mechanism: d.mechanism,
    readings: d.readings.map((id) => ({ id, pit_available_at: ctx.registry.readings[id].pit_available_at })),
    holding_periods: d.holding_periods,
    question_zh: d.question_zh, expected_failure_zh: d.expected_failure_zh,
    prompt_admission_sha256, model,
  }));
}

function validateIdeaRecord(rec, ctx) {
  const errors = [];
  const add = (code, detail) => errors.push({ code, detail });
  const shaOk = (v) => typeof v === 'string' && SHA64.test(v);
  if (!isObj(rec) || Object.keys(rec).sort().join() !== RECORD_KEYS.join() || rec.schema !== 'FACTOR_IDEA_V1' || typeof rec.model !== 'string' || rec.model === ''
    || !shaOk(rec.card_sha256) || !shaOk(rec.fact_pack_sha256) || !shaOk(rec.prompt_admission_sha256)) { add('FACTOR_IDEA_KEYS'); return { ok: false, errors }; }
  const m = IDEA_ID.exec(rec.idea_id);
  if (!m || m[1] !== rec.market || m[2] !== rec.week_id || rec.market !== ctx.market || rec.week_id !== ctx.week_id) add('FACTOR_IDEA_ID_INVALID', rec.idea_id);
  if (rec.fact_pack_sha256 !== packSha(ctx.pack)) add('FACTOR_IDEA_PACK_SHA_MISMATCH');
  const readings = Array.isArray(rec.readings) ? rec.readings : [];
  for (const r of readings) {
    if (!isObj(r) || !own(ctx.registry.readings, r.id) || ctx.registry.readings[r.id].pit_available_at !== r.pit_available_at) add('FACTOR_IDEA_PIT_MISMATCH', isObj(r) ? r.id : null);
  }
  const draft = { fact_ids: rec.fact_ids, mechanism: rec.mechanism, readings: readings.map((r) => (isObj(r) ? r.id : r)), holding_periods: rec.holding_periods, question_zh: rec.question_zh, expected_failure_zh: rec.expected_failure_zh };
  errors.push(...validateIdeaDraft(draft, ctx).errors);
  return { ok: errors.length === 0, errors };
}

module.exports = { MAX_IDEAS_PER_WEEK, validateIdeaDraft, buildIdeaRecords, validateIdeaRecord, packSha };
