'use strict';

/**
 * The controlled read of the label table (contract section 7.1 LB-3, LB-4, LB-5; section 10 condition 3).
 *
 * Isolation is NOT a new permission system. The label directory is registered as a controlled data directory of the existing W20 authority layer
 * (services/independent-verifier/authority.js; hosts list such directories in QRP_HOLDOUT_DATA_DIRS or pass `holdoutDirs`). `authority.authorize({action: 'READ_FILE'})`
 * then refuses every principal but the evaluator (the holdout scorer principal): mining-generator and review-agent get HOLDOUT_DIR_READ_REFUSED, any unregistered
 * principal (a K2 drafter included) gets VERIFIER_PRINCIPAL_UNKNOWN. A generator process additionally takes the existing process lock (launcher.lockGenerator), which refuses
 * the file read itself. A directory that is not registered is refused here (LABEL_STORE_NOT_PROTECTED): the authority layer allows reads of directories it does not control,
 * so silence would be a hole. Every read leaves a read record (LB-5) and a row in the W24 hash chained access log; every refusal leaves a refused row.
 *
 * Stage gate (LB-4): trial-ledger segmentsFor. SEEN readable. UNSEEN only as the registered K2's own first read, never for a program frozen K2 (RF1118 star P3).
 * FORWARD_RESERVED only for its holder, after its declared read time, then FORWARD_READ. A read appends a DATA_SEGMENT_MARK_V1 SEEN mark through the existing markSegments
 * (W05 ruling: the ledger holds the marks, no range is computed here); replaying the same read adds a read record but no second mark.
 */
const { read } = require('../../packages/ledger');
const trials = require('../trial-ledger');
const authority = require('../independent-verifier/authority');
const accessLog = require('../independent-verifier/access-log');
const { PROGRAM, FROZEN_BY_LABEL } = require('../k2-freeze-program/program_freeze_gate');
const { appendLine } = require('./store');
const join = require('./join');
const v = require('./vocab');

const { fail, need, sha256, canonicalJson } = v;
const COORDINATOR = 'COORDINATOR';
const DAY = 86400000;
const addDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** The hash of a read record: its content without `sha256`. */
function readRecordHashOf(rec) {
  const { sha256: _s, ...rest } = rec;
  return sha256(canonicalJson(rest));
}

/** Who froze this K2, read from the same section 0 line the K2 freeze program reads (program_freeze_gate.js). */
function frozenByOf(text) {
  const at = text.indexOf(FROZEN_BY_LABEL);
  if (at < 0) return null;
  const line = text.slice(at + FROZEN_BY_LABEL.length).split('\n')[0];
  if (line.includes(`冻结者 ${PROGRAM}`)) return PROGRAM;
  if (line.includes(`冻结者 ${COORDINATOR}`)) return COORDINATOR;
  return 'UNKNOWN';
}

function validateRequest(r) {
  const bad = (d) => fail('LABEL_READ_REQUEST_INVALID', d);
  if (!v.isObj(r)) bad('request');
  if (!v.isText(r.principal)) bad('principal');
  if (!v.isObj(r.k2Ref) || !v.isText(r.k2Ref.id) || !v.SHA64.test(r.k2Ref.sha256 || '')) bad('k2Ref');
  if (!v.READ_STAGES.includes(r.stage)) bad(`stage:${r.stage}`);
  if (!v.MARKETS.includes(r.market)) bad(`market:${r.market}`);
  if (!Array.isArray(r.families) || !r.families.length || !r.families.every(v.isText) || new Set(r.families).size !== r.families.length) bad('families');
  if (!v.DATE.test(r.from || '') || !v.DATE.test(r.to || '') || r.from > r.to) bad(`range:${r.from}..${r.to}`);
  if (!Array.isArray(r.windows) || !r.windows.length || new Set(r.windows).size !== r.windows.length) bad('windows');
  for (const w of r.windows) { try { v.parseWindowId(r.market, w); } catch { bad(`window:${w}`); } }
  if (!v.isIso(r.readAt)) bad('readAt');
  if (!Array.isArray(r.panelRecords)) bad('panelRecords');
  if (r.forward !== undefined && !(v.isObj(r.forward) && v.isText(r.forward.shadowRef) && v.isIso(r.forward.declaredReadAt))) bad('forward');
}

const readKeyOf = (r) => sha256(canonicalJson({ k2Sha256: r.k2Ref.sha256, stage: r.stage, market: r.market, families: [...r.families].sort(), from: r.from, to: r.to, windows: [...r.windows].sort(), forward: r.forward || null }));

