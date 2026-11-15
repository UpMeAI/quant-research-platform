'use strict';

/**
 * G-CAUSAL 公用工具（修订草稿 §3.3、§3.5）：读清单（CAUSALITY_MANIFEST_V1），对每个函数跑三项测试，写 CAUSALITY_EVIDENCE_V1。
 *
 *   T-C1 前缀等价：每个截点 c，f(X) 与 f(X[≤c]) 在所有 t ≤ c 上的输出逐字节相等（规范串相等，见 canon.js）；
 *   T-C2 未来替换：X 中可得时点 > c 的行换成扰动数据（SHUFFLE 打乱行内容、WALK 同列随机游走，种子固定），t ≤ c 的输出不变；
 *   T-C3 只读给定输入：每次调用都在沙箱里（Node：权限模型 + 桩；Python：审计钩子），任何越界尝试都判 FAIL。
 *
 * 截断与比较都按「可得时点」，不按业务日期：每个输入都要写可得时点规则，算不出的行一律判不过（AVAILABILITY_UNKNOWN）。
 * 截点、扰动都由 sha256(种子|函数|…) 决定，与语言无关，重跑逐字节相同。比较与判定只在这里做；运行器只调用和写规范串。
 * 每次调用前被测模块都重新加载（MODULE_RELOAD；或每次调用一个新进程，PROCESS_PER_CALL），模块里的缓存不能把一次调用的未来带进另一次。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const gate = require('../../../services/causality-gate');

const HARNESS_VERSION = '1.0.0';
const MANIFEST_SCHEMA = 'CAUSALITY_MANIFEST_V1';
const VARIANTS = Object.freeze(['SHUFFLE', 'WALK']);
/** MODULE_RELOAD（默认）：一个函数一个进程，每次调用前重新加载被测模块、清掉新增全局变量；PROCESS_PER_CALL：每次调用一个新进程。 */
const ISOLATIONS = Object.freeze(['MODULE_RELOAD', 'PROCESS_PER_CALL']);
const MARK = '@@CAUSALITY@@';
const DAY = 86400000;
const ROOT = path.join(__dirname, '..');
const HARNESS_FILES = Object.freeze(['run.js', 'lib/core.js', 'lib/canon.js', 'lib/sandbox.js', 'lib/node-runner.js', 'python/causality_runner.py']);
const NODE_RUNNER = path.join(ROOT, 'lib', 'node-runner.js');
const PY_RUNNER = path.join(ROOT, 'python', 'causality_runner.py');
const TZ = /^[+-]\d{2}:\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

