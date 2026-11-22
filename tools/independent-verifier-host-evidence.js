#!/usr/bin/env node
'use strict';

/**
 * 主机侧证据（W20，PLAN V1.1 修订 1 §2.3 / V1.1 W20 行）：文件权限、挂载、网络。由 ops-coord 在安装时运行，本仓库只提供脚本。
 * 只收集事实并判定，不改任何东西；查不到的记 UNKNOWN，不当 PASS。输出里没有主机名、地址、密钥，只有路径、模式位与判定。
 *
 *   node tools/independent-verifier-host-evidence.js --generator-uid <uid> --generator-gids <gid[,gid]> \
 *     --protected <path> [--protected ...] --holdout-dir <dir> [--holdout-dir ...] [--generator-pid <pid>] [--sandbox-pid <pid>]
 *
 *   PROTECTED_NOT_GENERATOR_WRITABLE  验证器代码、配置、判定表（及其下文件）生成方账号都写不了；
 *   HOLDOUT_NOT_GENERATOR_READABLE    留出段数据目录生成方账号既读不了也进不去；
 *   GENERATOR_MOUNTS                  Linux：生成方进程的挂载里看不到留出段目录，验证器路径只读（/proc/<pid>/mountinfo）；
 *   SANDBOX_NO_NETWORK                Linux：DSL 沙箱进程的网络命名空间里只有 lo（/proc/<pid>/net/dev）。
 * 退出码：有 FAIL → 1；否则 0（overall 为 PASS 或 INCOMPLETE，INCOMPLETE = 还有 UNKNOWN）。
 */
const fs = require('fs');
const path = require('path');

const bit = (mode, shift, w) => Boolean(mode & (w << shift));
/** 这个账号对这个文件按 Unix 规则（属主 → 同组 → 其他人）落在哪一类。 */
const klass = (st, id) => (st.uid === id.uid ? 6 : id.gids.includes(st.gid) ? 3 : 0);
const writableBy = (st, id) => bit(st.mode, klass(st, id), 2);
/** 读或进入（目录）：r 位或 x 位。 */
const readableBy = (st, id) => bit(st.mode, klass(st, id), 4) || bit(st.mode, klass(st, id), 1);

function mountFacts(info, { holdoutDirs = [], verifierDirs = [] } = {}) {
  if (typeof info !== 'string') return 'UNKNOWN';
  const mounts = info.split('\n').filter(Boolean).map((l) => { const f = l.split(' '); return { point: f[4], options: (f[5] || '').split(',') }; });
  const rel = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  const holdoutVisible = holdoutDirs.filter((d) => mounts.some((m) => m.point !== '/' && (rel(d, m.point) || rel(m.point, d))));
  const verifierReadOnly = Object.fromEntries(verifierDirs.map((d) => [d, mounts.some((m) => m.point === d && m.options.includes('ro'))]));
  return { holdoutVisible, verifierReadOnly };
}

function networkVerdict(text) {
  if (typeof text !== 'string') return 'UNKNOWN';
  const names = text.split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
  return names.every((n) => n === 'lo') ? 'PASS' : 'FAIL';
}

function walk(p, out = [], limit = 5000) {
  const st = fs.lstatSync(p);
  out.push({ path: p, st });
  if (st.isDirectory() && out.length < limit) for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n), out, limit);
  return out;
}
const readOrNull = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const stat = (p) => { const s = fs.lstatSync(p); return { mode: s.mode & 0o7777, uid: s.uid, gid: s.gid, isDirectory: s.isDirectory() }; };
const check = (id, state, detail = {}) => ({ id, state, detail });

function collect(argv) {
  const a = { protected: [], holdout: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]; const v = argv[i + 1];
    if (k === '--generator-uid') a.uid = Number(v); else if (k === '--generator-gids') a.gids = v.split(',').map(Number);
    else if (k === '--protected') a.protected.push(v); else if (k === '--holdout-dir') a.holdout.push(v);
    else if (k === '--generator-pid') a.genPid = v; else if (k === '--sandbox-pid') a.sandboxPid = v;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!Number.isInteger(a.uid) || !Array.isArray(a.gids) || a.gids.some((g) => !Number.isInteger(g))) throw new Error('--generator-uid and --generator-gids are required');
  return a;
}

function run(argv) {
  const a = collect(argv);
  const id = { uid: a.uid, gids: a.gids };
  const checks = [];
  if (!a.protected.length) checks.push(check('PROTECTED_NOT_GENERATOR_WRITABLE', 'UNKNOWN', { reason: 'NO_PATHS_GIVEN' }));
  else {
    const bad = a.protected.flatMap((p) => walk(p)).filter(({ st }) => writableBy({ mode: st.mode, uid: st.uid, gid: st.gid }, id)).map(({ path: p, st }) => ({ path: p, mode: (st.mode & 0o7777).toString(8) }));
    checks.push(check('PROTECTED_NOT_GENERATOR_WRITABLE', bad.length ? 'FAIL' : 'PASS', { checked: a.protected, writable: bad.slice(0, 20) }));
  }
  if (!a.holdout.length) checks.push(check('HOLDOUT_NOT_GENERATOR_READABLE', 'UNKNOWN', { reason: 'NO_PATHS_GIVEN' }));
  else {
    const bad = a.holdout.filter((d) => readableBy(stat(d), id)).map((d) => ({ path: d, mode: (stat(d).mode).toString(8) }));
    checks.push(check('HOLDOUT_NOT_GENERATOR_READABLE', bad.length ? 'FAIL' : 'PASS', { checked: a.holdout, readable: bad }));
  }
  const info = process.platform === 'linux' && a.genPid ? readOrNull(`/proc/${a.genPid}/mountinfo`) : null;
  const facts = mountFacts(info, { holdoutDirs: a.holdout, verifierDirs: a.protected.filter((p) => fs.statSync(p).isDirectory()) });
  if (facts === 'UNKNOWN') checks.push(check('GENERATOR_MOUNTS', 'UNKNOWN', { reason: 'NEEDS_LINUX_AND_GENERATOR_PID' }));
  else checks.push(check('GENERATOR_MOUNTS', facts.holdoutVisible.length || Object.values(facts.verifierReadOnly).some((v) => !v) ? 'FAIL' : 'PASS', facts));
  const net = process.platform === 'linux' && a.sandboxPid ? networkVerdict(readOrNull(`/proc/${a.sandboxPid}/net/dev`)) : 'UNKNOWN';
  checks.push(check('SANDBOX_NO_NETWORK', net, net === 'UNKNOWN' ? { reason: 'NEEDS_LINUX_AND_SANDBOX_PID' } : {}));
  const overall = checks.some((c) => c.state === 'FAIL') ? 'FAIL' : checks.some((c) => c.state === 'UNKNOWN') ? 'INCOMPLETE' : 'PASS';
  return { schema: 'INDEPENDENT_VERIFIER_HOST_EVIDENCE_V1', platform: process.platform, generator: { uid: a.uid, gids: a.gids }, checks, overall };
}

if (require.main === module) {
  try {
    const doc = run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    process.exit(doc.overall === 'FAIL' ? 1 : 0);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}

module.exports = { writableBy, readableBy, mountFacts, networkVerdict, run };