/** UNSEEN: only the K2's own first read, and never a program frozen K2. */
function checkUnseen(family, r, ctx) {
  const no = (why) => fail('LABEL_READ_UNSEEN_NOT_PERMITTED', `${family}:${why}`);
  if (r.stage !== 'UNSEEN_FIRST_READ') no('STAGE_NOT_UNSEEN_FIRST_READ');
  const bytes = typeof ctx.k2Bytes === 'function' ? ctx.k2Bytes(r.k2Ref) : null;
  if (!bytes) no('K2_UNREADABLE');
  if (sha256(bytes) !== r.k2Ref.sha256) no('K2_BYTES_MISMATCH');
  const by = frozenByOf(bytes.toString('utf8'));
  if (by === PROGRAM) no('PROGRAM_FROZEN_K2');
  if (by !== COORDINATOR) no('FROZEN_BY_NOT_COORDINATOR');
  const registered = read(trials.TRIALS()).some((t) => t.schema === 'RESEARCH_TRIAL_V1' && t.row_kind === 'REGISTRATION' && t.family_id === family && t.k2_sha256 === r.k2Ref.sha256);
  if (!registered) no('K2_NOT_REGISTERED_FOR_FAMILY');
}

/** FORWARD_RESERVED days (a FORWARD_READ later on the same days and shadow closes the reservation): holder, declared read time. Returns the holder's runs of days. */
function checkForward(family, reservations, r) {
  const state = new Map(); // day -> Map(shadow -> label), marks in ledger order, the later one wins
  for (const res of reservations) {
    for (let d = res.from; d <= res.to; d = addDay(d)) {
      if (!state.has(d)) state.set(d, new Map());
      state.get(d).set(res.shadow_ref, res.label);
    }
  }
  const reserved = [];
  const holders = new Set();
  for (const [day, shadows] of [...state.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const [shadow, label] of shadows) if (label === 'FORWARD_RESERVED') { reserved.push(day); holders.add(shadow); }
  }
  if (!reserved.length) return [];
  if (r.stage !== 'FORWARD' || !r.forward || holders.size !== 1 || !holders.has(r.forward.shadowRef)) fail('LABEL_READ_FORWARD_NOT_PERMITTED', `${family}:${[...holders].join(',')}`);
  if (Date.parse(r.readAt) < Date.parse(r.forward.declaredReadAt)) fail('LABEL_READ_FORWARD_BEFORE_READ_TIME', `${family}:${r.forward.declaredReadAt}`);
  const runs = [];
  for (const day of [...new Set(reserved)].sort()) {
    const last = runs[runs.length - 1];
    if (last && addDay(last.to) === day) last.to = day; else runs.push({ from: day, to: day });
  }
  return runs.map((run) => ({ family, shadowRef: r.forward.shadowRef, ...run }));
}

/** The whole gate for every declared family. @returns {{from, to, family, shadowRef}[]} the reserved ranges the holder reads (to be marked FORWARD_READ) */
function stageGate(r, ctx) {
  const forwardReads = [];
  for (const family of r.families) {
    const { pieces, reservations } = trials.segmentsFor(family, r.from, r.to);
    if (pieces.some((p) => p.label === 'UNSEEN')) checkUnseen(family, r, ctx);
    forwardReads.push(...checkForward(family, reservations, r));
  }
  return forwardReads;
}

/** SEEN (and FORWARD_READ) marks for this read, through the existing markSegments; skipped for a family whose mark for this same read is already in the ledger. */
function writeMarks(r, record, forwardReads, ctx) {
  const existing = read(trials.SEGMENTS());
  const sourceRef = { kind: 'PANEL_LABEL_READ', read_record_sha256: record.sha256, read_key: record.readKey, k2_sha256: r.k2Ref.sha256, stage: r.stage };
  const specs = [];
  const done = (family, label, from, to) => existing.some((m) => m.family_id === family && m.label === label && m.from === from && m.to === to
    && (m.source_refs || []).some((s) => s && s.kind === 'PANEL_LABEL_READ' && s.read_key === record.readKey));
  for (const family of r.families) {
    const base = { family_id: family, market: v.QRP_MARKET[r.market], reason: `PANEL_LABEL_READ ${r.k2Ref.id} ${r.stage}`, source_refs: [sourceRef] };
    if (!done(family, 'SEEN', r.from, r.to)) specs.push({ ...base, from: r.from, to: r.to, label: 'SEEN', seen_kind: null });
    for (const f of forwardReads.filter((x) => x.family === family)) {
      if (!done(family, 'FORWARD_READ', f.from, f.to)) specs.push({ ...base, from: f.from, to: f.to, label: 'FORWARD_READ', shadow_ref: f.shadowRef });
    }
  }
  return specs.length ? trials.markSegments(specs, { registeredBy: ctx.registeredBy, registeredAt: r.readAt }) : [];
}

