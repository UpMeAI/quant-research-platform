'use strict';
/** RF1116 post-round mechanism-note pack and output validators. Pure: no file, clock, model or network access. */
const { isObj, sha256, SECRET_SHAPED } = require('./canon');
const { estimateTokens, numericTokens } = require('./facts');
const lexicon = require('./lexicon');

const PACK_KEYS = ['batch_no', 'batch_of', 'candidates', 'glossary', 'market', 'mechanisms', 'pins', 'round_id', 'schema'];
const PIN_KEYS = ['code_commit', 'register_sha256', 'selection_record_hash', 'space_sha256'];
const CANDIDATE_KEYS = ['candidate_id', 'fields', 'formula'];
const MECHANISM_KEYS = ['description_zh', 'mechanism_id', 'title_zh'];
const OUTPUT_KEYS = ['batch_no', 'notes', 'round_id'];
const NOTE_KEYS = ['candidate_id', 'economic_logic_zh', 'failure_mode_zh', 'fields_cited', 'mechanism_id', 'no_mechanism_code', 'outcome', 'proposal'];
const PROPOSAL_KEYS = ['description_zh', 'title_zh'];
const OUTCOMES = ['NOTE', 'NO_MECHANISM', 'NEW_MECHANISM_PROPOSAL'];
const NO_MECHANISM_CODES = ['DEGENERATE', 'MIXED_UNITS', 'NEAR_ZERO_DENOMINATOR', 'MECHANICAL_ONLY', 'NONE_FITS'];
const SHA64 = /^[0-9a-f]{64}$/;
const MAX_PACK_TOKENS = 12000;
const SIZE_WORDING = /小市值|市值效应|规模效应|small[- ]?cap|size (effect|premium)/i;
const MINING_OUT = /(^|\/)rf1116-mining\/out(\/|$)/i;
const FORBIDDEN_KEY = /score|ic|fold|holdout|gate|sr|return|pnl/i;
const FORBIDDEN_KEY_EXCEPTIONS = new Set(['economic_logic_zh']);
const sameKeys = (o, keys) => isObj(o) && Object.keys(o).sort().join() === keys.join();
const strings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

function scanFirewall(v, path = '') {
  if (Array.isArray(v)) return v.flatMap((x, i) => scanFirewall(x, `${path}[${i}]`));
  if (!isObj(v)) return typeof v === 'string' && MINING_OUT.test(v) ? [path] : [];
  const hits = [];
  for (const [k, x] of Object.entries(v)) {
    if (FORBIDDEN_KEY.test(k) && !FORBIDDEN_KEY_EXCEPTIONS.has(k)) hits.push(path ? `${path}.${k}` : k);
    hits.push(...scanFirewall(x, path ? `${path}.${k}` : k));
  }
  return hits;
}

function checkNotePack(pack) {
  const errors = [];
  const add = (code, path, detail) => errors.push({ code, path, detail });
  const hits = scanFirewall(pack);
  if (hits.length) add('MECH_PACK_FIREWALL', hits[0]);
  if (SECRET_SHAPED.test(JSON.stringify(pack))) add('MECH_PACK_FIREWALL', 'secret-shaped');
  if (estimateTokens(pack) > MAX_PACK_TOKENS) add('MECH_PACK_TOO_LARGE', null, estimateTokens(pack));
  if (!sameKeys(pack, PACK_KEYS) || pack.schema !== 'RF1116_MECH_NOTE_PACK_V1' || pack.market !== 'CN_A'
    || typeof pack.round_id !== 'string' || !Number.isInteger(pack.batch_no) || !Number.isInteger(pack.batch_of)
    || pack.batch_no < 1 || pack.batch_of < pack.batch_no || !sameKeys(pack.pins, PIN_KEYS)
    || !Object.values(pack.pins || {}).every((x) => typeof x === 'string' && SHA64.test(x))) add('MECH_PACK_SCHEMA');
  if (!Array.isArray(pack && pack.candidates) || pack.candidates.length < 1 || pack.candidates.length > 6
    || pack.candidates.some((c) => !sameKeys(c, CANDIDATE_KEYS) || typeof c.candidate_id !== 'string' || typeof c.formula !== 'string' || !strings(c.fields) || c.fields.length === 0)) add('MECH_PACK_SCHEMA', 'candidates');
  if (!Array.isArray(pack && pack.mechanisms) || pack.mechanisms.some((m) => !sameKeys(m, MECHANISM_KEYS) || !Object.values(m).every((x) => typeof x === 'string'))) add('MECH_PACK_SCHEMA', 'mechanisms');
  if (!Array.isArray(pack && pack.glossary)) add('MECH_PACK_SCHEMA', 'glossary');
  return { ok: errors.length === 0, errors };
}

/** Parse the complete pinned register from authoritative raw bytes without exposing it to the model input. */
function checkMechanismRegister(registerBytes, expectedSha256) {
  const fail = (code) => ({ ok: false, errors: [{ code }], registeredText: null });
  if (!(Buffer.isBuffer(registerBytes) || typeof registerBytes === 'string')) return fail('MECH_REGISTER_UNAVAILABLE');
  const bytes = Buffer.isBuffer(registerBytes) ? registerBytes : Buffer.from(registerBytes, 'utf8');
  if (sha256(bytes) !== expectedSha256) return fail('MECH_REGISTER_SHA_MISMATCH');
  let register;
  try { register = JSON.parse(bytes.toString('utf8')); } catch (e) { return fail('MECH_REGISTER_INVALID'); }
  if (!isObj(register) || register.contract !== 'QRP_RESEARCH_MECHANISM_REGISTER_V1' || !Array.isArray(register.mechanisms)
    || register.mechanisms.some((m) => !isObj(m) || typeof m.title_zh !== 'string' || typeof m.description_zh !== 'string')) return fail('MECH_REGISTER_INVALID');
  return { ok: true, errors: [], registeredText: new Set(register.mechanisms.flatMap((m) => [m.title_zh, m.description_zh])) };
}

