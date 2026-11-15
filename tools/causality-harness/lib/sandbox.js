'use strict';

/**
 * T-C3「只读给定输入」的 Node 沙箱（修订草稿 §3.3）：注入的桩，叠加子进程的 Node 权限模型（--permission，见 core.js）。
 *
 * 两个阶段：
 *   LOAD（加载被测模块）：可读代码根下的代码文件与 .json（模块自带的静态表），夹具目录；
 *   CALL（调用被测函数）：只可读夹具目录与清单声明的静态文件（static_reads，sha256 记进证据）；代码根下只允许按需加载
 *     代码文件（.js/.cjs/.mjs/.node），不允许读别的数据文件。
 * 两个阶段都不许写文件、访问网络（含 Unix 套接字，即数据库）、起子进程或线程。
 * 每一次越界都先记下再抛错：被测函数吞掉异常、改走别的路，T-C3 照样判 FAIL。
 */
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const CODE_EXT = /\.(c?js|mjs|node)$/;
const DENIED = 'CAUSALITY_SANDBOX_DENIED';

function createSandbox({ fixtureDir, codeRoots, staticReads = [] }) {
  const attempts = [];
  const loadReads = [];
  let phase = 'LOAD';
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const fixture = real(fixtureDir);
  const roots = codeRoots.map(real);
  const statics = new Set(staticReads.map(real)); // 清单声明、已记 sha256 的静态文件（参数表），调用阶段也可读
  const inside = (abs, dir) => abs === dir || abs.startsWith(dir + path.sep);
  const display = (abs) => {
    if (inside(abs, fixture)) return `<fixture>/${path.relative(fixture, abs)}`;
    const root = roots.find((r) => inside(abs, r));
    return root ? `<code>/${path.relative(root, abs)}` : `<outside>/${path.basename(abs)}`;
  };
  const toPath = (p) => {
    if (typeof p === 'number') return null; // 已打开的 fd：打开时已检查
    if (p instanceof URL) p = fileURLToPath(p);
    if (Buffer.isBuffer(p)) p = p.toString();
    if (typeof p !== 'string') return null;
    const abs = path.resolve(p);
    let r = abs;
    try { r = realOrig(abs); } catch { /* 不存在的路径按原样判 */ }
    return r;
  };
  const realOrig = fs.realpathSync.native.bind(fs);
  const deny = (kind, target) => {
    attempts.push({ phase, kind, target });
    const e = new Error(`${DENIED}:${kind}:${target}`);
    e.code = DENIED;
    throw e;
  };
  const readAllowed = (abs) => {
    if (inside(abs, fixture) || statics.has(abs)) return true;
    if (!roots.some((r) => inside(abs, r))) return false;
    if (CODE_EXT.test(abs)) return true;
    return phase === 'LOAD' && abs.endsWith('.json');
  };
  const checkRead = (p, kind = 'FS_READ') => {
    const abs = toPath(p);
    if (abs === null) return;
    if (!readAllowed(abs)) deny(kind, display(abs));
    if (phase === 'LOAD' && !inside(abs, fixture) && !CODE_EXT.test(abs)) loadReads.push(display(abs));
  };
  const writeFlags = (flags) => (typeof flags === 'string' ? /[wa+]/.test(flags) : typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND)) !== 0 : false);

  const wrap = (obj, name, guard) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    const fn = function sandboxed(...args) { guard(args); return orig.apply(this, args); };
    Object.defineProperty(fn, 'name', { value: name });
    for (const k of Object.keys(orig)) fn[k] = orig[k]; // fs.realpathSync.native 等
    obj[name] = fn;
  };
  const READS = ['readFileSync', 'readFile', 'createReadStream', 'readdirSync', 'readdir', 'opendirSync', 'opendir', 'statSync', 'stat', 'lstatSync', 'lstat',
    'existsSync', 'exists', 'accessSync', 'access', 'realpathSync', 'realpath', 'readlinkSync', 'readlink', 'watch', 'watchFile', 'statfsSync', 'statfs', 'readvSync'];
  const WRITES = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'mkdtempSync', 'mkdtemp', 'rmSync', 'rm', 'rmdirSync', 'rmdir',
    'unlinkSync', 'unlink', 'renameSync', 'rename', 'createWriteStream', 'truncateSync', 'truncate', 'symlinkSync', 'symlink', 'linkSync', 'link',
    'chmodSync', 'chmod', 'chownSync', 'chown', 'utimesSync', 'utimes', 'copyFileSync', 'copyFile', 'cpSync', 'cp'];
  const denyWrite = (args) => { const abs = toPath(args[0]); deny('FS_WRITE', abs === null ? '<fd>' : display(abs)); };

  function install() {
    for (const target of [fs, fs.promises]) {
      for (const name of READS) wrap(target, name, (args) => checkRead(args[0]));
      for (const name of WRITES) wrap(target, name, denyWrite);
      for (const name of ['openSync', 'open']) wrap(target, name, (args) => { if (writeFlags(args[1])) denyWrite(args); else checkRead(args[0]); });
    }
    const net = require('net');
    const netDeny = (kind) => (args) => {
      const a = args[0];
      const t = a && typeof a === 'object' ? (a.path ? `unix:${path.basename(String(a.path))}` : `${a.host || a.hostname || 'localhost'}:${a.port || ''}`) : `${args[1] || 'localhost'}:${a}`;
      deny(kind, t);
    };
    wrap(net.Socket.prototype, 'connect', netDeny('NET_CONNECT'));
    for (const name of ['connect', 'createConnection']) wrap(net, name, netDeny('NET_CONNECT'));
    wrap(require('tls'), 'connect', netDeny('NET_CONNECT'));
    for (const mod of ['http', 'https']) for (const name of ['request', 'get']) wrap(require(mod), name, (args) => deny('NET_HTTP', typeof args[0] === 'string' ? new URL(args[0]).host : String(args[0] && (args[0].host || args[0].hostname))));
    wrap(require('http2'), 'connect', (args) => deny('NET_HTTP', String(args[0])));
    const dns = require('dns');
    for (const name of Object.keys(dns).filter((k) => /^(lookup|resolve)/.test(k))) wrap(dns, name, (args) => deny('NET_DNS', String(args[0])));
    for (const name of Object.keys(dns.promises).filter((k) => /^(lookup|resolve)/.test(k))) wrap(dns.promises, name, (args) => deny('NET_DNS', String(args[0])));
    wrap(require('dgram'), 'createSocket', () => deny('NET_UDP', 'dgram'));
    if (typeof globalThis.fetch === 'function') wrap(globalThis, 'fetch', (args) => deny('NET_HTTP', String(args[0])));
    if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = function WebSocket(url) { deny('NET_WS', String(url)); };
    const cp = require('child_process');
    for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) wrap(cp, name, (args) => deny('PROCESS', String(args[0])));
    const wt = require('worker_threads');
    const OrigWorker = wt.Worker;
    wt.Worker = function Worker(file) { deny('THREAD', String(file)); return new OrigWorker(file); };
    process.binding = () => deny('PROCESS_BINDING', 'process.binding');
    const dlopen = process.dlopen;
    process.dlopen = function guarded(mod, file, ...rest) { checkRead(file, 'NATIVE_ADDON'); return dlopen.call(this, mod, file, ...rest); };
  }

  return {
    install,
    enterCall() { phase = 'CALL'; },
    enterLoad() { phase = 'LOAD'; },
    attempts: () => attempts.slice(),
    takeAttempts() { return attempts.splice(0, attempts.length); },
    loadReads: () => [...new Set(loadReads)],
    isDenied: (error) => Boolean(error && error.code === DENIED),
  };
}

module.exports = { createSandbox, DENIED };
