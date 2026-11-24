'use strict';

/**
 * Launch of the real CN_A experiment step (plan-coord requirement 11-23, ops-coord slot booking): an `rf1116-generate-w24-<card>` container, so the existing
 * rf1116 window pause (deploy/research-lane/round-runner/rf1116-window-pause.sh pauses rf1116-generate-*) yields it in the weekday windows with no extra timer.
 * Resources: 2 CPUs, 24g (no swap), nice 19, ionice idle, no network, read-only root, research disk only (the lane copy, the validation tail and the output directory;
 * the sealed holdout is never mounted into a generator step). The container runs the round-runner CLI `generate` (the existing image entrypoint is replaced only to put nice and
 * ionice in front of the same node command). docker runs on the Linux research lane; here the argv is built and a runner function is injected (tests, or the lane wrapper).
 */
const crypto = require('crypto');
const path = require('path');

const RESEARCH_ROOT = '/srv/research-lane/';
const CLI = 'services/mining-sandbox/round-runner/cli.js';
const err = (code, d) => Object.assign(new Error(d === undefined ? code : `${code}:${d}`), { code, detail: d === undefined ? null : d });
const sha8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

function containerSpec({ cardId, image, laneCopy, valTail, outDir, holdoutRef, holdoutSha256, authority, generator = 'AI_MINED_LLM' }) {
  if (typeof image !== 'string' || !image) throw err('EXPERIMENT_LAUNCH_IMAGE_REQUIRED');
  for (const p of [laneCopy, valTail, outDir]) if (typeof p !== 'string' || !path.isAbsolute(p) || !p.startsWith(RESEARCH_ROOT)) throw err('EXPERIMENT_LAUNCH_PATH_INVALID', String(p));
  for (const p of [laneCopy, valTail, outDir]) if (/holdout/i.test(p)) throw err('EXPERIMENT_LAUNCH_HOLDOUT_MOUNT_REFUSED', p);
  const name = `rf1116-generate-w24-${sha8(String(cardId))}`;
  const argv = ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '1000:1000', '--cpus', '2', '--cpuset-cpus', '0-7,16-23', '--memory', '24g', '--memory-swap', '24g', '--pids-limit', '256', '-e', 'QRP_DATA_DIR=/out/qrp-data', '-e', `QRP_PRODUCT_MILESTONE_AUTHORITY=${authority}`,
    '-v', `${laneCopy}:/data/lane:ro`, '-v', `${valTail}:/data/tail:ro`, '-v', `${outDir}:/out:rw`, '--entrypoint', 'nice', image,
    '-n', '19', 'ionice', '-c', '3', 'node', '--max-old-space-size=20480', CLI, 'generate', '--generator', generator, '--out', '/out', '--lane', '/data/lane', '--tail', '/data/tail',
    '--holdout-ref', holdoutRef, '--holdout-sha256', holdoutSha256];
  return { name, argv };
}

/** services.experiment for the lane: `run(argv)` returns { status, stdout, stderr } (docker, supplied by the host wrapper). */
function dockerExecutor({ run, ...spec }) {
  return {
    execute() {
      const { argv } = containerSpec(spec);
      const r = run(argv);
      if (r.status === 75) throw err('EXPERIMENT_LAUNCH_WAITING', (JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}').llm_state) || 'WAITING');
      if (r.status !== 0) { let code = `EXIT_${r.status}`; try { code = JSON.parse(String(r.stderr).trim().split('\n').pop()).error || code; } catch { /* keep exit code */ } throw err('EXPERIMENT_LAUNCH_FAILED', code); }
      const out = JSON.parse(String(r.stdout).trim().split('\n').pop());
      return { roundId: out.round_id, outDir: spec.outDir, accessLogFile: path.join(spec.outDir, 'rounds', out.round_id.replace(/[^A-Za-z0-9_-]/g, '_'), 'access_log.jsonl') };
    },
  };
}

module.exports = { RESEARCH_ROOT, containerSpec, dockerExecutor };
