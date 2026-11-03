#!/usr/bin/env node
'use strict';
/**
 * Carry V2 接入 QRP:M1 封存清单与 A0 复现(smartflow CARRY_V2_QRP_ONBOARDING_K2_DRAFT_V1,FREEZE_1)。
 * 钉住的 smartflow 检出由 QRP_SMARTFLOW_ROOT 给出(含 node_modules);smartflow 一字不改,只读其 docs/evidence。
 *
 *   m1          --args <JSON> --out <回执>                    M1-1 … M1-4 与 A0-1(carry_m1.js,子进程)
 *   a0-runner   --data D --dtb3-dir X --dtb3-rel R --work W     A0-2:冻结跑数器原样复跑 + jest,与封存比
 *   a0-jobs     --is-oos DIR --is-oos-run F --w DIR --w-run F --out F
 *                                                              A0-3:作业清单 / 重跑回执 vs PR #48 证明
 *   a0-backfill --data D --dtb3-dir X --dtb3-rel R --is-oos-jobs DIR --w-jobs DIR --data-evidence F --tests F --out DIR
 *                                                              A0-4:回填重组(carry_backfill.js,每组 A/B 两个子进程)+ v2-result
 *   seal        --pass1 DIR --pass2 DIR --out F                A0-5:两遍逐文件比
 * 退出码:判据全过 0;有判据不过 1;用法或运行错误 2。不联网、不取数、不写台账。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const bridge = require('../../adapters/replay-core-bridge');
const Onb = require('../../adapters/replay-core-bridge/carry_onboarding');

const BRIDGE_DIR = path.join(__dirname, '..', '..', 'adapters', 'replay-core-bridge');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`BAD_ARGUMENTS:${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
const need = (f, ks) => { for (const k of ks) if (!f[k]) throw new Error(`MISSING_FLAG:${k}`); };

/** smartflow 侧脚本以最小环境的子进程运行(与 cache_jobs 相同)。 */
function child(script, f) {
  const root = bridge.smartflowRoot();
  const r = spawnSync(process.execPath, [path.join(BRIDGE_DIR, script), '--root', root, '--args', path.resolve(f.args), '--out', path.resolve(f.out)],
    { cwd: fs.existsSync(f.out) && fs.statSync(f.out).isDirectory() ? path.resolve(f.out) : path.dirname(path.resolve(f.out)), env: bridge.childEnv(), encoding: 'utf8', timeout: 6 * 60 * 60 * 1000, maxBuffer: 1 << 26 });
  if (r.error) throw new Error(`CHILD_FAILED:${r.error.code || r.error.message}`);
  if (r.status !== 0) throw new Error(`CHILD_FAILED:${String(r.stderr || '').trim().split('\n').pop()}`);
  return String(r.stdout || '').trim();
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (cmd === 'm1') {
    need(f, ['args', 'out']);
    process.stdout.write(`${child('carry_m1.js', f)}\n`);
    return JSON.parse(fs.readFileSync(f.out, 'utf8')).pass.all ? 0 : 1;
  }
  if (cmd === 'a0-runner') {
    need(f, ['data', 'dtb3-dir', 'dtb3-rel', 'work']);
    const r = Onb.a0Runner({ root: bridge.smartflowRoot(), data: f.data, dtb3Dir: f['dtb3-dir'], dtb3Rel: f['dtb3-rel'], work: f.work });
    process.stdout.write(`${JSON.stringify({ pass: r.pass, windows: Object.fromEntries(Object.entries(r.windows).map(([w, x]) => [w, x.resultsSha256 || null])) })}\n`);
    return r.pass.all ? 0 : 1;
  }
  if (cmd === 'a0-jobs') {
    need(f, ['is-oos', 'is-oos-run', 'w', 'w-run', 'out']);
    const r = Onb.a0Jobs({ groups: { IS_OOS: { dir: f['is-oos'], run: f['is-oos-run'] }, W1_W2_FULL: { dir: f.w, run: f['w-run'] } }, out: f.out });
    process.stdout.write(`${JSON.stringify({ pass: r.pass, jobs: r.jobs_total, groups: Object.fromEntries(Object.entries(r.groups).map(([g, x]) => [g, { manifest: x.manifest_sha256.slice(0, 8), jobs: x.jobs_sha256.slice(0, 8), pass: x.pass }])) })}\n`);
    return r.pass ? 0 : 1;
  }
  if (cmd === 'a0-backfill') {
    need(f, ['data', 'dtb3-dir', 'dtb3-rel', 'is-oos-jobs', 'w-jobs', 'data-evidence', 'tests', 'out']);
    const out = path.resolve(f.out);
    fs.mkdirSync(out, { recursive: true });
    const jobsOf = { IS_OOS: f['is-oos-jobs'], W1_W2_FULL: f['w-jobs'] };
    // 每组两个新进程(A 遍、B 遍),窗口顺序照写作业端(carry_backfill.js 文件头)
    for (const [group, windows] of Object.entries(Onb.BACKFILL_GROUPS)) {
      for (const pass of ['A', 'B']) {
        const args = { group, data: f.data, dtb3: { dir: f['dtb3-dir'], rel: f['dtb3-rel'] }, windows, jobs: [path.resolve(jobsOf[group])], dataEvidence: path.resolve(f['data-evidence']),
          again: pass === 'B' ? path.join(out, `a0-4-backfill.${group}.A.json`) : null };
        const argsFile = path.join(out, `args.${group}.${pass}.json`);
        fs.writeFileSync(argsFile, `${JSON.stringify(args, null, 1)}\n`);
        process.stdout.write(`${child('carry_backfill.js', { args: argsFile, out })}\n`);
      }
    }
    const r = Onb.a0BackfillVerdict({ root: bridge.smartflowRoot(), dir: out, dataEvidence: path.resolve(f['data-evidence']), tests: path.resolve(f.tests) });
    process.stdout.write(`${JSON.stringify({ pass: r.pass, windows: Object.fromEntries(Object.entries(r.windows).map(([w, x]) => [w, x.resultsSha256])) })}\n`);
    return r.pass.all ? 0 : 1;
  }
  if (cmd === 'seal') {
    need(f, ['pass1', 'pass2', 'out']);
    const r = Onb.sealCompare(path.resolve(f.pass1), path.resolve(f.pass2));
    fs.writeFileSync(f.out, `${JSON.stringify(r, null, 1)}\n`);
    process.stdout.write(`${JSON.stringify({ pass: r.pass, files: r.files, byte_identical: r.byte_identical, except_volatile: r.identical_except_volatile, projection: r.projection_compared, different: r.different, missing: r.missing })}\n`);
    return r.pass ? 0 : 1;
  }
  throw new Error('USAGE:m1|a0-runner|a0-jobs|a0-backfill|seal');
}

try {
  process.exitCode = main();
} catch (e) {
  process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`);
  process.exitCode = 2;
}
