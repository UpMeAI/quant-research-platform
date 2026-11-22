'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fx = require('./_k2_freeze_fixture');

const prog = require('../services/k2-freeze-program');
const rf1118 = require('../services/k2-freeze-program/rf1118');
const revocation = require('../services/k2-freeze-program/revocation');

/**
 * AQ-39 (freeze artifacts), AQ-40 (TRL before freeze), AQ-41 (revocation), AQ-42 (program freeze only), AQ-43 (caps) of AUTONOMOUS_RESEARCH_QUEUE_V1
 * (frozen rev 4, sha 52418471), over RF1118 r2 (FREEZE_1 ae8f2491). Same inputs -> byte-identical artifacts.
 */
const { baseDraft, baseCtx, failing, codesOf } = fx;
const ROOT = path.join(__dirname, '..');

function freezeFlow(draft, ctxOver = {}, at = fx.REGISTERED_AT) {
  const ctx = baseCtx(ctxOver);
  const p = prog.prepare(draft, ctx);
  assert.equal(p.state, 'WAITING_EXTERNAL', JSON.stringify(p.codes));
  const receipts = fx.registerAt(p, at);
  const res = prog.finalize(draft, receipts, { ...ctx, now: fx.NOW_FREEZE, ledgerRows: fx.ledgerRows() }, p.prepared);
  return { ctx, p, receipts, res };
}
const readDir = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n))]));
const subdir = (ctx, id) => path.join(ctx.outDir, id);

test('RF1118 binding: FREEZE_1 page sha, effective time, caps are the frozen constants', () => {
  assert.equal(rf1118.FREEZE.sha256, 'ae8f24910c62dd0c2a14c52b6d1cb8fc2913297f52cc396fbee0985fb7092309');
  assert.equal(rf1118.FREEZE.state, 'FREEZE_1');
  assert.equal(rf1118.FREEZE.texts[0].sha256.slice(0, 8), '61e7c280');
  assert.equal(rf1118.EFFECTIVE_FROM, '2026-11-18T15:48:18+08:00');
  assert.deepEqual(rf1118.CAPS, { per_week: 2, per_month: 6, arms_per_freeze: 20 });
  assert.equal(rf1118.isBound(), true);
  assert.equal(rf1118.isBound({ ...rf1118.FREEZE, state: 'DRAFT' }), false);
});

