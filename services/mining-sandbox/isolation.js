'use strict';

/**
 * 沙箱隔离（研究框架修订 2026-11-16 §3.5；§8.3 第 11 条；P1）：沙箱进程只许写自己的输出目录（候选文件、台账行由轮次执行器经 QRP 正门写）。
 *
 * lockdown({ allowRoot }) 在沙箱进程启动时调用一次，之后本进程里 fs 的写入口（writeFile / appendFile / mkdir / rename / rm / unlink /
 * copyFile / symlink / open 带写标志 / createWriteStream，同步、回调与 promises 三套）只要目标不在 allowRoot 之下就抛 MINE_SANDBOX_WRITE_REFUSED。
 * 这意味着沙箱进程写 QRP 台账（var/ledger）、config/、V6、smartflow 或桌面的任何路径都会失败。不能解除（同一进程里没有 unlock）。
 * 网络只许连模型接口（§3.5）由研究车道的出网规则管，不在本模块。
 */
const fs = require('fs');
const path = require('path');

class IsolationError extends Error {
  constructor(code, detail) { super(`${code}:${detail}`); this.code = code; this.detail = detail; }
}

let LOCKED = null;
let ROOTS = [];

const WRITE_FLAGS = /[wa+]/;
const SYNC = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'copyFileSync', 'cpSync', 'symlinkSync', 'linkSync', 'truncateSync', 'chmodSync', 'utimesSync', 'mkdtempSync'];
const ASYNC = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'copyFile', 'cp', 'symlink', 'link', 'truncate', 'chmod', 'utimes', 'mkdtemp'];
const TWO_PATHS = new Set(['renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'symlinkSync', 'symlink', 'linkSync', 'link']);

function inside(target, root) {
  const t = path.resolve(String(target instanceof URL ? target.pathname : target));
  const rel = path.relative(root, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function guard(name, target) {
  if (!ROOTS.some((r) => inside(target, r))) throw new IsolationError('MINE_SANDBOX_WRITE_REFUSED', `${name}:${path.resolve(String(target))}`);
}

/**
 * @param {{allowRoot: string}} o  沙箱的输出目录（必须已存在）
 * @returns {{allowRoot: string}}
 */
function lockdown({ allowRoot } = {}) {
  if (LOCKED) { if (!ROOTS.includes(path.resolve(allowRoot))) throw new IsolationError('MINE_SANDBOX_ALREADY_LOCKED', LOCKED); return { allowRoot: LOCKED }; }
  if (!allowRoot || !fs.existsSync(allowRoot) || !fs.statSync(allowRoot).isDirectory()) throw new IsolationError('MINE_SANDBOX_ALLOW_ROOT_INVALID', String(allowRoot));
  LOCKED = fs.realpathSync(path.resolve(allowRoot));
  ROOTS = [...new Set([path.resolve(allowRoot), LOCKED])]; // macOS：/var 与 /private/var 是同一处
  const wrap = (obj, name) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function guarded(...args) {
      guard(name, args[0]);
      if (TWO_PATHS.has(name)) guard(name, args[1]);
      return orig.apply(this, args);
    };
  };
  for (const n of [...SYNC, 'renameSync']) wrap(fs, n);
  for (const n of [...ASYNC, 'rename']) wrap(fs, n);
  for (const n of [...ASYNC, 'rename']) {
    const orig = fs.promises[n];
    if (typeof orig !== 'function') continue;
    fs.promises[n] = function guardedPromise(...args) { // promises 一套：拒绝走 Promise.reject，不同步抛
      try { guard(n, args[0]); if (TWO_PATHS.has(n)) guard(n, args[1]); } catch (e) { return Promise.reject(e); }
      return orig.apply(this, args);
    };
  }
  const writes = (flags) => (typeof flags === 'string' ? WRITE_FLAGS.test(flags)
    : (typeof flags === 'number' && Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT))));
  for (const n of ['openSync', 'open']) {
    const orig = fs[n];
    fs[n] = function guardedOpen(p, flags, ...rest) { if (writes(flags)) guard(n, p); return orig.call(this, p, flags, ...rest); };
  }
  const pOpen = fs.promises.open;
  fs.promises.open = function guardedPromiseOpen(p, flags, ...rest) {
    try { if (writes(flags)) guard('promises.open', p); } catch (e) { return Promise.reject(e); }
    return pOpen.call(this, p, flags, ...rest);
  };
  const cws = fs.createWriteStream;
  fs.createWriteStream = function guardedStream(p, ...rest) { guard('createWriteStream', p); return cws.call(this, p, ...rest); };
  return { allowRoot: LOCKED };
}

const lockedRoot = () => LOCKED;

module.exports = { IsolationError, lockdown, lockedRoot, internals: { inside } };
