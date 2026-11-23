'use strict';

/**
 * The controlled read of the label table (contract section 7.1 LB-3, LB-4, LB-5; section 10 condition 3; NOTE_1; independent review P1, P2).
 *
 * Isolation is NOT a new permission system. The label directory is registered as a controlled data directory of the existing W20 authority layer
 * (services/independent-verifier/authority.js) through the HOST list QRP_HOLDOUT_DATA_DIRS, the same list the generator process lock reads; a caller's context cannot name
 * the protected directories or the config. `authority.authorize({action: 'READ_FILE'})` then refuses every principal but the evaluator (the holdout scorer principal):
 * mining-generator and review-agent get HOLDOUT_DIR_READ_REFUSED, any unregistered principal (a K2 drafter included) gets VERIFIER_PRINCIPAL_UNKNOWN. A generator process
 * additionally takes the existing process lock (launcher.lockGenerator), which refuses the file read itself. A directory that is not on the host list is refused here
 * (LABEL_STORE_NOT_PROTECTED): the authority layer allows reads of directories it does not control, so silence would be a hole.
 * Every read leaves a read record (LB-5) and a row in the W24 hash chained access log; every refusal leaves a refused row.
 *
 * Gate (in this order, every stage): the K2 is bound (its bytes hash to k2Ref.sha256 and the trial ledger holds a REGISTRATION row (family, K2) for EACH declared family, in the
 * requested market: LABEL_READ_MARKET_MISMATCH otherwise);
 * no FORWARD_RESERVED day of ANY family of the market in [from, to] unless the requester is that family's holder, and a holder is refused too
 * (FORWARD_READ_TIME_NOT_IN_LEDGER: the ledger holds no declared read time, so this version never converts a reservation to FORWARD_READ); UNSEEN only as the bound
 * coordinator-frozen K2's own first read (RF1118 star P3), and no day UNSEEN for another family of the market (LABEL_READ_CROSS_FAMILY_UNSEEN, NOTE_2). The read time is the host clock (ctx.now, default the ledger clock); the request's own time is not used.
 * A passed read appends a DATA_SEGMENT_MARK_V1 SEEN mark through the existing markSegments (W05 ruling: the ledger holds the marks, no range is computed here);
 * replaying the same read adds a read record but no second mark.
 */
const fs = require('fs');
const path = require('path');
const { read, now: ledgerNow } = require('../../packages/ledger');
const trials = require('../trial-ledger');
const authority = require('../independent-verifier/authority');
const accessLog = require('../independent-verifier/access-log');
const { PROGRAM, FROZEN_BY_LABEL } = require('../k2-freeze-program/program_freeze_gate');
const { appendLine } = require('./store');
const chain = require('./chain');
const join = require('./join');
const v = require('./vocab');

const { fail, need, sha256, canonicalJson } = v;
const ROOT = path.join(__dirname, '..', '..');
const COORDINATOR = 'COORDINATOR';
const DAY = 86400000;
const addDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** The hash of a read record: its content without `sha256`. */
function readRecordHashOf(rec) {
  const { sha256: _s, ...rest } = rec;
  return sha256(canonicalJson(rest));
}

/** Who froze this K2, read from the same section 0 line the K2 freeze program reads (program_freeze_gate.js; a parity test holds the two together). */
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
  if (!Array.isArray(r.panelRecords)) bad('panelRecords');
  if (r.forward !== undefined && !(v.isObj(r.forward) && v.isText(r.forward.shadowRef))) bad('forward');
}

const readKeyOf = (r) => sha256(canonicalJson({ k2Sha256: r.k2Ref.sha256, stage: r.stage, market: r.market, families: [...r.families].sort(), from: r.from, to: r.to, windows: [...r.windows].sort() }));

/** P1-1: the K2 is bound at every stage. @returns {{bytes: Buffer, markets: Map}} family -> the market its registration row names */
function bindK2(r, ctx) {
  const no = (why) => fail('LABEL_READ_K2_NOT_BOUND', why);
  const bytes = typeof ctx.k2Bytes === 'function' ? ctx.k2Bytes(r.k2Ref) : null;
  if (!bytes) no('K2_UNREADABLE');
  if (sha256(bytes) !== r.k2Ref.sha256) no('K2_BYTES_MISMATCH');
  const rows = read(trials.TRIALS()).filter((t) => t.schema === 'RESEARCH_TRIAL_V1' && t.row_kind === 'REGISTRATION' && t.k2_sha256 === r.k2Ref.sha256);
  const markets = new Map();
  for (const family of r.families) {
    const row = rows.find((t) => t.family_id === family);
    if (!row) no(`K2_NOT_REGISTERED_FOR_FAMILY:${family}`);
    if (!v.MARKET_MARK_NAMES[r.market].includes(row.market)) fail('LABEL_READ_MARKET_MISMATCH', `${family}:${row.market} is not ${r.market}`);
    markets.set(family, row.market);
  }
  return { bytes, markets };
}