test('AQ-39 freeze artifacts: frozen text, validation report, freeze page and their .sha256 sidecars exist and are 0444; the page binds text sha, k2_frozen_at, report sha, program sha, author line, TRL ids', () => {
  const d = baseDraft();
  const { res, p, ctx } = freezeFlow(d);
  assert.equal(res.state, 'FROZEN', JSON.stringify(res.codes));
  const dir = subdir(ctx, d.draft_id);
  const files = readDir(dir);
  const text = `${d.draft_id}_K2_V1.frozen.${p.k2_sha256.slice(0, 8)}.md`;
  const table = `${d.draft_id}_K2_V1.prior_table.${p.prior_table_sha256.slice(0, 8)}.json`;
  const names = [text, `${text}.sha256`, table, `${table}.sha256`, `${d.draft_id}_K2_V1_VALIDATION_REPORT_1.json`, `${d.draft_id}_K2_V1_VALIDATION_REPORT_1.json.sha256`,
    `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`, `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md.sha256`].sort();
  assert.deepEqual(Object.keys(files), names);
  for (const n of names) assert.equal(fs.statSync(path.join(dir, n)).mode & 0o777, 0o444, n);
  assert.equal(fx.sha(files[text]), p.k2_sha256);
  assert.equal(files[`${text}.sha256`].toString(), `${p.k2_sha256}  ${text}\n`);
  const page = files[`${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`].toString();
  const block = JSON.parse(/```json K2_PROGRAM_FREEZE_PAGE_V1\n([\s\S]*?)\n```/.exec(page)[1]);
  assert.equal(block.k2_sha256, p.k2_sha256);
  assert.equal(block.k2_frozen_at, fx.NOW_FREEZE);
  assert.equal(block.report_sha256, fx.sha(files[`${d.draft_id}_K2_V1_VALIDATION_REPORT_1.json`]));
  assert.match(block.program_sha256, /^[0-9a-f]{64}$/);
  assert.equal(block.authored_by.kind, 'AI_PREREG_AGENT');
  assert.equal(block.frozen_by, 'K2_FREEZE_PROGRAM_V1');
  assert.equal(block.rf1118.sha256, rf1118.FREEZE.sha256);
  assert.deepEqual(block.trial_ids.sort(), res.trial_ids.sort());
  assert.equal(block.trial_ids.length, 2);
  assert.equal(block.family_n.n_distinct_configs, 1); // BASELINE does not count in N, the one VERDICT_ARM does
  const report = JSON.parse(files[`${d.draft_id}_K2_V1_VALIDATION_REPORT_1.json`]);
  assert.equal(report.results.length, 14);
  assert.ok(report.results.every((r) => r.state === 'PASS' || r.state === 'NOT_APPLICABLE'));
  // exactly one queue line per freeze sha, idempotent
  assert.equal(res.queue_line, `K2_PROGRAM_FROZEN ${d.draft_id} ${p.k2_sha256} ${fx.sha(files[`${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`])} CN_A LINUX`);
  const queue = require('../services/k2-freeze-program/queue_line');
  let log = '';
  for (let i = 0; i < 3; i += 1) log = queue.ensureLine(log, `2026-11-24T10:06:00+08:00 ${res.queue_line}`).text;
  assert.equal(queue.count(log, p.k2_sha256), 1);
});

test('AQ-39 the text carries section 0 (five lines), data inputs, causality scope, 8 desk items and the TRL id table, rendered by code only', () => {
  const d = baseDraft();
  const { res, p, ctx } = freezeFlow(d);
  const text = fs.readFileSync(path.join(subdir(ctx, d.draft_id), `${d.draft_id}_K2_V1.frozen.${p.k2_sha256.slice(0, 8)}.md`), 'utf8');
  for (const label of ['**机制**：', '**预期失效方式**：', '**可能被哪条现行规则解释**：', '**AI 输入**：', '**作者与冻结者**：']) assert.ok(text.includes(label), label);
  assert.ok(text.includes('G-CAUSAL N/A: RISK_K_OR_ACCOUNT_LAYER'));
  assert.ok(text.includes('`DATA:ALL_A_CROSS_SECTION@'));
  for (const id of res.trial_ids) assert.ok(text.includes(id), id);
  assert.ok(text.includes(p.prior_table_sha256));
  assert.ok(text.includes('K2_FREEZE_PROGRAM_V1'));
  assert.ok(!/DEVIATION_ACCEPTED/.test(text));
});

test('same inputs -> byte-identical freeze artifacts (two output directories); a refusal is byte-identical too', () => {
  const d = baseDraft();
  const a = freezeFlow(d);
  const b = freezeFlow(d);
  assert.equal(a.res.state, 'FROZEN');
  assert.equal(b.res.state, 'FROZEN');
  const fa = readDir(subdir(a.ctx, d.draft_id));
  const fb = readDir(subdir(b.ctx, d.draft_id));
  assert.deepEqual(Object.keys(fa), Object.keys(fb));
  for (const n of Object.keys(fa)) assert.ok(fa[n].equals(fb[n]), n);
  const bad = baseDraft();
  delete bad.section0;
  const r1 = prog.prepare(bad, baseCtx());
  const r2 = prog.prepare(bad, baseCtx());
  assert.equal(r1.state, 'REFUSED');
  assert.ok(Buffer.from(r1.refusal.bytes).equals(Buffer.from(r2.refusal.bytes)));
  assert.equal(r1.refusal.name, r2.refusal.name);
});

test('refusal files are written 0444 under the draft id and name the attempt; the agent view is reason codes only; revisions: 3 allowed, then PREREG_REFUSED', () => {
  const d = baseDraft();
  delete d.section0;
  const ctx = baseCtx();
  const r = prog.prepare(d, ctx);
  assert.equal(r.state, 'REFUSED');
  assert.equal(r.next, 'REVISE');
  const file = path.join(subdir(ctx, d.draft_id), r.refusal.name);
  assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  assert.ok(Buffer.from(r.refusal.bytes).equals(fs.readFileSync(file)));
  assert.deepEqual(Object.keys(r.agent_view), ['codes']);
  const third = prog.prepare({ ...d, revision: 3 }, baseCtx());
  assert.equal(third.next, 'WAITING_EXTERNAL:PREREG_REFUSED');
  const fourth = prog.prepare({ ...d, revision: 4 }, baseCtx());
  assert.equal(fourth.state, 'REFUSED');
  assert.ok(fourth.codes.includes('PREREG_REVISION_LIMIT'));
  assert.equal(fourth.next, 'WAITING_EXTERNAL:PREREG_REFUSED');
});

test('AQ-40 TRL before freeze: a row registered exactly at k2_frozen_at, or after, refuses the freeze page; before it passes; no page is written on refusal', () => {
  for (const [at, expectFrozen] of [['2026-11-24T10:04:59+08:00', true], [fx.NOW_FREEZE, false], ['2026-11-24T10:05:01+08:00', false]]) {
    const d = baseDraft();
    const { res, ctx } = freezeFlow(d, {}, at);
    assert.equal(res.state, expectFrozen ? 'FROZEN' : 'REFUSED', at);
    if (!expectFrozen) {
      assert.deepEqual(failing(res), ['V9']);
      const dir = subdir(ctx, d.draft_id);
      assert.ok(!fs.readdirSync(dir).some((n) => n.includes('FREEZE_PROGRAM')), 'no freeze page on refusal');
    }
  }
});

test('AQ-41 revocation: a revocation page leaves the freeze byte-identical; runs are REVOKED_AFTER_RUN; N is unchanged', () => {
  const d = baseDraft();
  const { res, ctx, p } = freezeFlow(d);
  assert.equal(res.state, 'FROZEN');
  const dir = subdir(ctx, d.draft_id);
  const before = readDir(dir);
  const nBefore = fx.trials.count(d.family_id);
  const out = revocation.write(dir, { draftId: d.draft_id, revokedBy: 'COORDINATOR', reason: 'audit: synthetic', now: '2026-11-25T09:00:00+08:00' });
  assert.equal(out.name, `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1_REVOCATION_1.md`);
  assert.equal(fs.statSync(path.join(dir, out.name)).mode & 0o777, 0o444);
  const after = readDir(dir);
  for (const n of Object.keys(before)) assert.ok(before[n].equals(after[n]), `${n} changed`);
  assert.deepEqual(Object.keys(after).filter((n) => !(n in before)), [out.name]);
  assert.equal(revocation.read(dir, d.draft_id).revoked, true);
  assert.equal(revocation.statusOfRuns(dir, d.draft_id, { runsDone: true }), 'REVOKED_AFTER_RUN');
  assert.equal(revocation.statusOfRuns(dir, d.draft_id, { runsDone: false }), 'REVOKED_NO_RUN');
  assert.deepEqual(fx.trials.count(d.family_id), nBefore);
  assert.equal(nBefore.n_distinct_configs, 1);
  // a second revocation page does not overwrite the first
  assert.throws(() => revocation.write(dir, { draftId: d.draft_id, revokedBy: 'COORDINATOR', reason: 'again', now: '2026-11-25T10:00:00+08:00' }), /REVOCATION_EXISTS/);
  assert.equal(p.k2_sha256, res.k2_sha256);
});

test('AQ-42 program freeze only: before RF1118 FREEZE_1 is bound, in DRAFT_ONLY mode, or for a downgraded class, the program refuses to freeze and routes to WAITING_FREEZE with nothing written', () => {
  const cases = [
    [{ rf1118: { ...rf1118.FREEZE, state: 'DRAFT' } }, 'PREREG_RF1118_NOT_FROZEN'],
    [{ freezeMode: 'DRAFT_ONLY' }, 'PREREG_MODE_DRAFT_ONLY'],
    [{ downgradedClasses: ['CN_A:ACCT'] }, 'PREREG_CLASS_DOWNGRADED'],
  ];
  for (const [over, code] of cases) {
    const d = baseDraft();
    const ctx = baseCtx(over);
    const r = prog.prepare(d, ctx);
    assert.equal(r.state, 'WAITING_FREEZE', code);
    assert.equal(r.code, code);
    assert.ok(!fs.existsSync(subdir(ctx, d.draft_id)) || fs.readdirSync(subdir(ctx, d.draft_id)).length === 0);
    const f = prog.finalize(d, null, { ...ctx, now: fx.NOW_FREEZE }, { k2_sha256: 'x' });
    assert.equal(f.state, 'WAITING_FREEZE');
  }
  // a time before the RF1118 effective moment cannot freeze either
  const early = prog.prepare(baseDraft(), baseCtx({ now: '2026-11-18T15:48:17+08:00' }));
  assert.equal(early.state, 'WAITING_FREEZE');
  assert.equal(early.code, 'PREREG_RF1118_NOT_EFFECTIVE');
  // other classes are unaffected by a downgrade of one
  const ok = prog.prepare(baseDraft(), baseCtx({ downgradedClasses: ['US_EQUITY:ACCT'] }));
  assert.equal(ok.state, 'WAITING_EXTERNAL');
});

test('downgrade class is one named rule (plan-coord ruling 11-22) and the human-authored identity is recorded on the page', () => {
  assert.equal(rf1118.DOWNGRADE_CLASS_RULE, '<market>:<mechanism-layer-prefix>');
  assert.equal(rf1118.classOf('CN_A', 'ACCT.CONCURRENCY.NON_MAJOR_CAP'), 'CN_A:ACCT');
  const d = baseDraft({ authored_by: { kind: 'HUMAN_SESSION', session_ref: 'research-session-1' } });
  const { res, ctx } = freezeFlow(d, { receipt: null, admissions: [] });
  assert.equal(res.state, 'FROZEN');
  const page = fs.readFileSync(path.join(subdir(ctx, d.draft_id), `${d.draft_id}_K2_V1_FREEZE_PROGRAM_1.md`), 'utf8');
  assert.ok(page.includes('"session_ref": "research-session-1"'));
});

test('AQ-42 no code path but the program writes a FREEZE_PROGRAM page: scan of services, apps and tools; no freeze writer is exported', () => {
  const holders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'var') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(js|cjs|mjs|py|sh)$/.test(e.name)) {
        const s = fs.readFileSync(f, 'utf8');
        if (/FREEZE_PROGRAM_1/.test(s) && /(writeFileSync|writeFile|fs\.open|appendFile|chmodSync)/.test(s)) holders.push(path.relative(ROOT, f));
      }
    }
  };
  for (const top of ['services', 'apps', 'tools', 'adapters', 'packages', 'deploy']) if (fs.existsSync(path.join(ROOT, top))) walk(path.join(ROOT, top));
  const allowed = holders.filter((f) => f.startsWith(`services${path.sep}k2-freeze-program${path.sep}`));
  assert.deepEqual(holders.sort(), allowed.sort(), `writers outside the program: ${holders.filter((h) => !allowed.includes(h))}`);
  assert.ok(allowed.length >= 1);
  // the program module exports no raw writer; only finalize() produces pages
  for (const name of Object.keys(prog)) assert.ok(!/^write|^emit|^chmod/i.test(name) || name === 'writeRefusal', name);
  assert.equal(typeof prog.finalize, 'function');
});