class HarnessError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new HarnessError(`CAUSALITY_HARNESS_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rank = (...parts) => sha256(parts.join('|'));
const byRank = (tag) => (a, b) => (rank(tag, a) < rank(tag, b) ? -1 : 1);
/** [0, 1)：sha256 前 13 位十六进制（52 位）。 */
const unit = (...parts) => parseInt(rank(...parts).slice(0, 13), 16) / 2 ** 52;
const iso = (ms) => new Date(ms).toISOString();
const real = (p) => fs.realpathSync.native(p);
const inside = (abs, dir) => abs === dir || abs.startsWith(dir + path.sep);
const clip = (s, n = 160) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

function harnessSha256() {
  return sha256(HARNESS_FILES.map((f) => `${f}\0${sha256(fs.readFileSync(path.join(ROOT, f)))}`).join('\n'));
}

// ── 可得时点 ────────────────────────────────────────────────────────────────────

function dateOf(v) {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  return null;
}

/**
 * 可得时点规则 → (row) => 毫秒 | null。
 *   FIELD    { field, add_seconds? }：字段是带时区的 ISO 时间，或毫秒时间戳；
 *   DATE_AT  { field, time: 'HH:MM', tz: '+08:00', offset_days? }：字段是日期，可得时点 = 该日（+offset_days）的 time（日线收盘、报表 ann_date 次日 00:00）；
 *   RULED_LAG：FIELD 或 DATE_AT 的写法，加 lag_seconds 与 ruling_sha256（§3.3「协调会话的裁定写明滞后规则」，导入门核对裁定）。
 */
function availabilityOf(rule, where) {
  need(rule && gate.AVAILABILITY_RULES.includes(rule.rule), 'AVAILABILITY_RULE_INVALID', where);
  need(typeof rule.field === 'string' && rule.field, 'AVAILABILITY_RULE_INVALID', `${where}:field`);
  const ruled = rule.rule === 'RULED_LAG';
  if (ruled) need(Number.isFinite(rule.lag_seconds) && rule.lag_seconds >= 0 && gate.SHA64.test(rule.ruling_sha256 || ''), 'AVAILABILITY_RULE_INVALID', `${where}:RULED_LAG`);
  const dateAt = rule.rule === 'DATE_AT' || (ruled && rule.time !== undefined);
  if (dateAt) need(HHMM.test(rule.time || '') && TZ.test(rule.tz || '') && Number.isInteger(rule.offset_days || 0), 'AVAILABILITY_RULE_INVALID', `${where}:DATE_AT`);
  const addMs = ((rule.add_seconds || 0) + (ruled ? rule.lag_seconds : 0)) * 1000;
  return (row) => {
    const v = row !== null && typeof row === 'object' ? row[rule.field] : undefined;
    let ms = null;
    if (dateAt) { const d = dateOf(v); if (d) ms = Date.parse(`${d}T${rule.time}:00${rule.tz}`) + (rule.offset_days || 0) * DAY; } else if (typeof v === 'number' && Number.isFinite(v)) ms = v;
    else if (typeof v === 'string' && /T\d{2}:\d{2}/.test(v) && /([zZ]|[+-]\d{2}:\d{2})$/.test(v)) ms = Date.parse(v);
    return Number.isFinite(ms) ? ms + addMs : null;
  };
}

// ── 截点（★3 (a)） ──────────────────────────────────────────────────────────────

const offsetMs = (tz) => (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * 60000;
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * 候选 = 所有输入行的不同可得时点，去掉最后一个（要有未来可截）。必选：首 5%、尾 5% 各一个，每个段边界两侧各一个，
 * 盘中函数每个交易日一个盘中截点（开盘后、收盘前）；再按 sha256 排序补到 K 个。必选超过 K 时全取。
 */
function cutPoints(fid, avails, { seed, k, boundaries = [], session = null }) {
  const all = [...new Set(avails)].sort((a, b) => a - b);
  const cands = all.slice(0, -1);
  if (!cands.length) return { cuts: [], blocked: 'NO_CUT_CANDIDATE' };
  const tag = (t) => `${seed}|${fid}|${t}`;
  const pick = (list, t) => list.slice().sort(byRank(tag(t)))[0];
  const chosen = new Set();
  const edge = Math.max(1, Math.ceil(0.05 * cands.length));
  chosen.add(pick(cands.slice(0, edge), 'head'));
  chosen.add(pick(cands.slice(cands.length - edge), 'tail'));
  for (const b of boundaries) {
    const ms = Date.parse(b);
    need(typeof b === 'string' && /([zZ]|[+-]\d{2}:\d{2})$/.test(b) && Number.isFinite(ms), 'SEGMENT_BOUNDARY_INVALID', `${fid}:${b}`);
    const before = cands.filter((c) => c < ms).pop();
    const at = cands.find((c) => c >= ms);
    if (before !== undefined) chosen.add(before);
    if (at !== undefined) chosen.add(at);
  }
  if (session) {
    const off = offsetMs(session.tz);
    const open = minutes(session.open);
    const close = minutes(session.close);
    const days = new Map();
    for (const c of cands) {
      const local = c + off;
      const m = Math.floor((((local % DAY) + DAY) % DAY) / 60000);
      if (m <= open || m >= close) continue;
      const day = new Date(local).toISOString().slice(0, 10);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(c);
    }
    if (!days.size) return { cuts: [], blocked: 'NO_INTRADAY_CUT' };
    for (const [day, list] of days) chosen.add(pick(list, `day:${day}`));
  }
  const rest = cands.filter((c) => !chosen.has(c)).sort(byRank(tag('fill')));
  while (chosen.size < k && rest.length) chosen.add(rest.shift());
  return { cuts: [...chosen].sort((a, b) => a - b), blocked: null };
}

// ── 截断与扰动 ──────────────────────────────────────────────────────────────────

const prefixOf = (input, c) => input.rows.filter((_, i) => input.avail[i] <= c);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** t > c 的行换成扰动数据。受保护的列（可得时点字段、key_fields、keep_fields）留在原行；其余列 SHUFFLE 在未来行之间打乱，WALK 换成随机游走。 */
function replaceFuture(input, c, variant, tag) {
  const out = input.rows.slice();
  const fut = input.rows.map((_, i) => i).filter((i) => input.avail[i] > c);
  if (!fut.length) return out;
  const prot = new Set([input.availability.field, ...(input.key_fields || []), ...(input.keep_fields || [])]);
  if (variant === 'SHUFFLE') {
    const perm = fut.slice().sort(byRank(`${tag}|shuffle`));
    fut.forEach((i, p) => {
      const dst = input.rows[i];
      const src = input.rows[perm[p]];
      const row = {};
      for (const k of Object.keys(dst)) row[k] = prot.has(k) ? dst[k] : src[k];
      for (const k of Object.keys(src)) if (!(k in row)) row[k] = src[k];
      out[i] = row;
    });
    return out;
  }
  const keyOf = (row) => JSON.stringify((input.key_fields || []).map((k) => row[k]));
  const groups = new Map();
  input.rows.forEach((row, i) => { const g = keyOf(row); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
  for (const [g, idx] of groups) {
    const futIdx = idx.filter((i) => input.avail[i] > c);
    if (!futIdx.length) continue;
    const cols = [...new Set(idx.flatMap((i) => Object.keys(input.rows[i])))].filter((k) => !prot.has(k));
    for (const col of cols) {
      const vals = idx.map((i) => input.rows[i][col]).filter((v) => v !== null && v !== undefined);
      if (!vals.length || !vals.every(isNum)) continue;
      const integer = vals.every(Number.isInteger);
      const past = idx.filter((i) => input.avail[i] <= c && isNum(input.rows[i][col]));
      let last = past.length ? input.rows[past[past.length - 1]][col] : vals[0];
      for (const i of futIdx) {
        const step = 0.1 * (unit(tag, 'walk', g, col, i) - 0.5);
        last = last !== 0 ? last * (1 + step) : step;
        if (out[i] === input.rows[i]) out[i] = { ...input.rows[i] };
        out[i][col] = integer ? Math.floor(last + 0.5) : last;
      }
    }
  }
  return out;
}

// ── 运行器 ──────────────────────────────────────────────────────────────────────

/**
 * Node 权限模型的读权限。嵌套的路径只留最外层：Node 23.11 上，子目录排在父目录前面时，父目录本身会被拒（实测）。
 * 权限模型只是第二道防线，判 T-C3 的是 sandbox.js 的桩。
 */
function permissionFlags(paths) {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const allow = sorted.filter((p, i) => !sorted.slice(0, i).some((q) => inside(p, q)));
  const flags = process.allowedNodeEnvironmentFlags;
  const flag = flags.has('--permission') ? '--permission' : flags.has('--experimental-permission') ? '--experimental-permission' : null;
  return flag ? { mode: 'PERMISSION_MODEL+STUBS', args: [flag, ...allow.map((p) => `--allow-fs-read=${p}`)] } : { mode: 'STUBS_ONLY', args: [] };
}

/** 起一个运行器进程跑一批作业（MODULE_RELOAD：一个函数一批；PROCESS_PER_CALL：一次调用一批）。返回 Map(作业 id → { mode, init, result, error })。 */
function invoke(ctx, spec, jobs) {
  const runner = spec.runner || 'node';
  const init = { op: 'init', code_root: ctx.codeRoot, code_roots: ctx.codeRoots, fixture_dir: ctx.fixtureDir, path: spec.path, entry: spec.entry,
    call: spec.call || {}, output: spec.output, frames: spec.frames || {}, static_reads: ctx.staticReads };
  const input = `${[init, ...jobs].map((x) => JSON.stringify(x)).join('\n')}\n`;
  let cmd; let args; let mode;
  if (runner === 'node') {
    const perm = permissionFlags([path.dirname(NODE_RUNNER), ctx.fixtureDir, ...ctx.codeRoots]);
    cmd = process.execPath; args = [...perm.args, NODE_RUNNER]; mode = perm.mode;
  } else {
    cmd = ctx.python; args = ['-I', '-B', PY_RUNNER]; mode = 'AUDIT_HOOK';
  }
  const r = spawnSync(cmd, args, { input, maxBuffer: 1 << 30, timeout: ctx.timeoutMs * jobs.length, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TZ: 'UTC' } });
  const lines = String(r.stdout || '').split('\n').filter((l) => l.startsWith(MARK)).map((l) => JSON.parse(l.slice(MARK.length)));
  const initRow = lines.find((l) => l.id === 'init') || null;
  let base = null;
  if (r.error) base = `RUNNER_FAILED:${r.error.code || r.error.message}`;
  else if (!initRow) base = `RUNNER_FAILED:${clip(String(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`, 200)}`;
  else if (!initRow.ok) base = `INIT_FAILED:${clip(initRow.error, 200)}`;
  const out = new Map();
  jobs.forEach((job, i) => {
    const result = lines.find((l) => l.id === job.id) || null;
    const error = base || (result ? null : `RUNNER_FAILED:no result (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})`);
    out.set(job.id, { mode, init: i === 0 ? initRow : null, result, error });
  });
  return out;
}

// ── 比较 ────────────────────────────────────────────────────────────────────────

/** 一次调用的输出 → Map(比较键 → { t, value })。ALIGNED 以主输入的行号为键；KEYED 以 key_fields 与输出可得时点为键。 */
function readings(spec, out, primary, outAvail, rowIndex = null) {
  const map = new Map();
  if (spec.output.align !== 'KEYED') {
    need(out.kind === 'ALIGNED', 'OUTPUT_KIND_MISMATCH');
    const idx = rowIndex || primary.rows.map((_, i) => i);
    if (out.values.length !== idx.length) return { error: `OUTPUT_NOT_ALIGNED:${out.values.length}≠${idx.length}` };
    out.values.forEach((v, j) => map.set(String(idx[j]), { t: primary.avail[idx[j]], value: v }));
    return { map };
  }
  for (const [key, rawT, value] of out.rows) {
    const t = outAvail({ [spec.output.availability.field]: rawT });
    if (t === null) return { error: `OUTPUT_AVAILABILITY_UNKNOWN:${clip(String(rawT), 40)}` };
    const k = `${key}@${t}`;
    if (map.has(k)) return { error: `OUTPUT_KEY_DUPLICATE:${clip(key, 60)}` };
    map.set(k, { t, value });
  }
  return { map };
}

function compare(full, other, c, test, variant, sink) {
  let n = 0;
  const push = (t, key, a, b) => { n += 1; sink.push({ test, ...(variant ? { variant } : {}), c: iso(c), t: t === null ? null : iso(t), key: clip(key, 80), full: clip(a), other: clip(b) }); };
  for (const [k, r] of full) if (r.t <= c) { const o = other.get(k); if (!o) push(r.t, k, r.value, '<missing>'); else if (o.value !== r.value) push(r.t, k, r.value, o.value); }
  for (const [k, o] of other) if (o.t <= c && !full.has(k)) push(o.t, k, '<missing>', o.value);
  return n;
}

// ── 一个函数 ────────────────────────────────────────────────────────────────────

function loadInput(ctx, spec, fid) {
  need(spec && typeof spec.name === 'string' && typeof spec.file === 'string', 'INPUT_INVALID', fid);
  const file = path.resolve(ctx.fixtureDir, spec.file);
  need(fs.existsSync(file) && inside(real(file), ctx.fixtureDir), 'INPUT_OUTSIDE_FIXTURE_DIR', `${fid}:${spec.file}`);
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  const rows = /\.(ndjson|jsonl)$/.test(file) ? text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : JSON.parse(text);
  need(Array.isArray(rows), 'INPUT_NOT_ARRAY', `${fid}:${spec.name}`);
  const availOf = availabilityOf(spec.availability, `${fid}:${spec.name}`);
  return { name: spec.name, file: spec.file, file_sha256: sha256(bytes), rows, avail: rows.map(availOf), availability: spec.availability,
    intraday: Boolean(spec.intraday), key_fields: spec.key_fields || [], keep_fields: spec.keep_fields || [] };
}

function runFunction(spec, ctx) {
  need(spec && typeof spec.path === 'string' && typeof spec.entry === 'string', 'FUNCTION_SPEC_INVALID');
  const fid = `${ctx.codeRepo}:${spec.path}#${spec.entry}`;
  need(gate.FUNCTION_ID.test(fid), 'FUNCTION_ID_INVALID', fid);
  const runner = spec.runner || 'node';
  need(gate.RUNNERS.includes(runner), 'RUNNER_INVALID', `${fid}:${runner}`);
  need(Array.isArray(spec.inputs) && spec.inputs.length, 'INPUTS_MISSING', fid);
  const output = spec.output || {};
  need(['ALIGNED', 'KEYED', 'AT_POINT'].includes(output.align), 'OUTPUT_SPEC_INVALID', fid);
  const inputs = spec.inputs.map((s) => loadInput(ctx, s, fid));
  const names = inputs.map((i) => i.name);
  need(new Set(names).size === names.length, 'INPUT_DUPLICATE', fid);
  const primary = output.align !== 'KEYED' ? inputs.find((i) => i.name === output.to) : null;
  if (output.align !== 'KEYED') need(primary, 'OUTPUT_SPEC_INVALID', `${fid}:to names the input the readings align to`);
  if (output.align === 'AT_POINT') {
    const ats = [].concat((spec.call || {}).at || []);
    need(ats.length && ats.every((at) => at && Number.isInteger(at.position) && at.position >= 0 && (at.value === 'INDEX' || (at.value === 'FIELD' && typeof at.field === 'string'))), 'OUTPUT_SPEC_INVALID', `${fid}:AT_POINT needs call.at {position, value: INDEX|FIELD} (or a list of them)`);
  }
  if (output.align === 'KEYED') need(typeof output.time_field === 'string' && output.availability && output.availability.field === output.time_field, 'OUTPUT_SPEC_INVALID', `${fid}:KEYED needs time_field and availability on it`);
  const outAvail = output.align === 'KEYED' ? availabilityOf(output.availability, `${fid}:output`) : null;
  const sourceFile = path.join(ctx.codeRoot, spec.path);
  need(fs.existsSync(sourceFile), 'FUNCTION_FILE_MISSING', fid);
  // 静态文件或目录：文件记 sha256；目录逐个文件（相对路径排序）记 sha256，再对清单取 sha256
  const staticReads = (spec.static_reads || []).map((rel) => {
    const abs = path.resolve(ctx.codeRoot, rel);
    need(fs.existsSync(abs) && inside(real(abs), ctx.codeRoot), 'STATIC_READ_INVALID', `${fid}:${rel}`);
    if (!fs.statSync(abs).isDirectory()) return { path: rel, abs: real(abs), kind: 'FILE', sha256: sha256(fs.readFileSync(abs)) };
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) files.push(f); } };
    walk(abs);
    const listing = files.map((f) => `${path.relative(abs, f)}\0${sha256(fs.readFileSync(f))}`).sort().join('\n');
    return { path: rel, abs: real(abs), kind: 'DIR', files: files.length, sha256: sha256(listing) };
  });
  const callCtx = { ...ctx, staticReads: staticReads.map((x) => x.abs) };

  const reasons = {};
  const block = (code) => { reasons.t_c1 = reasons.t_c1 || code; reasons.t_c2 = reasons.t_c2 || code; };
  for (const input of inputs) {
    const bad = input.avail.findIndex((x) => x === null);
    if (bad >= 0) block(`AVAILABILITY_UNKNOWN:${input.name}[${bad}]`);
    for (const label of ctx.labelFields) if (input.rows.some((r) => r && typeof r === 'object' && label in r)) block(`LABEL_IN_INPUT:${input.name}.${label}`);
  }
  const intraday = inputs.some((i) => i.intraday);
  if (intraday) need(spec.session && HHMM.test(spec.session.open || '') && HHMM.test(spec.session.close || '') && TZ.test(spec.session.tz || ''), 'SESSION_REQUIRED', fid);
  let cuts = [];
  if (!reasons.t_c1) {
    const sel = cutPoints(fid, inputs.flatMap((i) => i.avail), { seed: ctx.seed, k: ctx.k, boundaries: spec.segment_boundaries || [], session: intraday ? spec.session : null });
    if (sel.blocked) block(sel.blocked);
    cuts = sel.cuts;
  }

  const jobs = [{ op: 'call', id: 'full', inputs: Object.fromEntries(inputs.map((i) => [i.name, i.rows])) }];
  for (const [ci, c] of cuts.entries()) {
    jobs.push({ op: 'call', id: `c1|${ci}`, inputs: Object.fromEntries(inputs.map((i) => [i.name, prefixOf(i, c)])) });
    for (const v of VARIANTS) jobs.push({ op: 'call', id: `c2|${ci}|${v}`, inputs: Object.fromEntries(inputs.map((i) => [i.name, replaceFuture(i, c, v, `${ctx.seed}|${fid}|${c}|${i.name}`)])) });
  }
  const attempts = [];
  const loadReads = new Set();
  let runtime = null; let mode = null;
  const results = new Map();
  const batches = ctx.isolation === 'PROCESS_PER_CALL' ? jobs.map((j) => [j]) : [jobs];
  for (const batch of batches) {
    for (const [id, r] of invoke(callCtx, spec, batch)) {
      mode = r.mode;
      if (r.init) { attempts.push(...(r.init.attempts || [])); for (const x of r.init.load_reads || []) loadReads.add(x); runtime = runtime || r.init.runtime || null; }
      if (r.result) attempts.push(...(r.result.attempts || []));
      results.set(id, r);
    }
  }

  const mismatches = [];
  const counts = { t_c1: 0, t_c2: 0 };
  const full = results.get('full');
  let fullMap = null;
  let summary = null;
  if (full.error || !full.result.ok) block(`FULL_CALL_FAILED:${clip(full.error || full.result.error, 160)}`);
  else {
    const r = readings(spec, full.result.out, primary, outAvail);
    if (r.error) block(r.error);
    else {
      fullMap = r.map;
      // 读数只有一种值（全空、全报错、恒定）时，T-C1 的「相等」证明不了什么：T-C1 判不过，夹具要能让读数变化。
      // T-C2 照常跑——换掉未来之后读数若变了，正好说明函数读了未来（单边行情上的前视就是这样被看出来的）
      const values = [...fullMap.values()].map((x) => x.value);
      const distinct = new Set(values).size;
      summary = { count: values.length, distinct, null_or_error: values.filter((v) => v === 'n' || v === 'u' || v.startsWith('x:')).length };
      if (distinct < 2) reasons.t_c1 = reasons.t_c1 || `DEGENERATE_OUTPUT:${distinct}_distinct_of_${values.length}`;
    }
  }
  if (fullMap) {
    const firstErr = { t_c1: null, t_c2: null };
    for (const [ci, c] of cuts.entries()) {
      const one = (id, test, variant, rowIndex) => {
        const r = results.get(id);
        const key = test === 'T-C1' ? 't_c1' : 't_c2';
        if (r.error || !r.result.ok) { firstErr[key] = firstErr[key] || `THREW:${clip(r.error || r.result.error, 160)}`; return; }
        const m = readings(spec, r.result.out, primary, outAvail, rowIndex);
        if (m.error) { firstErr[key] = firstErr[key] || m.error; return; }
        counts[key] += compare(fullMap, m.map, c, test, variant, mismatches);
      };
      const prefixIdx = primary ? primary.rows.map((_, i) => i).filter((i) => primary.avail[i] <= c) : null;
      one(`c1|${ci}`, 'T-C1', null, prefixIdx);
      for (const v of VARIANTS) one(`c2|${ci}|${v}`, 'T-C2', v, null);
    }
    for (const key of ['t_c1', 't_c2']) if (!reasons[key]) reasons[key] = firstErr[key] || (counts[key] ? `MISMATCH:${counts[key]}` : undefined);
  }
  const seen = new Set();
  const forbidden = attempts.filter((a) => { const k = `${a.phase}|${a.kind}|${a.target}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (forbidden.length) reasons.t_c3 = `${forbidden[0].kind}:${forbidden[0].target}`;
  else if (full.error && /^(RUNNER|INIT)_FAILED/.test(full.error)) reasons.t_c3 = full.error.split(':')[0];
  for (const k of Object.keys(reasons)) if (reasons[k] === undefined) delete reasons[k];
  const status = (k) => (reasons[k] ? 'FAIL' : 'PASS');
  return {
    function_id: fid, path: spec.path, entry: spec.entry, runner, file_sha256: sha256(fs.readFileSync(sourceFile)),
    inputs: inputs.map((i) => ({ name: i.name, file: i.file, file_sha256: i.file_sha256, rows: i.rows.length, availability: i.availability, intraday: i.intraday, key_fields: i.key_fields, keep_fields: i.keep_fields })),
    call: spec.call || {}, output, static_reads: staticReads.map(({ abs: _a, ...rest }) => rest), ...(spec.session ? { session: spec.session } : {}), segment_boundaries: spec.segment_boundaries || [],
    cut_points: cuts.map(iso), calls: jobs.length, isolation: ctx.isolation, sandbox: { mode, runtime },
    t_c1: status('t_c1'), t_c2: status('t_c2'), t_c3: status('t_c3'), fail_reasons: reasons,
    readings_summary: summary, mismatch_counts: counts, mismatches: mismatches.slice(0, gate.MAX_MISMATCHES), forbidden_attempts: forbidden.slice(0, 20), load_reads: [...loadReads].sort(),
  };
}

// ── 代码版本 ────────────────────────────────────────────────────────────────────

/** code_sha 只在被测文件都已提交、已跟踪文件没有改动时才写；否则写 null 并在 unknown 里写原因。 */
function codeShaOf(codeRoot, paths) {
  const git = (...args) => execFileSync('git', ['-C', codeRoot, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try { git('rev-parse', '--is-inside-work-tree'); } catch { return { sha: null, unknown: 'NOT_A_GIT_REPO' }; }
  let head;
  try { head = git('rev-parse', 'HEAD'); } catch { return { sha: null, unknown: 'NO_COMMIT' }; }
  for (const p of paths) { try { git('ls-files', '--error-unmatch', p); } catch { return { sha: null, unknown: `FUNCTION_FILE_UNTRACKED:${p}` }; } }
  if (git('status', '--porcelain', '--untracked-files=no')) return { sha: null, unknown: 'WORKTREE_DIRTY' };
  return { sha: head, unknown: null };
}

// ── 清单 → 证据 ─────────────────────────────────────────────────────────────────

const gitTop = (dir) => { try { return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

function loadManifest(file) {
  const bytes = fs.readFileSync(file);
  const m = JSON.parse(bytes.toString('utf8'));
  need(m && m.schema === MANIFEST_SCHEMA, 'MANIFEST_SCHEMA_INVALID', file);
  need(typeof m.study_ref === 'string' && m.study_ref && gate.SHA64.test(m.k2_sha256 || ''), 'MANIFEST_INVALID', 'study_ref / k2_sha256');
  need(/^[a-z0-9][a-z0-9-]*$/.test(m.code_repo || ''), 'MANIFEST_INVALID', 'code_repo');
  need(Array.isArray(m.functions) && m.functions.length, 'MANIFEST_INVALID', 'functions');
  return { manifest: m, sha256: sha256(bytes), dir: path.dirname(path.resolve(file)) };
}

/**
 * 跑一份清单，返回证据（未写盘）。
 * @param {string} manifestFile 清单路径（夹具目录相对清单所在目录）
 * @param {{codeRoot?: string, extraCodeRoots?: string[], registeredBy: string, registeredAt?: string, python?: string, timeoutMs?: number, seed?: number, k?: number}} opts
 */
function runManifest(manifestFile, opts = {}) {
  need(typeof opts.registeredBy === 'string' && opts.registeredBy.trim(), 'REGISTERED_BY_REQUIRED');
  const { manifest: m, sha256: manifestSha, dir } = loadManifest(manifestFile);
  const codeRoot = real(opts.codeRoot || gitTop(dir) || dir);
  const fixtureDir = real(path.resolve(dir, m.fixture_dir || '.'));
  const ctx = {
    codeRepo: m.code_repo, codeRoot, codeRoots: [codeRoot, ...(opts.extraCodeRoots || []).map(real)], fixtureDir,
    seed: opts.seed !== undefined ? opts.seed : (m.seed !== undefined ? m.seed : gate.SEED), k: opts.k !== undefined ? opts.k : (m.cut_points_per_function !== undefined ? m.cut_points_per_function : gate.CUT_POINTS),
    labelFields: m.label_fields || [], python: opts.python || 'python3', timeoutMs: opts.timeoutMs || 120000, isolation: opts.isolation || 'MODULE_RELOAD',
  };
  need(Number.isInteger(ctx.seed) && Number.isInteger(ctx.k) && ctx.k > 0, 'MANIFEST_INVALID', 'seed / k');
  need(ISOLATIONS.includes(ctx.isolation), 'ISOLATION_INVALID', ctx.isolation);
  const functions = m.functions.map((spec) => runFunction(spec, ctx));
  const unknown = {};
  const code = codeShaOf(codeRoot, m.functions.map((f) => f.path));
  if (code.unknown) unknown.code_sha = code.unknown;
  const doc = {
    schema: gate.SCHEMA, study_ref: m.study_ref, k2_sha256: m.k2_sha256, code_repo: m.code_repo, code_sha: code.sha,
    harness_version: HARNESS_VERSION, harness_sha256: harnessSha256(), seed: ctx.seed, cut_points_per_function: ctx.k, manifest_sha256: manifestSha,
    functions, unknown, production_effect: 'NONE', registered_by: opts.registeredBy, registered_at: opts.registeredAt || new Date().toISOString(),
  };
  doc.record_hash = gate.recordHash(doc);
  gate.parseEvidence(Buffer.from(JSON.stringify(doc)), 'self-check');
  return doc;
}

/** 写一次不改：目标已存在就拒绝（更正写新文件）。旁边写 <file>.sha256。 */
function writeEvidence(file, doc) {
  need(!fs.existsSync(file), 'EVIDENCE_EXISTS', file);
  const bytes = `${JSON.stringify(doc, null, 1)}\n`;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  const digest = sha256(bytes);
  fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, { flag: 'wx' });
  return digest;
}

module.exports = {
  HARNESS_VERSION, MANIFEST_SCHEMA, VARIANTS, ISOLATIONS, HarnessError, harnessSha256, runManifest, runFunction, writeEvidence, loadManifest,
  internals: { availabilityOf, cutPoints, replaceFuture, prefixOf, compare, codeShaOf, rank, unit },
};
