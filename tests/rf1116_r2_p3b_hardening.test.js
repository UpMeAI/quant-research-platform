'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'deploy/research-lane/r2-day-export/r2-day-export.sh');
const PROBE = path.join(ROOT, 'deploy/research-lane/r2-day-export/R2_DAY_EXPORT_READINESS_V2.sql');

function run(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3b-export-'));
  const env = {
    ...process.env,
    R2EXP_ENV_FILE: '/nonexistent',
    R2EXP_PG_CONTAINER: 'postgres-v6',
    R2EXP_PG_USER: 'research_reader',
    R2EXP_PG_DB: 'v6',
    R2EXP_DROP_ROOT: path.join(root, 'drop'),
    ...extra,
  };
  const result = spawnSync('bash', [SCRIPT, '--segment', 'R1'], { env, encoding: 'utf8' });
  return result;
}

test('P3B-9 leading-dash container and invalid database identifiers are refused before docker', () => {
  for (const [key, value] of [['R2EXP_PG_CONTAINER', '-postgres'], ['R2EXP_PG_USER', 'reader user'], ['R2EXP_PG_DB', 'v6/db']]) {
    const result = run({ R2EXP_TEST: '1', R2EXP_NOW: '2026-11-23T16:00:00+08:00', [key]: value });
    assert.equal(result.status, 2, `${key}: ${result.stderr}`);
    assert.match(result.stderr, /PG_IDENTIFIER_INVALID/);
    assert.match(result.stderr, new RegExp(key));
  }
});

test('P3B-9 a custom readiness probe must be byte-identical to the pinned V2 probe', () => {
  const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-p3b-probe-')), 'probe.sql');
  fs.writeFileSync(other, `${fs.readFileSync(PROBE, 'utf8')}-- changed\n`);
  const result = run({ R2EXP_TEST: '1', R2EXP_NOW: '2026-11-23T16:00:00+08:00', R2EXP_READY_SQL: other });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /PROBE_SQL_SHA_MISMATCH/);
});

test('P3B-9 R2EXP_NOW is refused unless the explicit test guard is enabled', () => {
  const result = run({ R2EXP_NOW: '2026-11-23T16:00:00+08:00' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /R2EXP_NOW_REQUIRES_R2EXP_TEST/);
});

