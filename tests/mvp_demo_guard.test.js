'use strict';
/**
 * MVP 演示的数据目录守卫（协调会话 2026-11-17）：packages/ledger 的 dataDir() 在 QRP_DATA_DIR 没设时落到 <repo>/var/ledger（真的台账），
 * 所以 apps/research-cli/run_ashare_mvp.js 只在 QRP_DATA_DIR 设了、且解析符号链接之后的真实路径在系统临时目录之下、或在一个名字是 demo
 * / demo-* 的目录之下时才开跑；<repo>/var/ledger 和它下面的任何路径、没设，都拒绝（MVP_DEMO_DATA_DIR_NOT_DEMO）。先红后绿。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'apps', 'research-cli', 'run_ashare_mvp.js');
const guard = require('../apps/research-cli/mvp_demo_guard');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('守卫：没设 → 拒绝；<repo>/var/ledger 与它下面 → 拒绝（哪怕 repo 本身在临时目录里）；指向 var/ledger 的符号链接 → 拒绝；临时目录 → 过（返回真实路径）', () => {
  const repo = tmp('mvp-repo-');
  const ledger = path.join(repo, 'var', 'ledger');
  fs.mkdirSync(path.join(ledger, 'research'), { recursive: true });
  const opts = { repoRoot: repo };
  assert.throws(() => guard.checkDemoDataDir({}, opts), code(/MVP_DEMO_DATA_DIR_NOT_DEMO:.*unset/));
  assert.throws(() => guard.checkDemoDataDir({ QRP_DATA_DIR: '' }, opts), code(/MVP_DEMO_DATA_DIR_NOT_DEMO/));
  assert.throws(() => guard.checkDemoDataDir({ QRP_DATA_DIR: ledger }, opts), code(/MVP_DEMO_DATA_DIR_NOT_DEMO:.*var\/ledger/));
  assert.throws(() => guard.checkDemoDataDir({ QRP_DATA_DIR: path.join(ledger, 'research') }, opts), code(/MVP_DEMO_DATA_DIR_NOT_DEMO:.*var\/ledger/));
  const links = tmp('mvp-link-');
  fs.symlinkSync(ledger, path.join(links, 'looks-like-tmp'));
  assert.throws(() => guard.checkDemoDataDir({ QRP_DATA_DIR: path.join(links, 'looks-like-tmp') }, opts), code(/MVP_DEMO_DATA_DIR_NOT_DEMO:.*var\/ledger/));
  assert.throws(() => guard.checkDemoDataDir({ QRP_DATA_DIR: path.join(links, 'nope') }, opts), code(/MVP_DEMO_DATA_DIR_NOT_DEMO:.*does not exist/));
  const ok = tmp('mvp-demo-run-');
  assert.equal(guard.checkDemoDataDir({ QRP_DATA_DIR: ok }, opts), fs.realpathSync(ok));
  // 这个仓库自己的 var/ledger（默认 repoRoot）也拒绝
  assert.throws(() => guard.checkDemoDataDir({ QRP_DATA_DIR: path.join(ROOT, 'var', 'ledger') }), code(/MVP_DEMO_DATA_DIR_NOT_DEMO/));
});

test('守卫：临时目录之外，只有名字是 demo 或 demo-* 的目录（或它下面）能过；符号链接按真实路径判', () => {
  const fakeTmp = tmp('mvp-faketmp-'); // 把「系统临时目录」换成别处，单测 demo 规则
  const outside = tmp('mvp-outside-');
  const opts = { repoRoot: tmp('mvp-repo2-'), tmpRoot: fakeTmp };
  for (const name of ['demo', 'demo-ashare', path.join('demo-x', 'nested')]) {
    const d = path.join(outside, name); fs.mkdirSync(d, { recursive: true });
    assert.equal(guard.checkDemoDataDir({ QRP_DATA_DIR: d }, opts), fs.realpathSync(d), name);
  }
  for (const name of ['demos', 'my-demo', 'ledger']) {
    const d = path.join(outside, name); fs.mkdirSync(d, { recursive: true });
    assert.throws(() => guard.checkDemoDataDir({ QRP_DATA_DIR: d }, opts), code(/MVP_DEMO_DATA_DIR_NOT_DEMO/), name);
  }
  // 名字像 demo 的符号链接，指向别处 → 按真实路径判，拒绝
  fs.symlinkSync(path.join(outside, 'ledger'), path.join(outside, 'demo-link'));
  assert.throws(() => guard.checkDemoDataDir({ QRP_DATA_DIR: path.join(outside, 'demo-link') }, opts), code(/MVP_DEMO_DATA_DIR_NOT_DEMO/));
});

test('命令行：没设 QRP_DATA_DIR 就不开跑（退出码 1、报 MVP_DEMO_DATA_DIR_NOT_DEMO、什么都不写）；--help 写明绝不能对着真的研究数据目录跑', () => {
  const env = { ...process.env }; delete env.QRP_DATA_DIR;
  let out = '';
  try { execFileSync(process.execPath, [CLI], { env, stdio: ['ignore', 'pipe', 'pipe'] }); assert.fail('should refuse'); } catch (e) { out = `${e.stdout}${e.stderr}`; assert.equal(e.status, 1); }
  assert.match(out, /MVP_DEMO_DATA_DIR_NOT_DEMO/);
  assert.doesNotMatch(out, /Step 1/);
  const help = execFileSync(process.execPath, [CLI, '--help'], { env }).toString();
  assert.match(help, /never run against the real research data dir/i);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /mvp:ashare[\s\S]{0,200}(绝不|never)/i);
  assert.match(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['mvp:ashare'], /QRP_DATA_DIR="?\$\(mktemp -d/);
});
