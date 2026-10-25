'use strict';
require('./_env');
const test = require('node:test');
const { beforeEach } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const AUTHORITY = 'INDEPENDENT_PRODUCT_REVIEWER';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const k3 = require('../services/baseline-evaluation');
const { result, write } = require('./_q0_fixture');

beforeEach(() => { fs.rmSync(k3.LEDGER(), { force: true }); k3.clearCache(); });

const imp = (file, extra = {}) => k3.importBaselineEvaluation(file, { registeredBy: AUTHORITY, allowNonActual: true, ...extra });
const reader = () => k3.createProjectionReader({ build: (lock) => k3.buildProjection(lock, { allowNonActual: true }) });
const STRESS_NUMBERS = ['max_loss_usd', 'longest_underwater_sessions', 'recovered', 'end_capital'];
const mutate = (fn) => write(result((doc) => { fn(doc); return doc; }));

test('尚未导入：整卡是「尚未回测」和原因，不是证据不足，也不用 0 补位', () => {
  const projection = k3.readProjection('NO-SUCH-CASE');
  assert.equal(projection.state, 'NOT_IMPORTED');
  assert.equal(projection.conclusion.state, 'NOT_BACKTESTED');
  assert.equal(projection.conclusion.label, '尚未回测');
  assert.equal(projection.conclusion.main_number, null);
  assert.deepEqual(projection.blocks.map((block) => block.key), ['period', 'account', 'winrate', 'stress', 'kelly', 'verdict']);
  assert.ok(projection.blocks.every((block) => block.state === 'NOT_BACKTESTED' && block.data === null && block.reason));
});

test('导入：封存校验、结果锁、输入与引擎摘要；同一文件重放幂等；六块按固定顺序全部可用', () => {
  const file = write();
  const lock = imp(file);
  assert.equal(lock.schema, 'BASELINE_EVALUATION_LOCK_V1');
  assert.equal(lock.eval_class, 'BASELINE_EVALUATION_V1');
  assert.equal(lock.verdict_state, 'INSUFFICIENT');
  assert.match(lock.result_id, /^Q0-[0-9a-f]{16}$/);
  assert.match(lock.inputs_digest, /^[0-9a-f]{64}$/);
  assert.match(lock.engine_digest, /^[0-9a-f]{64}$/);
  assert.equal(lock.production_effect, 'NONE');
  assert.equal(imp(file).replayHit, true);
  assert.equal(k3.locks(k3.CASE_REF).length, 1);
  assert.equal(k3.baselineFor(lock.result_id).file_sha256, lock.file_sha256);

  const projection = reader().read();
  assert.equal(projection.state, 'LOCKED_VERIFIED');
  assert.deepEqual(projection.blocks.map((block) => block.key), ['period', 'account', 'winrate', 'stress', 'kelly', 'verdict']);
  assert.ok(projection.blocks.every((block) => block.state === 'AVAILABLE'), JSON.stringify(projection.blocks.map((b) => b.reason)));
  assert.equal(projection.conclusion.label, '证据不足');
  assert.equal(projection.conclusion.main_number.value, 0.22);
  assert.deepEqual(projection.conclusion.main_number.ci, { lo: 0.12, hi: 0.31 });
  const account = projection.blocks.find((block) => block.key === 'account').data;
  assert.deepEqual(account.arms.map((arm) => arm.label), ['本策略', 'SPY 买入持有', '现金']);
  const stress = projection.blocks.find((block) => block.key === 'stress').data;
  assert.equal(stress.rows.find((row) => row.simulated).note, '模拟序列，不是可交易历史');
  assert.deepEqual(stress.headline, { scenario: 'REPLAY_2020_02_19_2020_04_30', label: '区间重放：2020-02-19 至 2020-04-30', max_loss_usd: 900 });
  assert.deepEqual(stress.counts, { executed: 2, simulated: 1, missing: 1, invalid_input: 0 });
  const missing = stress.rows.find((row) => row.missing);
  assert.equal(missing.missing_reason, '2007–2009 行业 ETF 日线在 Mac 与 HK 均无，按 Owner 规则不重新拉取');
  assert.equal(missing.simulated, false);
  assert.ok(STRESS_NUMBERS.every((key) => missing[key] === null));
  const kelly = projection.blocks.find((block) => block.key === 'kelly').data;
  assert.equal(kelly.supported, true);
  assert.equal(kelly.floor_usd, 1800);
  assert.equal(kelly.note, '研究计算，不是仓位建议；现行仓位规则不变');
  const winrate = projection.blocks.find((block) => block.key === 'winrate').data;
  assert.equal(winrate.formula.note, '公式推算，不是回测');
  assert.equal(projection.diagnosis.items.length, 2);
  assert.equal(projection.diagnosis.items[0].experiment.id, 'Q1');
  assert.equal(projection.diagnosis.items[1].source_label, '执行');
  assert.equal(projection.diagnosis.items[0].state_label, '待验证，不是结论');
});

