'use strict';
/**
 * 挖掘轮次、累计 N、留出段保管、AI_MINED_CANDIDATE、挖掘谱系的晋级（研究框架修订 2026-11-16，签字 fd22876f / 39f8c17c，§3.3、§3.4、§2.4；
 * §8.3 第 8、9、10 条；协调会话 2026-11-17 的补充：PROMOTION_MINED_REQUIRES_RACE_AND_PAPER）。先红后绿，全部是合成数据。
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const AUTH = 'TEST_MINING_ROUNDS_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
const trials = require('../services/trial-ledger');
const rounds = require('../services/mining-rounds');
const vault = require('../services/holdout-vault');
const mechGate = require('../services/research-mechanism-register/gate');
const experiments = require('../services/experiment-orchestrator');
const shadow = require('../services/shadow-control');
const controlPlane = require('../services/strategy-control-plane');
const { setupExperiment } = require('./_fixture');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
let spaceN = 0;
const space = () => { spaceN += 1; return { space_ref: `MS-SYNTH-${spaceN}`, sha256: sha(`space-${spaceN}`), freeze: { path: `synthetic/MS_${spaceN}_FREEZE.md`, sha256: sha(`freeze-${spaceN}`) } }; };
const LLM = { mode: 'AI_MINED_LLM', model: 'synthetic-model', model_knowledge_cutoff: '2026-06-30' };
const HOLDOUT = { from: '2026-07-01', to: '2026-10-31' };
const open = (market, openedAt, patch = {}) => rounds.openRound({ market, space: space(), holding_periods: [5, 10], generator: LLM, holdout: HOLDOUT, openedAt, ...patch });
const cand = (r, i, h = 5, extra = {}) => {
  const f = `rank(ts_mean(close,${i}))`;
  return rounds.recordCandidate(r.round_id, { candidate_id: `C${String(i).padStart(3, '0')}`, formula_canonical: f, formula_sha256: sha(f), holding_period: h, mining_score: i / 1000, ...extra },
    { registeredBy: AUTH, registeredAt: r.opened_at });
};

test('试验台账：MINED_CANDIDATE 只在 SIGNAL 阶段、族是 MINE:<市场>:H<持有期>、要写挖掘块；计入 N；别的角色不能写挖掘块', () => {
  const base = { family_id: 'MINE:CN_A:H5', market: 'CN_A', study_ref: 'MR-X', config_label: 'C1', stage: 'SIGNAL', role: 'MINED_CANDIDATE', k2_sha256: 'a'.repeat(64),
    rule_config: { formula: 'rank(close)' }, mining: { round_id: 'MR-X', candidate_id: 'C1', space_sha256: 'b'.repeat(64), formula_sha256: sha('rank(close)'), generator: 'AI_MINED_GP' } };
  const reg = (patch) => trials.register([{ ...base, ...patch }], { registeredBy: AUTH, dryRun: true });
  assert.throws(() => reg({ stage: 'BOOK' }), code(/MINED_CANDIDATE_STAGE_SIGNAL/));
  assert.throws(() => reg({ family_id: 'MINE:US:H5' }), code(/MINED_CANDIDATE_FAMILY/));
  assert.throws(() => reg({ family_id: 'CN_A_SELECTION' }), code(/MINED_CANDIDATE_FAMILY/));
  assert.throws(() => reg({ mining: { ...base.mining, generator: 'HUMAN' } }), code(/MINED_CANDIDATE_NEEDS_MINING/));
  assert.throws(() => reg({ role: 'SIGNAL_TEST' }), code(/MINING_ONLY_FOR_MINED_CANDIDATE/));
  const [row] = reg({});
  assert.deepEqual([row.role, row.stage, row.mining.candidate_id], ['MINED_CANDIDATE', 'SIGNAL', 'C1']);
  assert.ok(trials.COUNTS_IN_N.has('MINED_CANDIDATE'));
});

test('轮次（§8.3 第 8 条）：第 201 个不算分、本轮停止；同市场同月第 3 轮被拒；N 按族跨轮累计、从不清零；去重被拒与正交化的版本都计入 N', () => {
  const r1 = open('CN_A', '2026-12-01T02:00:00Z', { cap: 200 });
  for (let i = 1; i <= 200; i += 1) cand(r1, i);
  assert.equal(rounds.roundHead(r1.round_id).status, 'CAP_REACHED');
  assert.throws(() => cand(r1, 201), code(/MINE_ROUND_CAP_REACHED/));
  assert.equal(rounds.roundHead(r1.round_id).candidates_scored, 200);
  assert.equal(rounds.familyN('CN_A', 5), 200);
  assert.throws(() => open('CN_A', '2026-12-02T02:00:00Z'), code(/MINE_ROUND_ALREADY_OPEN/));
  rounds.closeRound(r1.round_id, { gmine_passes: 1, closedAt: '2026-12-05T02:00:00Z' });
  const r2 = open('CN_A', '2026-12-10T02:00:00Z');
  cand(r2, 1001); // 去重被拒的候选：一样算过分，一样记
  cand(r2, 1002, 5, { rule_config: { formula: 'rank(ts_mean(close,1002))', orthogonalized_against: ['F_EXISTING'] } }); // 正交化版本
  cand(r2, 1003, 10);
  rounds.closeRound(r2.round_id, { gmine_passes: 0 });
  assert.equal(rounds.familyN('CN_A', 5), 202);
  assert.equal(rounds.familyN('CN_A', 10), 1);
  assert.throws(() => open('CN_A', '2026-12-20T02:00:00Z'), code(/MINE_ROUND_MONTHLY_CAP:CN_A:2026-12/));
  assert.equal(open('CN_A', '2027-01-03T02:00:00Z').month, '2027-01'); // 下个月照开
  assert.equal(open('US', '2026-12-20T02:00:00Z').market, 'US'); // 别的市场不受影响
});

test('暂停：某市场连续 3 轮没有候选过 G-MINE → 暂停；用那几轮用过的空间再开被拒，换一份新的冻结空间才能再开；暂停期间 N 照旧累计', () => {
  const months = ['2027-03', '2027-04', '2027-05'];
  const used = [];
  for (const m of months) {
    const r = open('CRYPTO', `${m}-02T02:00:00Z`);
    used.push(r.space);
    cand(r, 1, 5); rounds.closeRound(r.round_id, { gmine_passes: 0 });
  }
  const p = rounds.pauseState('CRYPTO');
  assert.equal(p.paused, true);
  assert.throws(() => rounds.openRound({ market: 'CRYPTO', space: used[2], holding_periods: [5], generator: LLM, holdout: HOLDOUT, openedAt: '2027-06-02T02:00:00Z' }), code(/MINE_MARKET_PAUSED/));
  assert.equal(rounds.familyN('CRYPTO', 5), 3); // 三轮各一个（空间不同，配置不同）
  const r = open('CRYPTO', '2027-06-02T02:00:00Z');
  assert.equal(r.resumed_after_pause.length, 3);
  cand(r, 1, 5);
  assert.equal(rounds.familyN('CRYPTO', 5), 4); // 暂停前后 N 照旧累计，不清零
});

test('留出段：起点不晚于大模型知识截止日 → 轮次清单被拒；第一轮之后不能挪；每轮只封一次、只开一次，每个候选只读一次，开了之后不能再记候选', () => {
  assert.throws(() => open('US', '2027-02-02T02:00:00Z', { holdout: { from: '2026-06-30', to: '2026-10-31' } }), code(/MINE_ROUND_HOLDOUT_BEFORE_CUTOFF/));
  assert.throws(() => open('US', '2027-02-02T02:00:00Z', { holdout: { from: '2026-08-01', to: '2026-10-31' } }), code(/MINE_ROUND_HOLDOUT_MOVED/));
  const prior = rounds.roundsOf('US').at(-1);
  rounds.closeRound(prior.round_id, { gmine_passes: 0 });
  const r = open('US', '2027-02-02T02:00:00Z', { generator: { mode: 'AI_MINED_GP', gp_seed: 20261116 } });
  cand(r, 1); cand(r, 2); cand(r, 3);
  const data = { round_id: r.round_id, segment: HOLDOUT, data_ref: 'lane:/holdout/US/2026-07-01..2026-10-31', data_sha256: sha('holdout-bytes'), sealedBy: 'VAULT' };
  assert.throws(() => vault.open({ round_id: r.round_id, candidate_ids: ['C001'], openedBy: 'SELECTOR' }), code(/MINE_HOLDOUT_NOT_SEALED/));
  assert.throws(() => vault.seal({ ...data, segment: { from: '2026-07-01', to: '2026-11-30' } }), code(/MINE_HOLDOUT_SEGMENT_MISMATCH/));
  vault.seal(data);
  assert.throws(() => vault.seal(data), code(/MINE_HOLDOUT_ALREADY_SEALED/));
  assert.throws(() => vault.open({ round_id: r.round_id, candidate_ids: ['C001', 'C001'], openedBy: 'SELECTOR' }), code(/MINE_HOLDOUT_CANDIDATE_READ_TWICE/));
  assert.throws(() => vault.open({ round_id: r.round_id, candidate_ids: ['C999'], openedBy: 'SELECTOR' }), code(/MINE_HOLDOUT_CANDIDATE_UNKNOWN/));
  const got = vault.open({ round_id: r.round_id, candidate_ids: ['C001', 'C003'], openedBy: 'SELECTOR' });
  assert.deepEqual([got.data_sha256, got.candidate_ids], [data.data_sha256, ['C001', 'C003']]);
  assert.equal(vault.openLog(r.round_id).length, 1);
  assert.throws(() => vault.open({ round_id: r.round_id, candidate_ids: ['C002'], openedBy: 'SELECTOR' }), code(/MINE_HOLDOUT_ALREADY_OPENED/));
  assert.throws(() => cand(r, 4), code(/MINE_ROUND_NOT_OPEN/));
  assert.equal(rounds.roundHead(r.round_id).status, 'SCORING');
  rounds.closeRound(r.round_id, { gmine_passes: 1 });
});

test('生成方的接口（§8.3 第 9 条）：只有搜索空间、挖掘段分数与已试公式；读不到验证折、留出段、赛马、模拟盘的结果，也读不到 G-MINE 过没过', () => {
  const r = rounds.roundsOf('CN_A').at(-1);
  cand(r, 7001); cand(r, 7002);
  const view = rounds.generatorView(r.round_id);
  assert.deepEqual(Object.keys(view).sort(), ['holding_periods', 'market', 'mining_scores', 'round_id', 'space', 'tried_formulas']);
  assert.deepEqual(Object.keys(view.mining_scores[0]).sort(), ['candidate_id', 'formula', 'mining_segment_score']);
  assert.ok(view.tried_formulas.includes('rank(ts_mean(close,1))')); // 本市场以前各轮试过的公式也在
  const text = JSON.stringify(view);
  for (const banned of ['holdout', 'validation', 'gmine', 'race', 'paper', 'data_sha256', 'pass']) assert.equal(text.toLowerCase().includes(banned), false, banned);
  assert.equal(typeof vault.open, 'function'); // 留出段只在保管服务里，生成方的视图里没有它的任何东西
});

const LIB = { factors: [
  { factor_id: 'F_MINED_1', origin: 'AI_MINED_LLM', mining: { round_id: 'MR-CN_A-2026-12-aaaa', candidate_id: 'C042' } },
  { factor_id: 'F_HUMAN_1', origin: 'HUMAN', mining: null },
] };

test('AI 输入（§8.3 第 10 条）：测挖掘因子的 K2 没写 AI_MINED_CANDIDATE → 拒绝；写了要带候选编号与轮次，且第 4 行写出这两个编号；不测挖掘因子的题照旧', () => {
  const ai = (entry, line4) => mechGate.internals.checkAiInputs({ id: 'T', ...entry }, line4, () => LIB);
  const mined = { category: 'AI_MINED_CANDIDATE', ref: 'factor:F_MINED_1', desc_zh: '挖掘候选', candidate_id: 'C042', round_id: 'MR-CN_A-2026-12-aaaa' };
  assert.throws(() => ai({ factor_refs: ['F_MINED_1'], ai_inputs: [] }, '无'), code(/AI_ROLE_MINED_CANDIDATE_MISSING:T:F_MINED_1:C042@MR-CN_A-2026-12-aaaa/));
  assert.throws(() => ai({ factor_refs: ['F_MINED_1'], ai_inputs: [{ ...mined, candidate_id: 'C043' }] }, 'AI_MINED_CANDIDATE C043 MR-CN_A-2026-12-aaaa'), code(/AI_ROLE_MINED_CANDIDATE_MISSING/));
  assert.throws(() => ai({ factor_refs: ['F_MINED_1'], ai_inputs: [{ ...mined, round_id: undefined }] }, 'AI_MINED_CANDIDATE C042'), code(/AI_ROLE_INPUT_INVALID/));
  assert.throws(() => ai({ factor_refs: ['F_MINED_1'], ai_inputs: [mined] }, 'AI_MINED_CANDIDATE（候选 C042）'), code(/AI_ROLE_K2_LINE_MISMATCH/));
  assert.equal(ai({ factor_refs: ['F_MINED_1'], ai_inputs: [mined] }, 'AI_MINED_CANDIDATE：候选 C042，轮次 MR-CN_A-2026-12-aaaa'), 1);
  assert.throws(() => ai({ factor_refs: ['F_NOPE'], ai_inputs: [] }, '无'), code(/AI_ROLE_FACTOR_UNKNOWN/));
  assert.equal(ai({ factor_refs: ['F_HUMAN_1'], ai_inputs: [] }, '无'), 0);
  assert.equal(ai({ ai_inputs: [{ category: 'EXTRACTED_FACT', ref: 'r', desc_zh: 'd' }] }, 'EXTRACTED_FACT 一项'), 1);
  assert.deepEqual([...mechGate.AI_CATEGORIES], ['EXTRACTED_FACT', 'AI_MINED_CANDIDATE']);
});

test('晋级：试验谱系里有 MINED_CANDIDATE 的候选，没有赛马清单引用与模拟盘登记 → PROMOTION_MINED_REQUIRES_RACE_AND_PAPER；没有挖掘谱系的照旧（逐字节）', async () => {
  const fx = await setupExperiment({ min_forward_evidence: 2 });
  await experiments.runBacktest(fx.exp.experiment_id);
  experiments.recordResult(fx.exp.experiment_id, { verdict: 'CHALLENGER_WINS' });
  const run = shadow.openShadowRun({ champion_ref: fx.champRef, challenger_ref: fx.chalRef, race_ref: 'RACE-T', experiment_ref: fx.exp.experiment_id });
  shadow.recordObservation(run.shadow_id, { key: 'd1', business_date: 'd1', champion_output: [], challenger_output: [] });
  shadow.recordObservation(run.shadow_id, { key: 'd2', business_date: 'd2', champion_output: [], challenger_output: ['600001.SH'] });
  const base = { release_candidate_ref: fx.chalRef, market: 'CN_A', experiment_ref: fx.exp.experiment_id, research_evidence_refs: ['ev1'], shadow_forward_refs: [run.shadow_id], rollback_ref: fx.champRef };
  const minedTrial = trials.heads().get([...trials.heads().values()].find((t) => t.role === 'MINED_CANDIDATE').trial_id);
  // 一个 VERDICT_ARM 试验，source_refs 指回挖掘候选（谱系隔一层）
  const [arm] = trials.register([{ family_id: 'CN_A_SEL_MINED_K2', market: 'CN_A', study_ref: 'K2-MINED', config_label: 'ARM', stage: 'BOOK', role: 'VERDICT_ARM', k2_sha256: 'c'.repeat(64),
    rule_config: { factor: 'F_MINED_1' }, source_refs: [minedTrial.trial_id], unknown: { sr_monthly_delta: 'synthetic' } }], { registeredBy: AUTH });
  const [human] = trials.register([{ family_id: 'CN_A_SEL_HUMAN', market: 'CN_A', study_ref: 'K2-HUMAN', config_label: 'ARM', stage: 'SIGNAL', role: 'SIGNAL_TEST', k2_sha256: 'd'.repeat(64),
    rule_config: { factor: 'F_HUMAN_1' } }], { registeredBy: AUTH });
  await assert.rejects(controlPlane.createPromotionCandidate({ ...base, trial_refs: [minedTrial.trial_id] }), code(/PROMOTION_MINED_REQUIRES_RACE_AND_PAPER/));
  await assert.rejects(controlPlane.createPromotionCandidate({ ...base, trial_refs: [arm.trial_id] }), code(new RegExp(`PROMOTION_MINED_REQUIRES_RACE_AND_PAPER:${minedTrial.trial_id}`)));
  await assert.rejects(controlPlane.createPromotionCandidate({ ...base, trial_refs: [arm.trial_id], race_manifest_ref: { race_id: 'X', manifest_sha256: 'e'.repeat(64) } }), code(/PROMOTION_MINED_REQUIRES_RACE_AND_PAPER/));
  // 两样都带了：门照常核（这里赛马不存在 → 赛马路径自己的拒绝）
  await assert.rejects(controlPlane.createPromotionCandidate({ ...base, trial_refs: [arm.trial_id], race_manifest_ref: { race_id: 'X', manifest_sha256: 'e'.repeat(64) }, paper_validation_refs: ['PV-X'] }),
    code(/PROMOTION_RACE_NOT_CLOSED/));
  await assert.rejects(controlPlane.createPromotionCandidate({ ...base, trial_refs: ['TRL-0000000000000000'] }), code(/PROMOTION_TRIAL_REF_UNKNOWN/));
  // 没有挖掘谱系：与不带 trial_refs 的候选逐字节相同（createdAt 除外）
  const plain = await controlPlane.createPromotionCandidate({ ...base });
  const withHuman = await controlPlane.createPromotionCandidate({ ...base, trial_refs: [human.trial_id] });
  const strip = ({ createdAt: _c, ...rest }) => JSON.stringify(rest);
  assert.equal(strip(withHuman), strip(plain));
  assert.ok(dataRoot);
});
