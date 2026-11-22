'use strict';

/**
 * 生成方进程的进程级锁（W20，PLAN V1.1 修订 1 §2.3）：写只许输出目录（复用 mining-sandbox/isolation 的 lockdown，不另写），
 * 读不许进留出段数据目录（本文件补的那一半）。同一进程里没有解除入口。OS 级隔离（用户、挂载、网络）不在这里，见 tools/independent-verifier-host-evidence.js。
 */
const fs = require('fs');
const path = require('path');
const isolation = require('../mining-sandbox/isolation');

const READ_SYNC = ['readFileSync', 'readdirSync', 'openSync', 'opendirSync', 'createReadStream', 'copyFileSync', 'cpSync', 'readlinkSync'];
const READ_ASYNC = ['readFile', 'readdir', 'open', 'opendir', 'copyFile', 'cp', 'readlink'];

class ReadRefused extends Error {
  constructor(detail) { super(`VERIFIER_HOLDOUT_READ_REFUSED:${detail}`); this.code = 'VERIFIER_HOLDOUT_READ_REFUSED'; this.detail = detail; }
}

const realpath = fs.realpathSync;
function real(p) {
  let cur = path.resolve(String(p instanceof URL ? p.pathname : p));
  const tail = [];
  for (;;) {
    try { return path.join(realpath(cur), ...tail.reverse()); } catch (e) {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(String(p));
      tail.push(path.basename(cur)); cur = up;
    }
  }
}
const within = (target, root) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

let LOCKED = false;
/**
 * @param {{allowWriteRoot: string, denyReadRoots?: string[]}} o
 */
function lockProcess({ allowWriteRoot, denyReadRoots = [] } = {}) {
  isolation.lockdown({ allowRoot: allowWriteRoot });
  if (LOCKED) return { allowWriteRoot, denyReadRoots };
  LOCKED = true;
  const deny = [...new Set(denyReadRoots.flatMap((r) => [path.resolve(r), real(r)]))];
  const guard = (target) => { if (typeof target === 'number' || target === undefined || target === null) return; const t = real(target); if (deny.some((r) => within(t, r))) throw new ReadRefused(t); };
  const wrap = (obj, name, nPaths = 1) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function guarded(...args) { for (let i = 0; i < nPaths; i += 1) guard(args[i]); return orig.apply(this, args); };
  };
  for (const n of READ_SYNC) wrap(fs, n, /^(copyFile|cp)/.test(n) ? 1 : 1);
  for (const n of READ_ASYNC) wrap(fs, n);
  for (const n of READ_ASYNC) {
    const orig = fs.promises[n];
    if (typeof orig !== 'function') continue;
    fs.promises[n] = function guardedPromise(...args) { try { guard(args[0]); } catch (e) { return Promise.reject(e); } return orig.apply(this, args); };
  }
  return { allowWriteRoot, denyReadRoots };
}

module.exports = { ReadRefused, lockProcess };
