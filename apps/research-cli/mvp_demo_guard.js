'use strict';

/**
 * MVP 演示的数据目录守卫（协调会话 2026-11-17，失败即关）。packages/ledger 的 dataDir() 在 QRP_DATA_DIR 没设时落到
 * <repo>/var/ledger，那是真的研究台账；演示会往台账里写实验、影子、候选与激活。所以演示只在下面两种目录里开跑：
 *   - QRP_DATA_DIR 解析符号链接之后的真实路径在系统临时目录（os.tmpdir() 的真实路径）之下；或
 *   - 真实路径自己或某一级上级目录的名字是 demo 或以 demo- 开头。
 * 没设、不存在、在 <repo>/var/ledger 或它下面（按真实路径，符号链接解开后比）→ MVP_DEMO_DATA_DIR_NOT_DEMO。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODE = 'MVP_DEMO_DATA_DIR_NOT_DEMO';
const HELP_LINE = 'The MVP demo must never run against the real research data dir: set QRP_DATA_DIR to a fresh temp dir (npm run mvp:ashare does this) or a directory named demo / demo-*.';

class MvpDemoGuardError extends Error {
  constructor(detail) { super(`${CODE}:${detail}`); this.code = CODE; this.detail = detail; }
}
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const under = (p, root) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/**
 * @param {object} env  通常是 process.env
 * @param {{repoRoot?: string, tmpRoot?: string}} [o]  只给测试用：仓库根与「系统临时目录」
 * @returns {string} QRP_DATA_DIR 的真实路径
 */
function checkDemoDataDir(env, { repoRoot = path.join(__dirname, '..', '..'), tmpRoot = os.tmpdir() } = {}) {
  const raw = env && env.QRP_DATA_DIR;
  if (!raw) throw new MvpDemoGuardError('QRP_DATA_DIR unset (the ledger would fall back to <repo>/var/ledger)');
  let real;
  try { real = fs.realpathSync(raw); } catch { throw new MvpDemoGuardError(`QRP_DATA_DIR does not exist: ${raw}`); }
  const ledger = path.join(repoRoot, 'var', 'ledger');
  if (under(real, realOr(ledger)) || under(real, path.resolve(ledger))) throw new MvpDemoGuardError(`QRP_DATA_DIR resolves into the real ledger <repo>/var/ledger: ${real}`);
  const inTmp = under(real, realOr(tmpRoot));
  const demoNamed = real.split(path.sep).some((seg) => seg === 'demo' || seg.startsWith('demo-'));
  if (!inTmp && !demoNamed) throw new MvpDemoGuardError(`QRP_DATA_DIR is neither under the system temp dir nor under a demo / demo-* directory: ${real}`);
  return real;
}

module.exports = { CODE, HELP_LINE, MvpDemoGuardError, checkDemoDataDir };