test('封存文件在锁定后被改动、删除或旁证丢失：整卡失败关闭，页面不再显示任何数字', () => {
  const file = write();
  imp(file);
  const fresh = () => reader().read();
  assert.equal(fresh().state, 'LOCKED_VERIFIED');
  fs.appendFileSync(file, ' ');
  const drifted = fresh();
  assert.equal(drifted.state, 'INVALID');
  assert.match(drifted.reason, /Q0_RESULT_SHA256_MISMATCH/);
  assert.equal(drifted.conclusion.label, '尚未回测');
  assert.ok(drifted.blocks.every((block) => block.data === null));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd());
  fs.unlinkSync(`${file}.sha256`);
  assert.equal(fresh().state, 'MISSING');
  fs.unlinkSync(file);
  assert.equal(fresh().state, 'MISSING');
});

test('导入拒绝：非实际路径、缺 sha256 旁证、旁证不符、缺顶层字段、未复现', () => {
  assert.throws(() => k3.importBaselineEvaluation(write(), { registeredBy: AUTHORITY }), /Q0_RESULT_NON_ACTUAL_SOURCE/);
  assert.throws(() => imp(write(result(), { sidecar: false })), /Q0_RESULT_SHA256_FILE_MISSING/);
  assert.throws(() => imp(write(result(), { tamperSidecar: true })), /Q0_RESULT_SHA256_MISMATCH/);
  assert.throws(() => imp('relative/RESULT.json'), /Q0_RESULT_PATH_MUST_BE_ABSOLUTE/);
  assert.throws(() => imp(mutate((doc) => { delete doc.stress; })), /Q0_RESULT_TOP_LEVEL_MISSING:stress/);
  assert.throws(() => imp(mutate((doc) => { doc.reproducibility.runs[1].sha256 = 'f'.repeat(64); })), /Q0_RESULT_NOT_REPRODUCED/);
  assert.throws(() => imp(mutate((doc) => { doc.reproducibility.identical = false; })), /Q0_RESULT_NOT_REPRODUCED/);
  assert.throws(() => imp(mutate((doc) => { doc.identity.schema = 'OTHER'; })), /Q0_RESULT_SCHEMA_UNSUPPORTED/);
  assert.throws(() => imp(mutate((doc) => { delete doc.identity.engine_files; })), /Q0_ENGINE_BLOBS_MISSING/);
  assert.throws(() => imp(mutate((doc) => { doc.inputs.series[0].sha256 = 'x'; })), /Q0_INPUT_SERIES_INCOMPLETE/);
  assert.equal(k3.locks(k3.CASE_REF).length, 0);
});