function validateNoteOutput(raw, pack, authority) {
  const errors = [];
  const add = (code, path, detail) => errors.push({ code, path, detail });
  let out = raw;
  if (typeof raw === 'string') { try { out = JSON.parse(raw); } catch (e) { out = null; } }
  if (!sameKeys(out, OUTPUT_KEYS) || out.round_id !== pack.round_id || out.batch_no !== pack.batch_no || !Array.isArray(out.notes)) {
    add('MECH_NOTE_SCHEMA'); return { ok: false, errors, output: null };
  }
  if (SECRET_SHAPED.test(JSON.stringify(out))) add('MECH_NOTE_SECRET_SHAPED');
  const candidates = new Map((pack.candidates || []).map((c) => [c.candidate_id, c]));
  const got = out.notes.map((n) => n && n.candidate_id);
  if (got.length !== candidates.size || new Set(got).size !== got.length || got.some((id) => !candidates.has(id)) || [...candidates.keys()].some((id) => !got.includes(id))) add('MECH_NOTE_CANDIDATE_SET');
  const mechanismIds = new Set((pack.mechanisms || []).map((m) => m.mechanism_id));
  const registeredText = authority && authority.registeredText instanceof Set ? authority.registeredText : null;
  if (!registeredText) add('MECH_REGISTER_UNAVAILABLE');
  out.notes.forEach((n, i) => {
    const p = `notes[${i}]`;
    if (!sameKeys(n, NOTE_KEYS) || !OUTCOMES.includes(n.outcome)) { add('MECH_NOTE_SCHEMA', p); return; }
    const c = candidates.get(n.candidate_id);
    if (!c) return;
    if (n.outcome === 'NOTE') {
      if (!mechanismIds.has(n.mechanism_id)) add('MECH_NOTE_MECHANISM_NOT_IN_PACK', p);
      if (typeof n.economic_logic_zh !== 'string' || n.economic_logic_zh.length < 20 || n.economic_logic_zh.length > 160
        || typeof n.failure_mode_zh !== 'string' || n.failure_mode_zh.length < 10 || n.failure_mode_zh.length > 100) add('MECH_NOTE_LENGTH', p);
      if (!strings(n.fields_cited) || n.fields_cited.length === 0 || new Set(n.fields_cited).size !== n.fields_cited.length || n.fields_cited.some((f) => !c.fields.includes(f))) add('MECH_NOTE_FIELDS_NOT_IN_FORMULA', p);
      if (n.no_mechanism_code !== null || n.proposal !== null) add('MECH_NOTE_SCHEMA', p);
    } else if (n.outcome === 'NO_MECHANISM') {
      if (n.mechanism_id !== null || n.economic_logic_zh !== null || n.failure_mode_zh !== null || !Array.isArray(n.fields_cited) || n.fields_cited.length || !NO_MECHANISM_CODES.includes(n.no_mechanism_code) || n.proposal !== null) add('MECH_NOTE_SCHEMA', p);
    } else {
      if (n.mechanism_id !== null || n.economic_logic_zh !== null || n.failure_mode_zh !== null || !Array.isArray(n.fields_cited) || n.fields_cited.length || n.no_mechanism_code !== null
        || !sameKeys(n.proposal, PROPOSAL_KEYS) || typeof n.proposal.title_zh !== 'string' || n.proposal.title_zh.length < 1 || n.proposal.title_zh.length > 30
        || typeof n.proposal.description_zh !== 'string' || n.proposal.description_zh.length < 1 || n.proposal.description_zh.length > 120) add('MECH_NOTE_SCHEMA', p);
      if (isObj(n.proposal) && registeredText && (registeredText.has(n.proposal.title_zh) || registeredText.has(n.proposal.description_zh))) add('MECH_NOTE_PROPOSAL_DUPLICATES_REGISTERED', p);
    }
    const texts = [n.economic_logic_zh, n.failure_mode_zh, n.proposal && n.proposal.title_zh, n.proposal && n.proposal.description_zh].filter((x) => typeof x === 'string');
    if (texts.some((t) => lexicon.findWording(t, ['PREDICTION', 'VERDICT', 'DIRECTION']).length)) add('MECH_NOTE_WORDING', p);
    if (texts.some((t) => SIZE_WORDING.test(t))) add('MECH_NOTE_SIZE_AS_MECHANISM', p);
    const formulaNumbers = new Set(numericTokens(c.formula));
    if (texts.flatMap(numericTokens).some((x) => !formulaNumbers.has(x))) add('MECH_NOTE_NUMBER_NOT_IN_PACK', p);
  });
  const unique = errors.filter((e, i, a) => a.findIndex((x) => `${x.code}|${x.path}|${x.detail}` === `${e.code}|${e.path}|${e.detail}`) === i);
  return { ok: unique.length === 0, errors: unique, output: unique.length === 0 ? out : null };
}

module.exports = { MAX_PACK_TOKENS, checkNotePack, checkMechanismRegister, validateNoteOutput };
