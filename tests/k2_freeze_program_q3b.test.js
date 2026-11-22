'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fx = require('./_k2_freeze_fixture');
const prog = require('../services/k2-freeze-program');
const pfGate = require('../services/k2-freeze-program/program_freeze_gate');
const { canonicalJson } = require('../services/trial-ledger');
const engine = require('../services/promotion-engine');
const queueLine = require('../services/k2-freeze-program/queue_line');

/**
 * AUTONOMOUS_RESEARCH_QUEUE_V1 Q3b: a K2 freeze records, in the same event, the sha of the candidate's PROMOTION_TERMS_V1 (W16 binding, plan-coord ruling 11-23 (1))
 * and carries the ROBUSTNESS_DECLARATION_SHA256 line that W20 V-5 reads (INDEPENDENT_VERIFIER_V1). Refusal codes for a missing terms sha and a missing declaration.
 */
const { baseDraft, baseCtx, failing, codesOf, sha, clone } = fx;
const VCFG = require('../config/independent_verifier.v1.json');

const flow = (draft, ctxOver = {}) => {
  const ctx = baseCtx(ctxOver);
  const p = prog.prepare(draft, ctx);
  if (p.state !== 'WAITING_EXTERNAL') return { ctx, p, res: p };
  const receipts = fx.registerAt(p);
  const res = prog.finalize(draft, receipts, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows() }, p.prepared);
  return { ctx, p, res, receipts };
};
const dirOf = (ctx, d) => path.join(ctx.outDir, d.draft_id);
const pageBlock = (dir, id) => JSON.parse(/```json K2_PROGRAM_FREEZE_PAGE_V1\n([\s\S]*?)\n```/.exec(fs.readFileSync(path.join(dir, `${id}_K2_V1_FREEZE_PROGRAM_1.md`), 'utf8'))[1]);

test('Q3b freeze: the page records the terms sha and the robustness sha; the terms file is bound to the K2 and valid for the promotion engine; the K2 text carries the V-5 line', () => {
  const d = baseDraft();
  const { res, ctx, p } = flow(d);
  assert.equal(res.state, 'FROZEN', JSON.stringify(res.codes));
  const dir = dirOf(ctx, d);
  const block = pageBlock(dir, d.draft_id);
  // terms
  assert.match(block.promotion_terms.sha256, /^[0-9a-f]{64}$/);
  const termsBytes = fs.readFileSync(path.join(dir, block.promotion_terms.file));
  assert.equal(sha(termsBytes), block.promotion_terms.sha256);
  assert.equal(fs.readFileSync(path.join(dir, `${block.promotion_terms.file}.sha256`), 'utf8'), `${block.promotion_terms.sha256}  ${block.promotion_terms.file}\n`);
  assert.equal(fs.statSync(path.join(dir, block.promotion_terms.file)).mode & 0o777, 0o444);
  const terms = JSON.parse(termsBytes);
  assert.equal(terms.schema, 'PROMOTION_TERMS_V1');
  assert.equal(terms.k2_sha256, p.k2_sha256, 'bound to the K2 by sha');
  assert.equal(terms.k2_frozen_at, block.k2_frozen_at);
  assert.equal(terms.terms_frozen_at, block.k2_frozen_at, 'frozen in the same event: never after the K2');
  assert.equal(terms.market, d.market);
  assert.equal(terms.candidate_id, d.desk_items.candidate_ref);
  assert.deepEqual(terms.mechanism_ids, d.section0.mechanism_ids);
  assert.equal(terms.min_sample_n, d.power.n_required, 'copied from the power tool output, not drafted');
  assert.equal('stage_evidence' in terms, false, 'evidence shas cannot exist at freeze time');
  assert.deepEqual(engine.validateTerms(terms), [], 'the engine accepts the frozen terms as they are');
  // robustness: the verifier reads exactly this line out of the frozen K2 text
  const k2Name = `${d.draft_id}_K2_V1.frozen.${p.k2_sha256.slice(0, 8)}.md`;
  const k2 = fs.readFileSync(path.join(dir, k2Name), 'utf8');
  const m = new RegExp(`^${VCFG.robustness.declarationLine}: ([0-9a-f]{64})\\s*$`, 'm').exec(k2);
  assert.ok(m, 'ROBUSTNESS_DECLARATION_SHA256 line in the K2');
  assert.equal(m[1], sha(canonicalJson(d.robustness_declaration)));
  assert.equal(block.robustness_declaration_sha256, m[1]);
  // visible on the page text and in the report, which the page binds
  const page = fs.readFileSync(path.join(dir, `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`), 'utf8');
  assert.match(page, new RegExp(`^PROMOTION_TERMS_SHA256: ${block.promotion_terms.sha256}$`, 'm'));
  assert.match(page, new RegExp(`^ROBUSTNESS_DECLARATION_SHA256: ${m[1]}$`, 'm'));
  const report = JSON.parse(fs.readFileSync(path.join(dir, `${d.draft_id}_K2_V1_VALIDATION_REPORT_1.json`)));
  assert.equal(report.promotion_terms_sha256, block.promotion_terms.sha256);
  assert.equal(report.robustness_declaration_sha256, m[1]);
  assert.equal(res.promotion_terms_sha256, block.promotion_terms.sha256);
  assert.equal(res.robustness_declaration_sha256, m[1]);
  // the K2 text itself binds the terms content, so changing a value changes the K2 sha
  const d2 = clone(d);
  d2.promotion_terms.review_endpoint = { kind: 'DATE', value: '2027-03-31' };
  const p2 = prog.prepare(d2, baseCtx());
  assert.equal(p2.state, 'WAITING_EXTERNAL', JSON.stringify(p2.codes));
  assert.notEqual(p2.k2_sha256, p.k2_sha256);
});

