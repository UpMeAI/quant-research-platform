'use strict';
/**
 * smartflow replay core 的钉版校验(QRP 侧,REPLAY_CORE_CONTRACT_V1 §6)。
 *
 * 平台不搬、不改 replay core:US / CRYPTO 适配器在**钉住的 smartflow 检出**上起子进程调用它(runner.js)。
 * 本模块只做校验,不含任何回放逻辑:
 *   - coreDirHash:按合同 §6 item 4 的口径**独立复算**核心目录哈希
 *     (每个 *.js 按 POSIX 路径升序拼 `<path>\0<sha256(bytes)>\n` 再 sha256),不信任被校验代码的自报;
 *   - loadedPackageFiles:子进程 require 完策略侧模块后,对已加载的 smartflow 文件(核心目录与 node_modules 除外)
 *     按同一口径求哈希 —— 钉住策略文件,改了 hooks 依赖的任何文件即拒跑。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PIN = require('./pin.json');

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function listJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const posixRel = (root, full) => path.relative(root, full).split(path.sep).join('/');
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const aggregate = (files) => sha256Hex(files.map((f) => `${f.path}\0${f.sha256}\n`).join(''));

/** { hash, fileCount } —— 核心目录的版本哈希(合同 §6 item 4 口径)。 */
function coreDirHash(coreDir) {
  const files = listJs(coreDir)
    .map((full) => ({ path: posixRel(coreDir, full), sha256: sha256Hex(fs.readFileSync(full)) }))
    .sort(byPath);
  return { hash: aggregate(files), fileCount: files.length };
}

/** smartflow 包根(trading-system-v2)与核心目录;根目录由调用方给出(QRP_SMARTFLOW_ROOT)。 */
function layout(smartflowRoot) {
  const pkgRoot = path.join(smartflowRoot, PIN.smartflow.package_dir);
  return { pkgRoot, coreDir: path.join(pkgRoot, PIN.core.dir) };
}

/** 已加载的 smartflow 文件(核心目录、node_modules 除外)的 { hash, files }。 */
function loadedPackageFiles(pkgRoot, coreDir, cache = require.cache) {
  const inside = (full, dir) => full === dir || full.startsWith(dir + path.sep);
  const files = Object.keys(cache)
    .filter((full) => inside(full, pkgRoot) && !inside(full, coreDir) && !full.split(path.sep).includes('node_modules'))
    .map((full) => ({ path: posixRel(pkgRoot, full), sha256: sha256Hex(fs.readFileSync(full)) }))
    .sort(byPath);
  return { hash: aggregate(files), files };
}

/** 钉版失败一律抛错(Fail Closed):消息只含哈希前缀,不含路径之外的任何环境信息。 */
function assertCore(coreDir) {
  const actual = coreDirHash(coreDir);
  if (actual.hash !== PIN.core.version_hash || actual.fileCount !== PIN.core.file_count) {
    throw new Error(`CORE_VERSION_MISMATCH:pin=${PIN.core.version_hash.slice(0, 8)}:core=${actual.hash.slice(0, 8)}`);
  }
  return actual;
}

module.exports = { PIN, sha256Hex, coreDirHash, layout, loadedPackageFiles, assertCore };