test('AQ-43 caps: the 3rd freeze of a market in a CST week and the 7th in a CST month are refused; boundaries and other markets are not counted', () => {
  const prior = (market, at) => ({ market, frozen_at: at, k2_sha256: fx.sha(`${market}${at}`), n_arms: 2 });
  const week = [prior('CN_A', '2026-11-23T09:00:00+08:00'), prior('CN_A', '2026-11-24T08:00:00+08:00')];
  const r3 = prog.prepare(baseDraft(), baseCtx({ priorFreezes: week }));
  assert.equal(r3.state, 'REFUSED');
  assert.deepEqual(failing(r3), ['V11']);
  assert.ok(codesOf(r3, 'V11').some((c) => c.startsWith('PREREG_CAP_WEEK')));
  assert.equal(prog.prepare(baseDraft(), baseCtx({ priorFreezes: week.slice(0, 1) })).state, 'WAITING_EXTERNAL');
  assert.equal(prog.prepare(baseDraft(), baseCtx({ priorFreezes: [...week.slice(0, 1), prior('US_EQUITY', '2026-11-24T08:00:00+08:00')] })).state, 'WAITING_EXTERNAL');
  // Sunday 11-22 23:59:59 CST belongs to the previous ISO week (Monday start)
  assert.equal(prog.prepare(baseDraft(), baseCtx({ priorFreezes: [prior('CN_A', '2026-11-22T23:59:59+08:00'), prior('CN_A', '2026-11-22T10:00:00+08:00')] })).state, 'WAITING_EXTERNAL');
  const month6 = ['2026-11-02', '2026-11-03', '2026-11-09', '2026-11-10', '2026-11-16', '2026-11-17'].map((d) => prior('CN_A', `${d}T10:00:00+08:00`));
  const r7 = prog.prepare(baseDraft(), baseCtx({ priorFreezes: month6 }));
  assert.equal(r7.state, 'REFUSED');
  assert.deepEqual(failing(r7), ['V11']);
  assert.ok(codesOf(r7, 'V11').some((c) => c.startsWith('PREREG_CAP_MONTH')));
  assert.equal(prog.prepare(baseDraft(), baseCtx({ priorFreezes: month6.slice(1) })).state, 'WAITING_EXTERNAL');
  // 20 counting arms are allowed, 21 are not (see the V11 counter-example in the validators test)
  const { armsOf } = fx;
  const d20 = baseDraft();
  d20.arms = armsOf(20);
  d20.comparison.baseline_label = 'BASE';
  assert.equal(prog.prepare(d20, baseCtx()).state, 'WAITING_EXTERNAL');
});