const inRange = (r, idx, label) => {
  const hit = idx.get(label.candidateId);
  if (!hit || hit.record.market !== r.market) return false;
  const day = hit.record.sessionDate;
  if (day < r.from || day > r.to) return false;
  return label.state !== 'VALUE' || v.localDate(r.market, label.exitAt) <= r.to; // a value whose window ends after the range would show prices the gate did not check
};

/**
 * @param {{principal: string, k2Ref: {id: string, sha256: string}, stage: string, market: string, families: string[], from: string, to: string, windows: string[],
 *   readAt: string, panelRecords: object[], forward?: {shadowRef: string, declaredReadAt: string}}} request
 * @param {{store: object, holdoutDirs?: string[], accessLogFile: string, readLedgerFile: string, registeredBy: string, k2Bytes?: (ref: object) => Buffer|null}} ctx
 * @returns {{rows: object[], record: object, marks: object[]}}
 */
function readLabels(request, ctx) {
  need(v.isObj(ctx) && ctx.store && v.isText(ctx.accessLogFile) && v.isText(ctx.readLedgerFile), 'LABEL_READ_CONTEXT_INVALID');
  const log = accessLog.writer(ctx.accessLogFile);
  const refuse = (e) => {
    try { log.record({ principal: String(request.principal), op: 'HOLDOUT_READ_REFUSED', dataset: v.READ_DATASET, from: request.from, to: request.to, code: e.code || 'LABEL_READ_REFUSED' }); } catch { /* an unloggable request is still refused */ }
    throw e;
  };
  const guard = (f) => { try { return f(); } catch (e) { return refuse(e); } };

  guard(() => {
    const dirs = authority.holdoutDirsOf(ctx);
    if (!dirs.some((d) => authority.internals.within(ctx.store.file, d))) fail('LABEL_STORE_NOT_PROTECTED', ctx.store.file);
    authority.authorize({ principal: request && request.principal, action: 'READ_FILE', target: ctx.store.file }, ctx);
  });
  validateRequest(request);
  const forwardReads = guard(() => stageGate(request, ctx));

  const idx = join.indexPanel(request.panelRecords);
  const wanted = new Set(request.windows);
  const labels = [...ctx.store.heads().values()].filter((l) => wanted.has(l.windowId) && inRange(request, idx, l))
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : a.windowId < b.windowId ? -1 : 1));
  const rows = join.joinLabels({ labels, panelRecords: request.panelRecords });

  const body = {
    schema: 'PANEL_LABEL_READ_V1', readerRole: request.principal, k2Ref: { id: request.k2Ref.id, sha256: request.k2Ref.sha256 }, stage: request.stage, market: request.market,
    families: request.families, from: request.from, to: request.to, windows: request.windows, readAt: request.readAt, rowsReturned: rows.length,
    rowsSha256: sha256(canonicalJson(rows.map((x) => ({ candidateId: x.candidateId, windowId: x.windowId, state: x.state, reasonCode: x.reasonCode, labelHash: x.label.labelHash })))),
    readKey: readKeyOf(request),
  };
  if (request.forward) body.forward = { shadowRef: request.forward.shadowRef, declaredReadAt: request.forward.declaredReadAt };
  const record = { ...body, sha256: sha256(canonicalJson(body)) };
  appendLine(ctx.readLedgerFile, record);
  let marks;
  try { marks = writeMarks(request, record, forwardReads, ctx); } catch (e) {
    appendLine(ctx.readLedgerFile, { schema: 'PANEL_LABEL_READ_ABORTED_V1', readRecordSha256: record.sha256, code: e.code || 'UNKNOWN', reason: String(e.message).slice(0, 200) });
    throw new v.PanelLabelError('LABEL_READ_MARK_FAILED', e.code || e.message);
  }
  log.record({ principal: request.principal, op: 'READ', dataset: v.READ_DATASET, from: request.from, to: request.to });
  return { rows, record, marks };
}

module.exports = { readRecordHashOf, frozenByOf, stageGate, readLabels };
