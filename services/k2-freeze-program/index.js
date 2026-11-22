'use strict';

/**
 * K2_FREEZE_PROGRAM_V1 (RF1118 r2; AUTONOMOUS_RESEARCH_QUEUE_V1 Q3). The program, not an AI, decides whether a K2 draft is frozen:
 *
 *   prepare(draft, ctx)                       validators V1-V8, V10, V11, V14 (and the id/clock part of V12); renders the K2 text; builds the TRL
 *                                             registration request; waits for the Mac registrar: WAITING_EXTERNAL:TRL_RECEIPT.
 *   finalize(draft, receipts, ctx, prepared)  re-runs everything, then V9 (TRL rows before the freeze), V12, V13; on 14 passes writes the frozen text, its
 *                                             sidecar, the prior table, the validation report and the freeze page (all 0444) and returns the queue line;
 *                                             otherwise writes a refusal file (0444) and returns reason codes.
 *
 * No clock is read here (ctx.now is the host clock handed in by the caller), no model is called, nothing is fetched. Same inputs, same bytes.
 * This is the only module that writes a FREEZE_PROGRAM page (AQ-42): there is no exported writer.
 */
const fs = require('fs');
const path = require('path');
const trials = require('../trial-ledger');
const { sha256, canonicalJson, prettyJson, isObj, isCstStamp, codeOf } = require('./common');
const rf1118 = require('./rf1118');
const templates = require('./templates');
const queueLine = require('./queue_line');
const render = require('./render');
const val = require('./validators');
const schema = require('./schema');

const PROGRAM = 'K2_FREEZE_PROGRAM_V1';
const MAX_REVISION = 3;

/** Version sha of the program: its own source files plus the template library, in a fixed order. */
function programSha256() {
  const dir = __dirname;
  const parts = fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort().map((n) => `${n}\0${sha256(fs.readFileSync(path.join(dir, n)))}`);
  parts.push(`k2_decision_table_templates.v1.json\0${sha256(fs.readFileSync(templates.FILE))}`);
  return sha256(parts.join('\n'));
}
const PROGRAM_SHA256 = programSha256();

const names = (id) => ({ page: `${id}_K2_V1_FREEZE_PROGRAM_1.md`, report: `${id}_K2_V1_VALIDATION_REPORT_1.json` });
const k2Name = (id, sha) => `${id}_K2_V1.frozen.${sha.slice(0, 8)}.md`;
const tableName = (id, sha) => `${id}_K2_V1.prior_table.${sha.slice(0, 8)}.json`;
const sidecar = (sha, name) => Buffer.from(`${sha}  ${name}\n`);

function existingFreeze(ctx, id) {
  if (!ctx.outDir || !val.ID_RE.test(id)) return null;
  const file = path.join(ctx.outDir, id, names(id).page);
  if (!fs.existsSync(file)) return null;
  const m = /```json K2_PROGRAM_FREEZE_PAGE_V1\n([\s\S]*?)\n```/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) return { k2_sha256: null, file };
  try { const block = JSON.parse(m[1]); return { k2_sha256: block.k2_sha256, block, file }; } catch { return { k2_sha256: null, file }; }
}

/** Mode gates before any validator runs (AQ-42). A draft that cannot be frozen by the program goes back to the coordinator freeze path. */
function gates(draft, ctx) {
  const frozen = ctx.rf1118 || rf1118.FREEZE;
  if (!rf1118.isBound(frozen)) return { code: 'PREREG_RF1118_NOT_FROZEN' };
  if (isCstStamp(ctx.now) && Date.parse(ctx.now) < Date.parse(rf1118.EFFECTIVE_FROM)) return { code: 'PREREG_RF1118_NOT_EFFECTIVE' };
  if ((ctx.freezeMode || 'PROGRAM') !== 'PROGRAM') return { code: 'PREREG_MODE_DRAFT_ONLY' };
  const down = ctx.downgradedClasses || [];
  if (down.length && isObj(draft) && isObj(draft.section0) && Array.isArray(draft.section0.mechanism_ids)) {
    const classes = [...new Set(draft.section0.mechanism_ids.map((id) => `${draft.market}:${val.prefixOf(id)}`))];
    if (down.includes('*') || classes.some((c) => down.includes(c))) return { code: 'PREREG_CLASS_DOWNGRADED' };
  }
  return null;
}

