'use strict';
// RF1116 window pause (deploy/research-lane/round-runner/rf1116-window-pause.sh): which containers it pauses, and when.
// Runs the real script under bash with stub `date` and `docker` first on PATH; nothing reaches Docker or /srv.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR = path.resolve(__dirname, '..', 'deploy/research-lane/round-runner');
const SCRIPT = path.join(DIR, 'rf1116-window-pause.sh');
// Every container run.sh can start, plus two that are not the runner's.
const RUN = ['rf1116-generate-20261117', 'rf1116-resume', 'rf1116-score', 'rf1116-rescore'];
const NOT_PAUSED = ['rf1116-mechanisms', 'rf1116-review', 'v6-scheduler'];

function run({ hhmm, dow, ps }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf1116-pause-'));
  fs.writeFileSync(path.join(dir, 'date'), '#!/bin/bash\ncase "$*" in *%H%M*) echo "$FAKE_HHMM" ;; *%u*) echo "$FAKE_DOW" ;; *) echo 2026-11-18T00:00:00+08:00 ;; esac\n', { mode: 0o755 });
  // `docker ps` ignores its filters here, so the script's own name check is what is tested.
  fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/bash\ncase "$1" in ps) printf "%s\\n" "$FAKE_PS" | tr ";" "\\n" ;; pause|unpause) echo "$1 $2" >> "$FAKE_CALLS" ;; esac\n', { mode: 0o755 });
  const calls = path.join(dir, 'calls'); const log = path.join(dir, 'window-pause.log');
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8',
    env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_HHMM: hhmm, FAKE_DOW: String(dow), FAKE_PS: ps.join(';'), FAKE_CALLS: calls, RF1116_WINDOW_PAUSE_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  return { calls: lines(calls).toSorted(), log: lines(log) };
}
const all = (state) => [...RUN, ...NOT_PAUSED].map((n) => `${n} ${state}`);

test('window pause: inside a weekday window it pauses generate, resume, score and rescore (★RF1116_SCORE_PAUSE (a)), never mechanisms, review or other containers', () => {
  const { calls, log } = run({ hhmm: '0645', dow: 3, ps: all('running') });
  assert.deepEqual(calls, RUN.map((n) => `pause ${n}`).toSorted());
  assert.equal(log.length, RUN.length);
  assert.ok(log.every((l) => / PAUSE rf1116-\S+ \(window\)$/.test(l)), log.join('\n'));
});

test('window pause: outside the windows it unpauses only the runner containers it pauses, and leaves running ones alone', () => {
  assert.deepEqual(run({ hhmm: '0800', dow: 3, ps: all('paused') }).calls, RUN.map((n) => `unpause ${n}`).toSorted());
  assert.deepEqual(run({ hhmm: '0800', dow: 3, ps: all('running') }).calls, []);
  assert.deepEqual(run({ hhmm: '0645', dow: 3, ps: all('paused') }).calls, [], 'already paused inside a window: nothing to do');
});

test('window pause: window edges 06:30–08:00, 09:15–15:30, 18:10–20:45 CST (start inside, end outside)', () => {
  const edges = { '0629': false, '0630': true, '0759': true, '0800': false, '0914': false, '0915': true, '1529': true, '1530': false,
    '1809': false, '1810': true, '2044': true, '2045': false, '0000': false, '2359': false };
  for (const [hhmm, inside] of Object.entries(edges)) {
    for (const name of ['rf1116-score', 'rf1116-rescore', 'rf1116-generate-20261117']) {
      assert.deepEqual(run({ hhmm, dow: 2, ps: [`${name} running`] }).calls, inside ? [`pause ${name}`] : [], `${hhmm} ${name}`);
    }
  }
});

test('window pause: Saturday and Sunday have no windows; a container paused on Friday evening is released', () => {
  for (const dow of [6, 7]) {
    assert.deepEqual(run({ hhmm: '1000', dow, ps: all('running') }).calls, [], `dow ${dow}`);
    assert.deepEqual(run({ hhmm: '1000', dow, ps: all('paused') }).calls, RUN.map((n) => `unpause ${n}`).toSorted(), `dow ${dow}`);
  }
});

test('window pause: DEPLOY.md lists the sha256 of the script and both units in this directory', () => {
  const deploy = fs.readFileSync(path.join(DIR, 'DEPLOY.md'), 'utf8');
  for (const f of ['rf1116-window-pause.sh', 'rf1116-window-pause.service', 'rf1116-window-pause.timer']) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex');
    assert.ok(deploy.includes(sha), `DEPLOY.md: ${f} ${sha}`);
  }
  assert.ok(deploy.includes('rf1116-score') && deploy.includes('rf1116-rescore'), 'DEPLOY.md names the score containers it pauses');
});
