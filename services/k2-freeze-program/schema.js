'use strict';

/**
 * K2_DRAFT_V1 structure check (validator V1). Pure function of the draft. Required sections, types, enums, no unknown keys, no free text that could
 * forge a token the downstream gates read (backticks, TRL ids, DATA:/CF:/G-CAUSAL markers, section-0 labels). The inside of decision_table (V2) and
 * rule_config (V7) is left to their validators so that each counter-example is caught by exactly one validator.
 */
const trials = require('../trial-ledger');
const { isObj, SHA64 } = require('./common');

const MARKETS = Object.freeze(['CN_A', 'US_EQUITY', 'CRYPTO']);
const ROLES = Object.freeze(['VERDICT_ARM', 'BASELINE', 'REPORT_ONLY_VARIANT', 'DIAGNOSTIC_ARM']);
const HOSTS = Object.freeze(['LINUX', 'HK']);
const AUTHOR_KINDS = Object.freeze(['AI_PREREG_AGENT', 'HUMAN_SESSION']);
const LIVE_CLASSES = Object.freeze(['NONE', 'NEEDS_SIGNATURE']);
/** REVIEW_LOOP_ACCEPTANCE_V1 section 5.7 (desk, 05cabd2d): the eight items a research draft must state (item 1 is two keys). */
const DESK_ITEMS = Object.freeze(['candidate_ref', 'rule_ref', 'change_and_window_zh', 'decision_criteria_zh', 'data_limits_zh', 'round2_plan_zh', 'lease_ref', 'measurement_plan_zh', 'paper_stop_zh']);
const TOP = Object.freeze(['schema', 'draft_id', 'market', 'family_id', 'study_ref', 'title_zh', 'revision', 'authored_by', 'section0', 'data_inputs', 'causality', 'desk_items', 'arms', 'comparison', 'sample',
  'decision_table', 'power', 'scope', 'deviation_codes']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL = /^[A-Za-z0-9_.-]{1,40}$/;
const FORBIDDEN_TEXT = /[`\r\n]|\*\*|TRL-|DATA:|CF:|G-CAUSAL|DEVIATION_ACCEPTED|K2_PROGRAM_FROZEN|FREEZE_PROGRAM/;
const FORBIDDEN_TOKEN = /[|`\r\n*]/;

const keysOf = (obj, allowed, at, codes) => { for (const k of Object.keys(obj)) if (!allowed.includes(k)) codes.push(`PREREG_SCHEMA_EXTRA_KEY:${at}.${k}`); };

/** @returns {string[]} reason codes (empty = pass). */
function validate(draft) {
  const codes = [];
  const miss = (at) => codes.push(`PREREG_SCHEMA_MISSING:${at}`);
  const type = (at) => codes.push(`PREREG_SCHEMA_TYPE:${at}`);
  const enumBad = (at) => codes.push(`PREREG_SCHEMA_ENUM:${at}`);
  const text = (v, at) => { if (typeof v !== 'string' || !v.trim()) { type(at); return; } if (FORBIDDEN_TEXT.test(v)) codes.push(`PREREG_SCHEMA_TEXT_FORBIDDEN:${at}`); };
  const token = (v, at) => { if (typeof v !== 'string' || !v.trim()) { type(at); return; } if (FORBIDDEN_TOKEN.test(v)) codes.push(`PREREG_SCHEMA_TEXT_FORBIDDEN:${at}`); };
  const sha64 = (v, at) => { if (typeof v !== 'string' || !SHA64.test(v)) type(at); };
  const date = (v, at) => { if (typeof v !== 'string' || !DATE.test(v)) type(at); };

  if (!isObj(draft)) return ['PREREG_SCHEMA_TYPE:draft'];
  keysOf(draft, TOP, '', codes);
  for (const k of TOP) if (!(k in draft)) miss(k);
  if ('schema' in draft && draft.schema !== 'K2_DRAFT_V1') type('schema');
  for (const k of ['draft_id', 'family_id', 'study_ref']) if (k in draft) token(draft[k], k);
  if ('title_zh' in draft) text(draft.title_zh, 'title_zh');
  if ('market' in draft && !MARKETS.includes(draft.market)) enumBad('market');
  if ('revision' in draft && !(Number.isInteger(draft.revision) && draft.revision >= 0)) type('revision');

  if ('authored_by' in draft) {
    const a = draft.authored_by;
    if (!isObj(a)) type('authored_by');
    else if (!AUTHOR_KINDS.includes(a.kind)) enumBad('authored_by.kind');
    else if (a.kind === 'AI_PREREG_AGENT') {
      keysOf(a, ['kind', 'model', 'prompt_sha256', 'schema_sha256', 'host', 'quality_gate_record_id'], 'authored_by', codes);
      token(a.model, 'authored_by.model');
      sha64(a.prompt_sha256, 'authored_by.prompt_sha256');
      sha64(a.schema_sha256, 'authored_by.schema_sha256');
      if (!HOSTS.includes(a.host)) enumBad('authored_by.host');
      if ('quality_gate_record_id' in a) token(a.quality_gate_record_id, 'authored_by.quality_gate_record_id');
    } else {
      keysOf(a, ['kind', 'session_ref'], 'authored_by', codes);
      token(a.session_ref, 'authored_by.session_ref');
    }
  }

  if ('section0' in draft) {
    const s = draft.section0;
    if (!isObj(s)) type('section0');
    else {
      keysOf(s, ['mechanism_ids', 'mechanism_text_zh', 'failure_mode_zh', 'explained_by_zh', 'ai_inputs'], 'section0', codes);
      for (const k of ['mechanism_ids', 'mechanism_text_zh', 'failure_mode_zh', 'explained_by_zh', 'ai_inputs']) if (!(k in s)) miss(`section0.${k}`);
      if ('mechanism_ids' in s) { if (!Array.isArray(s.mechanism_ids) || !s.mechanism_ids.length) type('section0.mechanism_ids'); else s.mechanism_ids.forEach((id, i) => token(id, `section0.mechanism_ids[${i}]`)); }
      for (const k of ['mechanism_text_zh', 'failure_mode_zh', 'explained_by_zh']) if (k in s) text(s[k], `section0.${k}`);
      if ('ai_inputs' in s) {
        if (!Array.isArray(s.ai_inputs)) type('section0.ai_inputs');
        else {
          s.ai_inputs.forEach((it, i) => {
            const at = `section0.ai_inputs[${i}]`;
            if (!isObj(it)) { type(at); return; }
            keysOf(it, ['category', 'ref', 'desc_zh', 'candidate_id', 'round_id', 'ai_logic_pin', 'production_archive'], at, codes);
            token(it.category, `${at}.category`); token(it.ref, `${at}.ref`); text(it.desc_zh, `${at}.desc_zh`);
            for (const k of ['candidate_id', 'round_id']) if (k in it) token(it[k], `${at}.${k}`);
          });
        }
      }
    }
  }

  if ('data_inputs' in draft) {
    if (!Array.isArray(draft.data_inputs) || !draft.data_inputs.length) type('data_inputs');
    else {
      draft.data_inputs.forEach((d, i) => {
        const at = `data_inputs[${i}]`;
        if (!isObj(d)) { type(at); return; }
        keysOf(d, ['dataset_id', 'series', 'registry_version', 'registry_sha256', 'pit', 'vendor', 'basis', 'hist', 'range', 'segment_label'], at, codes);
        for (const k of ['dataset_id', 'registry_version', 'pit', 'vendor', 'range', 'segment_label']) if (!(k in d)) miss(`${at}.${k}`);
        for (const k of ['dataset_id', 'series', 'registry_version', 'pit', 'vendor', 'basis', 'hist']) if (k in d) token(d[k], `${at}.${k}`);
        if ('registry_sha256' in d) sha64(d.registry_sha256, `${at}.registry_sha256`); else miss(`${at}.registry_sha256`);
        if ('segment_label' in d && !['SEEN', 'UNSEEN'].includes(d.segment_label)) enumBad(`${at}.segment_label`);
        if ('range' in d) { if (!isObj(d.range)) type(`${at}.range`); else { keysOf(d.range, ['from', 'to'], `${at}.range`, codes); date(d.range.from, `${at}.range.from`); date(d.range.to, `${at}.range.to`); } }
      });
    }
  }

  if ('causality' in draft) {
    const c = draft.causality;
    if (!isObj(c)) type('causality');
    else {
      keysOf(c, ['functions', 'evidence_sha256', 'not_applicable_code'], 'causality', codes);
      if ('functions' in c) { if (!Array.isArray(c.functions) || !c.functions.length) type('causality.functions'); else c.functions.forEach((f, i) => token(f, `causality.functions[${i}]`)); }
      if ('evidence_sha256' in c) sha64(c.evidence_sha256, 'causality.evidence_sha256');
      if ('not_applicable_code' in c) token(c.not_applicable_code, 'causality.not_applicable_code');
    }
  }

  if ('desk_items' in draft) {
    const d = draft.desk_items;
    if (!isObj(d)) type('desk_items');
    else {
      keysOf(d, DESK_ITEMS, 'desk_items', codes);
      for (const k of DESK_ITEMS) {
        if (typeof d[k] !== 'string' || !d[k].trim()) codes.push(`PREREG_SCHEMA_DESK_ITEM_MISSING:${k}`);
        else if (k.endsWith('_zh')) text(d[k], `desk_items.${k}`);
        else token(d[k], `desk_items.${k}`);
      }
    }
  }

  let labels = [];
  if ('arms' in draft) {
    if (!Array.isArray(draft.arms) || !draft.arms.length) type('arms');
    else {
      draft.arms.forEach((a, i) => {
        const at = `arms[${i}]`;
        if (!isObj(a)) { type(at); return; }
        keysOf(a, ['config_label', 'role', 'stage', 'rule_config'], at, codes);
        for (const k of ['config_label', 'role', 'stage', 'rule_config']) if (!(k in a)) miss(`${at}.${k}`);
        if ('config_label' in a && !(typeof a.config_label === 'string' && LABEL.test(a.config_label))) type(`${at}.config_label`);
        if ('role' in a && !ROLES.includes(a.role)) enumBad(`${at}.role`);
        if ('stage' in a && !trials.STAGES.includes(a.stage)) enumBad(`${at}.stage`);
        if ('rule_config' in a && !isObj(a.rule_config)) type(`${at}.rule_config`);
      });
      labels = draft.arms.map((a) => a && a.config_label).filter((x) => typeof x === 'string');
      if (new Set(labels).size !== labels.length) codes.push('PREREG_SCHEMA_DUPLICATE:arms.config_label');
    }
  }

  if ('comparison' in draft) {
    const c = draft.comparison;
    if (!isObj(c)) type('comparison');
    else {
      keysOf(c, ['kind', 'baseline_label'], 'comparison', codes);
      if (c.kind !== 'BASELINE_ARM') enumBad('comparison.kind');
      if (!labels.includes(c.baseline_label)) codes.push('PREREG_SCHEMA_REFERENCE:comparison.baseline_label');
    }
  }

  if ('sample' in draft) {
    const s = draft.sample;
    if (!isObj(s)) type('sample');
    else {
      keysOf(s, ['from', 'to', 'n_obs_planned'], 'sample', codes);
      date(s.from, 'sample.from'); date(s.to, 'sample.to');
      if (typeof s.from === 'string' && typeof s.to === 'string' && DATE.test(s.from) && DATE.test(s.to) && s.from > s.to) type('sample.range');
      if (!(Number.isInteger(s.n_obs_planned) && s.n_obs_planned > 0)) type('sample.n_obs_planned');
    }
  }

  if ('decision_table' in draft && !isObj(draft.decision_table)) type('decision_table');

  if ('power' in draft) {
    const p = draft.power;
    if (!isObj(p)) type('power');
    else {
      keysOf(p, ['effect_size_sd', 'alpha', 'power_target', 'n_required'], 'power', codes);
      for (const k of ['effect_size_sd', 'alpha', 'power_target', 'n_required']) { if (!(k in p)) miss(`power.${k}`); else if (typeof p[k] !== 'number') type(`power.${k}`); }
    }
  }

  if ('scope' in draft) {
    const s = draft.scope;
    if (!isObj(s)) type('scope');
    else {
      keysOf(s, ['live_class', 'research_only', 'new_data_fetch', 'unseal', 'production_config_touch'], 'scope', codes);
      if (!LIVE_CLASSES.includes(s.live_class)) enumBad('scope.live_class');
      for (const k of ['research_only', 'new_data_fetch', 'unseal', 'production_config_touch']) if (typeof s[k] !== 'boolean') type(`scope.${k}`);
    }
  }

  if ('deviation_codes' in draft) {
    if (!Array.isArray(draft.deviation_codes)) type('deviation_codes');
    else if (draft.deviation_codes.length) codes.push('PREREG_SCHEMA_DEVIATION_NOT_ALLOWED');
  }
  return codes;
}

module.exports = { MARKETS, ROLES, HOSTS, AUTHOR_KINDS, DESK_ITEMS, TOP, validate };