function skipped(id, reason) { return { v: id, name: val.NAMES[id], state: 'NOT_RUN', codes: [], reason }; }

/** Runs every validator that can run in this phase. */
function evaluate(draft, ctx, opts) {
  const mutantV1 = process.env.QRP_TEST_K2_PROGRAM_MUTANT === '1' && Array.isArray(ctx.testDisableValidators) && ctx.testDisableValidators.includes('V1');
  try { return evaluateAll(draft, ctx, opts, mutantV1); } catch (e) {
    if (!mutantV1) throw e; // only the V1 mutant may meet a malformed draft past the schema check
    return { results: val.ORDER.map((id) => (id === 'V1' ? { v: 'V1', name: val.NAMES.V1, state: 'PASS', codes: [], reason: 'MUTANT_DISABLED' } : skipped(id, 'MUTANT_V1_MALFORMED_DRAFT'))), text: null, k2Sha: null, table: null, asOf: null, trlRequest: null };
  }
}

function evaluateAll(draft, ctx, { phase, prepared = null, receipts = null }, mutantV1) {
  const out = { results: [], text: null, k2Sha: null, table: null, asOf: null, trlRequest: null };
  const v1 = schema.validate(draft);
  if (v1.length && !mutantV1) {
    out.results = val.ORDER.map((id) => (id === 'V1' ? { v: 'V1', name: val.NAMES.V1, state: 'REFUSED', codes: v1 } : skipped(id, 'SCHEMA_INVALID')));
    return out;
  }
  const run1 = { v: 'V1', name: val.NAMES.V1, state: 'PASS', codes: [], ...(v1.length ? { reason: 'MUTANT_DISABLED' } : {}) };
  if (!isCstStamp(ctx.now)) {
    out.results = val.ORDER.map((id) => (id === 'V1' ? run1 : id === 'V12' ? { v: 'V12', name: val.NAMES.V12, state: 'REFUSED', codes: ['PREREG_ARTIFACT_CLOCK'] } : skipped(id, 'CLOCK_INVALID')));
    return out;
  }
  const asOf = phase === 'FINALIZE' && prepared && isCstStamp(prepared.as_of) ? prepared.as_of : ctx.now;
  const table = val.priorTable(draft, ctx, asOf);
  const text = render.renderK2(draft, { priorTableSha256: table.sha256 });
  const k2Sha = sha256(text);
  const preparedMismatch = phase === 'FINALIZE' && Boolean(prepared) && typeof prepared.k2_sha256 === 'string' && prepared.k2_sha256 !== k2Sha;
  const st = { draft, ctx, text, k2Sha, table, asOf, phase, receipts, prepared, preparedMismatch, existing: existingFreeze(ctx, draft.draft_id) };
  const labels = (() => { try { return trials.segmentLabels(draft.family_id, draft.sample.from, draft.sample.to, { marks: ctx.marks || [] }); } catch { return []; } })();
  Object.assign(out, { text, k2Sha, table, asOf, trlRequest: render.trlRequest(draft, k2Sha, labels) });
  for (const id of val.ORDER) {
    if (id === 'V1') { out.results.push(run1); continue; }
    if (id === 'V9') {
      if (preparedMismatch) out.results.push(skipped('V9', 'PREPARED_MISMATCH'));
      else if (phase !== 'FINALIZE') out.results.push({ v: 'V9', name: val.NAMES.V9, state: 'PENDING', codes: [], reason: 'TRL_RECEIPT' });
      else if (!receipts) out.results.push({ v: 'V9', name: val.NAMES.V9, state: 'PENDING', codes: [], reason: 'TRL_RECEIPT' });
      else out.results.push(val.runOne('V9', st));
      continue;
    }
    out.results.push(val.runOne(id, st));
  }
  return out;
}

const refusedCodes = (results) => [...new Set(results.filter((r) => r.state === 'REFUSED').flatMap((r) => r.codes))].sort();
const nextOf = (revision) => (revision >= MAX_REVISION ? 'WAITING_EXTERNAL:PREREG_REFUSED' : 'REVISE');

