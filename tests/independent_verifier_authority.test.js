'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fx = require('./_verifier_fixture');
const verifier = require('../services/independent-verifier');
const authority = require('../services/independent-verifier/authority');

/**
 * W20 越权拒绝（PLAN V1.1 修订 1 §2.2–§2.3）：每种越权各一条测试。两层：授权函数（authority.authorize / grantHoldoutRead）与进程级锁
 * （process-lock：写只许输出目录、读不许进留出段目录；子进程里不可解除）。生成方 = mining-generator、review-agent；未知主体一律拒绝（失败即关）。
 */
const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const refuses = (fn, code) => assert.throws(fn, (e) => e instanceof authority.VerifierAuthorityError && e.code === code, code);
const GEN = ['mining-generator', 'review-agent'];

function world() {
  const repoRoot = tmp('w20-repo-'); const holdout = tmp('w20-holdout-'); const ledgerFile = path.join(tmp('w20-ledger-'), 'reads.jsonl');
  for (const f of ['services/independent-verifier/index.js', 'config/independent_verifier.v1.json', 'config/mining_gate_thresholds.v1.json']) {
    fs.mkdirSync(path.dirname(path.join(repoRoot, f)), { recursive: true }); fs.writeFileSync(path.join(repoRoot, f), 'x');
  }
  fs.writeFileSync(path.join(holdout, 'bars.csv'), 'date,close\n');
  return { repoRoot, holdoutDirs: [holdout], ledgerFile, holdout };
}

test('拒绝 1：改验证器文件或配置（生成方、验证器自己、未知主体都不行）', () => {
  const w = world();
  for (const principal of [...GEN, 'verifier']) {
    for (const target of ['services/independent-verifier/index.js', 'services/independent-verifier/new-file.js', 'config/independent_verifier.v1.json']) {
      refuses(() => authority.authorize({ principal, action: 'WRITE_FILE', target: path.join(w.repoRoot, target) }, w), 'VERIFIER_WRITE_REFUSED');
    }
  }
  refuses(() => authority.authorize({ principal: 'someone-else', action: 'WRITE_FILE', target: path.join(w.repoRoot, 'README.md') }, w), 'VERIFIER_PRINCIPAL_UNKNOWN');
  assert.equal(authority.authorize({ principal: 'mining-generator', action: 'WRITE_FILE', target: path.join(os.tmpdir(), 'w20-own-output.json') }, w).allowed, true); // 自己的输出目录不拦
});

test('拒绝 2：请求留出段指标（或验证段之后的任何指标）', () => {
  const w = world();
  for (const principal of GEN) {
    refuses(() => authority.authorize({ principal, action: 'REQUEST_METRICS', candidateId: 'cand-1', segment: 'HOLDOUT' }, w), 'HOLDOUT_METRICS_REFUSED');
    refuses(() => authority.authorize({ principal, action: 'REQUEST_METRICS', candidateId: 'cand-1', segment: 'AFTER_VALIDATION' }, w), 'HOLDOUT_METRICS_REFUSED');
    refuses(() => authority.authorize({ principal, action: 'REQUEST_METRICS', candidateId: 'cand-1', segment: 'UNKNOWN_SEGMENT' }, w), 'HOLDOUT_METRICS_REFUSED');
    assert.equal(authority.authorize({ principal, action: 'REQUEST_METRICS', candidateId: 'cand-1', segment: 'MINING' }, w).allowed, true);
  }
  refuses(() => authority.authorize({ principal: 'mining-generator', action: 'REQUEST_VERDICT_DETAIL', candidateId: 'cand-1' }, w), 'HOLDOUT_METRICS_REFUSED');
});

