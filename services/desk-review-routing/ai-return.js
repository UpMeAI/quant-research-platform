'use strict';

/** Consume only completion-authority RQ_VALIDATED_RETURN_V1 bundles. */
const fs = require('fs');
const path = require('path');
const { canonicalJson, sha256, isObj, SHA64 } = require('../research-queue-agent/canon');
const { validateCard } = require('../research-queue-agent/card');
const { validateIdeaRecord } = require('../research-queue-agent/factor-idea');
const { buildRegistryView } = require('../research-queue-agent/registries');

const NAME = /^validated-return-([A-Za-z0-9._-]+)-a([1-9]\d*)\.json$/;
const VALIDATOR = Object.freeze({ name: 'rq-consumer-revalidate', version: 'Q3C_V1' });
const shaBytes = (bytes) => require('crypto').createHash('sha256').update(bytes).digest('hex');
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

function defaultRoot() {
  const ledger = process.env.QRP_DATA_DIR || path.join(__dirname, '..', '..', 'var', 'ledger');
  return path.join(path.dirname(path.resolve(ledger)), 'research-queue-return');
}

function readJson(file, code) {
  let raw; let value;
  try { raw = fs.readFileSync(file); value = JSON.parse(raw); } catch { fail(code); }
  if (!isObj(value)) fail(code);
  return { raw, value };
}

function bindingValue(binding, kind, registryFor) {
  if (!isObj(binding) || typeof binding.ref !== 'string' || !SHA64.test(binding.sha256 || '')) fail(`${kind}_BINDING_INVALID`);
  if (kind === 'REGISTRY' && binding.ref === 'in/bundle.json#/registry') {
    const value = registryFor();
    if (!isObj(value) || sha256(canonicalJson(value)) !== binding.sha256) fail('REGISTRY_SHA256_MISMATCH');
    return value;
  }
  const marker = binding.ref.indexOf('#/registry');
  const file = marker >= 0 ? binding.ref.slice(0, marker) : binding.ref;
  if (!path.isAbsolute(file)) fail(`${kind}_REF_INVALID`);
  const loaded = readJson(file, `${kind}_SOURCE_INVALID`);
  const value = marker >= 0 ? loaded.value.registry : loaded.value;
  if (!isObj(value)) fail(`${kind}_SOURCE_INVALID`);
  const actual = kind === 'FACT_PACK' ? shaBytes(loaded.raw) : sha256(canonicalJson(value));
  if (actual !== binding.sha256) fail(`${kind}_SHA256_MISMATCH`);
  return value;
}

function verify(doc, registryFor) {
  if (doc.schema !== 'RQ_VALIDATED_RETURN_V1' || doc.kind !== 'AI_REVIEW_CARD') fail('BUNDLE_SCHEMA_INVALID');
  if (!Number.isInteger(doc.attempt_no) || doc.attempt_no < 1 || typeof doc.task_id !== 'string') fail('BUNDLE_ID_INVALID');
  if (!isObj(doc.validator) || doc.validator.name !== VALIDATOR.name || doc.validator.version !== VALIDATOR.version) fail('VALIDATOR_UNKNOWN');
  const body = { ...doc }; delete body.bundle_sha256;
  if (!SHA64.test(doc.bundle_sha256 || '') || sha256(canonicalJson(body)) !== doc.bundle_sha256) fail('BUNDLE_SHA256_MISMATCH');
  if (!isObj(doc.card) || sha256(canonicalJson(doc.card)) !== doc.card_sha256) fail('CARD_SHA256_MISMATCH');
  if (!Array.isArray(doc.ideas) || sha256(canonicalJson(doc.ideas)) !== doc.ideas_sha256) fail('IDEAS_SHA256_MISMATCH');
  if (doc.card.task_id !== doc.task_id || doc.card.schema !== 'REVIEW_AI_CARD_V1' || doc.card.market !== doc.market) fail('CARD_BINDING_MISMATCH');
  const pack = bindingValue(doc.fact_pack, 'FACT_PACK', registryFor);
  const registry = bindingValue(doc.registry, 'REGISTRY', registryFor);
  const { schema: _s, task_id: _t, prompt_admission_sha256: _p, model: _m, ...cardBody } = doc.card;
  const ctx = { pack, registry, market: doc.market, week_id: doc.card.week_id, existing_idea_count: 0 };
  const cardResult = validateCard(cardBody, ctx);
  if (!cardResult.ok) fail(`CARD_INVALID:${cardResult.errors[0].code}`);
  for (const idea of doc.ideas) {
    const result = validateIdeaRecord(idea, ctx);
    if (!result.ok) fail(`IDEA_INVALID:${result.errors[0].code}`);
    if (idea.card_sha256 !== doc.card_sha256) fail('IDEA_CARD_SHA256_MISMATCH');
  }
  return { doc, pack, registry };
}