test('Q3b freeze: replay returns the same terms sha; bytes are identical for identical inputs', () => {
  const d = baseDraft();
  const a = flow(d);
  assert.equal(a.res.state, 'FROZEN');
  const again = prog.finalize(d, a.receipts, { ...a.ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows() }, a.p.prepared);
  assert.equal(again.replay, true);
  assert.equal(again.promotion_terms_sha256, a.res.promotion_terms_sha256);
  assert.equal(again.robustness_declaration_sha256, a.res.robustness_declaration_sha256);
});

test('Q3b refusal: a draft without promotion_terms is refused PREREG_TERMS_SHA_MISSING (V1), nothing is frozen', () => {
  const d = baseDraft();
  delete d.promotion_terms;
  const { res, ctx } = flow(d);
  assert.equal(res.state, 'REFUSED');
  assert.ok(res.codes.includes('PREREG_TERMS_SHA_MISSING'), JSON.stringify(res.codes));
  assert.deepEqual(failing(res), ['V1']);
  assert.equal(fs.existsSync(path.join(ctx.outDir, d.draft_id, `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`)), false);
});

test('Q3b refusal: a draft without robustness_declaration is refused PREREG_ROBUSTNESS_DECLARATION_MISSING (V1), nothing is frozen', () => {
  const d = baseDraft();
  delete d.robustness_declaration;
  const { res, ctx } = flow(d);
  assert.equal(res.state, 'REFUSED');
  assert.ok(res.codes.includes('PREREG_ROBUSTNESS_DECLARATION_MISSING'), JSON.stringify(res.codes));
  assert.deepEqual(failing(res), ['V1']);
  assert.equal(fs.existsSync(path.join(ctx.outDir, d.draft_id, `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`)), false);
});

test('Q3b refusal: terms are checked with the engine own validator (V2); min_sample_n and stage_evidence are never drafted', () => {
  const bad = (mut) => { const d = baseDraft(); mut(d.promotion_terms); return flow(d).res; };
  let res = bad((t) => { t.min_economic_value = { metric: 'DELTA_G_PER_YEAR', value: 0.01 }; }); // RISK layer needs CVAR5_IMPROVEMENT
  assert.deepEqual(failing(res), ['V2']);
  assert.ok(codesOf(res, 'V2').includes('PROMOTION_TERMS_ENUM:min_economic_value.metric'), JSON.stringify(codesOf(res, 'V2')));
  res = bad((t) => { t.thresholds = { s3: { cost_multiple: -1 } }; });
  assert.ok(codesOf(res, 'V2').some((c) => c.startsWith('PROMOTION_TERMS_TYPE:thresholds.s3')), JSON.stringify(codesOf(res, 'V2')));
  res = bad((t) => { t.insufficient_policy = { ...t.insufficient_policy, p_threshold: 2 }; });
  assert.ok(codesOf(res, 'V2').some((c) => c.startsWith('PROMOTION_POLICY_INVALID')), JSON.stringify(codesOf(res, 'V2')));
  res = bad((t) => { t.min_sample_n = 99; });
  assert.deepEqual(failing(res), ['V1']);
  assert.ok(res.codes.includes('PREREG_SCHEMA_EXTRA_KEY:promotion_terms.min_sample_n'));
  res = bad((t) => { t.stage_evidence = { S0: { path: 'a', sha256: 'a'.repeat(64) } }; });
  assert.ok(res.codes.includes('PREREG_SCHEMA_EXTRA_KEY:promotion_terms.stage_evidence'));
  for (const k of ['insufficient_policy', 'review_endpoint', 'layer']) {
    res = bad((t) => { delete t[k]; });
    assert.ok(res.codes.includes(`PREREG_SCHEMA_MISSING:promotion_terms.${k}`), k);
  }
});