test('标签不能越过算术证据：δ 冻结，SUPPORTED／NOT_PASSED 须有区间支持，近似引擎不能 SUPPORTED，模拟场景必须标模拟', () => {
  const supported = (patch) => mutate((doc) => { doc.verdict.state = 'SUPPORTED'; doc.verdict.L_R = 0.12; doc.verdict.L_g = 0.01; Object.assign(doc.verdict, patch); });
  assert.throws(() => imp(supported({ L_R: 0.1 })), /Q0_VERDICT_SUPPORTED_WITHOUT_EVIDENCE/);
  assert.throws(() => imp(supported({ L_g: 0 })), /Q0_VERDICT_SUPPORTED_WITHOUT_EVIDENCE/);
  assert.throws(() => imp(supported({ n_trades: 29 })), /Q0_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL/);
  assert.throws(() => imp(supported({ engine_approximation: { flag: true, missing: ['A17'] } })), /Q0_VERDICT_SUPPORTED_ON_APPROXIMATE_ENGINE/);
  assert.throws(() => imp(mutate((doc) => { doc.verdict.state = 'NOT_PASSED'; })), /Q0_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE/);
  assert.throws(() => imp(mutate((doc) => { doc.verdict.delta_R = 0.05; })), /Q0_VERDICT_DELTA_CHANGED/);
  assert.throws(() => imp(mutate((doc) => { doc.verdict.delta_g = 0.01; })), /Q0_VERDICT_DELTA_CHANGED/);
  assert.throws(() => imp(mutate((doc) => { doc.verdict.comparators = ['SPY_BUY_HOLD']; })), /Q0_VERDICT_COMPARATORS_CHANGED/);
  assert.throws(() => imp(mutate((doc) => { doc.verdict.ci_method = 'IID_BOOTSTRAP'; })), /Q0_VERDICT_CI_METHOD_CHANGED/);
  assert.throws(() => imp(mutate((doc) => { doc.stress.rows[2].simulated = false; })), /Q0_STRESS_SIMULATED_NOT_FLAGGED/);
  assert.throws(() => imp(mutate((doc) => { doc.gates.A0.state = 'FAILED'; })), /Q0_ENGINE_APPROXIMATION_NOT_DECLARED/);
  assert.throws(() => imp(mutate((doc) => { doc.gates.rules[0].status = 'NOT_IMPLEMENTED'; })), /Q0_ENGINE_APPROXIMATION_NOT_DECLARED/);
  assert.equal(k3.locks(k3.CASE_REF).length, 0);
  // 有算术证据的 SUPPORTED、以及保守方向的 INSUFFICIENT／近似引擎下的 NOT_PASSED 都允许
  const ok = imp(supported({}));
  assert.equal(ok.verdict_state, 'SUPPORTED');
});

test('一个 case 只锁一次；改锁须引用缺陷和原因，旧锁保留，Q1–Q4 引用的 result_id 不变', () => {
  const first = imp(write());
  const other = write(result((doc) => { doc.identity.seed = 8; return doc; }));
  assert.throws(() => imp(other), /BASELINE_ALREADY_LOCKED/);
  assert.throws(() => imp(other, { supersedes: first.result_id }), /BASELINE_SUPERSEDE_REQUIRES_DEFECT_AND_REASON/);
  assert.throws(() => imp(other, { supersedes: 'Q0-wrong', defectRef: 'D', reason: 'r' }), /BASELINE_ALREADY_LOCKED/);
  const second = imp(other, { supersedes: first.result_id, defectRef: 'DEFECT:Q0:001', reason: 'A0 对齐关卡复算有误' });
  assert.equal(second.supersedes_ref, first.result_id);
  assert.equal(k3.locks(k3.CASE_REF).length, 2);
  assert.equal(k3.headLock(k3.CASE_REF).result_id, second.result_id);
  assert.equal(k3.baselineFor(first.result_id).result_id, first.result_id);
});

test('导入只由完成权威执行：未配置、记录人不符都拒绝', () => {
  const file = write();
  assert.throws(() => k3.importBaselineEvaluation(file, { allowNonActual: true }), /BASELINE_LOCK_REGISTERED_BY_REQUIRED/);
  assert.throws(() => imp(file, { registeredBy: 'IMPLEMENTER' }), /BASELINE_LOCK_REGISTERED_BY_NOT_AUTHORIZED/);
  const saved = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  delete process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  try { assert.throws(() => imp(file), /BASELINE_LOCK_AUTHORITY_NOT_CONFIGURED/); } finally { process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = saved; }
});

test('区块各自失败：缺一块只让该块写「尚未回测：原因」，其他块照常，不用 0 或空表补位', () => {
  imp(write(result((doc) => { delete doc.stats.rows; delete doc.half_kelly.replay; doc.arms.D.summary.end_capital = 1; return doc; })));
  const projection = reader().read();
  const byKey = Object.fromEntries(projection.blocks.map((block) => [block.key, block]));
  assert.equal(byKey.winrate.state, 'NOT_BACKTESTED');
  assert.match(byKey.winrate.reason, /stats\.rows/);
  assert.equal(byKey.kelly.state, 'NOT_BACKTESTED');
  assert.match(byKey.kelly.reason, /half_kelly\.replay/);
  assert.equal(byKey.account.state, 'NOT_BACKTESTED');
  assert.match(byKey.account.reason, /与权益序列末点不一致/);
  for (const key of ['period', 'stress', 'verdict']) assert.equal(byKey[key].state, 'AVAILABLE', key);
  assert.equal(byKey.winrate.data, null);
  assert.equal(projection.conclusion.label, '证据不足');
});

