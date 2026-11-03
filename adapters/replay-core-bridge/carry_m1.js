#!/usr/bin/env node
'use strict';
/**
 * Carry V2 接入 M1 封存清单 + A0-1 身份(smartflow CARRY_V2_QRP_ONBOARDING_K2_DRAFT_V1 §5.2、§4.2 A0-1;FREEZE_1)。
 * QRP 侧代码,运行在钉住的 smartflow 检出上;由 apps/research-cli/carry_v2_onboarding.js 以最小环境的子进程启动。
 *
 *   node carry_m1.js --root <smartflow 根> --args <参数 JSON 文件> --out <回执文件>
 *   args: { data, dtb3: { dir, rel }, ledgerRoot, cutoff: 'YYYY-MM-DD', k2: <K2 文件副本> }
 *
 *   M1-1 研究历史:规格里每个文件(或签字前缀 / 追加部分)的 sha256 与别处记录的值逐条比;文本来源的记录值必须在
 *        来源文本的同一行与 anchor 一起出现(抄录可核),JSON 来源按字段取。0 不符才算通过。
 *   M1-2 / A0-1 数据:跑数器同一份加载器(tier2 的 loadAll 副本,与跑数器逐字节同步)复算清单 = 162d80c9…;
 *        fetch-log 里每个 OK 文件全部重算 sha256,变动 0;DTB3 = 1e9dbca8…。只跑一次,两处共用。
 *   A0-1 身份:钉版的 5 个研究代码文件 = V2 证据 code = FORWARD_SETUP code;验收哈希 = 证据 acceptance(跑数器自己的
 *        checkAcceptanceV2 复算)。
 *   M1-3 (b) 账本:影子自己的 store.load + ledger.fold(哈希链、seq、fold 不变量);WORKER_LIVE ≥ 1、F_START 恰好 1;
 *        最大恒等式残差;代码清单 13 个文件 = 钉版检出。
 *   M1-4 计数:按类型行数;MISSING / MISSING_FINAL 按「缺什么」分类并列时点与原因码;HALT / RESUME / CODE_CHANGE;
 *        (a)、(b) 已满的前向月数(日历)。一条 MISSING_FINAL 原样显示;一条 DECISION 追踪(不显示 A7、τ)。
 * 不输出余额、权益、资金费或利息金额、收益、X、CI;回执写出前按 denied_keys 自查,出现即拒写(FORWARD_VALUE_LEAK)。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PIN, layout, assertCore } = require('./core_pin');

const SPEC = require('./carry_v2_onboarding_spec.json');
const RECEIPT_KIND = 'QRP_CARRY_V2_M1_PACKAGE_V1';
const TIER2 = 'scripts/lib/replay-core-golden/tier2.js';
const RUNNER = 'scripts/research/funding-basis-carry-run.js';
const LEDGER = 'src/services/carry-v2-shadow/ledger.js';
const STORE = 'src/services/carry-v2-shadow/store.js';
const DAY = 86_400_000;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** 字段路径取值:键里可以有点(文件路径),每层取能对上的最长前缀键。 */
function getField(obj, field) {
  let cur = obj;
  let rest = field;
  while (rest) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(cur, rest)) return cur[rest];
    let cut = -1;
    for (let j = rest.indexOf('.'); j >= 0; j = rest.indexOf('.', j + 1)) if (Object.prototype.hasOwnProperty.call(cur, rest.slice(0, j))) cut = j;
    if (cut < 0) return undefined;
    cur = cur[rest.slice(0, cut)];
    rest = rest.slice(cut + 1);
  }
  return cur;
}

/** 一个文件(或签字前缀 / 追加部分)的 sha256。view: FILE | PREFIX:<n> | SUFFIX:<n>。 */
function viewSha(buf, view) {
  if (view === 'FILE') return sha256(buf);
  const m = /^(PREFIX|SUFFIX):(\d+)$/.exec(view);
  if (!m) throw new Error(`SPEC_VIEW_UNKNOWN:${view}`);
  const n = Number(m[2]);
  return sha256(m[1] === 'PREFIX' ? buf.subarray(0, n) : buf.subarray(n));
}

