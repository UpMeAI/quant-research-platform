'use strict';

/**
 * Q3b: what a K2 freeze records for the promotion engine (W16) and for the independent verifier (W20 V-5), in the same event as the K2.
 *
 *   PROMOTION_TERMS_V1 file   written by the program next to the K2 (0444, bound to the K2 by k2_sha256, terms_frozen_at = k2_frozen_at, never after it).
 *                             The drafter supplies layer, minimum economic value, thresholds, the section 4.2 policy and the review endpoint; the program fills the
 *                             rest: candidate id and mechanism ids from the draft, min_sample_n from the power tool output, the binding fields from the freeze. The engine's own
 *                             validator (promotion-engine/terms.js) judges the result; there is no second copy of its rules here. No stage evidence is named: it cannot exist yet.
 *   ROBUSTNESS declaration    the draft's declaration is hashed as W20 V-5 expects (sha256 of canonicalJson) and the K2 text carries the line; the kinds and the cost multiplier
 *                             it must declare are read from config/independent_verifier.v1.json (the verifier's own configuration).
 *
 * An AI-authored draft may not choose the numbers: they must equal ctx.promotionTermsStar (the deterministic bundle's registered values, like margin_sd from the risk
 * rules). A human-authored draft states them itself. Pure functions of the draft and the context: no clock, no network, no model call.
 */
const { canonicalJson, sha256, prettyJson, isObj } = require('./common');
const engineTerms = require('../promotion-engine/terms');
const VERIFIER = require('../../config/independent_verifier.v1.json');

const TERMS_KEYS = Object.freeze(['layer', 'min_economic_value', 'thresholds', 'insufficient_policy', 'review_endpoint', 'next_review_endpoint']);
const TERMS_REQUIRED = Object.freeze(['layer', 'min_economic_value', 'thresholds', 'insufficient_policy', 'review_endpoint']);
const STAR_FIELDS = Object.freeze(['min_economic_value', 'thresholds', 'insufficient_policy']);
const TEST_KEYS = Object.freeze(['id', 'kind', 'metric', 'op', 'threshold', 'multiplier']);
const OPS = Object.freeze(['>', '>=']);
const LINE = VERIFIER.robustness.declarationLine;
const TERMS_BODY_LINE = 'PROMOTION_TERMS_BODY_SHA256';
const INVALID = 'PREREG_ROBUSTNESS_DECLARATION_INVALID';

const declarationSha256 = (draft) => sha256(canonicalJson(draft.robustness_declaration));
const bodySha256 = (draft) => sha256(canonicalJson(draft.promotion_terms));

/** The PROMOTION_TERMS_V1 object of a draft, bound to a K2 sha and a freeze time. */
function assemble(draft, { k2Sha256, frozenAt }) {
  const t = draft.promotion_terms;
  return { schema: 'PROMOTION_TERMS_V1', candidate_id: draft.desk_items.candidate_ref, market: draft.market, layer: t.layer, k2_sha256: k2Sha256, k2_frozen_at: frozenAt, terms_frozen_at: frozenAt,
    mechanism_ids: [...draft.section0.mechanism_ids], min_sample_n: draft.power.n_required, min_economic_value: t.min_economic_value, thresholds: t.thresholds,
    insufficient_policy: t.insufficient_policy, review_endpoint: t.review_endpoint, ...(t.next_review_endpoint ? { next_review_endpoint: t.next_review_endpoint } : {}) };
}

/** Reason codes of the frozen terms (engine validator) and, for an AI-authored draft, of the registered-values rule. */
function validateTerms(draft, ctx, { k2Sha256, frozenAt }) {
  const terms = assemble(draft, { k2Sha256, frozenAt });
  const codes = [...engineTerms.validate(terms, { asOf: frozenAt })];
  if (draft.authored_by.kind === 'AI_PREREG_AGENT') {
    const star = ctx.promotionTermsStar;
    const layer = isObj(star) && isObj(star.by_layer) ? star.by_layer[terms.layer] : null;
    if (!isObj(star) || !isObj(layer)) codes.push('PREREG_TERMS_VALUES_NOT_REGISTERED:star_missing');
    else {
      const want = { min_economic_value: layer.min_economic_value, thresholds: layer.thresholds, insufficient_policy: star.insufficient_policy };
      for (const f of STAR_FIELDS) if (canonicalJson(terms[f]) !== canonicalJson(want[f])) codes.push(`PREREG_TERMS_VALUES_NOT_REGISTERED:${f}`);
    }
  }
  return [...new Set(codes)];
}

