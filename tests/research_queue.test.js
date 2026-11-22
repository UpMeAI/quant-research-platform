'use strict';
// AUTONOMOUS_RESEARCH_QUEUE_V1, Q1: runs the Python acceptance tests under tests/research_queue (unittest, stdlib only).
// The queue core is Python 3.12 stdlib by design (★RQ13); this wrapper makes `node --test tests/*.test.js` include them.
// If python3 is absent the test is skipped with a visible reason (ci-node may not ship python3); install checks run them on the hosts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, 'research_queue');
const py = spawnSync('python3', ['-c', 'import sys, sqlite3; assert sys.version_info >= (3, 10); print(sqlite3.sqlite_version)'], { encoding: 'utf8' });
const have = py.status === 0;

test('research queue (Python): AQ acceptance suite passes', { skip: have ? false : 'python3 >= 3.10 not available on this runner' }, () => {
  const r = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', DIR, '-p', 'test_*.py', '-v'], { encoding: 'utf8', cwd: DIR, timeout: 540000 });
  const tail = `${r.stdout}\n${r.stderr}`.split('\n').slice(-40).join('\n');
  assert.equal(r.status, 0, tail);
  assert.match(r.stderr, /\nOK/);
});
