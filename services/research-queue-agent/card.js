'use strict';
/**
 * REVIEW_AI_CARD_V1 的验证器（§5.6、§5.10，AQ-12、AQ-45）。卡 = 支持 / 反对 / 未知（都带事实 id）、重复模式（次数由代码给）、1–5 条 factor_ideas
 * （0 条要有带引用的 no_idea_reason）、至多 2 条非因子问题。模型只写这些键；schema、task_id、哈希由代码补。
 */
const { isObj } = require('./canon');
const { factsMap, codeCounts } = require('./facts');
const { textErrors } = require('./text-rules');
const { validateIdeaDraft, MAX_IDEAS_PER_WEEK } = require('./factor-idea');

const KEYS = ['factor_ideas', 'market', 'no_idea_reason', 'opposing', 'question_proposals', 'repeated_patterns', 'supporting', 'unknowns', 'week_id'];
const ITEM_KEYS = ['fact_ids', 'text_zh'];
const PATTERN_KEYS = ['count', 'fact_ids', 'note_zh', 'pattern_key'];
const QUESTION_KEYS = ['decision_point', 'fact_ids', 'layer', 'market', 'mechanism_id', 'question_zh'];
const LAYERS = ['SELECTION_TIMING', 'RISK', 'ACCOUNT', 'NA_EXECUTION'];
const DECISION_POINTS = ['SELECT', 'DIRECTION', 'ENTRY', 'EXIT', 'SIZING', 'COST'];
const MAX_QUESTIONS = 2;
const INTERROGATIVE = /[?？]\s*$|是否|吗/;
const sameKeys = (o, keys) => isObj(o) && Object.keys(o).sort().join() === keys.join();

function validateCard(raw, ctx) {
  const errors = [];
  const add = (code, path, detail) => errors.push({ code, path, detail });
  let c = raw;
  if (typeof raw === 'string') { try { c = JSON.parse(raw); } catch (e) { c = null; } }
  if (!isObj(c)) { add('CARD_NOT_JSON'); return { ok: false, errors, card: null }; }
  if (!sameKeys(c, KEYS)) { add('CARD_KEYS', null, Object.keys(c).join()); return { ok: false, errors, card: null }; }
  const byId = factsMap(ctx.pack);
  if (c.market !== ctx.market) add('CARD_MARKET_MISMATCH', 'market', c.market);
  if (c.week_id !== ctx.week_id) add('CARD_WEEK_MISMATCH', 'week_id', c.week_id);

  const cited = (ids, path) => {
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) { add('CARD_ITEM_KEYS', path, 'fact_ids'); return []; }
    if (ids.length === 0) add('CARD_ITEM_UNCITED', path);
    for (const id of ids) if (!byId.has(id)) add('CARD_FACT_UNKNOWN', path, id);
    return ids;
  };
  const text = (t, ids, path, lists = ['PREDICTION', 'VERDICT']) => errors.push(...textErrors(t, { prefix: 'CARD', lists, cited: ids, factsById: byId }, path));

  for (const section of ['supporting', 'opposing', 'unknowns']) {
    if (!Array.isArray(c[section])) { add('CARD_ITEM_KEYS', section); continue; }
    c[section].forEach((it, i) => {
      const path = `${section}[${i}]`;
      if (!sameKeys(it, ITEM_KEYS) || typeof it.text_zh !== 'string') { add('CARD_ITEM_KEYS', path); return; }
      text(it.text_zh, cited(it.fact_ids, path), `${path}.text_zh`);
    });
  }

  const counts = new Map(codeCounts(ctx.pack).map((x) => [x.key, x.count]));
  if (!Array.isArray(c.repeated_patterns)) add('CARD_ITEM_KEYS', 'repeated_patterns');
  else c.repeated_patterns.forEach((p, i) => {
    const path = `repeated_patterns[${i}]`;
    if (!sameKeys(p, PATTERN_KEYS) || typeof p.note_zh !== 'string') { add('CARD_ITEM_KEYS', path); return; }
    const ids = cited(p.fact_ids, path);
    if (!counts.has(p.pattern_key)) add('CARD_PATTERN_UNKNOWN', path, p.pattern_key);
    else if (counts.get(p.pattern_key) !== p.count) add('CARD_PATTERN_COUNT_MISMATCH', path, p.pattern_key);
    text(p.note_zh, ids, `${path}.note_zh`);
  });

  const ideas = Array.isArray(c.factor_ideas) ? c.factor_ideas : (add('CARD_ITEM_KEYS', 'factor_ideas'), []);
  if ((ctx.existing_idea_count || 0) + ideas.length > MAX_IDEAS_PER_WEEK) add('FACTOR_IDEA_TOO_MANY', 'factor_ideas', ideas.length);
  ideas.forEach((d, i) => { for (const e of validateIdeaDraft(d, ctx).errors) add(e.code, `factor_ideas[${i}]`, e.detail); });

  const r = c.no_idea_reason;
  if (ideas.length === 0 && r === null) add('CARD_ZERO_IDEAS_NO_REASON');
  if (ideas.length > 0 && r !== null) add('CARD_REASON_WITH_IDEAS');
  if (r !== null) {
    if (!sameKeys(r, ITEM_KEYS) || typeof r.text_zh !== 'string' || !Array.isArray(r.fact_ids)) add('CARD_NO_IDEA_REASON_UNCITED', 'no_idea_reason', 'shape');
    else {
      if (r.fact_ids.length === 0 || !r.fact_ids.every((id) => byId.has(id))) add('CARD_NO_IDEA_REASON_UNCITED', 'no_idea_reason');
      text(r.text_zh, r.fact_ids, 'no_idea_reason.text_zh');
    }
  }

  const qs = Array.isArray(c.question_proposals) ? c.question_proposals : (add('CARD_ITEM_KEYS', 'question_proposals'), []);
  if (qs.length > MAX_QUESTIONS) add('CARD_QUESTIONS_TOO_MANY', 'question_proposals', qs.length);
  qs.forEach((q, i) => {
    const path = `question_proposals[${i}]`;
    const ok = sameKeys(q, QUESTION_KEYS) && (q.mechanism_id === 'NEW' || ctx.registry.mechanisms.some((m) => m.mechanism_id === q.mechanism_id))
      && LAYERS.includes(q.layer) && DECISION_POINTS.includes(q.decision_point) && q.market === ctx.market
      && typeof q.question_zh === 'string' && INTERROGATIVE.test(q.question_zh) && Array.isArray(q.fact_ids) && q.fact_ids.length > 0 && q.fact_ids.every((id) => byId.has(id));
    if (!ok) { add('CARD_QUESTION_INVALID', path); }
    if (isObj(q) && typeof q.question_zh === 'string') text(q.question_zh, Array.isArray(q.fact_ids) ? q.fact_ids : [], `${path}.question_zh`, ['PREDICTION', 'VERDICT', 'DIRECTION']);
  });

  const seen = new Set();
  const uniq = errors.filter((e) => { const k = `${e.code}|${e.path}|${e.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ok: uniq.length === 0, errors: uniq, card: uniq.length === 0 ? c : null };
}

module.exports = { validateCard, LAYERS, DECISION_POINTS, MAX_QUESTIONS };
