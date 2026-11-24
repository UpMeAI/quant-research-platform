'use strict';
/**
 * W24: the real CN_A experiment runs as an rf1116-* container so the existing rf1116 window pause (rf1116-window-pause.sh matches rf1116-generate-*) yields it
 * in the weekday windows with no extra timer. Resources (ops-coord slot booking): 2 threads, 24 GB, research disk only, nice 19, ionice idle.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const launch = require('../services/research-lab-e2e/experiment-launch');

const base = { cardId: 'RQT-LINUX-20261124-aaaa1111', image: 'qrp-round-runner:abc123def456', laneCopy: '/srv/research-lane/rf1116-mining/data/lane', valTail: '/srv/research-lane/rf1116-mining/data/tail',
  outDir: '/srv/research-lane/rf1116-mining/out/w24', holdoutRef: 'lane:rf1116-mining/holdout-sealed/x', holdoutSha256: 'a'.repeat(64), authority: 'AUTH' };

test('container spec: name matches the rf1116 pause pattern, 2 CPUs, 24g with no swap, no network, research disk mounts only, nice 19 and ionice idle', () => {
  const s = launch.containerSpec(base);
  assert.match(s.name, /^rf1116-generate-w24-[0-9a-f]{8}$/);
  const a = s.argv;
  assert.equal(a[0], 'run');
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(at('--name'), s.name);
  assert.deepEqual([at('--cpus'), at('--cpuset-cpus'), at('--memory'), at('--memory-swap'), at('--network')], ['2', '0-7,16-23', '24g', '24g', 'none']);
  assert.ok(a.includes('--read-only') && a.includes('--cap-drop'));
  assert.equal(at('--entrypoint'), 'nice');
  const tail = a.slice(a.indexOf(base.image) + 1);
  assert.deepEqual(tail.slice(0, 7), ['-n', '19', 'ionice', '-c', '3', 'node', '--max-old-space-size=20480']);
  assert.ok(tail.includes('services/mining-sandbox/round-runner/cli.js') && tail.includes('generate'));
  const mounts = a.filter((x, i) => a[i - 1] === '-v');
  assert.deepEqual(mounts.sort(), [`${base.laneCopy}:/data/lane:ro`, `${base.valTail}:/data/tail:ro`, `${base.outDir}:/out:rw`].sort());
  assert.ok(mounts.every((m) => m.startsWith('/srv/research-lane/')), 'research disk only');
  assert.equal(mounts.some((m) => /holdout/i.test(m)), false, 'the generator step never mounts the holdout');
  assert.equal(JSON.stringify(a).includes('AUTH'), true);
});

test('the name is deterministic per card, and the rf1116 pause script yields it (pattern check against the deployed script)', () => {
  assert.equal(launch.containerSpec(base).name, launch.containerSpec({ ...base }).name);
  assert.notEqual(launch.containerSpec({ ...base, cardId: 'RQT-LINUX-20261125-bbbb2222' }).name, launch.containerSpec(base).name);
  const pause = fs.readFileSync(path.join(__dirname, '..', 'deploy/research-lane/round-runner/rf1116-window-pause.sh'), 'utf8');
  assert.match(pause, /rf1116-generate-\*/);
});

test('refuses a spec that would break the booking: missing paths, relative paths, a holdout path as an input', () => {
  assert.throws(() => launch.containerSpec({ ...base, laneCopy: 'relative/path' }), /EXPERIMENT_LAUNCH_PATH_INVALID/);
  assert.throws(() => launch.containerSpec({ ...base, valTail: '/srv/research-lane/rf1116-mining/holdout-sealed/x' }), /EXPERIMENT_LAUNCH_HOLDOUT_MOUNT_REFUSED/);
  assert.throws(() => launch.containerSpec({ ...base, image: '' }), /EXPERIMENT_LAUNCH_IMAGE_REQUIRED/);
});

test('docker executor: runs the spec through the injected runner, reads the round id from the CLI line, returns the run directory; a non-zero exit is a refusal code', () => {
  const calls = [];
  const exec = launch.dockerExecutor({ ...base, run: (argv) => { calls.push(argv); return { status: 0, stdout: `${JSON.stringify({ command: 'generate', round_id: 'MR-CN_A-2026-11-abc', status: 'CAP_REACHED' })}\n`, stderr: '' }; } });
  const r = exec.execute({ formulas: ['rank(pb)'] });
  assert.equal(r.roundId, 'MR-CN_A-2026-11-abc');
  assert.equal(r.accessLogFile, path.join(base.outDir, 'rounds', 'MR-CN_A-2026-11-abc', 'access_log.jsonl'));
  assert.equal(calls.length, 1);
  const waiting = launch.dockerExecutor({ ...base, run: () => ({ status: 75, stdout: '{"status":"WAITING","llm_state":"WAITING_KEY_ABSENT"}\n', stderr: '' }) });
  assert.throws(() => waiting.execute({ formulas: ['x'] }), /EXPERIMENT_LAUNCH_WAITING/);
  const failed = launch.dockerExecutor({ ...base, run: () => ({ status: 2, stdout: '', stderr: '{"error":"MINE_RUNNER_COVERAGE_BELOW_FLOOR"}' }) });
  assert.throws(() => failed.execute({ formulas: ['x'] }), /EXPERIMENT_LAUNCH_FAILED:MINE_RUNNER_COVERAGE_BELOW_FLOOR/);
});