test('问题清单：来源必须是六类之一，每条二选一（立题或不立题理由），否则整张清单失败关闭', () => {
  imp(write(result((doc) => { doc.diagnosis_items[0].proposed_experiment = null; return doc; })));
  const projection = reader().read();
  assert.equal(projection.diagnosis.state, 'NOT_BACKTESTED');
  assert.match(projection.diagnosis.reason, /须二选一/);
  assert.deepEqual(projection.diagnosis.items, []);
  assert.deepEqual(Object.keys(k3.EXPERIMENTS), ['Q1', 'Q2', 'Q3', 'Q4']);
});

test('投影缓存：文件指纹或锁变化立即重建，未变时成功结果缓存 10 分钟，失败只缓存 15 秒', () => {
  let clock = 0;
  let builds = 0;
  const lock = { lock_hash: 'a', file_ref: '/nonexistent/RESULT.json' };
  let head = lock;
  const r = k3.createProjectionReader({
    now: () => clock, head: () => head,
    build: (value) => { builds += 1; return { state: value && value.ok ? 'LOCKED_VERIFIED' : 'INVALID' }; },
  });
  assert.equal(r.read().state, 'INVALID');
  clock += 14000; r.read();
  assert.equal(builds, 1);
  clock += 1000; r.read();
  assert.equal(builds, 2);
  head = { ...lock, lock_hash: 'b', ok: true };
  assert.equal(r.read().state, 'LOCKED_VERIFIED');
  assert.equal(builds, 3);
  clock += 599000; r.read();
  assert.equal(builds, 3);
  clock += 1000; r.read();
  assert.equal(builds, 4);
});

test('F1 缺场景的压力行：不让文件失败，不进「最大损失」，不计为已执行；有数字、缺原因、simulated 为真则该块无效', () => {
  const lock = imp(write());
  assert.equal(lock.verdict_state, 'INSUFFICIENT');
  const stress = (patch) => {
    fs.rmSync(k3.LEDGER(), { force: true });
    imp(mutate((doc) => patch(doc.stress.rows)));
    return k3.buildProjection(k3.headLock(k3.CASE_REF), { allowNonActual: true }).blocks.find((block) => block.key === 'stress');
  };
  // 缺场景行带了数字：数字不能用 0 或估计值补位
  const withNumber = stress((rows) => { rows[3].max_loss_usd = 0; });
  assert.equal(withNumber.state, 'NOT_BACKTESTED');
  assert.match(withNumber.reason, /缺场景／无效输入行的数字必须是 null/);
  assert.match(stress((rows) => { delete rows[3].missing_reason; }).reason, /stress\.rows\[3\]\.reason/);
  // 没有序列的行 simulated 写什么都不算模拟序列（研究会话的文件把缺场景行写成 simulated:true），页面按缺场景显示
  const tolerated = stress((rows) => { rows[3].simulated = true; });
  assert.equal(tolerated.state, 'AVAILABLE');
  assert.equal(tolerated.data.rows.find((row) => row.missing).simulated, false);
  // 只剩模拟与缺场景：最大损失写「尚无」，不拿模拟序列顶替
  const none = stress((rows) => { rows.splice(0, 2); });
  assert.equal(none.state, 'AVAILABLE');
  assert.equal(none.data.headline, null);
  assert.deepEqual(none.data.counts, { executed: 0, simulated: 1, missing: 1, invalid_input: 0 });
  // 最大损失取已执行行里最大的一行，模拟行再大也不进主数字
  const biggest = stress((rows) => { rows[0].max_loss_usd = 1500; });
  assert.equal(biggest.data.headline.scenario, 'FEES_15BPS');
  assert.equal(biggest.data.headline.max_loss_usd, 1500);
  // 非缺场景的熊市行仍要求标模拟；缺场景行不要求
  assert.throws(() => imp(mutate((doc) => { doc.stress.rows[2].simulated = false; })), /Q0_STRESS_SIMULATED_NOT_FLAGGED/);
});