test('拒绝 3：改已冻结的判定表与门槛（运行时没有任何主体能改）', () => {
  const w = world();
  for (const principal of [...GEN, 'verifier']) {
    refuses(() => authority.authorize({ principal, action: 'MODIFY_DECISION_TABLE', target: path.join(w.repoRoot, 'config/mining_gate_thresholds.v1.json') }, w), 'FROZEN_TABLE_CHANGE_REFUSED');
    refuses(() => authority.authorize({ principal, action: 'MODIFY_DECISION_TABLE', target: path.join(w.repoRoot, 'config/independent_verifier.v1.json') }, w), 'FROZEN_TABLE_CHANGE_REFUSED');
  }
  // 门槛文件的字节被改 → 验证器拒绝运行（钉的 sha256 不符）
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/independent_verifier.v1.json'), 'utf8'));
  cfg.bhyAlpha = 0.5;
  refuses(() => authority.loadConfig(Buffer.from(JSON.stringify(cfg))), 'VERIFIER_CONFIG_PIN_MISMATCH');
  assert.equal(authority.loadConfig().contract, 'INDEPENDENT_VERIFIER_V1');
});

test('拒绝 4a：生成方读留出段数据目录（授权层）；留出段读取只有 holdout-scorer', () => {
  const w = world();
  for (const principal of GEN) {
    refuses(() => authority.authorize({ principal, action: 'READ_FILE', target: path.join(w.holdout, 'bars.csv') }, w), 'HOLDOUT_DIR_READ_REFUSED');
    refuses(() => authority.authorize({ principal, action: 'READ_FILE', target: w.holdout }, w), 'HOLDOUT_DIR_READ_REFUSED');
    refuses(() => authority.grantHoldoutRead({ principal, candidateSha256: fx.sha('c'), candidateId: 'c' }, w), 'HOLDOUT_DIR_READ_REFUSED');
  }
});

test('拒绝 4b：生成方进程读留出段数据目录（进程级：子进程里 fs 读入口被锁，不能解除）；写也只许输出目录', () => {
  const w = world(); const out = tmp('w20-out-');
  const script = `
    const fs = require('fs'); const path = require('path');
    const { lockProcess } = require(${JSON.stringify(path.join(ROOT, 'services/independent-verifier/process-lock'))});
    lockProcess({ allowWriteRoot: ${JSON.stringify(out)}, denyReadRoots: ${JSON.stringify(w.holdoutDirs)} });
    const code = (f) => { try { f(); return 'NOT_REFUSED'; } catch (e) { return e.code || e.message; } };
    const res = {
      readFile: code(() => fs.readFileSync(${JSON.stringify(path.join(w.holdout, 'bars.csv'))})),
      readdir: code(() => fs.readdirSync(${JSON.stringify(w.holdout)})),
      open: code(() => fs.openSync(${JSON.stringify(path.join(w.holdout, 'bars.csv'))}, 'r')),
      stream: code(() => { fs.createReadStream(${JSON.stringify(path.join(w.holdout, 'bars.csv'))}); }),
      writeVerifier: code(() => fs.writeFileSync(${JSON.stringify(path.join(w.repoRoot, 'services/independent-verifier/index.js'))}, 'pwn')),
      writeConfig: code(() => fs.writeFileSync(${JSON.stringify(path.join(w.repoRoot, 'config/independent_verifier.v1.json'))}, '{}')),
      writeOwn: code(() => fs.writeFileSync(path.join(${JSON.stringify(out)}, 'ok.json'), '{}')),
      readOther: code(() => fs.readFileSync(${JSON.stringify(path.join(w.repoRoot, 'config/mining_gate_thresholds.v1.json'))})),
    };
    process.stdout.write(JSON.stringify(res));`;
  const res = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  assert.deepEqual(res, { readFile: 'VERIFIER_HOLDOUT_READ_REFUSED', readdir: 'VERIFIER_HOLDOUT_READ_REFUSED', open: 'VERIFIER_HOLDOUT_READ_REFUSED', stream: 'VERIFIER_HOLDOUT_READ_REFUSED',
    writeVerifier: 'MINE_SANDBOX_WRITE_REFUSED', writeConfig: 'MINE_SANDBOX_WRITE_REFUSED', writeOwn: 'NOT_REFUSED', readOther: 'NOT_REFUSED' });
  assert.equal(fs.readFileSync(path.join(w.repoRoot, 'services/independent-verifier/index.js'), 'utf8'), 'x');
});

