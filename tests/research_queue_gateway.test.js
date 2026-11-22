'use strict';
/**
 * AUTONOMOUS_RESEARCH_QUEUE_V1 Q2：rq-deepseek-gateway（Python 标准库，unix socket）的测试入口。
 * 测试本体在 services/rq-deepseek-gateway/test_rq_gateway.py（unittest，全部用桩传输，假密钥，不连网络）；这里把每个用例登记成一个 node:test 用例，
 * 这样 `npm test` 与失败定位都和别的测试一致。没有 python3 时整组跳过并明说（不算通过）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const PY = path.join(__dirname, '..', 'services', 'rq-deepseek-gateway', 'test_rq_gateway.py');
const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const HAVE_PY = probe.status === 0;
const list = HAVE_PY ? spawnSync('python3', [PY, '--list'], { encoding: 'utf8' }) : null;

test('python3 present and the gateway test module lists its cases', { skip: HAVE_PY ? false : 'python3 not found: gateway tests NOT run' }, () => {
  assert.equal(list.status, 0, list.stderr);
  assert.ok(list.stdout.trim().split('\n').length >= 40, 'expected at least 40 gateway cases');
});

if (HAVE_PY && list.status === 0) {
  for (const id of list.stdout.trim().split('\n').filter(Boolean)) {
    test(`gateway ${id}`, () => {
      const r = spawnSync('python3', ['-m', 'unittest', '-q', id], { cwd: path.dirname(PY), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', PYTHONDONTWRITEBYTECODE: '1' } });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    });
  }
}