// 研究会话实际封存的压力行形状（status / reason / in_headline），见 US_V5_M2_Q0_RESULT_V1 的 stress.rows。
const researchStress = () => [
  { scenario: 'BASELINE', label: '当前 D 参照', max_loss_usd: 480, longest_underwater_sessions: 194, recovered: false, end_capital: 4330, simulated: false },
  { scenario: 'SCAN_PHASE_PLUS_60MIN', label: '扫描相位 ±60 分钟', max_loss_usd: 1083.5614, longest_underwater_sessions: 589, recovered: false, end_capital: 2374, simulated: false },
  { scenario: 'WINDOW_2020_02_19_04_30', label: '区间重放 2020-02-19 → 04-30', status: 'INVALID_INPUT', simulated: false, max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null, max_drawdown: null, reason: 'no carrier passes the floors before 2020-05-29' },
  { scenario: 'EXTREME_BEAR_2008', label: '极端熊市 2008-09 → 2009-03：缺场景', status: 'MISSING_SCENARIO', simulated: true, max_loss_usd: null, longest_underwater_sessions: null, recovered: null, end_capital: null, reason: 'SMH, XLK daily 2007–2009 are in neither store' },
  { scenario: 'EXTREME_BEAR_2008_SPY_QQQ_SYNTH_SUPPLEMENT', label: '规则边界情景（补充）', status: 'SUPPLEMENTARY_NOT_IN_CONCLUSION', simulated: true, in_headline: false, max_loss_usd: 2000, longest_underwater_sessions: 100, recovered: false, end_capital: 900 },
];
const withResearchStress = (patch = () => {}) => mutate((doc) => {
  doc.stress = { rows: researchStress(), conclusion: 'The 2008 extreme bear is a missing scenario and the 2020 window is an invalid input, so the stress evaluation is incomplete' };
  patch(doc);
});
const stressOf = (file) => {
  fs.rmSync(k3.LEDGER(), { force: true });
  imp(file);
  return k3.buildProjection(k3.headLock(k3.CASE_REF), { allowNonActual: true }).blocks.find((block) => block.key === 'stress');
};

test('研究会话文件的压力行：缺场景和无效输入各写原因，补充行和模拟行不进最大损失，整块不变空', () => {
  const stress = stressOf(withResearchStress());
  assert.equal(stress.state, 'AVAILABLE', stress.reason);
  const byScenario = Object.fromEntries(stress.data.rows.map((row) => [row.scenario, row]));
  assert.equal(byScenario.EXTREME_BEAR_2008.kind, 'MISSING');
  assert.equal(byScenario.EXTREME_BEAR_2008.kind_label, '缺场景');
  assert.equal(byScenario.EXTREME_BEAR_2008.simulated, false, '没有序列的行不算模拟序列');
  assert.equal(byScenario.WINDOW_2020_02_19_04_30.kind, 'INVALID_INPUT');
  assert.equal(byScenario.WINDOW_2020_02_19_04_30.kind_label, '无效输入');
  assert.match(byScenario.WINDOW_2020_02_19_04_30.reason, /no carrier passes the floors/);
  assert.equal(byScenario.EXTREME_BEAR_2008_SPY_QQQ_SYNTH_SUPPLEMENT.kind, 'SUPPLEMENTARY');
  assert.equal(byScenario.EXTREME_BEAR_2008_SPY_QQQ_SYNTH_SUPPLEMENT.in_headline, false);
  assert.deepEqual(stress.data.headline, { scenario: 'SCAN_PHASE_PLUS_60MIN', label: '扫描相位 ±60 分钟', max_loss_usd: 1083.5614 });
  assert.deepEqual(stress.data.counts, { executed: 2, simulated: 1, missing: 1, invalid_input: 1 });
  assert.equal(stress.data.evaluation.complete, false);
  assert.match(stress.data.evaluation.text, /缺场景 1 个、无效输入 1 个/);
  assert.match(stress.data.evaluation.original, /stress evaluation is incomplete/);
});

test('压力行的状态不自洽时只让压力块无效：未知状态、补充行没标 in_headline:false、无效输入缺原因、带数字', () => {
  assert.match(stressOf(withResearchStress((doc) => { doc.stress.rows[0].status = 'WEIRD'; })).reason, /status=WEIRD 不认识/);
  assert.match(stressOf(withResearchStress((doc) => { doc.stress.rows[4].in_headline = true; })).reason, /补充行必须 simulated:true 且 in_headline:false/);
  assert.throws(() => imp(withResearchStress((doc) => { doc.stress.rows[4].simulated = false; })), /Q0_STRESS_SIMULATED_NOT_FLAGGED/); // 熊市补充行没标模拟：整文件拒绝
  assert.match(stressOf(withResearchStress((doc) => { delete doc.stress.rows[2].reason; })).reason, /stress\.rows\[2\]\.reason/);
  assert.match(stressOf(withResearchStress((doc) => { doc.stress.rows[3].end_capital = 0; })).reason, /数字必须是 null/);
  // 有「中文原因」时优先显示中文
  const zh = stressOf(withResearchStress((doc) => { doc.stress.rows[3].reason_zh = '2007–2009 行业 ETF 日线在 Mac 与 HK 均无'; }));
  assert.equal(zh.data.rows.find((row) => row.scenario === 'EXTREME_BEAR_2008').reason, '2007–2009 行业 ETF 日线在 Mac 与 HK 均无');
  // 没有缺场景和无效输入时压力评价完整，不写「不完整」
  const complete = stressOf(withResearchStress((doc) => { doc.stress.rows.splice(2, 2); delete doc.stress.conclusion; }));
  assert.equal(complete.data.evaluation.complete, true);
  assert.equal(complete.data.evaluation.text, null);
});