/** Refusal file: 0444, named by draft id, attempt and draft sha; identical content is never rewritten. */
function refusal(draft, ctx, results, codes) {
  const draftSha = sha256(canonicalJson(draft));
  const revision = isObj(draft) && Number.isInteger(draft.revision) ? draft.revision : 0;
  const next = nextOf(revision);
  const bytes = render.renderRefusal({ draft, draftSha256: draftSha, attempt: revision + 1, results, codes, next, programSha256: PROGRAM_SHA256 });
  const id = isObj(draft) && typeof draft.draft_id === 'string' ? draft.draft_id : 'UNKNOWN';
  const name = `${id}_K2_V1_PREREG_REFUSAL_${revision + 1}.${draftSha.slice(0, 8)}.json`;
  if (ctx.outDir && val.ID_RE.test(id)) {
    const dir = path.join(ctx.outDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { fs.writeFileSync(file, bytes, { mode: 0o444, flag: 'wx' }); fs.chmodSync(file, 0o444); }
  }
  return { next, agent_view: { codes }, refusal: { name, bytes } };
}

function precheck(draft, ctx) {
  const g = gates(draft, ctx);
  if (g) return { state: 'WAITING_FREEZE', code: g.code, results: [], codes: [g.code] };
  if (isObj(draft) && Number.isInteger(draft.revision) && draft.revision > MAX_REVISION) {
    const results = val.ORDER.map((id) => skipped(id, 'REVISION_LIMIT'));
    const codes = ['PREREG_REVISION_LIMIT'];
    return { state: 'REFUSED', codes, results, ...refusal(draft, ctx, results, codes) };
  }
  return null;
}

function prepare(draft, ctx) {
  const pre = precheck(draft, ctx);
  if (pre) return pre;
  const ev = evaluate(draft, ctx, { phase: 'PREPARE' });
  const codes = refusedCodes(ev.results);
  if (codes.length) return { state: 'REFUSED', codes, results: ev.results, ...refusal(draft, ctx, ev.results, codes) };
  if (!ev.k2Sha) return { state: 'REFUSED', codes: ['PREREG_INTERNAL_ERROR:MUTANT_V1_MALFORMED_DRAFT'], results: ev.results }; // only reachable with the V1 test mutant
  const trialIds = draft.arms.map((a) => render.trialIdOf(draft, a));
  const prepared = { schema: 'K2_PREPARED_V1', draft_sha256: sha256(canonicalJson(draft)), as_of: ctx.now, k2_sha256: ev.k2Sha, prior_table_sha256: ev.table.sha256, request_sha256: sha256(canonicalJson(ev.trlRequest)) };
  return { state: 'WAITING_EXTERNAL', code: 'TRL_RECEIPT', results: ev.results, k2_text: ev.text, k2_sha256: ev.k2Sha, prior_table_sha256: ev.table.sha256, prior_table_bytes: ev.table.bytes,
    trl_request: ev.trlRequest, trial_ids: trialIds, prepared };
}

function writeAll(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  try {
    for (const [name, bytes] of files) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes, { mode: 0o444, flag: 'wx' });
      fs.chmodSync(file, 0o444);
      written.push(file);
    }
    const bad = written.filter((f) => (fs.statSync(f).mode & 0o777) !== 0o444);
    if (bad.length) throw Object.assign(new Error('mode'), { code: 'PREREG_ARTIFACT_MODE' });
  } catch (e) {
    for (const f of written) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
    throw e;
  }
}