test('Q3b refusal: an AI-authored draft may not choose the numbers; they must equal the registered values in ctx (a human draft may)', () => {
  const d = baseDraft();
  d.promotion_terms.min_economic_value = { metric: 'CVAR5_IMPROVEMENT', value: 0.5 };
  let res = flow(d).res;
  assert.deepEqual(failing(res), ['V2']);
  assert.ok(codesOf(res, 'V2').includes('PREREG_TERMS_VALUES_NOT_REGISTERED:min_economic_value'), JSON.stringify(codesOf(res, 'V2')));
  res = flow(baseDraft(), { promotionTermsStar: null }).res;
  assert.ok(codesOf(res, 'V2').includes('PREREG_TERMS_VALUES_NOT_REGISTERED:star_missing'), JSON.stringify(codesOf(res, 'V2')));
  const h = baseDraft({ authored_by: { kind: 'HUMAN_SESSION', session_ref: 'coordinator-session-1' } });
  h.promotion_terms.min_economic_value = { metric: 'CVAR5_IMPROVEMENT', value: 0.5 };
  res = flow(h, { admissions: [], receipt: null }).res;
  assert.equal(res.state, 'FROZEN', JSON.stringify(res.codes));
});

test('Q3b refusal: the robustness declaration must satisfy the verifier config (kinds, cost multiplier, ids, ops) at freeze time (V2)', () => {
  const bad = (mut) => { const d = baseDraft(); mut(d.robustness_declaration); return flow(d).res; };
  let res = bad((r) => { r.tests = r.tests.filter((t) => t.kind !== 'PARAM_PERTURBATION'); });
  assert.deepEqual(failing(res), ['V2']);
  assert.ok(codesOf(res, 'V2').includes('PREREG_ROBUSTNESS_DECLARATION_INVALID:PARAM_PERTURBATION_NOT_DECLARED'), JSON.stringify(codesOf(res, 'V2')));
  res = bad((r) => { r.tests.find((t) => t.kind === 'COST_MULTIPLIER').multiplier = 1.5; });
  assert.ok(codesOf(res, 'V2').includes('PREREG_ROBUSTNESS_DECLARATION_INVALID:COST_X2_NOT_DECLARED'));
  res = bad((r) => { r.tests[1].id = r.tests[0].id; });
  assert.ok(codesOf(res, 'V2').some((c) => c.startsWith('PREREG_ROBUSTNESS_DECLARATION_INVALID:DUPLICATE_TEST_ID')));
  res = bad((r) => { r.tests[0].op = '<'; });
  assert.ok(codesOf(res, 'V2').some((c) => c.startsWith('PREREG_ROBUSTNESS_DECLARATION_INVALID:OP')));
  res = bad((r) => { r.tests = []; });
  assert.deepEqual(failing(res).sort(), ['V2']);
  res = bad((r) => { r.extra = 1; });
  assert.ok(res.codes.includes('PREREG_SCHEMA_EXTRA_KEY:robustness_declaration.extra'));
});

// ── importer gate ────────────────────────────────────────────────────────────────────────────────