test('拒绝 5：同一候选的留出段被读第二次（以候选 sha256 记，一次授权一行台账）', () => {
  const w = world();
  const c = fx.sha('candidate-1');
  const first = authority.grantHoldoutRead({ principal: 'holdout-scorer', candidateSha256: c, candidateId: 'cand-1' }, w);
  assert.equal(first.allowed, true);
  assert.equal(authority.holdoutReadsOf(c, w).length, 1);
  refuses(() => authority.grantHoldoutRead({ principal: 'holdout-scorer', candidateSha256: c, candidateId: 'cand-1' }, w), 'HOLDOUT_SECOND_READ_REFUSED');
  refuses(() => authority.grantHoldoutRead({ principal: 'holdout-scorer', candidateSha256: c, candidateId: 'renamed' }, w), 'HOLDOUT_SECOND_READ_REFUSED');
  assert.equal(authority.holdoutReadsOf(c, w).length, 1);
  assert.equal(authority.grantHoldoutRead({ principal: 'holdout-scorer', candidateSha256: fx.sha('candidate-2'), candidateId: 'cand-2' }, w).allowed, true);
});

test('留出段被否掉后再提交的近似候选：同机制或相关性超过因子库去重线 → 计入同一试验家族的 N，并必须过机制去重', () => {
  const prior = { candidateId: 'old', mechanismId: 'SEL.MOMENTUM.SHORT', familyId: 'CN_A_H5', nTrialsAtFailure: 12 };
  const resub = (patch) => fx.build({ v3: (v3) => { v3.priorHoldoutFailures = [prior]; Object.assign(v3, patch); } });
  const go = (o) => verifier.verify(o.bundle, o.ctx);
  // 同机制、同族、N 已累计（13 > 12）、去重有结论 → 过 V-3
  const ok = resub({ familyTrialCount: 13 }); ok.bundle.v3.overfit.n_trials = 13;
  assert.equal(go(ok).internal.stages[2].status, 'PASS');
  assert.deepEqual(go(ok).internal.stages[2].detail.resubmissionOf, ['old']);
  // 换个族名想躲 N → 拒绝
  const split = resub({ familyTrialCount: 13 }); split.bundle.v3.overfit.n_trials = 13; split.bundle.familyId = 'CN_A_H5_V2';
  assert.deepEqual(go(split).generator.reasonCodes, ['V3_RESUBMISSION_FAMILY_SPLIT']);
  // N 没有累计 → 拒绝
  assert.deepEqual(go(resub({})).generator.reasonCodes, ['V3_RESUBMISSION_N_NOT_CUMULATIVE']);
  // 没有机制去重结论 → 拒绝
  const nodedupe = resub({ familyTrialCount: 13 }); nodedupe.bundle.v3.overfit.n_trials = 13; delete nodedupe.bundle.mechanism.dedupeDecision;
  assert.deepEqual(go(nodedupe).generator.reasonCodes, ['V3_RESUBMISSION_NOT_DEDUPED']);
  // 换机制名、但因子序列与失败的那个相关性 > 因子库去重线 → 照样当近似候选
  const rho = resub({ familyTrialCount: 13 }); rho.bundle.v3.overfit.n_trials = 13; rho.bundle.mechanism.id = 'SEL.OTHER.NAME'; rho.bundle.v3.priorHoldoutFailures[0] = { ...prior, rho: 0.85 };
  assert.equal(go(rho).internal.stages[2].detail.resubmissionOf[0], 'old');
});

test('未知主体与缺字段：失败即关', () => {
  const w = world();
  refuses(() => authority.authorize({ principal: '', action: 'READ_FILE', target: '/x' }, w), 'VERIFIER_PRINCIPAL_UNKNOWN');
  refuses(() => authority.authorize({ principal: 'mining-generator', action: 'NOT_AN_ACTION' }, w), 'VERIFIER_ACTION_UNKNOWN');
});