function finalize(draft, receipts, ctx, prepared) {
  const pre = precheck(draft, ctx);
  if (pre) return pre;
  const ev = evaluate(draft, ctx, { phase: 'FINALIZE', prepared, receipts });
  const results = ev.results;
  const codes = refusedCodes(results);
  if (codes.length) return { state: 'REFUSED', codes, results, ...refusal(draft, ctx, results, codes) };
  if (!ev.k2Sha) return { state: 'REFUSED', codes: ['PREREG_INTERNAL_ERROR:MUTANT_V1_MALFORMED_DRAFT'], results };
  // replay: the same K2 was already frozen here; return what is on disk, never rewrite
  const existing = existingFreeze(ctx, draft.draft_id);
  if (existing && existing.k2_sha256 === ev.k2Sha && existing.block) {
    return { state: 'FROZEN', replay: true, results, k2_sha256: ev.k2Sha, k2_frozen_at: existing.block.k2_frozen_at, trial_ids: existing.block.trial_ids,
      queue_line: queueLine.lineFor({ draftId: draft.draft_id, k2Sha: ev.k2Sha, pageSha: sha256(fs.readFileSync(existing.file)), market: draft.market, host: ctx.host || 'LINUX' }) };
  }
  if (!receipts) return { state: 'WAITING_EXTERNAL', code: 'TRL_RECEIPT', results, k2_sha256: ev.k2Sha, prepared };
  const finalResults = results; // with a receipt in hand V9, V12 and V13 have been evaluated: no PENDING remains
  const trialIds = draft.arms.map((a) => render.trialIdOf(draft, a));
  const n = trials.count(draft.family_id, { rows: Array.isArray(ctx.ledgerRows) ? ctx.ledgerRows : [], asOf: ctx.now });
  const report = render.renderReport({ draft, draftSha256: sha256(canonicalJson(draft)), k2Sha256: ev.k2Sha, k2FrozenAt: ctx.now, results: finalResults, programSha256: PROGRAM_SHA256, libSha256: templates.LIBRARY.library_sha256 });
  const id = draft.draft_id;
  const n_ = names(id);
  const block = {
    schema: 'K2_PROGRAM_FREEZE_PAGE_V1', draft_id: id, market: draft.market, family_id: draft.family_id, study_ref: draft.study_ref, k2_sha256: ev.k2Sha, k2_file: k2Name(id, ev.k2Sha),
    k2_frozen_at: ctx.now, report_file: n_.report, report_sha256: sha256(report), program_version: PROGRAM, program_sha256: PROGRAM_SHA256, authored_by: draft.authored_by, frozen_by: PROGRAM,
    rf1118: { path: rf1118.FREEZE.path, sha256: rf1118.FREEZE.sha256, effective_from: rf1118.EFFECTIVE_FROM }, template_library_sha256: templates.LIBRARY.library_sha256,
    prior_table: { file: tableName(id, ev.table.sha256), sha256: ev.table.sha256 }, trial_ids: [...trialIds].sort(),
    family_n: { family_id: draft.family_id, n_raw: n.n_raw, n_distinct_configs: n.n_distinct_configs, n_is_lower_bound: n.n_is_lower_bound }, host: ctx.host || 'LINUX',
  };
  const page = render.renderPage({ block });
  const files = [
    [k2Name(id, ev.k2Sha), Buffer.from(ev.text)], [`${k2Name(id, ev.k2Sha)}.sha256`, sidecar(ev.k2Sha, k2Name(id, ev.k2Sha))],
    [tableName(id, ev.table.sha256), ev.table.bytes], [`${tableName(id, ev.table.sha256)}.sha256`, sidecar(ev.table.sha256, tableName(id, ev.table.sha256))],
    [n_.report, report], [`${n_.report}.sha256`, sidecar(sha256(report), n_.report)],
    [n_.page, page], [`${n_.page}.sha256`, sidecar(sha256(page), n_.page)],
  ];
  if (!ctx.outDir) return { state: 'REFUSED', codes: ['PREREG_ARTIFACT_NO_OUTDIR'], results, ...refusal(draft, ctx, results, ['PREREG_ARTIFACT_NO_OUTDIR']) };
  try { writeAll(path.join(ctx.outDir, id), files); } catch (e) {
    const code = codeOf(e);
    const r2 = results.map((r) => (r.v === 'V12' ? { ...r, state: 'REFUSED', codes: [code] } : r));
    return { state: 'REFUSED', codes: [code], results: r2, ...refusal(draft, ctx, r2, [code]) };
  }
  return { state: 'FROZEN', results: finalResults, k2_sha256: ev.k2Sha, k2_frozen_at: ctx.now, trial_ids: trialIds, page_sha256: sha256(page), report_sha256: sha256(report),
    queue_line: queueLine.lineFor({ draftId: id, k2Sha: ev.k2Sha, pageSha: sha256(page), market: draft.market, host: ctx.host || 'LINUX' }), files: files.map(([name, bytes]) => ({ name, sha256: sha256(bytes) })) };
}

module.exports = { PROGRAM, PROGRAM_SHA256, MAX_REVISION, prepare, finalize, internals: { evaluate, gates, existingFreeze, prettyJson } };