test('120 分钟扫描下 −60 与 +60 是同一组时刻：只有 +60 一行时合并显示并说明；两行都在时照常分开', () => {
  const merged = (file) => { fs.rmSync(k3.LEDGER(), { force: true }); imp(file); return k3.buildProjection(k3.headLock(k3.CASE_REF), { allowNonActual: true }).blocks.find((block) => block.key === 'winrate').data; };
  const only = merged(write());
  assert.equal(only.notes.length, 1);
  assert.match(only.notes[0], /提前 60 分钟与推后 60 分钟落在同一组时刻/);
  assert.ok(only.rows.filter((row) => row.phase === 'PLUS_60MIN').every((row) => row.phase_label === '相位 ±60 分钟'));
  const both = merged(mutate((doc) => { doc.stats.rows.push({ ...doc.stats.rows[3], phase: 'MINUS_60MIN' }); }));
  assert.deepEqual(both.notes, []);
  assert.deepEqual([...new Set(both.rows.map((row) => row.phase_label))], ['生产相位', '相位 +60 分钟', '相位 −60 分钟']);
});

test('近似引擎：结论的最大限制和周期块用文件自带的中文说明，不显示英文代码', () => {
  imp(write(result((doc) => {
    doc.verdict.engine_approximation = { flag: true, missing: ['KLINE_TIMING_V1', 'SCAN_SCHEDULE'] };
    doc.verdict.label = '研究引擎近似的当前 D（缺：K 线择时 v1、扫描时刻）';
    doc.verdict.reason_codes = ['ENGINE_APPROXIMATION', 'CI_G_STRADDLES_ZERO', 'STRESS_SCENARIO_MISSING'];
    return doc;
  })));
  const projection = k3.buildProjection(k3.headLock(k3.CASE_REF), { allowNonActual: true });
  assert.equal(projection.conclusion.biggest_limit, '使用的是研究引擎近似的当前 D（缺：K 线择时 v1、扫描时刻），结论最高只能是证据不足。');
  assert.equal(projection.blocks[0].data.engine.label, '研究引擎近似的当前 D（缺：K 线择时 v1、扫描时刻）');
  assert.deepEqual(projection.blocks.find((block) => block.key === 'verdict').data.reasons.map((reason) => reason.text),
    ['研究引擎只是当前 D 的近似', '年化对数增长区间跨过 0', '压力场景有缺（缺场景按不足处理）']);
});

const REAL = '/Users/kaylame/KaylaProject/research-data/us_v5_m2_q0_a1/result/US_V5_M2_Q0_RESULT_V1.json';
test('研究会话实际封存的 Q0 文件：六块全部可读、问题清单可读（本机有该文件时才跑，只读，不导入）', { skip: !fs.existsSync(REAL) }, () => {
  const sealed = k3.readSealed(REAL);
  const projection = k3.project(sealed, { result_id: `Q0-${sealed.sha256.slice(0, 16)}`, locked_at: 'test', locked_by: 'test', inputs_digest: 'x', engine_digest: 'x' });
  assert.deepEqual(projection.blocks.map((block) => `${block.key}:${block.state}`),
    ['period:AVAILABLE', 'account:AVAILABLE', 'winrate:AVAILABLE', 'stress:AVAILABLE', 'kelly:AVAILABLE', 'verdict:AVAILABLE']);
  assert.equal(projection.diagnosis.state, 'AVAILABLE');
  const stress = projection.blocks.find((block) => block.key === 'stress').data;
  assert.ok(stress.rows.some((row) => row.kind === 'MISSING') && stress.rows.some((row) => row.kind === 'INVALID_INPUT'));
  assert.ok(stress.headline && !stress.rows.find((row) => row.scenario === stress.headline.scenario).simulated);
});
