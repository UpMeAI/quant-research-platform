'use strict';
/** RF1116 mechanism-review pack and closed-output validator. */
const { isObj, SECRET_SHAPED } = require('./canon');
const { estimateTokens, numericTokens } = require('./facts');
const lexicon = require('./lexicon');

const PACK_KEYS = ['batch_no', 'batch_of', 'candidates', 'glossary', 'market', 'pins', 'round_id', 'schema'];
const PIN_KEYS = ['code_commit', 'mechanism_set_sha256', 'register_sha256', 'selection_record_hash', 'space_sha256'];
const CANDIDATE_KEYS = ['candidate_id', 'economic_logic_zh', 'failure_mode_zh', 'fields', 'formula', 'mechanism_description_zh', 'mechanism_id', 'registration_hash'];
const OUTPUT_KEYS = ['batch_no', 'items', 'round_id'];
const ITEM_KEYS = ['candidate_id', 'code', 'note_zh', 'status'];
const HOLD_CODES = ['HOLD_LOGIC_FORMULA_MISMATCH', 'HOLD_MECHANISM_MISMATCH', 'HOLD_FAILURE_MODE_EMPTY', 'HOLD_PREDICTIVE_CLAIM'];
const SHA64 = /^[0-9a-f]{64}$/;
const MAX_PACK_TOKENS = 12000;
const MINING_OUT = /(^|\/)rf1116-mining\/out(\/|$)/i;
const FORBIDDEN_KEY = /score|ic|fold|holdout|gate|sr|return|pnl/i;
const EXCEPTIONS = new Set(['economic_logic_zh']);
const sameKeys = (o, keys) => isObj(o) && Object.keys(o).sort().join() === keys.join();
const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
function firewall(v) {
  if (Array.isArray(v)) return v.some(firewall);
  if (!isObj(v)) return typeof v === 'string' && MINING_OUT.test(v);
  return Object.entries(v).some(([k, x]) => (FORBIDDEN_KEY.test(k) && !EXCEPTIONS.has(k)) || firewall(x));
}

function checkReviewPack(pack) {
  const errors = []; const add = (code, path, detail) => errors.push({ code, path, detail });
  if (firewall(pack) || SECRET_SHAPED.test(JSON.stringify(pack))) add('MECH_PACK_FIREWALL');
  if (estimateTokens(pack) > MAX_PACK_TOKENS) add('MECH_PACK_TOO_LARGE', null, estimateTokens(pack));
  if (!sameKeys(pack, PACK_KEYS) || pack.schema !== 'RF1116_MECH_REVIEW_PACK_V1' || pack.market !== 'CN_A' || typeof pack.round_id !== 'string'
    || !Number.isInteger(pack.batch_no) || !Number.isInteger(pack.batch_of) || pack.batch_no < 1 || pack.batch_of < pack.batch_no || !sameKeys(pack.pins, PIN_KEYS)
    || !Object.values(pack.pins || {}).every((x) => typeof x === 'string' && SHA64.test(x))) add('MECH_PACK_SCHEMA');
  if (!Array.isArray(pack && pack.candidates) || pack.candidates.length < 1 || pack.candidates.length > 6 || pack.candidates.some((c) => !sameKeys(c, CANDIDATE_KEYS)
    || typeof c.candidate_id !== 'string' || typeof c.formula !== 'string' || !strings(c.fields) || c.fields.length === 0 || typeof c.mechanism_id !== 'string'
    || typeof c.mechanism_description_zh !== 'string' || typeof c.economic_logic_zh !== 'string' || typeof c.failure_mode_zh !== 'string' || !SHA64.test(c.registration_hash || ''))) add('MECH_PACK_SCHEMA', 'candidates');
  if (!Array.isArray(pack && pack.glossary)) add('MECH_PACK_SCHEMA', 'glossary');
  return { ok: errors.length === 0, errors };
}

function validateReviewOutput(raw, pack) {
  const errors = []; const add = (code, path, detail) => errors.push({ code, path, detail });
  let out = raw; if (typeof raw === 'string') { try { out = JSON.parse(raw); } catch (e) { out = null; } }
  if (!sameKeys(out, OUTPUT_KEYS) || out.round_id !== pack.round_id || out.batch_no !== pack.batch_no || !Array.isArray(out.items)) {
    add('MECH_REVIEW_SCHEMA'); return { ok: false, errors, output: null };
  }
  if (SECRET_SHAPED.test(JSON.stringify(out))) add('MECH_REVIEW_SECRET_SHAPED');
  const candidates = new Map((pack.candidates || []).map((c) => [c.candidate_id, c]));
  const got = out.items.map((x) => x && x.candidate_id);
  if (got.length !== candidates.size || new Set(got).size !== got.length || got.some((id) => !candidates.has(id)) || [...candidates.keys()].some((id) => !got.includes(id))) add('MECH_REVIEW_CANDIDATE_SET');
  out.items.forEach((it, i) => {
    const p = `items[${i}]`; const c = candidates.get(it && it.candidate_id);
    if (!sameKeys(it, ITEM_KEYS) || !['CONSISTENT', 'HOLD'].includes(it.status) || typeof it.note_zh !== 'string' || it.note_zh.length > 80
      || (it.status === 'CONSISTENT' ? it.code !== null : !HOLD_CODES.includes(it.code))) { add('MECH_REVIEW_SCHEMA', p); return; }
    if (!c) return;
    if (lexicon.findWording(it.note_zh, ['PREDICTION', 'VERDICT', 'DIRECTION']).length) add('MECH_REVIEW_WORDING', p);
    const allowed = new Set(numericTokens(c.formula));
    if (numericTokens(it.note_zh).some((x) => !allowed.has(x))) add('MECH_REVIEW_NUMBER_NOT_IN_PACK', p);
  });
  const unique = errors.filter((e, i, a) => a.findIndex((x) => `${x.code}|${x.path}|${x.detail}` === `${e.code}|${e.path}|${e.detail}`) === i);
  return { ok: unique.length === 0, errors: unique, output: unique.length === 0 ? out : null };
}

module.exports = { MAX_PACK_TOKENS, HOLD_CODES, checkReviewPack, validateReviewOutput };