const item = (row) => ({ textZh: row.text_zh, factIds: row.fact_ids });
function projectCard(doc) {
  const c = doc.card;
  return {
    cardId: doc.task_id, market: c.market, weekId: c.week_id, cardSha256: doc.card_sha256,
    factPackSha256: doc.fact_pack.sha256, modelAlias: c.model,
    supporting: c.supporting.map(item), opposing: c.opposing.map(item), unknowns: c.unknowns.map(item),
    repeatedPatterns: c.repeated_patterns.map((r) => ({ patternKey: r.pattern_key, count: r.count, noteZh: r.note_zh, factIds: r.fact_ids })),
    questionProposals: c.question_proposals, noIdeaReason: c.no_idea_reason === null ? null : item(c.no_idea_reason),
    ideaIds: doc.ideas.map((idea) => idea.idea_id),
  };
}

function projectIdea(idea) {
  return {
    ideaId: idea.idea_id, market: idea.market, weekId: idea.week_id, mechanism: idea.mechanism,
    readings: idea.readings.map((r) => ({ id: r.id, pitAvailableAt: r.pit_available_at })),
    holdingPeriods: idea.holding_periods, questionZh: idea.question_zh, expectedFailureZh: idea.expected_failure_zh,
    factIds: idea.fact_ids, cardSha256: idea.card_sha256, recordHash: sha256(canonicalJson(idea)),
  };
}

function load({ root = defaultRoot(), registryFor = (market) => buildRegistryView({ market }) } = {}) {
  if (!fs.existsSync(root)) return { state: 'NO_VALIDATED_AI_CARDS_YET', cards: [], ideas: [], unverified: [], superseded: [] };
  const verified = []; const unverified = [];
  for (const host of fs.readdirSync(root).sort()) {
    const dir = path.join(root, host);
    let info; try { info = fs.lstatSync(dir); } catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const match = NAME.exec(name); if (!match) continue;
      const file = path.join(dir, name);
      try {
        const loaded = readJson(file, 'BUNDLE_JSON_INVALID');
        if (loaded.value.host.toLowerCase() !== host.toLowerCase() || loaded.value.task_id !== match[1] || loaded.value.attempt_no !== Number(match[2])) fail('BUNDLE_PATH_MISMATCH');
        verified.push(verify(loaded.value, () => registryFor(loaded.value.market)));
      } catch (error) { unverified.push({ host, file: name, state: 'UNVERIFIED', code: error.code || 'BUNDLE_READ_FAILED' }); }
    }
  }
  const heads = new Map(); const superseded = [];
  for (const row of verified) {
    const key = `${row.doc.host}\0${row.doc.task_id}`; const prior = heads.get(key);
    if (!prior || row.doc.attempt_no > prior.doc.attempt_no) { if (prior) superseded.push(prior.doc.bundle_sha256); heads.set(key, row); }
    else if (row.doc.attempt_no < prior.doc.attempt_no) superseded.push(row.doc.bundle_sha256);
    else if (row.doc.bundle_sha256 !== prior.doc.bundle_sha256) { heads.delete(key); unverified.push({ host: row.doc.host, taskId: row.doc.task_id, state: 'UNVERIFIED', code: 'CONFLICT' }); }
  }
  const selected = [...heads.values()].sort((a, b) => a.doc.task_id.localeCompare(b.doc.task_id));
  return {
    state: selected.length ? 'VERIFIED' : (unverified.length ? 'UNVERIFIED' : 'NO_VALIDATED_AI_CARDS_YET'),
    cards: selected.map((row) => projectCard(row.doc)), ideas: selected.flatMap((row) => row.doc.ideas.map(projectIdea)),
    unverified, superseded,
  };
}

module.exports = { VALIDATOR, defaultRoot, load };