/** Reason codes of the robustness declaration against the verifier's own configuration (what V-5 will demand again at run time). */
function validateDeclaration(decl) {
  const cfg = VERIFIER.robustness;
  const tests = isObj(decl) && Array.isArray(decl.tests) ? decl.tests : [];
  const codes = [];
  const seen = new Set();
  for (const t of tests) {
    if (seen.has(t.id)) codes.push(`${INVALID}:DUPLICATE_TEST_ID:${t.id}`);
    seen.add(t.id);
    if (!OPS.includes(t.op)) codes.push(`${INVALID}:OP:${t.id}`);
    if (typeof t.threshold !== 'number' || !Number.isFinite(t.threshold)) codes.push(`${INVALID}:THRESHOLD:${t.id}`);
    if ('multiplier' in t && !(typeof t.multiplier === 'number' && Number.isFinite(t.multiplier) && t.multiplier > 0)) codes.push(`${INVALID}:MULTIPLIER:${t.id}`);
  }
  for (const kind of cfg.requiredKinds) if (!tests.some((t) => t.kind === kind)) codes.push(`${INVALID}:${kind}_NOT_DECLARED`);
  if (!tests.some((t) => t.kind === 'COST_MULTIPLIER' && typeof t.multiplier === 'number' && t.multiplier >= cfg.minCostMultiplier)) codes.push(`${INVALID}:COST_X2_NOT_DECLARED`);
  return [...new Set(codes)];
}

/** The terms file: bytes, sha256 and name (named by draft id and the first eight hex of its own sha). */
function file(draft, { k2Sha256, frozenAt }) {
  const terms = assemble(draft, { k2Sha256, frozenAt });
  const bytes = prettyJson(terms);
  const hash = sha256(bytes);
  return { terms, bytes, sha256: hash, name: `${draft.draft_id}_K2_V1.promotion_terms.${hash.slice(0, 8)}.json` };
}

/** K2 text sections 6 and 7. Only numbers, enums and label-safe strings reach here (schema V1 checks every leaf), so the text cannot forge a token. */
function renderSections(draft) {
  const out = [];
  out.push('## 6 鲁棒性声明（独立验证器 V-5 读取）', '');
  for (const t of draft.robustness_declaration.tests) out.push(`- 测试 ${t.id}：类别 ${t.kind}；指标 ${t.metric}；比较 ${t.op} ${t.threshold}${'multiplier' in t ? `；倍数 ${t.multiplier}` : ''}`);
  out.push('', `${LINE}: ${declarationSha256(draft)}`, '');
  out.push('## 7 晋级条款（PROMOTION_TERMS_V1 内容；条款文件与本文同一次冻结，文件 sha 见冻结页）', '');
  const t = draft.promotion_terms;
  out.push(`- 层：${t.layer}`, `- 最小经济价值：${canonicalJson(t.min_economic_value)}`, `- 阈值：${canonicalJson(t.thresholds)}`, `- 证据不足处理：${canonicalJson(t.insufficient_policy)}`,
    `- 复核终点：${canonicalJson(t.review_endpoint)}`, ...(t.next_review_endpoint ? [`- 下一复核终点：${canonicalJson(t.next_review_endpoint)}`] : []),
    `- 最小样本量：${draft.power.n_required}（取功效工具输出）`, '', `${TERMS_BODY_LINE}: ${bodySha256(draft)}`, '');
  return out;
}

module.exports = { TERMS_KEYS, TERMS_REQUIRED, TEST_KEYS, OPS, LINE, declarationSha256, bodySha256, assemble, validateTerms, validateDeclaration, file, renderSections };