/** M1-1:每条记录 → MATCH / MISMATCH;文本来源要求同一行含 anchor 与值(PROVENANCE)。 */
function historyCheck({ pkgRoot, k2Text, spec = SPEC, pin = PIN }) {
  const texts = {};
  const jsons = {};
  const sourceText = (name) => {
    if (texts[name] === undefined) {
      const s = spec.history_sources[name];
      texts[name] = s.from === 'k2' ? k2Text : fs.readFileSync(path.join(pkgRoot, s.path), 'utf8');
    }
    return texts[name];
  };
  const sourceJson = (name) => {
    if (jsons[name] === undefined) jsons[name] = JSON.parse(fs.readFileSync(path.join(pkgRoot, spec.history_sources[name].path), 'utf8'));
    return jsons[name];
  };
  const rows = [];
  for (const h of spec.history) {
    const full = path.join(pkgRoot, h.path);
    const exists = fs.existsSync(full);
    const actual = exists ? viewSha(fs.readFileSync(full), h.view) : null;
    const recorded = h.recorded.map((r) => {
      const src = spec.history_sources[r.source];
      if (!src) throw new Error(`SPEC_SOURCE_UNKNOWN:${r.source}`);
      let value;
      let provenance;
      if (src.kind === 'TEXT') {
        value = r.value;
        provenance = sourceText(r.source).split('\n').some((line) => line.includes(r.anchor) && line.includes(r.value)) ? 'TEXT_LINE_OK' : 'TEXT_LINE_MISSING';
      } else if (src.kind === 'JSON') {
        value = getField(sourceJson(r.source), r.field);
        provenance = typeof value === 'string' ? 'FIELD_OK' : 'FIELD_MISSING';
      } else if (src.kind === 'PIN') {
        const v = getField(pin, r.field);
        value = typeof v === 'string' ? v.slice(v.indexOf('@') + 1) : undefined;
        provenance = typeof value === 'string' ? 'FIELD_OK' : 'FIELD_MISSING';
      } else throw new Error(`SPEC_SOURCE_KIND:${src.kind}`);
      const ok = provenance.endsWith('_OK') && actual != null && typeof value === 'string' && value.length >= 8 && actual.startsWith(value);
      return { source: r.source, ...(r.field ? { field: r.field } : {}), value: value === undefined ? null : value, provenance, status: ok ? 'MATCH' : 'MISMATCH' };
    });
    const status = !exists ? 'FILE_MISSING' : recorded.length === 0 ? 'NO_PRIOR_RECORD' : recorded.every((r) => r.status === 'MATCH') ? 'MATCH' : 'MISMATCH';
    rows.push({ group: h.group, path: h.path, view: h.view, sha256: actual, status, recorded });
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    files: new Set(rows.map((r) => r.path)).size, entries: rows.length,
    matched: count('MATCH'), no_prior_record: count('NO_PRIOR_RECORD'), mismatched: count('MISMATCH'), missing: count('FILE_MISSING'),
    recorded_values: rows.reduce((n, r) => n + r.recorded.length, 0),
    pass: count('MISMATCH') === 0 && count('FILE_MISSING') === 0,
  };
}

/** fetch-log 里每个 OK 文件全部重算(loadAll 只读它用到的文件;这里把整份日志都核一遍)。 */
function fetchLogRehash(dataDir) {
  const recs = new Map();
  for (const line of fs.readFileSync(path.join(dataDir, 'fetch-log.jsonl'), 'utf8').split('\n')) if (line) { const r = JSON.parse(line); recs.set(r.path, r); }
  const statuses = {};
  let checked = 0;
  const changed = [];
  const absent = [];
  for (const r of recs.values()) {
    statuses[r.status] = (statuses[r.status] || 0) + 1;
    if (r.status !== 'OK') continue;
    const full = path.join(dataDir, r.path);
    if (!fs.existsSync(full)) { absent.push(r.path); continue; }
    checked += 1;
    if (sha256(fs.readFileSync(full)) !== r.sha256) changed.push(r.path);
  }
  const onDisk = [];
  const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), p); else onDisk.push(p); } };
  walk(dataDir);
  return { log_entries: recs.size, statuses, ok_checked: checked, file_changed_since_fetch: changed.length, changed: changed.slice(0, 20), ok_absent: absent.length,
    files_on_disk: onDisk.length, data_files_on_disk: onDisk.filter((p) => p !== 'fetch-log.jsonl').length };
}