/**
 * NOTE_1 items 3 and 4: labels are per market, marks per family. Every family the ledger holds marks for in this market (and every declared family) is looked at: a
 * FORWARD_RESERVED day in [from, to] (not closed by a later FORWARD_READ of the same shadow) refuses the read unless the requester is that family's holder, and a holder is
 * refused with FORWARD_READ_TIME_NOT_IN_LEDGER. A stage FORWARD request is closed in this version whether or not anything is reserved.
 */
function forwardGate(r) {
  const all = read(trials.SEGMENTS()).filter((m) => m.schema === 'DATA_SEGMENT_MARK_V1');
  const names = v.MARKET_MARK_NAMES[r.market];
  const families = new Set([...all.filter((m) => names.includes(m.market)).map((m) => m.family_id), ...r.families]);
  const reserved = new Map(); // family -> the shadows holding a still reserved day of the range
  for (const family of families) {
    const { reservations } = trials.segmentsFor(family, r.from, r.to, { marks: all });
    const state = new Map(); // day -> Map(shadow -> label); marks in ledger order, the later one wins
    for (const res of reservations) {
      for (let d = res.from; d <= res.to; d = addDay(d)) {
        if (!state.has(d)) state.set(d, new Map());
        state.get(d).set(res.shadow_ref, res.label);
      }
    }
    const shadows = new Set();
    for (const byShadow of state.values()) for (const [shadow, label] of byShadow) if (label === 'FORWARD_RESERVED') shadows.add(shadow);
    if (shadows.size) reserved.set(family, shadows);
  }
  if (!reserved.size) {
    if (r.stage === 'FORWARD') fail('FORWARD_READ_TIME_NOT_IN_LEDGER', 'stage FORWARD is closed in this version');
    return;
  }
  const holder = r.stage === 'FORWARD' && r.forward && [...reserved.values()].every((s) => s.size === 1 && s.has(r.forward.shadowRef));
  const detail = [...reserved].map(([f, s]) => `${f}:${[...s].join('+')}`).join(',');
  if (!holder) fail('LABEL_READ_FORWARD_NOT_PERMITTED', detail);
  fail('FORWARD_READ_TIME_NOT_IN_LEDGER', detail);
}

/** UNSEEN: only stage UNSEEN_FIRST_READ, and only for a bound K2 whose section 0 says the coordinator froze it (a program frozen or unknown freezer is refused). */
function unseenGate(r, bound) {
  for (const family of r.families) {
    const { pieces } = trials.segmentsFor(family, r.from, r.to);
    if (!pieces.some((p) => p.label === 'UNSEEN')) continue;
    const no = (why) => fail('LABEL_READ_UNSEEN_NOT_PERMITTED', `${family}:${why}`);
    if (r.stage !== 'UNSEEN_FIRST_READ') no('STAGE_NOT_UNSEEN_FIRST_READ');
    const by = frozenByOf(bound.bytes.toString('utf8'));
    if (by === PROGRAM) no('PROGRAM_FROZEN_K2');
    if (by !== COORDINATOR) no('FROZEN_BY_NOT_COORDINATOR');
  }
}

/**
 * NOTE_2 item 1: labels are per market, UNSEEN per family. A day that is UNSEEN for any family of the market that the request does not declare refuses the whole read:
 * the read would show that family's unseen sample without marking it SEEN, and marking it SEEN would burn it silently. Fail closed, like the FORWARD scan.
 * (The declared families' own UNSEEN days are judged by unseenGate: their own first read.)
 */
function crossFamilyUnseenGate(r) {
  const all = read(trials.SEGMENTS()).filter((m) => m.schema === 'DATA_SEGMENT_MARK_V1');
  const names = v.MARKET_MARK_NAMES[r.market];
  const foreign = new Set(all.filter((m) => names.includes(m.market) && !r.families.includes(m.family_id)).map((m) => m.family_id));
  for (const family of foreign) {
    const { pieces } = trials.segmentsFor(family, r.from, r.to, { marks: all });
    if (pieces.some((p) => p.label === 'UNSEEN')) fail('LABEL_READ_CROSS_FAMILY_UNSEEN', family);
  }
}

/** SEEN marks for this read, through the existing markSegments, stamped with the host clock; skipped for a family whose mark for this same read is already in the ledger. */
function writeMarks(r, record, bound, ctx) {
  const existing = read(trials.SEGMENTS());
  const sourceRef = { kind: 'PANEL_LABEL_READ', read_record_sha256: record.sha256, read_key: record.readKey, k2_sha256: r.k2Ref.sha256, stage: r.stage };
  const specs = [];
  for (const family of r.families) {
    const done = existing.some((m) => m.family_id === family && m.label === 'SEEN' && m.from === r.from && m.to === r.to
      && (m.source_refs || []).some((s) => s && s.kind === 'PANEL_LABEL_READ' && s.read_key === record.readKey));
    if (!done) specs.push({ family_id: family, market: bound.markets.get(family), from: r.from, to: r.to, label: 'SEEN', seen_kind: null, reason: `PANEL_LABEL_READ ${r.k2Ref.id} ${r.stage}`, source_refs: [sourceRef] });
  }
  return specs.length ? trials.markSegments(specs, { registeredBy: ctx.registeredBy, registeredAt: record.readAt }) : [];
}

