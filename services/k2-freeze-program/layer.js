'use strict';

/** W10 research-layer checks. All classifications come from registered data, never from prose in the draft. */
const mech = require('../research-mechanism-register');
const proposed = require('./proposed');
const { isObj } = require('./common');

const MARKET_STATE = new Set(['MACRO_CYCLE', 'MARKET_SENTIMENT', 'MARKET_STRUCTURE']);
const OPENS_OR_DIRECTS = new Set(['MAINLINE', 'VOLUME_PRICE', 'TECHNICAL', 'FUNDAMENTAL']);
const NON_PROMOTABLE = new Set(['DIAGNOSTIC_BASELINE', 'DIAGNOSTIC', 'NA_ENGINEERING', 'NA_EXECUTION']);
const PROMOTION_PAIR = Object.freeze({ SELECTION_TIMING: 'ALPHA', RISK: 'RISK' });

function readingsOf(reg) {
  const value = isObj(reg) ? reg.readings : null;
  if (Array.isArray(value)) return new Map(value.map((id) => [id, null]));
  if (isObj(value)) return new Map(Object.entries(value));
  return new Map();
}

function componentsOf(draft) {
  return draft.arms.flatMap((arm) => (isObj(arm.rule_config) && Array.isArray(arm.rule_config.components) ? arm.rule_config.components : [])).filter(isObj);
}

function mechanismLayers(draft, registerBytes) {
  const register = mech.parse(registerBytes);
  const byId = new Map(register.mechanisms.map((item) => [item.mechanism_id, item.layer]));
  return draft.section0.mechanism_ids.map((id) => ({ id, layer: byId.get(id) || mech.PREFIX_LAYER[String(id).split('.')[0]] || null }));
}

/** @returns {string[]} exact refusal codes; empty means the layer boundary is respected. */
function validate(draft, ctx) {
  if (draft.schema !== proposed.DRAFT_SCHEMA) return []; // RF1118 transition: v1 stays byte-for-byte compatible
  const layer = draft.layer;

  const mechanisms = mechanismLayers(draft, ctx.registerBytes);
  const distinct = [...new Set(mechanisms.map((item) => item.layer).filter(Boolean))].sort();
  if (distinct.length > 1) return [`PREREG_LAYER_MULTIPLE_MECHANISM_LAYERS:${distinct.join(',')}`];
  const mismatch = mechanisms.find((item) => item.layer && item.layer !== layer);
  if (mismatch) return [`PREREG_LAYER_MECHANISM_MISMATCH:${mismatch.id}:${mismatch.layer}!=${layer}`];

  const registry = readingsOf(ctx.registeredComponents || {});
  for (const component of componentsOf(draft).filter((item) => item.kind === 'READING')) {
    const record = registry.get(component.id);
    const className = isObj(record) ? record.class : null;
    if (typeof className !== 'string' || !proposed.READING_CLASSES.includes(className)) return [`PREREG_LAYER_READING_CLASS_MISSING:${component.id}`];
    const forbidden = (layer === 'SELECTION_TIMING' && (MARKET_STATE.has(className) || className === 'FUNDAMENTAL'))
      || (layer === 'RISK' && OPENS_OR_DIRECTS.has(className))
      || (layer === 'ACCOUNT' && MARKET_STATE.has(className));
    if (forbidden) return [`PREREG_LAYER_READING_CLASS_FORBIDDEN:${layer}:${className}:${component.id}`];
  }

  if (layer === 'ACCOUNT') return ['PREREG_LAYER_ACCOUNT_NOT_SUPPORTED'];
  if (draft.promotion_terms !== undefined) {
    if (NON_PROMOTABLE.has(layer)) return [`PREREG_LAYER_PROMOTION_FORBIDDEN:${layer}`];
    const expected = PROMOTION_PAIR[layer];
    if (!expected || draft.promotion_terms.layer !== expected) return [`PREREG_LAYER_PROMOTION_PAIR_UNSETTLED:${layer}:${String(draft.promotion_terms.layer)}`];
  }
  return [];
}

module.exports = { MARKET_STATE, OPENS_OR_DIRECTS, NON_PROMOTABLE, PROMOTION_PAIR, readingsOf, mechanismLayers, validate };