/** M1-2 / A0-1 数据。 */
function dataCheck({ T2, args, spec = SPEC }) {
  const loaded = T2.loadAll(args.data);
  const rehash = fetchLogRehash(args.data);
  const dtb3 = T2.loadDtb3(args.dtb3.dir, args.dtb3.rel);
  const out = {
    manifest_sha256: loaded.manifestSha256, manifest_files: loaded.files.length, expected_manifest_sha256: spec.data.manifest_sha256,
    fetch_log: rehash,
    dtb3_file: { rel: dtb3.file.path, sha256: dtb3.file.sha256, bytes: dtb3.file.bytes },
  };
  out.pass = loaded.manifestSha256 === spec.data.manifest_sha256 && rehash.file_changed_since_fetch === 0 && rehash.ok_absent === 0
    && rehash.data_files_on_disk === spec.data.data_files && args.dtb3.rel === spec.data.dtb3_rel
    && dtb3.file.sha256.startsWith(spec.data.dtb3_sha256_prefix) && dtb3.file.bytes === spec.data.dtb3_bytes;
  return out;
}

/** A0-1 代码与验收身份。 */
function identityCheck({ pkgRoot, runner, spec = SPEC }) {
  const ev = Object.fromEntries(['V2_W1', 'V2_W2', 'V2_FULL', 'V2_DATA', 'V2_VERDICT', 'V2_FORWARD_SETUP'].map((k) => [k, JSON.parse(fs.readFileSync(path.join(pkgRoot, spec.sealed_evidence[k]), 'utf8'))]));
  const codeOf = (k) => (k === 'V2_VERDICT' ? ev[k].inputs.code : ev[k].code);
  const files = Object.keys(codeOf('V2_FORWARD_SETUP'));
  const code = Object.fromEntries(files.map((rel) => [rel, sha256(fs.readFileSync(path.join(pkgRoot, rel)))]));
  const codeRows = Object.keys(ev).map((k) => ({ evidence: k, identical: runner.stableJson(codeOf(k)) === runner.stableJson(code) }));
  let acceptance = null;
  let acceptanceError = null;
  try { acceptance = runner.checkAcceptanceV2(); } catch (e) { acceptanceError = String(e.message).split('\n')[0]; }
  const accRows = Object.keys(ev).map((k) => ({ evidence: k, identical: acceptance != null && runner.stableJson(ev[k].acceptance) === runner.stableJson(acceptance) }));
  const out = {
    code_files: files.length, code, code_vs_evidence: codeRows,
    acceptance: acceptance ? { round2: acceptance.sha256, v1SignedPrefix: acceptance.v1.sha256, v1Appended: acceptance.v1.appendedAfterSigning && acceptance.v1.appendedAfterSigning.sha256, amendment1: acceptance.v1.amendment1.sha256 } : null,
    acceptance_error: acceptanceError, acceptance_vs_evidence: accRows,
  };
  out.pass = files.length === 5 && codeRows.every((r) => r.identical) && acceptance != null && accRows.every((r) => r.identical);
  return out;
}

/** 日历上已满的整月数:from 起,第 k 个整月的结束 ≤ until(不含)。 */
function completeMonths(fromMs, untilMs) {
  if (fromMs == null || !(untilMs > fromMs)) return 0;
  const d = new Date(fromMs);
  let k = 0;
  for (;;) {
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
    if (next > untilMs) return k;
    k += 1;
  }
}

/** 回执里不许出现的键(前向数值);出现即拒写。 */
function assertNoForwardValues(obj, denied = SPEC.forward.denied_keys, where = '$') {
  if (Array.isArray(obj)) { obj.forEach((v, i) => assertNoForwardValues(v, denied, `${where}[${i}]`)); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (denied.includes(k)) throw new Error(`FORWARD_VALUE_LEAK:${where}.${k}`);
      assertNoForwardValues(v, denied, `${where}.${k}`);
    }
  }
}