/** The latest row per (candidate, window) of the verified table. The only file read of the package's read side. */
function loadTable(file) {
  if (!fs.existsSync(file)) return [];
  const heads = new Map();
  for (const e of chain.verify(fs.readFileSync(file, 'utf8'))) heads.set(`${e.label.candidateId}|${e.label.windowId}`, e.label);
  return [...heads.values()];
}

/**
 * P1-3: a label is returned only when its evaluation date is in [from, to], its record is of the requested market, and its window has ended inside the range:
 * exitAt, else maturesAt, on or before `to` (market local date), for EVERY state, so no label shows anything the gate did not check.
 */
const inRange = (r, idx, label) => {
  const hit = join.anyHit(idx, label);
  if (!hit || hit.record.market !== r.market) return false;
  const day = hit.record.sessionDate;
  if (day < r.from || day > r.to) return false;
  return v.localDate(r.market, label.exitAt || label.maturesAt) <= r.to;
};

/**
 * @param {{principal: string, k2Ref: {id: string, sha256: string}, stage: string, market: string, families: string[], from: string, to: string, windows: string[],
 *   panelRecords: object[], forward?: {shadowRef: string}}} request  (a `readAt` in the request is ignored)
 * @param {{store: object, accessLogFile: string, readLedgerFile: string, registeredBy: string, k2Bytes: (ref: object) => Buffer|null, now?: () => string}} ctx
 *   (a `holdoutDirs` or `config` in ctx is ignored: the protected directories come from the host list, the config from the pinned file)
 * @returns {{rows: object[], record: object, marks: object[]}}
 */
function readLabels(request, ctx) {
  need(v.isObj(ctx) && ctx.store && v.isText(ctx.accessLogFile) && v.isText(ctx.readLedgerFile), 'LABEL_READ_CONTEXT_INVALID');
  const readAt = typeof ctx.now === 'function' ? ctx.now() : ledgerNow();
  need(v.isIso(readAt), 'LABEL_READ_CONTEXT_INVALID', 'now');
  const log = accessLog.writer(ctx.accessLogFile);
  const refuse = (e) => {
    try { log.record({ principal: String(request.principal), op: 'HOLDOUT_READ_REFUSED', dataset: v.READ_DATASET, from: request.from, to: request.to, code: e.code || 'LABEL_READ_REFUSED' }); } catch { /* an unloggable request is still refused */ }
    throw e;
  };
  const guard = (f) => { try { return f(); } catch (e) { return refuse(e); } };

  guard(() => {
    const dirs = authority.holdoutDirsOf({}); // the host list only
    if (!dirs.some((d) => authority.internals.within(ctx.store.file, d))) fail('LABEL_STORE_NOT_PROTECTED', ctx.store.file);
    authority.authorize({ principal: request && request.principal, action: 'READ_FILE', target: ctx.store.file }, { holdoutDirs: dirs, repoRoot: ROOT });
  });
  validateRequest(request);
  const bound = guard(() => {
    const b = bindK2(request, ctx);
    forwardGate(request);
    unseenGate(request, b);
    crossFamilyUnseenGate(request);
    return b;
  });

  const labels = loadTable(ctx.store.file);
  const idx = join.indexPanel(request.panelRecords);
  const wanted = new Set(request.windows);
  const chosen = labels.filter((l) => wanted.has(l.windowId) && inRange(request, idx, l))
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : a.windowId < b.windowId ? -1 : 1));
  const rows = join.joinLabels({ labels: chosen, panelRecords: request.panelRecords });

  const body = {
    schema: 'PANEL_LABEL_READ_V1', readerRole: request.principal, k2Ref: { id: request.k2Ref.id, sha256: request.k2Ref.sha256 }, stage: request.stage, market: request.market,
    families: request.families, from: request.from, to: request.to, windows: request.windows, readAt, rowsReturned: rows.length,
    rowsSha256: sha256(canonicalJson(rows.map((x) => ({ candidateId: x.candidateId, windowId: x.windowId, state: x.state, reasonCode: x.reasonCode, labelHash: x.label.labelHash })))),
    readKey: readKeyOf(request),
  };
  const record = { ...body, sha256: sha256(canonicalJson(body)) };
  appendLine(ctx.readLedgerFile, record);
  let marks;
  try { marks = writeMarks(request, record, bound, ctx); } catch (e) {
    appendLine(ctx.readLedgerFile, { schema: 'PANEL_LABEL_READ_ABORTED_V1', readRecordSha256: record.sha256, code: e.code || 'UNKNOWN', reason: String(e.message).slice(0, 200) });
    throw new v.PanelLabelError('LABEL_READ_MARK_FAILED', e.code || e.message);
  }
  log.record({ principal: request.principal, op: 'READ', dataset: v.READ_DATASET, from: request.from, to: request.to });
  return { rows, record, marks };
}

module.exports = { readRecordHashOf, frozenByOf, readLabels };
