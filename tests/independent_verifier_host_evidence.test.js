'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ev = require('../tools/independent-verifier-host-evidence');

/**
 * 主机侧证据脚本（W20：文件权限、挂载、网络策略）。由 ops-coord 在安装时运行；这里只测判定逻辑与输出形状。
 * 查不到的一律 UNKNOWN，不当 PASS；输出里没有主机名、地址、密钥。
 */
const GEN = { uid: 2001, gids: [2001] };

test('文件权限：生成方可写（属主、同组写位、其他人写位）一律 FAIL；只读给它的 PASS', () => {
  const st = (mode, uid = 0, gid = 0) => ({ mode, uid, gid, isDirectory: false });
  assert.equal(ev.writableBy(st(0o644, 0, 0), GEN), false);
  assert.equal(ev.writableBy(st(0o666, 0, 0), GEN), true);
  assert.equal(ev.writableBy(st(0o644, 2001, 0), GEN), true);
  assert.equal(ev.writableBy(st(0o664, 0, 2001), GEN), true);
  assert.equal(ev.writableBy(st(0o664, 0, 0), GEN), false);
});

test('留出段目录：生成方不能读也不能进（属主、同组、其他人的 r / x 位都要看）', () => {
  const st = (mode, uid = 0, gid = 0) => ({ mode, uid, gid, isDirectory: true });
  assert.equal(ev.readableBy(st(0o700, 0, 0), GEN), false);
  assert.equal(ev.readableBy(st(0o755, 0, 0), GEN), true);
  assert.equal(ev.readableBy(st(0o750, 0, 2001), GEN), true);
  assert.equal(ev.readableBy(st(0o700, 2001, 0), GEN), true);
});

test('挂载（Linux mountinfo）：留出段路径不在生成方的挂载命名空间里、验证器路径只读；没有 mountinfo → UNKNOWN', () => {
  const info = ['36 35 8:1 / / rw - ext4 /dev/sda1 rw', '40 36 8:2 /verifier /srv/qrp/services/independent-verifier ro,relatime - ext4 /dev/sda2 ro'].join('\n');
  assert.deepEqual(ev.mountFacts(info, { holdoutDirs: ['/srv/holdout'], verifierDirs: ['/srv/qrp/services/independent-verifier'] }),
    { holdoutVisible: [], verifierReadOnly: { '/srv/qrp/services/independent-verifier': true } });
  assert.equal(ev.mountFacts(null, { holdoutDirs: ['/h'], verifierDirs: [] }), 'UNKNOWN');
  assert.deepEqual(ev.mountFacts(`${info}\n41 36 8:3 / /srv/holdout rw - ext4 /dev/sdb1 rw`, { holdoutDirs: ['/srv/holdout'], verifierDirs: [] }).holdoutVisible, ['/srv/holdout']);
});

test('网络（/proc/<pid>/net/dev）：沙箱进程只有 lo → PASS；有别的网卡 → FAIL；读不到 → UNKNOWN', () => {
  const dev = (names) => `Inter-|   Receive\n face |bytes\n${names.map((n) => `  ${n}: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`).join('\n')}\n`;
  assert.equal(ev.networkVerdict(dev(['lo'])), 'PASS');
  assert.equal(ev.networkVerdict(dev(['lo', 'eth0'])), 'FAIL');
  assert.equal(ev.networkVerdict(null), 'UNKNOWN');
});

test('命令行：对一个临时目录跑一遍，输出 JSON 的键固定，没有 UNKNOWN 当 PASS，进程退出码 = 有无 FAIL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w20-host-'));
  const guarded = path.join(dir, 'verifier.js'); fs.writeFileSync(guarded, 'x'); fs.chmodSync(guarded, 0o644);
  const hold = path.join(dir, 'holdout'); fs.mkdirSync(hold, { mode: 0o700 }); fs.chmodSync(hold, 0o700);
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'independent-verifier-host-evidence.js'),
    '--generator-uid', '2001', '--generator-gids', '2001', '--protected', guarded, '--holdout-dir', hold], { encoding: 'utf8' });
  const doc = JSON.parse(out);
  assert.deepEqual(Object.keys(doc).sort(), ['checks', 'generator', 'overall', 'platform', 'schema']);
  assert.equal(doc.schema, 'INDEPENDENT_VERIFIER_HOST_EVIDENCE_V1');
  const byId = Object.fromEntries(doc.checks.map((c) => [c.id, c.state]));
  assert.equal(byId.PROTECTED_NOT_GENERATOR_WRITABLE, 'PASS');
  assert.equal(byId.HOLDOUT_NOT_GENERATOR_READABLE, 'PASS');
  assert.equal(byId.GENERATOR_MOUNTS, 'UNKNOWN');
  assert.equal(byId.SANDBOX_NO_NETWORK, 'UNKNOWN');
  assert.equal(doc.overall, 'INCOMPLETE');
  assert.ok(!/(\d{1,3}\.){3}\d{1,3}|https?:|[A-Za-z0-9_-]{32,}/.test(out.replace(/[0-9a-f]{64}/g, '')), '输出里没有地址或密钥样子的串');
  fs.chmodSync(guarded, 0o666);
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'independent-verifier-host-evidence.js'), '--generator-uid', '2001', '--generator-gids', '2001', '--protected', guarded], { encoding: 'utf8', stdio: 'pipe' }),
    (e) => e.status === 1 && JSON.parse(e.stdout).overall === 'FAIL');
});