/**
 * M1-3 / M1-4:影子自己的 store.load + ledger.fold;只出通过 / 不通过、残差与计数。
 * ledgerRoot 下的 ledger/ 只放截止日(含)以前的日文件(拷贝时就按截止日取)。
 */
function ledgerCheck({ Ledger, Store, ledgerRoot, cutoff, pkgRoot, spec = SPEC }) {
  const store = Store.createStore(ledgerRoot);
  const fileNames = store.ledgerFiles();
  const late = fileNames.filter((f) => f.slice(0, 10) > cutoff);
  if (late.length) throw new Error(`LEDGER_FILE_AFTER_CUTOFF:${late[0]}`);
  const files = fileNames.map((f) => { const buf = fs.readFileSync(path.join(store.ledgerDir, f)); return { file: f, sha256: sha256(buf), lines: buf.toString('utf8').split('\n').filter(Boolean).length }; });
  const records = store.load();
  const byType = {};
  for (const r of records) byType[r.type] = (byType[r.type] || 0) + 1;

  let maxIdentity = 0;
  let maxMtmEquity = 0;
  let foldError = null;
  let state = null;
  try {
    state = Ledger.fold(records, {
      onMtm: (rec, e, sl) => {
        maxIdentity = Math.max(maxIdentity, Ledger.identityError(sl, rec.S, rec.F));
        maxMtmEquity = Math.max(maxMtmEquity, Math.abs(e - rec.equity));
      },
    });
  } catch (e) {
    foldError = { code: e.code || 'ERROR', message: String(e.message).split('\n')[0] };
  }
  const seqStrict = records.every((r, i) => r.seq === i + 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, spec.sealed_evidence.V2_SHADOW_CODE_MANIFEST), 'utf8'));
  const codeFiles = { ...manifest.ruleBearing, ...manifest.plumbing };
  const codeRows = Object.entries(codeFiles).map(([rel, want]) => ({ path: rel, identical: fs.existsSync(path.join(pkgRoot, rel)) && sha256(fs.readFileSync(path.join(pkgRoot, rel))) === want }));
  const m13 = {
    files: files.length, first_file: files.length ? files[0].file : null, last_file: files.length ? files[files.length - 1].file : null,
    ledger_files: files, records: records.length,
    fold: foldError ? 'FAIL' : 'PASS', fold_error: foldError,
    seq_strict_plus_one: seqStrict, first_seq: records.length ? records[0].seq : null, last_seq: records.length ? records[records.length - 1].seq : null,
    hash_chain: foldError && ['CHAIN_BREAK', 'HASH_MISMATCH', 'SEQ_GAP', 'SEQ_DUPLICATE'].includes(foldError.code) ? 'BROKEN' : foldError ? 'NOT_REACHED_OR_OK' : 'INTACT',
    worker_live: byType.WORKER_LIVE || 0, f_start: byType.F_START || 0,
    max_identity_residual_usdt: maxIdentity, max_mtm_equity_residual_usdt: maxMtmEquity, identity_tolerance_usdt: Ledger.IDENTITY_TOL,
    code_manifest: { files: codeRows.length, identical: codeRows.filter((r) => r.identical).length, differing: codeRows.filter((r) => !r.identical).map((r) => r.path), goLive: manifest.goLive, ruleAmendment: manifest.ruleAmendment },
  };
  m13.pass = !foldError && seqStrict && m13.worker_live >= 1 && m13.f_start === 1 && maxIdentity <= Ledger.IDENTITY_TOL && maxMtmEquity <= Ledger.IDENTITY_TOL
    && codeRows.length === 13 && codeRows.every((r) => r.identical) && records.length > 0;

  // M1-4 计数(只计数):MISSING 行按「缺什么」与原因码;MISSING_FINAL 取 fold 记下的原 MISSING(种类、时点、原因码)
  const missingRows = records.filter((r) => r.type === 'MISSING');
  const missingByWhat = {};
  for (const r of missingRows) {
    const g = missingByWhat[r.what] || (missingByWhat[r.what] = { rows: 0, reasons: {}, instants: [] });
    g.rows += 1;
    g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1;
    g.instants.push(iso(r.instant));
  }
  const finals = state ? state.missingFinal : [];
  const finalByWhat = {};
  for (const m of finals) {
    const g = finalByWhat[m.what] || (finalByWhat[m.what] = { rows: 0, reasons: {}, items: [] });
    g.rows += 1;
    g.reasons[m.reason] = (g.reasons[m.reason] || 0) + 1;
    g.items.push({ instant: iso(m.instant), sleeve: m.sleeve, reason: m.reason, openSeq: m.seq, closeSeq: m.closeSeq });
  }
  const openAtCutoff = state ? Object.values(state.missing) : [];
  const openByWhat = {};
  for (const m of openAtCutoff) openByWhat[m.what] = (openByWhat[m.what] || 0) + 1;
  const decisionKinds = {};
  for (const r of records.filter((x) => x.type === 'DECISION')) { const k = `${r.kind}${r.reason ? `:${r.reason}` : ''}`; decisionKinds[k] = (decisionKinds[k] || 0) + 1; }
  const events = (t) => records.filter((r) => r.type === t).map((r) => ({ seq: r.seq, at: iso(r.valueAt), ...(t === 'CODE_CHANGE' ? { from: r.from, to: r.to, codeCommit: r.codeCommit } : {}), ...(t === 'HALT' ? { trigger: r.trigger } : {}) }));
  const fStartB = (records.find((r) => r.type === 'F_START') || {}).fundingTime;
  const until = Date.parse(`${cutoff}T00:00:00.000Z`) + DAY;
  const fStartA = Date.parse(spec.forward.a_f_start);
  const m14 = {
    rows_by_type: byType,
    decisions_by_kind: decisionKinds,
    missing_by_what: missingByWhat,
    missing_final_by_what: finalByWhat,
    missing_open_at_cutoff: { rows: openAtCutoff.length, by_what: openByWhat },
    resolved: state ? state.resolved.length : null,
    halt: events('HALT'), resume: events('RESUME'), code_change: events('CODE_CHANGE'),
    halted_at_cutoff: state ? state.halted : null,
    forward_months: {
      a: { f_start: iso(fStartA), complete_months: completeMonths(fStartA, until), first_look: spec.forward.a_first_look, state: 'NOT_DUE' },
      b: { f_start: iso(fStartB), complete_months: completeMonths(fStartB, until), label: spec.forward.b_label },
      through: iso(until),
    },
    fill_rows: byType.FILL || 0, transfer_rows: byType.TRANSFER || 0,
  };

  // 一项缺项的实际显示:第一条 MISSING_FINAL(种类、时点、原因码)
  const shownFinal = finals.length ? (({ key, what, sleeve, instant, reason, seq, closeSeq }) => ({ key, what, sleeve, instant: iso(instant), reason, openSeq: seq, closeSeq }))(finals[0]) : null;
  // 一次决策追踪:第一条 kind = NONE 的真实 DECISION(没有就取第一条);不显示 A7、τ 等数值
  const decisions = records.filter((r) => r.type === 'DECISION');
  const d = decisions.find((r) => r.kind === 'NONE') || decisions[0] || null;
  let trace = null;
  if (d) {
    const from = d.inputs && d.inputs.windowFrom != null ? d.inputs.windowFrom : null;
    const settlementSeqs = records.filter((r) => r.type === 'SETTLEMENT' && r.sleeve === d.sleeve && r.seq < d.seq && r.fundingTime <= d.decidedAt && (from == null || r.fundingTime > from)).map((r) => r.seq);
    const klineSeqs = records.filter((r) => r.type === 'MTM' && r.sleeve === d.sleeve && r.seq < d.seq && (r.boundary === d.at || r.valueAt === d.at)).map((r) => r.seq);
    const fills = records.filter((r) => r.type === 'FILL' && r.sleeve === d.sleeve && r.decisionId === d.seq).length;
    trace = {
      seq: d.seq, sleeve: d.sleeve, kind: d.kind, reason: d.reason || null, at: iso(d.at), decidedAt: iso(d.decidedAt), execAt: iso(d.execAt),
      effIn: d.effIn === undefined ? null : d.effIn, fresh: d.fresh === undefined ? null : d.fresh, signalValid: d.valid === undefined ? null : Boolean(d.valid),
      dropped: d.dropped || [],
      inputs: { fundingTimes: ((d.inputs && d.inputs.fundingTimes) || []).map(iso), windowFrom: iso(from) },
      settlement_record_seqs: settlementSeqs, kline_record_seqs: klineSeqs, fills_for_this_decision: fills,
      why_no_fill: d.kind === 'NONE' ? (d.effIn ? 'NONE: in position, no exit condition (values not shown)' : 'NONE: flat, entry condition not met (values not shown)')
        : d.kind === 'MISSING' ? `MISSING: ${d.reason}` : `${d.kind}: decision scheduled for execAt`,
    };
  }
  return { m13, m14, shown_missing_final: shownFinal, decision_trace: trace };
}