function frozenSet() {
  const d = baseDraft();
  const { res, ctx, p } = flow(d);
  assert.equal(res.state, 'FROZEN', JSON.stringify(res.codes));
  const dir = dirOf(ctx, d);
  const text = fs.readFileSync(path.join(dir, `${d.draft_id}_K2_V1.frozen.${p.k2_sha256.slice(0, 8)}.md`));
  const page = fs.readFileSync(path.join(dir, `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`));
  const report = fs.readFileSync(path.join(dir, `${d.draft_id}_K2_V1_VALIDATION_REPORT_1.json`));
  const entry = { id: 'CN-AIP', kind: 'READING', k2: { sha256: sha(text) }, k2_frozen_at: fx.NOW_FREEZE, freeze_program: { page: { sha256: sha(page) }, report: { sha256: sha(report) } } };
  return { d, res, text, page, report, entry, line: `2026-11-24T10:06:00+08:00 ${res.queue_line}` };
}
const check = (s, o = {}) => {
  const page = o.page || s.page;
  const entry = o.page ? { ...s.entry, freeze_program: { ...s.entry.freeze_program, page: { sha256: sha(page) } } } : s.entry;
  const line = o.page ? `2026-11-24T10:06:00+08:00 ${queueLine.lineFor({ draftId: s.d.draft_id, k2Sha: s.entry.k2.sha256, pageSha: sha(page), market: s.d.market, host: 'LINUX' })}` : s.line;
  return pfGate.check(entry, { k2Bytes: () => o.text || s.text, pageBytes: () => page, reportBytes: () => s.report, queueLogText: () => `${line}\n` });
};
const withoutBlockKey = (s, key) => {
  const m = /(```json K2_PROGRAM_FREEZE_PAGE_V1\n)([\s\S]*?)(\n```)/.exec(s.page.toString());
  const block = JSON.parse(m[2]);
  delete block[key];
  return Buffer.from(s.page.toString().replace(m[0], `${m[1]}${JSON.stringify(block, null, 1)}${m[3]}`));
};

test('Q3b importer gate: a program freeze page without the terms sha, or without the robustness sha, is refused; a K2 whose V-5 line differs from the page is refused', () => {
  const s = frozenSet();
  const ok = check(s);
  assert.equal(ok.state, 'PASS');
  const blk = JSON.parse(/```json K2_PROGRAM_FREEZE_PAGE_V1\n([\s\S]*?)\n```/.exec(s.page.toString())[1]);
  assert.equal(ok.promotion_terms_sha256, blk.promotion_terms.sha256);
  assert.equal(ok.robustness_declaration_sha256, blk.robustness_declaration_sha256);
  assert.match(ok.promotion_terms_sha256, /^[0-9a-f]{64}$/);
  assert.match(ok.robustness_declaration_sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => check(s, { page: withoutBlockKey(s, 'promotion_terms') }), (e) => e.code === 'K2_FREEZE_PROGRAM_TERMS_SHA_MISSING');
  assert.throws(() => check(s, { page: withoutBlockKey(s, 'robustness_declaration_sha256') }), (e) => e.code === 'K2_FREEZE_PROGRAM_ROBUSTNESS_SHA_MISSING');
  const changed = Buffer.from(s.text.toString().replace(/^ROBUSTNESS_DECLARATION_SHA256: .*$/m, `ROBUSTNESS_DECLARATION_SHA256: ${'0'.repeat(64)}`));
  assert.throws(() => check(s, { text: changed }), (e) => e.code === 'K2_FREEZE_PROGRAM_ROBUSTNESS_K2_LINE_MISMATCH');
  const noLine = Buffer.from(s.text.toString().replace(/^ROBUSTNESS_DECLARATION_SHA256: .*$/m, ''));
  assert.throws(() => check(s, { text: noLine }), (e) => e.code === 'K2_FREEZE_PROGRAM_ROBUSTNESS_K2_LINE_MISMATCH');
});

test('Q3b prompt admission: AI_PREREG is ADMITTED in the queue admissions file, pinned to the text sha and the current draft schema sha', () => {
  const prompt = require('../services/k2-freeze-program/prompt');
  const schema = require('../services/k2-freeze-program/schema');
  const adm = require('../config/research_queue_prompt_admissions.v1.json');
  assert.equal(adm.entries.length, 3, 'AI_CHECK, AI_REVIEW_CARD and AI_PREREG');
  assert.ok(prompt.SYSTEM_SHA256.startsWith('fac82f68'), 'the text plan-coord read is unchanged');
  const e = adm.entries.find((x) => x.kind === 'AI_PREREG');
  assert.equal(e.state, 'ADMITTED');
  assert.equal(e.admission_basis, 'plan-coord read 11-23, queue AQ_Q3 REVIEW_ACCEPTED');
  assert.equal(e.system_sha256, prompt.SYSTEM_SHA256);
  assert.equal(e.schema_sha256, schema.SCHEMA_SHA256);
  assert.deepEqual(e.purposes, ['RQ_AGENT', 'RQ_AGENT_PRO_FALLBACK']);
  assert.equal(e.prompt_id, 'RQ_PROMPT_AI_PREREG_V1');
  const { state, admission_basis, ...shape } = prompt.admissionEntry();
  const { state: s2, admission_basis: b2, ...shape2 } = e;
  assert.deepEqual(shape2, shape);
  assert.equal(new Set(adm.entries.map((x) => x.system_sha256)).size, 3);
});
