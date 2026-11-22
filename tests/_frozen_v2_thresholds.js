'use strict';
/**
 * 测试辅助（RF1116 修订 SIZE_V2 N4）：V2 的轮读 config/mining_gate_thresholds.v2.json，冻结页 FREEZE_2 之前它是 PENDING_FREEZE，门不跑任何一项。
 * 要逐项看第 3–9 项的码的测试（经 runner.scoreHoldout / rescore 的在进程内的路径），用这个把打分与记录包在一份合成的 FROZEN v2 门槛文件 + 合成冻结页里。
 * 数与 v1 的六个数相同，加 size_exposure_abs_max 0.10。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function frozenV2() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-v2-'));
  fs.mkdirSync(path.join(root, 'docs', 'freeze'), { recursive: true });
  const vals = { ic_mean_min: 0.02, icir_min: 0.3, monotonicity_min: 0.9, decay_ratio_min: 0.5, marginal_ir_delta_min: 0, marginal_intercept_t_min: 2, size_exposure_abs_max: 0.1 };
  const body = `# synthetic FREEZE_2\n\n状态：**FROZEN。**\n\n${Object.entries(vals).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n')}\n`;
  const rel = 'docs/freeze/SYNTHETIC_FREEZE_2.md';
  fs.writeFileSync(path.join(root, rel), body);
  const doc = { ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'mining_gate_thresholds.v2.json'), 'utf8')), state: 'FROZEN',
    frozen_ref: { path: rel, sha256: crypto.createHash('sha256').update(body).digest('hex') } };
  const file = path.join(root, 'mining_gate_thresholds.v2.json');
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return { root, file, doc };
}

/** 让 runner.scoreHoldout 与 runner.rescore 在合成的 FROZEN v2 门槛下跑。 */
function installOn(runner) {
  const gate = require('../services/mining-gate');
  const records = require('../services/mining-rounds/gate-records');
  const t = frozenV2();
  for (const name of ['scoreHoldout', 'rescore']) {
    const orig = runner[name];
    runner[name] = (...a) => gate.internals.withFreezeRoot(t.root, () => records.internals.withThresholdsFile(t.file, () => orig(...a)));
  }
  return t;
}
module.exports = { frozenV2, installOn };
