'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./_verifier_fixture');
const verifier = require('../services/independent-verifier');

/**
 * W20 独立验证器（PLAN V1.1 修订 1 §2.1）：V-1…V-6 固定顺序，前一项不过就停，原因码写明停在哪一项；每一项一个通过案例、一个失败案例。
 * 先红后绿。现有闸门（G-CAUSAL、G-PARITY、G-COST、G-MINE 的 DSR/PBO、overfit.bhy、price-limits）只调用，不重写。
 */
const run = (o) => { const { bundle, ctx } = fx.build(o); return verifier.verify(bundle, ctx); };
const failsAt = (o, stage, pattern) => {
  const { internal, generator } = run(o);
  assert.equal(generator.verdict, 'fail');
  assert.equal(internal.failedStage, stage);
  assert.ok(generator.reasonCodes.length > 0 && generator.reasonCodes.every((c) => c.startsWith(`${stage}_`)), generator.reasonCodes.join(','));
  if (pattern) assert.ok(generator.reasonCodes.some((c) => pattern.test(c)), generator.reasonCodes.join(','));
  return internal;
};

test('固定顺序与全过：六项顺序写死，全过 → pass、没有原因码、六项都有记录', () => {
  assert.deepEqual([...verifier.STAGES], ['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
  const { internal, generator } = run();
  assert.deepEqual(generator, { candidateId: 'cand-1', verdict: 'pass', reasonCodes: [] });
  assert.deepEqual(internal.stagesRun, ['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
  assert.deepEqual(internal.stages.map((s) => s.status), Array(6).fill('PASS'));
});

test('V-1 时间因果：通过 = G-CAUSAL 与研究实盘一致口令门都过；失败 = 证据里 T-C2 不过（G-CAUSAL）；G-PARITY 的失败见下一条', () => {
  assert.equal(run().internal.stages[0].status, 'PASS');
  const bad = fx.evidenceOf(fx.build().bundle.v1.entry.k2.sha256, [fx.fnRecord(fx.FN, { t_c2: 'FAIL', fail_reasons: { t_c2: 'LOOKAHEAD' } })]);
  failsAt({ evidence: bad }, 'V1', /CAUSALITY/);
});

test('V-1 失败案例：K2 的 DATA 记号写了没登记的数据集 → 停在 V-1（G-PARITY），不进 V-2', () => {
  const { bundle, ctx } = fx.build({ dataset: 'NOT_A_REGISTERED_DATASET' });
  const out = verifier.verify(bundle, ctx);
  assert.equal(out.internal.failedStage, 'V1');
  assert.ok(out.generator.reasonCodes[0].startsWith('V1_PARITY_'), out.generator.reasonCodes.join(','));
  assert.deepEqual(out.internal.stagesRun, ['V1']);
});

test('V-1 失败案例：文件按 sha256 复验，字节被改 → V1_FILE_SHA_MISMATCH', () => {
  const { bundle, ctx, files } = fx.build();
  files.set('causality.json', Buffer.from('{}'));
  const out = verifier.verify(bundle, ctx);
  assert.deepEqual(out.generator.reasonCodes, ['V1_FILE_SHA_MISMATCH']);
});

test('V-2 样本隔离：通过 = 生成方的读都不晚于验证段终点、留出段一次没读；失败 = 生成方读到留出段', () => {
  assert.equal(run().internal.stages[1].status, 'PASS');
  failsAt({ accessRows: [fx.GEN_READ, { ...fx.GEN_READ_VALIDATION, to: '2026-10-19' }] }, 'V2', /V2_GENERATOR_READ_BEYOND_VALIDATION/);
});

test('V-2：留出段每个冻结候选最多读一次；12-31 之前不能读；读留出段的不能是生成方', () => {
  const cand = fx.build().bundle.candidateSha256;
  assert.equal(run({ asOf: '2027-01-10', accessRows: [fx.GEN_READ, fx.holdoutRead(cand)] }).generator.verdict, 'pass');
  failsAt({ asOf: '2027-01-10', accessRows: [fx.GEN_READ, fx.holdoutRead(cand), fx.holdoutRead(cand)] }, 'V2', /V2_HOLDOUT_READ_MORE_THAN_ONCE/);
  failsAt({ asOf: '2026-12-01', accessRows: [fx.GEN_READ, fx.holdoutRead(cand)] }, 'V2', /V2_HOLDOUT_READ_BEFORE_SEAL_END/);
  failsAt({ asOf: '2027-01-10', accessRows: [fx.GEN_READ, { ...fx.holdoutRead(cand), principal: 'review-agent' }] }, 'V2', /V2_GENERATOR_HOLDOUT_READ/);
  failsAt({ asOf: '2027-01-10', accessRows: [fx.GEN_READ, { ...fx.holdoutRead('9'.repeat(64)) }] }, 'V2', /V2_HOLDOUT_READ_NOT_THIS_CANDIDATE/);
});

test('V-2：访问记录要按 sha256 绑定、哈希链连续；W05 的 UNSEEN 声明遇到 SEEN 标签被拒', () => {
  const rows = fx.chain([fx.GEN_READ, fx.GEN_READ_VALIDATION]);
  failsAt({ accessChained: true, accessRows: [{ ...rows[0] }, { ...rows[1], prev: '1'.repeat(64) }] }, 'V2', /V2_ACCESS_LOG_CHAIN_BROKEN/);
  failsAt({ accessChained: true, accessRows: [rows[1]] }, 'V2', /V2_ACCESS_LOG_CHAIN_BROKEN/);
  const mark = { schema: 'DATA_SEGMENT_MARK_V1', family_id: 'CN_A_H5', label: 'UNSEEN', seen_kind: null, from: '2025-01-01', to: '2025-06-30', mark_id: 'M1' };
  const ok = run({ v2: (v2) => { v2.unseenClaim = { from: '2025-02-01', to: '2025-03-01' }; v2.segmentMarks = [mark]; } });
  assert.equal(ok.generator.verdict, 'pass');
  failsAt({ v2: (v2) => { v2.unseenClaim = { from: '2025-02-01', to: '2025-09-01' }; v2.segmentMarks = [mark]; } }, 'V2', /V2_UNSEEN_CLAIM_NOT_UNSEEN/);
});

test('V-3 多重检验：通过 = DSR、PBO、BHY 都过且 N 是试验家族累计数；失败各一例', () => {
  assert.equal(run().internal.stages[2].status, 'PASS');
  failsAt({ v3: (v3) => { v3.overfit.dsr = 0.5; } }, 'V3', /V3_MINE_DSR_BELOW_MIN/);
  failsAt({ v3: (v3) => { v3.overfit.pbo = 0.9; } }, 'V3', /V3_MINE_PBO_ABOVE_MAX/);
  failsAt({ v3: (v3) => { v3.overfit.n_trials = 3; } }, 'V3', /V3_MINE_DSR_N_NOT_CUMULATIVE/);
  failsAt({ v3: (v3) => { v3.overfit.bhy = { pValues: [0.04, 0.2, 0.5], index: 0 }; } }, 'V3', /V3_BHY_NOT_SIGNIFICANT/);
  failsAt({ v3: (v3) => { delete v3.overfit.bhy; } }, 'V3', /V3_BHY_INPUT_MISSING/);
});

test('V-4 成本与交易约束：通过 = 计成本且收齐登记项、成交不违反涨跌停与参与率；失败各一例', () => {
  assert.equal(run().internal.stages[3].status, 'PASS');
  failsAt({ v4: (v4) => { v4.runs[0].cost_breakdown.items = v4.runs[0].cost_breakdown.items.slice(1); } }, 'V4', /V4_COST_MODEL_NET_PARTIAL/);
  failsAt({ v4: (v4) => { v4.runs[0].cost_breakdown.commission_bps = 0; v4.runs[0].cost_breakdown.slippage_bps = 0; } }, 'V4', /V4_COST_MODEL_BELOW_FLOOR/);
  failsAt({ v4: (v4) => { v4.fills[0].open = 11; } }, 'V4', /V4_FILL_AT_PRICE_LIMIT/);
  failsAt({ v4: (v4) => { v4.fills[0].participation = 0.5; } }, 'V4', /V4_PARTICIPATION_CAP_EXCEEDED/);
});

test('V-5 鲁棒性：通过 = 只做 K2 事先写明的检验且全过；失败 = 声明与 K2 不符 / 多做 / 少做 / 成本加倍不过 / 没声明成本加倍', () => {
  assert.equal(run().internal.stages[4].status, 'PASS');
  failsAt({ v5: (v5) => { v5.results[0].value = -0.01; } }, 'V5', /V5_COST_MULTIPLIER_FAILED/);
  failsAt({ v5: (v5) => { v5.results.push({ id: 'EXTRA_POST_HOC', value: 1 }); } }, 'V5', /V5_UNDECLARED_TEST/);
  failsAt({ v5: (v5) => { v5.results.pop(); } }, 'V5', /V5_DECLARED_TEST_MISSING/);
  failsAt({ v5: (v5) => { v5.declaration.tests[0].threshold = -1; } }, 'V5', /V5_DECLARATION_NOT_IN_K2/);
  const weak = { tests: [{ id: 'COST_X1', kind: 'COST_MULTIPLIER', multiplier: 1, metric: 'M', op: '>', threshold: 0 }, { id: 'P', kind: 'PARAM_PERTURBATION', metric: 'M', op: '>', threshold: 0 }, { id: 'S', kind: 'SUB_PERIOD', metric: 'M', op: '>', threshold: 0 }] };
  failsAt({ robustness: weak, v5: (v5) => { v5.results = [{ id: 'COST_X1', value: 1 }, { id: 'P', value: 1 }, { id: 'S', value: 1 }]; } }, 'V5', /V5_COST_X2_NOT_DECLARED/);
});

test('V-6 组合增量：S4 合同文件 {candidateId, s4Evidence}；PASS 才过；缺文件、候选不符、非 PASS 都停在 V-6；没到 S3 的不跑 V-6', () => {
  assert.equal(run().internal.stages[5].status, 'PASS');
  failsAt({ s4: { candidateId: 'cand-1', s4Evidence: { verdict: 'FAIL', reasonCodes: ['S4_OVERLAP'], sha256: 'e'.repeat(64) } } }, 'V6', /V6_S4_FAIL/);
  failsAt({ s4: { candidateId: 'other', s4Evidence: { verdict: 'PASS', reasonCodes: [], sha256: 'e'.repeat(64) } } }, 'V6', /V6_S4_CANDIDATE_MISMATCH/);
  failsAt({ v6: (v6) => { v6.s4Contract = null; } }, 'V6', /V6_S4_EVIDENCE_MISSING/);
  const skipped = run({ reachedS3: false, v6: (v6) => { v6.s4Contract = null; } });
  assert.equal(skipped.generator.verdict, 'pass');
  assert.equal(skipped.internal.stages[5].status, 'NOT_RUN');
  assert.deepEqual(skipped.internal.stagesRun, ['V1', 'V2', 'V3', 'V4', 'V5']);
});

test('顺序强制：V-3 失败从不进 V-4…V-6；同时坏在 V-2 和 V-4 时只报 V-2', () => {
  const r3 = run({ v3: (v3) => { v3.overfit.dsr = 0.1; } });
  assert.deepEqual(r3.internal.stagesRun, ['V1', 'V2', 'V3']);
  assert.deepEqual(r3.internal.stages.slice(3).map((s) => s.status), ['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
  const both = run({ accessRows: [fx.GEN_READ, { ...fx.GEN_READ_VALIDATION, to: '2026-12-31' }], v4: (v4) => { v4.fills[0].open = 11; } });
  assert.deepEqual(both.generator.reasonCodes.map((c) => c.slice(0, 2)), ['V2']);
  assert.deepEqual(both.internal.stagesRun, ['V1', 'V2']);
});

test('阶段内部异常一律失败即关（V<n>_STAGE_ERROR），不当作通过', () => {
  const out = run({ v4: (v4) => { v4.runs = 'not-an-array'; } });
  assert.equal(out.generator.verdict, 'fail');
  assert.match(out.generator.reasonCodes[0], /^V4_/);
});

test('V-3 统计量出处（plan-coord 11-23 第 4 条）：DSR / PBO / BHY 各带「试验台账记录号 + 运行文件 sha256」，文件里的值与输入一致；缺、不符、sha 对不上 → V3_UNSOURCED_STATISTIC', () => {
  assert.equal(run().internal.stages[2].status, 'PASS'); // 通过案例：三个都有出处
  const only = (o) => { const { internal, generator } = run(o); assert.deepEqual(generator.reasonCodes, ['V3_UNSOURCED_STATISTIC']); assert.equal(internal.failedStage, 'V3'); };
  only({ v3: (v3) => { delete v3.provenance; } });
  only({ v3: (v3) => { delete v3.provenance.pbo; } });
  only({ v3: (v3) => { v3.provenance.dsr.trialRecordId = 'not-a-trial-id'; } });
  only({ v3: (v3) => { v3.provenance.dsr.run.sha256 = 'a'.repeat(64); } }); // sha 对不上（文件字节被换）
  only({ v3: (v3) => { v3.overfit.dsr = 0.99; } }); // 值与运行文件里写的不一致
  only({ v3: (v3) => { v3.provenance.bhy.trialRecordId = `TRL-${'0'.repeat(16)}`; } }); // 记录号与运行文件不一致
});
