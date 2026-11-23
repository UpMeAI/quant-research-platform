#!/usr/bin/env node
'use strict';

/**
 * RF1116 R2 end-resolution record, resolver, window-parameterised scoring and the pending seal: mutation check of their guards. Each mutant changes one condition and the tests in
 * tests/mining_segment_resolution.test.js, tests/mining_r2_scoring.test.js and tests/mining_holdout_segment_registry.test.js must go red.
 *   node tools/mining-r2-scorer-mutation-check.js [--only M01,M07] [--head <sha>] [--write docs/evidence/rf1116-r2-scorer-v1/MUTATION_RESULTS.json]
 * Baseline must be green; every mutant is restored whatever happens; red = KILLED, still green = SURVIVED. Run it on a COPY of the tree (~/bin-v6q0/linux-test, ci-node image);
 * it rewrites source files while it runs and refuses to run in a git checkout with uncommitted changes in the mutated files. Outside a git checkout pass --head <sha>.
 * Mutants not made (equivalent on the synthetic fixture): dropping `holdoutWindow` from the panel call of the scorer (the fixture window ends inside R1's, so the range check
 * passes either way; the parameter itself is pinned by RC5), and the sort of date-suffixed calendar parts.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TESTS = ['tests/mining_segment_resolution.test.js', 'tests/mining_r2_scoring.test.js', 'tests/mining_holdout_segment_registry.test.js'];
const SR = 'services/mining-rounds/segment-resolution.js';
const RV = 'services/mining-sandbox/round-runner/resolve-segment.js';
const AD = 'services/mining-sandbox/data-adapter/index.js';
const HS = 'services/mining-sandbox/round-runner/holdout-scoring.js';
const RN = 'services/mining-sandbox/round-runner/index.js';
const VT = 'services/holdout-vault/index.js';
const CL = 'services/mining-sandbox/round-runner/cli.js';
const SH = 'deploy/research-lane/round-runner/run.sh';
const SI = 'deploy/research-lane/round-runner/seal-init-r2.sh';

const T_AR = 'tests/mining_r2_arrival.test.js';
const T_DX = 'tests/rf1116_r2_day_export.test.js';
const DX = 'deploy/research-lane/r2-day-export/r2-day-export.sh';
const T_SC = 'tests/mining_r2_scoring.test.js';
const T_RS = 'tests/mining_segment_resolution.test.js';
const AV = 'services/mining-sandbox/round-runner/arrival.js';
const m = (id, guard, file, find, replace, tests = TESTS) => ({ id, guard, file, find, replace, tests });
const MUTANTS = [
  m('M01', 'only rule-defined segments are resolvable', SR, "need(entry && entry.start, 'MINE_SEGMENT_RESOLUTION_NOT_RESOLVABLE'", "need(entry, 'MINE_SEGMENT_RESOLUTION_NOT_RESOLVABLE'"),
  m('M02', 'the window starts strictly after the rule date', SR, 'w.from <= w.to && w.from > entry.start.after', 'w.from <= w.to && w.from >= entry.start.after'),
  m('M03', 'the window is 54 days', SR, "need(w.days === entry.length_trading_days && SHA64.test(w.days_sha256 || ''), 'MINE_SEGMENT_RESOLUTION_INVALID', 'window.days');", "need(SHA64.test(w.days_sha256 || ''), 'MINE_SEGMENT_RESOLUTION_INVALID', 'window.days');"),
  m('M04', 'the calendar must reach the window end', SR, '&& c.last_date >= w.to,', '&& true,'),
  m('M05', 'a different window after a record exists is a conflict', SR, 'const same = existing.window.from === rest.window.from && existing.window.to === rest.window.to && existing.window.days_sha256 === rest.window.days_sha256;', 'const same = true;'),
  m('M06', 'R1 and explicit windows come from the manifest', SR, 'if (holdoutSegments.isResolved(h)) return', 'if (false && holdoutSegments.isResolved(h)) return'),
  m('M07', 'resolutionOf is per segment', SR, "r.schema === SCHEMA && r.segment === segmentId);", 'r.schema === SCHEMA);'),
  m('M08', 'calendar evidence is required', SR, "need(isObj(c) && typeof c.exchange === 'string'", "need(true || isObj(c) && typeof c.exchange === 'string'"),
  m('M09', 'the resolver refuses a segment without a start rule', RV, "if (!entry || !entry.start) throw new SegmentResolveError('MINE_RUNNER_SEGMENT_NOT_RESOLVABLE'", "if (!entry) throw new SegmentResolveError('MINE_RUNNER_SEGMENT_NOT_RESOLVABLE'"),
  m('M10', 'too few listed days is NOT_READY', RV, "if (w.status !== 'RESOLVED') {", 'if (false) {'),
  m('M11', 'the record says how many calendar rows were read', RV, 'rows_read: cal.rows,', 'rows_read: 1,'),
  m('M12', 'the record carries the sha256 of the counted dates', RV, "days_sha256: sha256(counted.join('\\n'))", "days_sha256: sha256(counted.join(','))"),
  m('M13', 'a second run is not a new record', RV, 'created: !existing,', 'created: true,'),
  m('M14', 'the record names the calendar files with their sha256', RV, 'sha256: sha256(fs.readFileSync(path.join(dir, name))) }));', 'sha256: sha256(name) }));'),
  m('M15', 'rows read are counted', AD, "      rows += 1;\n      if (!ACCEPTED_QUALITY", "      if (!ACCEPTED_QUALITY"),
  m('M16', 'only the SSE rows give open days', AD, '.filter((v) => v.ex === calendarExchange && v.open)', '.filter((v) => v.open)'),
  m('M17', 'the window parameter is for the holdout panel only', AD, "if (segment !== 'HOLDOUT') fail('HOLDOUT_WINDOW_OUTSIDE_HOLDOUT', segment);", ''),
  m('M18', 'the holdout panel bound is the given window', AD, 'const seg = holdoutWindow !== undefined ? holdoutWindow : seg0;', 'const seg = seg0;'),
  m('M19', 'scoring days start at the window start', HS, '(d >= window.from ? t : -1)', '(d >= segs.SEGMENTS.HOLDOUT.from ? t : -1)'),
  m('M20', 'the panel must end on the window end', HS, 'const h = window; const d = panel && panel.dates;', 'const h = segs.SEGMENTS.HOLDOUT; const d = panel && panel.dates;'),
  m('M21', 'results record the window', HS, "segment: 'HOLDOUT', from: window.from, to: window.to,", "segment: 'HOLDOUT', from: segs.SEGMENTS.HOLDOUT.from, to: segs.SEGMENTS.HOLDOUT.to,"),
  m('M22', 'no window, no scoring', RN, "need(w, 'HOLDOUT_SEGMENT_END_UNKNOWN'", "need(true, 'HOLDOUT_SEGMENT_END_UNKNOWN'"),
  m('M23', 'registry segments use the deferred-seal check', RN, 'const deferredSeal = win.segment !== null;', 'const deferredSeal = false;'),
  m('M24', 'deferred seal: no sealed rows is allowed only in deferred mode', RN, "need(sealedCounts.length || deferredSeal, 'HOLDOUT_SEALED_DAYS_EMPTY'", "need(true, 'HOLDOUT_SEALED_DAYS_EMPTY'"),
  m('M25', 'deferred seal anchors on the data\'s own day median', RN, 'const anchor = sealedCounts.length ? median(sealedCounts) : (fromR1 ? given : median(per));', 'const anchor = sealedCounts.length ? median(sealedCounts) : (fromR1 ? given : 0);'),
  m('M26', 'deferred seal needs the pending statement sealed', RN, "if (deferredSeal) need(sealedNames.has('SEAL_PENDING_V1.json'), 'HOLDOUT_SEAL_PENDING_MISSING', dir);", ''),
  m('M27', 'the field floor is anchored too in deferred mode', RN, 'sealedCounts.length ? median(sealedCounts) : (deferredSeal ? (fromR1F ? givenF : median(per)) : 0);', 'sealedCounts.length ? median(sealedCounts) : 0;'),
  m('M28', 'R2 reads wait for the day after the window end', RN, 'return Date.parse(after) > Date.parse(base) ? after : base;', 'return Date.parse(after) > Date.parse(base) ? base : after;'),
  m('M29', 'the access-log dataset names the segment', RN, "`CN_A_HOLDOUT_${win && win.segment ? win.segment : 'R1'}`", "'CN_A_HOLDOUT_R1'"),
  m('M30', 'the open row records the window and the resolution record', RN, "...(win.segment ? { segment_window: { from: win.from, to: win.to, segment: win.segment, resolution_record_hash: win.resolution_record_hash } } : {})", ''),
  m('M31', 'the panel ends on the window end', RN, "segment: 'HOLDOUT', from: segs.SEGMENTS.MINING.from, to: win.to,", "segment: 'HOLDOUT', from: segs.SEGMENTS.MINING.from, to: segs.SEGMENTS.HOLDOUT.to,"),
  m('M32', 'the scorer gets the window', RN, "...(registered ? { window: { from: win.from, to: win.to } } : {}),", ''),
  m('M33', 'the directory check uses the window, not the seal row', RN, '{ ...seal, segment: { from: win.from, to: win.to } }', 'seal'),
  m('M34', 'the vault opens only with a window', VT, "need(segmentResolution.windowOf(r), 'MINE_HOLDOUT_SEGMENT_END_UNKNOWN'", "need(true, 'MINE_HOLDOUT_SEGMENT_END_UNKNOWN'"),
  m('M35', 'resolve-segment takes a segment', CL, "'resolve-segment': ['out', 'segment', 'holdout', 'resolved-at'],", "'resolve-segment': ['out', 'holdout', 'resolved-at'],"),
  m('M36', 'an earlier segment is added as ordinary LIVE history', CL, "...(o['prior-live'] ? [adapter.csvDirSource(o['prior-live'], { mode: 'LIVE', label: 'prior-live' })] : [])", '...[]'),
  m('M37', 'run.sh: R2 scoring mounts the R1 directory', SH, 'PRIORO=(--prior-live /data/prior-live)', 'PRIORO=()'),
  m('M38', 'run.sh: resolve-segment is for R2 only', SH, '[ "${RF1116_HOLDOUT_SEGMENT:-R1}" = R2 ] || { echo "run.sh: resolve-segment needs RF1116_HOLDOUT_SEGMENT=R2" >&2; exit 64; }', ''),
  m('M39', 'seal-init: the sealed copy exists', SI, '&& cp SHA256SUMS SHA256SUMS.sealed )', ')'),
  m('M40', 'seal-init: a foreign directory is not touched', SI, '  exit 3\n', '  exit 0\n'),
  m('M41', 'seal-init: idempotent', SI, 'if [ -f "$DIR/SEAL_PENDING_V1.json" ] && [ -f "$DIR/SHA256SUMS.sealed" ]; then', 'if false; then'),
  // R2 data arrival, the hash chain, the R1-median anchor and the UNSEEN mark (tests/mining_r2_arrival.test.js, mining_r2_scoring.test.js, mining_segment_resolution.test.js)
  m('A01', 'chain: rows are in sequence and linked', AV, "if (r.seq !== i || r.prev_hash !== (i ? rows[i - 1].record_hash : null)) invalid('SEQ', i);", "if (false) invalid('SEQ', i);", [T_AR]),
  m('A02', 'chain: every row hash is recomputed', AV, "if (h !== rowHash(body)) invalid('RECORD_HASH', i);", "if (false) invalid('RECORD_HASH', i);", [T_AR]),
  m('A03', 'chain: file bytes match the row', AV, "if (!fs.existsSync(full) || sha256(fs.readFileSync(full)) !== f.sha256) invalid('FILE_SHA', f.name);", "if (false) invalid('FILE_SHA', f.name);", [T_AR, T_SC]),
  m('A04', 'chain: the chained file is listed in SHA256SUMS with the same sha', AV, "if (sums.byName.get(f.name) !== f.sha256) invalid('SUMS', f.name);", "if (false) invalid('SUMS', f.name);", [T_AR]),
  m('A05', 'chain: a file is named once', AV, "if (named.has(f.name)) invalid('DUPLICATE', f.name);", '', [T_AR]),
  m('A06', 'chain: every day has all six tables', AV, "if (!names.includes(part)) invalid('MISSING_TABLE', `${r.trade_date}:${t.stem}`);", '', [T_AR]),
  m('A07', 'chain: a listed file that no row names is refused', AV, "if (unchained.length && !tolerateUnchained) invalid('UNCHAINED', unchained.join(','));", '', [T_AR, T_SC]),
  m('A08', 'chain: days are the consecutive open days of the calendar', AV, 'if (r.trade_date !== expected[i]) invalid(', 'if (false) invalid(', [T_AR]),
  m('A09', 'chain: days not arrived yet are INCOMPLETE', AV, "if (missing !== undefined) throw new ArrivalError('MINE_RUNNER_HOLDOUT_INCOMPLETE', `arrival:${missing}`);", '', [T_AR, T_SC]),
  m('A10', 'arrive R2: only into a pending-sealed directory', AV, "if (!fs.existsSync(path.join(dir, PENDING)) || !sealed || !sealed.has(PENDING) || !readSums(dir).byName.has(PENDING)) fail('NOT_SEALED', dir);", ';', [T_AR]),
  m('A10b', 'arrive R1: only into a directory sealed with its calendar and data', AV, "![...sealed].every((n) => sums.byName.has(n))) fail('NOT_SEALED', dir);", "![...sealed].every((n) => sums.byName.has(n))) ;", [T_AR]),
  m('A11', 'arrive: no skipping or going back', AV, "if (day !== null && day !== next) fail('ORDER', `${day} is not the next open day (${next})`);", '', [T_AR]),
  m('A12', 'arrive: a closed day is refused', AV, "if (day !== null && !cal.days.includes(day)) fail('NOT_OPEN_DAY', day);", '', [T_AR]),
  m('A13', 'arrive: an arrived day is a no-op', AV, "if (day !== null && arrivedDays.includes(day)) return { status: 'NOOP', what: day };", '', [T_AR]),
  m('A14', 'arrive: the header equals the base header', AV, "if (base[t.stem] !== undefined && base[t.stem] !== lines[0]) fail('HEADER', `${t.stem}`);", '', [T_AR]),
  m('A15', 'arrive: every row is that day\'s', AV, "if (r[t.dateCol] !== day) fail('ROW_DATE', `${t.stem}:${r[t.dateCol]}`);", '', [T_AR]),
  m('A16', 'arrive: prices is not empty', AV, "if (t.stem === 'prices_daily_stock' && rows === 0) fail('EMPTY_DAY', day);", '', [T_AR]),
  m('A17', 'arrive: a different file on disk is a conflict', AV, "if (!fs.readFileSync(f).equals(bytes)) fail('CONFLICT', name);", '', [T_AR]),
  m('A18', 'arrive: a calendar that closes an arrived day is refused', AV, "if (!arrived.every((d, i) => merged[i] === d)) fail('CALENDAR_CONFLICT', `arrived days no longer fit the calendar`);", '', [T_AR]),
  m('A19', 'arrive: the end of the window is COMPLETE', AV, "if (windowEnd && last !== null && last >= windowEnd) return { status: 'COMPLETE', what: last };", '', [T_AR]),
  m('A20', 'chain rows are linked by prev_hash', AV, "...body, prev_hash: rows.length ? rows[rows.length - 1].record_hash : null };", '...body, prev_hash: null };', [T_AR]),
  m('A21', 'arrive: a stray listed file is not healed away', AV, "for (const n of unchained) if (!pendingNames.has(n)) fail('CONFLICT', `unchained ${n}`);", '', [T_AR]),
  m('A22', 'pg: the query is for one day', AV, 'FROM prices_daily WHERE trade_date = ${d}', 'FROM prices_daily WHERE trade_date >= ${d}', [T_AR]),
  m('A23', 'pg: psql stops on error', AV, "'ON_ERROR_STOP=1'", "'ON_ERROR_STOP=0'", [T_AR]),
  m('A24', 'pg: no prices rows = not available', AV, 'csvLines(files.prices_daily_stock).length > 1 ?', 'csvLines(files.prices_daily_stock).length >= 1 ?', [T_AR]),
  m('A25', 'scorer: the arrival chain is verified before any row is read', RN, 'if (deferredSeal || requireChain) arrivalChain.verifyChain(', 'if (false) arrivalChain.verifyChain(', [T_SC]),
  m('A26', 'scorer: the chain starts at the resolution record\'s start rule', RN, '...(rec ? { startAfter: rec.rule.start_after } : {})', '...({})', [T_SC]),
  m('A27', 'anchor: R1\'s recorded row medians are used', RN, 'const anchor = sealedCounts.length ? median(sealedCounts) : (fromR1 ? given : median(per));', 'const anchor = sealedCounts.length ? median(sealedCounts) : median(per);', [T_SC]),
  m('A28', 'anchor: R1\'s recorded field medians are used', RN, '(deferredSeal ? (fromR1F ? givenF : median(per)) : 0)', '(deferredSeal ? median(per) : 0)', [T_SC]),
  m('A29', 'anchor: the check record names the R1 open row', RN, 'anchor_record_hash: anchors ? anchors.open_record_hash : null', 'anchor_record_hash: null', [T_SC]),
  m('A30', 'UNSEEN: the mark is written with the resolution row', RV, 'const marks = ensureUnseenMarks(rec, entry);', 'const marks = [];', [T_RS]),
  m('A31', 'UNSEEN: only the families of the rounds on the segment', RV, 'r.holdout && r.holdout.segment === rec.segment', 'r.holdout', [T_RS]),
  m('A32', 'UNSEEN: only days nobody marked yet (a rerun and a deliberate SEEN mark are left alone)', RV, "p.source === 'UNMARKED_DEFAULT_SEEN'", 'true', [T_RS]),
  m('A33', 'UNSEEN: the marks cover the unmarked pieces of the resolved window, not a wider range', RV, 'from: p.from, to: p.to, label', 'from: rec.window.from, to: rec.window.to, label', [T_RS]),
  // R1 catch-up, industry as the seventh table, readiness record, requireChain, checkComplete (tests/mining_r2_arrival.test.js, mining_r2_scoring.test.js)
  m('B01', 'R1 starts after the sealed export\'s D1', AV, "startAfter: '2026-11-17'", "startAfter: '2026-11-18'", [T_AR]),
  m('B02', 'R1\'s first industry part reaches back to 2026-10-17', AV, "industryFrom: '2026-10-17T00:00:00+08:00', calendarArrives: false", "industryFrom: '2026-10-18T00:00:00+08:00', calendarArrives: false", [T_AR]),
  m('B03', 'R2\'s first industry part starts 2027-01-01', AV, "industryFrom: '2027-01-01T00:00:00+08:00', calendarArrives: true", "industryFrom: '2027-01-02T00:00:00+08:00', calendarArrives: true", [T_AR]),
  m('B04', 'R1\'s calendar is sealed, not delivered', AV, "industryFrom: '2026-10-17T00:00:00+08:00', calendarArrives: false", "industryFrom: '2026-10-17T00:00:00+08:00', calendarArrives: true", [T_AR]),
  m('B05', 'industry window: the lower bound is inclusive', AV, 'if (!(at >= w.lo && at < w.hi))', 'if (!(at > w.lo && at < w.hi))', [T_AR]),
  m('B06', 'industry window: the upper bound is exclusive', AV, 'if (!(at >= w.lo && at < w.hi))', 'if (!(at >= w.lo && at <= w.hi))', [T_AR]),
  m('B07', 'industry window: an unreadable first_available_at is refused', AV, 'let at = NaN;', 'let at = w.lo;', [T_AR]),
  m('B08', 'R1: only tables the sealed manifest lacks get a base file', AV, 'for (const t of TABLES.filter(needsBase))', 'for (const t of TABLES)', [T_AR]),
  m('B09', 'R1: the header is checked against the sealed base file', AV, 'baseHeaders[t.stem] = firstLineOf(f);', 'baseHeaders[t.stem] = undefined;', [T_AR]),
  m('B10', 'checkComplete names the missing days', AV, 'd <= windowEnd && !days.includes(d)', 'd <= windowEnd && false', [T_AR]),
  m('B11', 'checkComplete: the calendar has to reach the window end', AV, 'cal.days.some((d) => d >= windowEnd)', 'true', [T_AR]),
  m('B12', 'verifyChain window: days up to the sealed D1 are not chain days', AV, 'd >= window.from && d <= window.to && d > after', 'd >= window.from && d <= window.to', [T_AR]),
  m('B14', 'pg: the industry query\'s lower bound is inclusive', AV, 'first_available_at >= TIMESTAMPTZ ${sqlTs(industryFrom)}', 'first_available_at > TIMESTAMPTZ ${sqlTs(industryFrom)}', [T_AR]),
  m('B15', 'readiness: ready_via must be a known rule', AV, '!READY_VIA.includes(o.ready_via)', 'false', [T_AR]),
  m('B16', 'readiness: the record must be of this day', AV, 'o.trade_date !== day', 'false', [T_AR]),
  m('B17', 'readiness: the record\'s file sha goes into the chain row', AV, 'file_sha256: sha256(Buffer.from(bytes))', 'file_sha256: null', [T_AR]),
  m('B19', 'readiness: the record is part of the chain row', AV, 'checkReadiness(next, got.readiness, { expectedFrom, nextOpen });', 'null;', [T_AR]),
  m('B20', 'readiness: a day without its record is not there yet', AV, 'if (!fs.existsSync(rf)) return null;', 'if (!fs.existsSync(rf)) return { files, readiness: Buffer.from("{}") };', [T_AR]),
  m('B21', 'readiness: counts are non-negative integers', AV, 'isCount(o[k])', 'true', [T_AR]),
  m('B22', 'scoring: requireChain turns the chain check on for R1', RN, 'if (deferredSeal || requireChain) arrivalChain.verifyChain(', 'if (deferredSeal) arrivalChain.verifyChain(', [T_AR]),
  m('B23', 'scoring: an R1 chain is verified with the R1 profile', RN, 'segment: segment || (deferredSeal ? "R2" : "R1")', 'segment: segment || "R2"', [T_AR]),
  m('B24', 'cli: check-complete reports INCOMPLETE when days are missing', CL, "status: c.complete ? 'COMPLETE' : 'INCOMPLETE'", "status: c.complete ? 'INCOMPLETE' : 'COMPLETE'", [T_AR]),
  m('B25', 'cli: INCOMPLETE exits with 4', CL, "else if (out.status === 'INCOMPLETE') process.exitCode = 4;", '', [T_AR]),
  m('B26', 'run.sh: score requires the arrival chain', SH, '--factor-series /data/factor-series --require-arrival-chain true ${EXO[@]+"${EXO[@]}"} ${PRIORO[@]+"${PRIORO[@]}"}', '--factor-series /data/factor-series ${EXO[@]+"${EXO[@]}"} ${PRIORO[@]+"${PRIORO[@]}"}', [T_AR]),
  m('B27', 'run.sh: the arrival drop directory is per segment', SH, 'DAYDROP="$LANE/holdout-daydrop/${RF1116_HOLDOUT_SEGMENT:-R1}"', 'DAYDROP="$LANE/holdout-daydrop/R2"', [T_AR]),
  // r2-day-export (tests/rf1116_r2_day_export.test.js; the SHA256SUMS test is skipped under a mutation run on purpose)
  m('D01', 'export: the session is read-only', DX, "PGOPTIONS='-c default_transaction_read_only=on'", "PGOPTIONS='-c default_transaction_read_only=off'", [T_DX]),
  m('D02', 'export: a session that is not read-only stops the run', DX, '[ "$ro" = on ]', '[ "$ro" = "$ro" ]', [T_DX]),
  m('D03', 'export: a day waiting more than 3 days is the alert', DX, 'STALE_DAYS=3', 'STALE_DAYS=30', [T_DX]),
  m('D04', 'export: R1 starts after the sealed D1', DX, 'R1) START_AFTER=2026-11-17;', 'R1) START_AFTER=2026-11-18;', [T_DX]),
  m('D05', 'export: R2 is 54 open days', DX, 'MAXDAYS=54', 'MAXDAYS=55', [T_DX]),
  m('D06', 'export: a day that is not ready is not exported', DX, 'if [ -z "$ready" ]; then', 'if false; then', [T_DX]),
  m('D07', 'export: a day appears atomically (rename)', DX, 'mv "$tmp" "$fin"', 'cp -r "$tmp" "$fin"', [T_DX]),
  m('D08', 'export: an exported day is not exported again', DX, 'if [ -d "$fin" ]; then', 'if false; then', [T_DX]),
  m('D09', 'export: a day without prices rows is not exported', DX, '-le 1 ]; then', '-le 0 ]; then', [T_DX]),
  m('D11', 'export: the window end of R1 is refused beyond', DX, '[[ "$DAY" > "$END" ]]', '[[ "$DAY" < "$END" ]]', [T_DX]),
  m('D12', 'export: R2 gets its calendar', DX, 'if [ "$seg" = R2 ]; then', 'if false; then', [T_DX]),
  m('D13', 'export: a failed probe fails closed', DX, 'echo "$seg PROBE_FAILED:$D" >&2; return 2;', 'echo "$seg PROBE_FAILED:$D" >&2; return 0;', [T_DX]),
  m('D14', 'export: a malformed probe row fails closed', DX, 'echo "$seg PROBE_BAD_ROW:$D:$ready" >&2; return 2;', 'echo "$seg PROBE_BAD_ROW:$D:$ready" >&2; return 0;', [T_DX]),
  m('D15', 'export: every psql call has a time limit', DX, 'timeout "$t" docker exec', 'docker exec', [T_DX]),
  m('D16', 'export: the readiness record carries ready_via', DX, '"ready_via":"%s"', '"ready_via":"POST_CLOSE_D"', [T_DX]),
  m('D17', 'export slot: the morning slot starts 08:20', DX, '[ "$hm" -ge 820 ]  && [ "$hm" -le 905 ]', '[ "$hm" -ge 800 ]  && [ "$hm" -le 905 ]', [T_DX]),
  m('D18', 'export slot: the night slot starts 21:35', DX, 'elif [ "$hm" -ge 2135 ]; then', 'elif [ "$hm" -ge 2100 ]; then', [T_DX]),
  m('D19', 'export slot: the afternoon slot starts 15:40', DX, '[ "$hm" -ge 1540 ]', '[ "$hm" -ge 1500 ]', [T_DX]),
  m('D20', 'export slot: outside a slot nothing is done', DX, 'if [ "$slot" = DENY ]; then', 'if false; then', [T_DX]),
  m('D21', 'export slot: every psql call is clamped to the end of the slot', DX, '[ "$left" -ge "$t" ] || t=$(( left > 1 ? left : 1 ))', ':', [T_DX]),
  m('D22', 'export slot: no day starts after the end of the slot', DX, 'if [ "$(now_epoch)" -ge "$DEADLINE" ]; then echo "$seg SLOT_ENDED:$D"; break; fi', 'if false; then echo "$seg SLOT_ENDED:$D"; break; fi', [T_DX]),
  m('D23', 'export cutoff: the point-in-time rule is on by default', DX, 'PIT_CUTOFF="${R2EXP_PIT_CUTOFF:-1}"', 'PIT_CUTOFF="${R2EXP_PIT_CUTOFF:-0}"', [T_DX]),
  m('D24', 'export cutoff: the next open day at 09:00+08', DX, 'date -d "$nx 09:00:00+08:00"', 'date -d "$nx 08:00:00+08:00"', [T_DX]),
  m('D25', 'export slot: weekends are not restricted to the weekday slots', DX, 'if [ "$dow" -le 5 ]; then', 'if true; then', [T_DX]),
  m('B28', 'readiness: window_from continues the previous part', AV, 'o.window_from !== expectedFrom', 'false', [T_AR]),
  m('B29', 'readiness: window_to is 09:00+08', AV, "(o.window_to.endsWith('T09:00:00+08:00') && o.window_to.slice(0, 10) > day)", '(o.window_to.slice(0, 10) > day)', [T_AR]),
  m('B30', 'readiness: window_to is after the day', AV, "(o.window_to.endsWith('T09:00:00+08:00') && o.window_to.slice(0, 10) > day)", "(o.window_to.endsWith('T09:00:00+08:00'))", [T_AR]),
  m('B31', 'readiness: window_to is the calendar\'s next open day when it knows one', AV, '(nextOpen && o.window_to.slice(0, 10) !== nextOpen)', '(false)', [T_AR]),
  m('B32', 'verifier: consecutive industry windows are contiguous', AV, "if (r.window_from !== (prevDay ? prevDay.window_to : profile.industryFrom)) invalid('WINDOW'", "if (false) invalid('WINDOW'", [T_AR]),
  m('B33', 'verifier: window_to is the calendar\'s next open day', AV, "if (nx && r.window_to.slice(0, 10) !== nx) invalid('WINDOW'", "if (false) invalid('WINDOW'", [T_AR]),
  m('B34', 'arrive: a day\'s window starts where the last arrived part ended', AV, 'dayRows[dayRows.length - 1].window_to', 'dayRows[0].window_to', [T_AR]),
  m('B35', 'arrive: the window goes into the chain row', AV, 'window_from: window.from, window_to: window.to', 'window_from: null, window_to: null', [T_AR]),
  m('B36', 'pg: a day whose window end is unknown is not available', AV, 'if (!ctx || !ctx.industryTo) return null;', '', [T_AR]),
  m('B37', 'pg: the window bounds keep their time of day', AV, '${iso.slice(0, 10)} ${iso.slice(11, 19)}+08', '${iso.slice(0, 10)} 00:00:00+08', [T_AR]),
  m('D26', 'export window: a later part starts at the day\'s own 09:00 (the previous part\'s end)', DX, 'else lower="$D 09:00:00+08"', 'else lower="$D 00:00:00+08"', [T_DX]),
  m('D27', 'export window: a part ends at the next open day\'s 09:00', DX, 'local upper="$nx 09:00:00+08"', 'local upper="$nx 00:00:00+08"', [T_DX]),
  m('D28', 'export window: the first part starts at the segment\'s lower bound', DX, 'lower="$FIRST_LOWER 00:00:00+08"', 'lower="$FIRST_LOWER 09:00:00+08"', [T_DX]),
  m('D29', 'export window: a day with no known next open day waits', DX, '[ -n "$nx" ] || cut=1', ':', [T_DX]),
  m('D30', 'export window: window_from is recorded', DX, '"${lower/ /T}:00"', '"${upper/ /T}:00"', [T_DX]),
  m('D31', 'export probe: one variable names the probe file', DX, 'READY_SQL="${R2EXP_READY_SQL:-$HERE/R2_DAY_EXPORT_READINESS_V2.sql}"', 'READY_SQL="$HERE/R2_DAY_EXPORT_READINESS_V2.sql"', [T_DX]),
  m('D32', 'export probe: a missing probe file stops the run', DX, '[ -f "$READY_SQL" ] || { echo "PROBE_SQL_MISSING: $READY_SQL" >&2; exit 2; }', ':', [T_DX]),
];

function listFailures(out) { return [...new Set((out.match(/^not ok \d+ - .+$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, '')))]; }
function runTests(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', QRP_MUTATION_RUN: '1' }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  return { status: r.status, failing: listFailures(`${r.stdout || ''}\n${r.stderr || ''}`) };
}
const arg = (argv, k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

function main(argv) {
  const only = arg(argv, '--only') ? new Set(arg(argv, '--only').split(',')) : null;
  const outFile = arg(argv, '--write');
  const merge = argv.includes('--merge');
  let head = arg(argv, '--head');
  try {
    if (!head) head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...new Set(MUTANTS.map((x) => x.file))], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (dirty) { process.stderr.write(`refusing to run: uncommitted changes in mutated files:\n${dirty}\n`); return 2; }
  } catch { if (!head) { process.stderr.write('not a git checkout: pass --head <sha>\n'); return 2; } }
  const base = runTests([...new Set(MUTANTS.flatMap((x) => x.tests))]);
  if (base.status !== 0) { process.stderr.write(`baseline is not green: ${JSON.stringify(base.failing)}\n`); return 2; }
  const results = [];
  for (const x of MUTANTS.filter((y) => !only || only.has(y.id))) {
    const abs = path.join(ROOT, x.file);
    const original = fs.readFileSync(abs, 'utf8');
    const count = original.split(x.find).length - 1;
    if (count !== 1) { process.stderr.write(`${x.id}: find text occurs ${count} times in ${x.file}\n`); results.push({ id: x.id, guard: x.guard, file: x.file, result: 'BAD_MUTANT', occurrences: count }); continue; }
    let r;
    try { fs.writeFileSync(abs, original.replace(x.find, () => x.replace)); r = runTests(x.tests); } finally { fs.writeFileSync(abs, original); }
    const killed = r.status !== 0;
    results.push({ id: x.id, guard: x.guard, file: x.file, result: killed ? 'KILLED' : 'SURVIVED', failing: r.failing.slice(0, 3), head });
    process.stdout.write(`${x.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${x.guard}${killed ? `  <- ${r.failing[0] || `exit ${r.status}`}` : ''}\n`);
  }
  let all = results;
  if (merge && outFile && fs.existsSync(path.join(ROOT, outFile))) {
    const prior = JSON.parse(fs.readFileSync(path.join(ROOT, outFile), 'utf8')).results.filter((x) => !results.some((y) => y.id === x.id) && MUTANTS.some((m) => m.id === x.id)); // a result of a mutant that no longer exists is dropped
    all = [...prior, ...results].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  const summary = { schema: 'MINING_R2_SCORER_MUTATION_RESULTS_V1', baseline: 'GREEN', mutants: all.length, killed: all.filter((x) => x.result === 'KILLED').length,
    survived: all.filter((x) => x.result === 'SURVIVED').map((x) => x.id), bad: all.filter((x) => x.result === 'BAD_MUTANT').map((x) => x.id), heads: [...new Set(all.map((x) => x.head).filter(Boolean))], results: all };
  if (outFile) { fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true }); fs.writeFileSync(path.join(ROOT, outFile), `${JSON.stringify(summary, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, bad: summary.bad, heads: summary.heads })}\n`);
  return summary.survived.length || summary.bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MUTANTS };