function m1(root, args, out) {
  const { pkgRoot, coreDir } = layout(path.resolve(root));
  assertCore(coreDir);
  for (const k of ['data', 'dtb3', 'ledgerRoot', 'cutoff', 'k2']) if (!args || !args[k]) throw new Error(`USAGE:args.${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.cutoff)) throw new Error('USAGE:cutoff');
  if (fs.existsSync(out)) throw new Error('M1_RECEIPT_EXISTS');
  const k2Buf = fs.readFileSync(args.k2);
  if (sha256(k2Buf) !== SPEC.k2.sha256) throw new Error(`K2_SHA256_MISMATCH:${sha256(k2Buf).slice(0, 8)}`);
  const envBefore = new Set(Object.keys(process.env));
  const req = (rel) => require(path.join(pkgRoot, rel));
  const T2 = req(TIER2);
  const runner = req(RUNNER);
  const Ledger = req(LEDGER);
  const Store = req(STORE);
  const injected = Object.keys(process.env).filter((k) => !envBefore.has(k));
  if (injected.length) throw new Error(`SMARTFLOW_ENV_INJECTED:${injected.length}`);

  const M1_1 = historyCheck({ pkgRoot, k2Text: k2Buf.toString('utf8') });
  const M1_2 = dataCheck({ T2, args });
  const A0_1 = identityCheck({ pkgRoot, runner });
  const led = ledgerCheck({ Ledger, Store, ledgerRoot: args.ledgerRoot, cutoff: args.cutoff, pkgRoot });
  const receipt = {
    kind: RECEIPT_KIND,
    k2: SPEC.k2, identity: SPEC.identity,
    smartflow_commit: PIN.smartflow.commit, core_version_hash: PIN.core.version_hash,
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    cutoff: args.cutoff,
    M1_1, M1_2, A0_1, M1_3: led.m13, M1_4: led.m14,
    shown_missing_final: led.shown_missing_final, decision_trace: led.decision_trace,
    attempts: SPEC.attempts,
    not_output: 'balances, equity, funding or interest amounts, returns, annualized figures, X, CI, (a)-vs-(b) comparison (K2 §5.1 R-M1-FWD ★a)',
    limits: ['both forward forms are before their first look', '(b) gives no verdict (PAPER_SHADOW · NO_CAPITAL · NO_VERDICT)', 'FILL / TRANSFER counts are the actual M1-4 numbers'],
  };
  receipt.pass = { M1_1: M1_1.pass, M1_2: M1_2.pass, M1_3: led.m13.pass, A0_1: A0_1.pass };
  receipt.pass.all = Object.values(receipt.pass).every(Boolean);
  assertNoForwardValues(receipt);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(receipt, null, 1)}\n`);
  return receipt;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`USAGE:${argv[i]}`);
    o[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['root', 'args', 'out']) if (!o[k]) throw new Error(`USAGE:--${k}`);
  return o;
}

function main(argv) {
  try {
    const o = parseArgs(argv);
    const r = m1(o.root, JSON.parse(fs.readFileSync(o.args, 'utf8')), o.out);
    process.stdout.write(`${JSON.stringify({ pass: r.pass, records: r.M1_3.records, history: { matched: r.M1_1.matched, mismatched: r.M1_1.mismatched, no_prior_record: r.M1_1.no_prior_record } })}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { RECEIPT_KIND, SPEC, getField, viewSha, historyCheck, fetchLogRehash, dataCheck, identityCheck, completeMonths, assertNoForwardValues, ledgerCheck, m1 };
