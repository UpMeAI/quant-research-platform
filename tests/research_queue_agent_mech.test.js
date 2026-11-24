'use strict';
/** #149 package A frozen acceptance A01-A17. All gateway replies are in-process stubs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { sha256, canonicalJson } = require('../services/research-queue-agent/canon');
const { runAgentTask } = require('../services/research-queue-agent/agent');
const prompts = require('../services/research-queue-agent/prompts');
const { parseAgentTask } = require('../services/research-queue-agent/queue-seam');
const { stageFiles } = require('../services/research-queue-agent/stage');
const { validateResult } = require('../services/research-queue-agent/validate-result');
const note = require('../services/research-queue-agent/mech-note');
const review = require('../services/research-queue-agent/mech-review');

const ROOT = path.join(__dirname, '..');
const H = (s) => sha256(String(s));
const clone = (v) => JSON.parse(JSON.stringify(v));

function notePack(over = {}) {
  const candidates = Array.from({ length: 6 }, (_, i) => ({ candidate_id: `A${String(i + 1).padStart(3, '0')}`, formula: '(-ts_std(pb,10))', fields: ['pb'] }));
  return {
    schema: 'RF1116_MECH_NOTE_PACK_V1', round_id: 'MR-CN_A-2026-11-a6cb823f86', market: 'CN_A', batch_no: 1, batch_of: 1,
    pins: { selection_record_hash: H('selection'), register_sha256: H('register'), space_sha256: H('space'), code_commit: H('commit') },
    candidates,
    mechanisms: [{ mechanism_id: 'SEL.XSEC.VALUE', title_zh: '截面估值差异', description_zh: '比较截面估值字段的相对差异' }],
    glossary: [{ name: 'pb', description_zh: '市净率' }, { name: 'ts_std', description_zh: '时间序列标准差算子' }],
    ...over,
  };
}

const goodNote = (candidate_id) => ({
  candidate_id, outcome: 'NOTE', mechanism_id: 'SEL.XSEC.VALUE',
  economic_logic_zh: '估值字段的历史波动收窄可能反映定价分歧减少，并为截面差异提供可检验的经济解释',
  failure_mode_zh: '估值口径失真或样本结构突变时，这一解释可能失效',
  fields_cited: ['pb'], no_mechanism_code: null, proposal: null,
});
const noteOutput = (pack = notePack()) => ({ round_id: pack.round_id, batch_no: pack.batch_no, notes: pack.candidates.map((c) => goodNote(c.candidate_id)) });

function reviewPack(over = {}) {
  const base = notePack();
  return {
    schema: 'RF1116_MECH_REVIEW_PACK_V1', round_id: base.round_id, market: 'CN_A', batch_no: 1, batch_of: 1,
    pins: { ...base.pins, mechanism_set_sha256: H('mechanism-set') },
    candidates: base.candidates.map((c) => ({ ...c, mechanism_id: 'SEL.XSEC.VALUE', mechanism_description_zh: '比较截面估值字段的相对差异', economic_logic_zh: goodNote(c.candidate_id).economic_logic_zh, failure_mode_zh: goodNote(c.candidate_id).failure_mode_zh, registration_hash: H(c.candidate_id) })),
    glossary: base.glossary,
    ...over,
  };
}
const goodReview = (candidate_id) => ({ candidate_id, status: 'CONSISTENT', code: null, note_zh: '公式、机制与文字说明相互一致' });
const reviewOutput = (pack = reviewPack()) => ({ round_id: pack.round_id, batch_no: pack.batch_no, items: pack.candidates.map((c) => goodReview(c.candidate_id)) });

const task = (kind, over = {}) => ({ task_id: 'RQT-LINUX-20261124-a1490001', host: 'LINUX', agent_host: 'LINUX', kind, market: 'CN_A', template_id: `T-${kind}-V1-LINUX-CN_A`, template_sha256: H(kind), attempt_no: 1, ...over });
const bundle = (pack) => ({ schema: 'RQ_AGENT_BUNDLE_V1', market: 'CN_A', pack });
const ok = (body, model = 'deepseek-flash') => ({ ok: true, status: 200, data: { choices: [{ message: { content: JSON.stringify(body) } }], model } });
function client(replies) {
  const calls = [];
  return { calls, async chat(req) { calls.push(clone(req)); const value = replies.shift(); if (!value) throw new Error('missing stub reply'); return value; } };
}
const promptAdmissions = () => ({ byKind: {
  AI_MECH_NOTE: { system_sha256: sha256(prompts.TEXTS.AI_MECH_NOTE) },
  AI_MECH_REVIEW: { system_sha256: sha256(prompts.TEXTS.AI_MECH_REVIEW) },
} });
const opts = (c, over = {}) => ({ client: c, env: {}, host: 'LINUX', now: () => '2026-11-24T15:00:00+08:00', promptAdmissions: promptAdmissions(), ...over });
const codes = (v) => v.errors.map((e) => e.code);

test('A01 valid six-candidate note pack completes in one stubbed call and consumer revalidation agrees', async () => {
  const p = notePack(); const c = client([ok(noteOutput(p))]); const t = task('AI_MECH_NOTE'); const b = bundle(p);
  const r = await runAgentTask(t, b, opts(c));
  assert.equal(r.status, 'DONE'); assert.equal(c.calls.length, 1); assert.equal(r.outputs.mechanism_notes.schema, 'RF1116_MECH_NOTE_OUTPUT_V1');
  assert.deepEqual(r.validator, { ok: true, sha256: r.outputs.mechanism_notes_sha256 });
  assert.equal(r.validator.sha256, sha256(canonicalJson(r.outputs.mechanism_notes)));
  const v = validateResult({ task: t, bundle: b, result: r, promptAdmissions: promptAdmissions() });
  assert.deepEqual(v.codes, []); assert.equal(v.ok, true); assert.match(v.output_sha256, /^[0-9a-f]{64}$/);
});

test('D01 trusted consumer requires but never trusts the mechanism producer self-certificate', async () => {
  for (const [kind, p, body, key] of [
    ['AI_MECH_NOTE', notePack(), noteOutput, 'mechanism_notes'],
    ['AI_MECH_REVIEW', reviewPack(), reviewOutput, 'mechanism_review'],
  ]) {
    const t = task(kind); const b = bundle(p);
    const r = await runAgentTask(t, b, opts(client([ok(body(p))])));
    const namedSha = r.outputs[`${key}_sha256`];
    assert.deepEqual(r.validator, { ok: true, sha256: namedSha });
    assert.match(r.validator.sha256, /^[0-9a-f]{64}$/);
    assert.equal(namedSha, sha256(canonicalJson(r.outputs[key])));
    assert.equal(validateResult({ task: t, bundle: b, result: r, promptAdmissions: promptAdmissions() }).ok, true);

    const missing = clone(r); delete missing.validator;
    let v = validateResult({ task: t, bundle: b, result: missing, promptAdmissions: promptAdmissions() });
    assert.equal(v.ok, false); assert.ok(v.codes.includes('RESULT_VALIDATOR_MISSING'), JSON.stringify(v.codes));

    const falseClaim = clone(r); falseClaim.validator.ok = false;
    v = validateResult({ task: t, bundle: b, result: falseClaim, promptAdmissions: promptAdmissions() });
    assert.equal(v.ok, false); assert.ok(v.codes.includes('RESULT_VALIDATOR_NOT_OK'), JSON.stringify(v.codes));

    const mismatch = clone(r); mismatch.validator.sha256 = '0'.repeat(64);
    v = validateResult({ task: t, bundle: b, result: mismatch, promptAdmissions: promptAdmissions() });
    assert.equal(v.ok, false); assert.ok(v.codes.includes('RESULT_VALIDATOR_SHA_MISMATCH'), JSON.stringify(v.codes));

    const forgedContent = clone(r); forgedContent.outputs[key].round_id = 'MR-CN_A-forged';
    forgedContent.outputs[`${key}_sha256`] = sha256(canonicalJson(forgedContent.outputs[key]));
    forgedContent.validator.sha256 = forgedContent.outputs[`${key}_sha256`];
    v = validateResult({ task: t, bundle: b, result: forgedContent, promptAdmissions: promptAdmissions() });
    assert.equal(v.ok, false, 'matching self-certificate cannot replace independent content revalidation');
    assert.ok(v.codes.includes(kind === 'AI_MECH_NOTE' ? 'MECH_NOTE_SCHEMA' : 'MECH_REVIEW_SCHEMA'), JSON.stringify(v.codes));
  }
});

test('A02 note output must contain every candidate exactly once', () => {
  const p = notePack();
  assert.ok(codes(note.validateNoteOutput({ ...noteOutput(p), notes: noteOutput(p).notes.slice(1) }, p)).includes('MECH_NOTE_CANDIDATE_SET'));
  const dup = noteOutput(p); dup.notes[1] = clone(dup.notes[0]);
  assert.ok(codes(note.validateNoteOutput(dup, p)).includes('MECH_NOTE_CANDIDATE_SET'));
});

test('A03 NOTE mechanism_id must be in the pack allow-list', () => {
  const p = notePack(); const o = noteOutput(p); o.notes[0].mechanism_id = 'SEL.XSEC.NOT_PRESENT';
  assert.ok(codes(note.validateNoteOutput(o, p)).includes('MECH_NOTE_MECHANISM_NOT_IN_PACK'));
});

test('A04 all three lexicon lists are applied to note text', () => {
  for (const word of ['预计', '目标价', '看多', 'outperform', '做多', '不做']) {
    const p = notePack(); const o = noteOutput(p); o.notes[0].economic_logic_zh += word;
    assert.ok(codes(note.validateNoteOutput(o, p)).includes('MECH_NOTE_WORDING'), word);
  }
});

test('A05 size-effect wording is not accepted as a mechanism explanation', () => {
  const p = notePack(); const o = noteOutput(p); o.notes[0].economic_logic_zh += '小市值效应';
  assert.ok(codes(note.validateNoteOutput(o, p)).includes('MECH_NOTE_SIZE_AS_MECHANISM'));
});

test('A06 only numbers present in that candidate formula may occur in its text', () => {
  const p = notePack(); const pass = noteOutput(p); pass.notes[0].economic_logic_zh += '并用10日窗口度量';
  assert.equal(codes(note.validateNoteOutput(pass, p)).includes('MECH_NOTE_NUMBER_NOT_IN_PACK'), false);
  const fail = noteOutput(p); fail.notes[0].economic_logic_zh += '并得到0.92的读数';
  assert.ok(codes(note.validateNoteOutput(fail, p)).includes('MECH_NOTE_NUMBER_NOT_IN_PACK'));
});

test('A07 closed output schemas reject an extra confidence key', () => {
  const p = notePack(); const o = noteOutput(p); o.notes[0].confidence = 0.5;
  assert.ok(codes(note.validateNoteOutput(o, p)).includes('MECH_NOTE_SCHEMA'));
});

test('A08 NOTE text length bounds are deterministic', () => {
  const p = notePack(); const o = noteOutput(p); o.notes[0].economic_logic_zh = '甲'.repeat(161);
  assert.ok(codes(note.validateNoteOutput(o, p)).includes('MECH_NOTE_LENGTH'));
});

test('A09 fields_cited is a non-empty subset of formula fields', () => {
  const p = notePack(); const o = noteOutput(p); o.notes[0].fields_cited = ['roe'];
  assert.ok(codes(note.validateNoteOutput(o, p)).includes('MECH_NOTE_FIELDS_NOT_IN_FORMULA'));
});

test('A10 firewall rejects forbidden keys and mining out paths before any gateway call', async () => {
  for (const dirty of [
    (() => { const p = notePack(); p.candidates[0].validation_mean_ic = 0.1; return p; })(),
    (() => { const p = notePack(); p.pins.code_commit = '/srv/research-lane/rf1116-mining/out/selection.json'; return p; })(),
  ]) {
    const c = client([ok(noteOutput(dirty))]); const r = await runAgentTask(task('AI_MECH_NOTE'), bundle(dirty), opts(c));
    assert.equal(r.status, 'BLOCKED_DETERMINISTIC'); assert.equal(r.reason_code, 'MECH_PACK_FIREWALL'); assert.equal(c.calls.length, 0);
  }
});

test('A11 packs over 12k estimated tokens are blocked before any gateway call', async () => {
  const p = notePack(); p.glossary.push({ name: 'oversized', description_zh: '甲'.repeat(40000) });
  const c = client([ok(noteOutput(p))]); const r = await runAgentTask(task('AI_MECH_NOTE'), bundle(p), opts(c));
  assert.equal(r.status, 'BLOCKED_DETERMINISTIC'); assert.equal(r.reason_code, 'MECH_PACK_TOO_LARGE'); assert.equal(c.calls.length, 0);
});

test('A12 two failed flash attempts permit exactly one pro fallback and pro failure blocks deterministically', async () => {
  const p = notePack(); const bad = { round_id: p.round_id, batch_no: p.batch_no, notes: [] };
  const c1 = client([ok(bad), ok(bad), ok(bad), ok(bad), ok(noteOutput(p), 'deepseek-v4-pro')]);
  const qg = []; const r1 = await runAgentTask(task('AI_MECH_NOTE'), bundle(p), opts(c1, { writeQualityRecord: (x) => qg.push(x) }));
  assert.equal(r1.status, 'DONE'); assert.equal(c1.calls.filter((x) => x.purpose === 'RQ_AGENT_PRO_FALLBACK').length, 1);
  assert.equal(qg.length, 1); assert.equal(qg[0].schema, 'RQ_FLASH_QUALITY_GATE_RECORD_V1'); assert.equal(qg[0].failures.length, 2);
  const c2 = client([ok(bad), ok(bad), ok(bad), ok(bad), ok(bad, 'deepseek-v4-pro')]);
  const r2 = await runAgentTask(task('AI_MECH_NOTE'), bundle(p), opts(c2));
  assert.equal(r2.status, 'BLOCKED_DETERMINISTIC'); assert.equal(r2.reason_code, 'RQ_PRO_FALLBACK_FAILED');
});

test('A13 review HOLD requires an allowed code and CONSISTENT requires null code', () => {
  const p = reviewPack(); const hold = reviewOutput(p); hold.items[0] = { ...hold.items[0], status: 'HOLD', code: null };
  assert.ok(codes(review.validateReviewOutput(hold, p)).includes('MECH_REVIEW_SCHEMA'));
  const consistent = reviewOutput(p); consistent.items[0].code = 'HOLD_MECHANISM_MISMATCH';
  assert.ok(codes(review.validateReviewOutput(consistent, p)).includes('MECH_REVIEW_SCHEMA'));
});

test('A14 prompt text hashes equal both PENDING_ADMISSION entries; changing text is refused on load', () => {
  const cfg = require('../config/research_queue_prompt_admissions.v1.json');
  for (const kind of ['AI_MECH_NOTE', 'AI_MECH_REVIEW']) {
    const e = cfg.entries.find((x) => x.kind === kind); assert.ok(e); assert.equal(e.state, 'PENDING_ADMISSION'); assert.equal(e.system_sha256, sha256(prompts.TEXTS[kind]));
  }
  const save = prompts.TEXTS.AI_MECH_NOTE;
  try { prompts.TEXTS.AI_MECH_NOTE += 'x'; assert.throws(() => prompts.loadAdmissions(), /RQ_ADMISSION_SHA_MISMATCH/); } finally { prompts.TEXTS.AI_MECH_NOTE = save; }
});

test('A15 queue seam, Q3c stage, and Python consumer kind table register both new kinds without changing AI_PREREG behavior', () => {
  for (const [kind, pack] of [['AI_MECH_NOTE', notePack()], ['AI_MECH_REVIEW', reviewPack()]]) {
    const t = task(kind); assert.equal(parseAgentTask(t).kind, kind);
    const staged = stageFiles({ row: t, input: pack }); assert.deepEqual(staged.task, t); assert.deepEqual(staged.bundle, bundle(pack));
  }
  assert.throws(() => parseAgentTask(task('AI_PREREG')), /RQ_AGENT_KIND_UNSUPPORTED/);
  const py = fs.readFileSync(path.join(ROOT, 'services/research-queue/rq/agentseam.py'), 'utf8');
  assert.match(py, /AGENT_KINDS\s*=.*AI_MECH_NOTE.*AI_MECH_REVIEW/);
});

test('A16 a new-mechanism proposal cannot duplicate a registered title or description verbatim', () => {
  for (const proposal of [
    { title_zh: '截面估值差异', description_zh: '另一段描述' },
    { title_zh: '新标题', description_zh: '比较截面估值字段的相对差异' },
  ]) {
    const p = notePack(); const o = noteOutput(p); o.notes[0] = { candidate_id: 'A001', outcome: 'NEW_MECHANISM_PROPOSAL', mechanism_id: null, economic_logic_zh: null, failure_mode_zh: null, fields_cited: [], no_mechanism_code: null, proposal };
    assert.ok(codes(note.validateNoteOutput(o, p)).includes('MECH_NOTE_PROPOSAL_DUPLICATES_REGISTERED'));
  }
});

test('review validator is closed, candidate-complete, wording/number/secret safe, and a valid result consumer-revalidates', async () => {
  const p = reviewPack();
  for (const mutate of [
    (o) => { o.items.pop(); }, (o) => { o.items[0].extra = true; }, (o) => { o.items[0].note_zh = '预计该公式会涨'; },
    (o) => { o.items[0].note_zh = '一致度为0.92'; }, (o) => { o.items[0].note_zh = `泄漏sk-${'a'.repeat(20)}`; },
  ]) { const o = reviewOutput(p); mutate(o); assert.equal(review.validateReviewOutput(o, p).ok, false); }
  const c = client([ok(reviewOutput(p))]); const t = task('AI_MECH_REVIEW'); const b = bundle(p);
  const r = await runAgentTask(t, b, opts(c)); assert.equal(r.status, 'DONE'); assert.equal(r.outputs.mechanism_review.schema, 'RF1116_MECH_REVIEW_OUTPUT_V1');
  assert.deepEqual(r.validator, { ok: true, sha256: r.outputs.mechanism_review_sha256 });
  assert.equal(r.validator.sha256, sha256(canonicalJson(r.outputs.mechanism_review)));
  assert.equal(validateResult({ task: t, bundle: b, result: r, promptAdmissions: promptAdmissions() }).ok, true);
});

test('note output rejects secret-shaped text', () => {
  const p = notePack(); const o = noteOutput(p); o.notes[0].failure_mode_zh = `密钥sk-${'b'.repeat(20)}不应出现`;
  assert.ok(codes(note.validateNoteOutput(o, p)).includes('MECH_NOTE_SECRET_SHAPED'));
});

test('A17 the mutation harness declares a dedicated mutant for every new validator guard family', () => {
  const { MUTANTS } = require('../tools/rq-gateway-agent-mutation-check');
  const ids = new Set(MUTANTS.map((m) => m.id));
  for (const id of Array.from({ length: 17 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`)) assert.ok(ids.has(id), id);
  for (const m of MUTANTS.filter((x) => /^M\d+$/.test(x.id))) assert.deepEqual(m.tests, ['tests/research_queue_agent_mech.test.js']);
});

test('frozen schemas hash deterministically and contain no real provider, secret, filesystem, or network dependency', () => {
  assert.match(canonicalJson(noteOutput()), /A001/);
  for (const f of ['mech-note.js', 'mech-review.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'services/research-queue-agent', f), 'utf8');
    assert.equal(/require\(['"](fs|child_process|net|http|https|dns|vm|worker_threads)['"]\)/.test(src), false, f);
  }
});
