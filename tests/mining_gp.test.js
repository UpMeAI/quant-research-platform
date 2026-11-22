'use strict';
/**
 * GP 生成器 AI_MINED_GP 与挖掘段打分（RF1116 P2 规格 §2、§4 第 1、2 条；★R (a)：一轮只用一种生成方式；大模型这一步没开）。先红后绿，合成数据。
 *   - 确定性：同种子、同空间、同挖掘段数据 → 逐字节相同的公式串；换种子不同；同一份生成方视图调两次给同一批；
 *   - 只产出合法的 DSL（过 dsl.parse、在冻结空间里、≤ 20 记号、≤ 5 层）；
 *   - 适应度只用挖掘段：中性化后的 rank IC 均值减长度惩罚；喂进验证折或留出段的面板就抛错；
 *   - 只看 generatorView：视图里出现验证折、留出段、选择、G-MINE 之类的字段就拒绝；模块不引用数据、打分、留出段、门，也不引用任何网络模块；
 *   - 大模型生成方（RF1116 LLM_GEN，2026-11-18）已接上：assertGeneratorEnabled 认它；generatorFor 没有交换目录与计量就拒（见 mining_llm_generator.test.js）。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { makeMiningDataFixture } = require('./_mining_data_fixture');
const adapter = require('../services/mining-sandbox/data-adapter');
const scoring = require('../services/mining-sandbox/scoring');
const gp = require('../services/mining-sandbox/gp');
const generators = require('../services/mining-sandbox/generators');
const dsl = require('../services/mining-sandbox/dsl');
const { dslSpaceOf } = require('../services/mining-sandbox/space');

const ROOT = path.join(__dirname, '..');
const SPACE = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json'), 'utf8'));
const DSL_SPACE = dslSpaceOf(SPACE);
const fx = makeMiningDataFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-mining-gp-')));
const sources = () => [adapter.csvDirSource(fx.dirs.lane, { mode: 'HISTORY', label: 'lane' }), adapter.csvDirSource(fx.dirs.tail, { mode: 'LIVE', label: 'tail' })];
const MINING = adapter.buildPanel({ sources: sources(), space: SPACE, segment: 'MINING', from: '2020-06-01', to: '2023-12-29' });
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 不经台账的一轮：生成 → 去重 → 挖掘段打分 → 进视图（台账那一套在执行器里，这里只验生成方）。 */
function offlineRound(seed, attempts) {
  const g = gp.createGp({ seed, space: DSL_SPACE, holdingPeriod: 5 });
  const view = { round_id: 'MR-OFFLINE', market: 'CN_A', space: { space_ref: SPACE.space_ref, sha256: 'f'.repeat(64) }, holding_periods: [5], mining_scores: [], tried_formulas: [] };
  const out = [];
  while (out.length < attempts) {
    const batch = g.nextBatch(Object.freeze({ ...view, mining_scores: [...view.mining_scores], tried_formulas: [...view.tried_formulas] }), { n: Math.min(gp.GP_PARAMS.batch_size, attempts - out.length) });
    assert.ok(batch.length >= 1);
    for (const text of batch) {
      const parsed = dsl.parse(text, DSL_SPACE);
      const dup = view.tried_formulas.includes(parsed.canonical);
      const score = dup ? null : scoring.miningScore(parsed, MINING, { holding_period: 5, neutralization: 'LINEAR_RAW_V1' }).score;
      out.push(text);
      view.mining_scores.push({ candidate_id: `MR-OFFLINE:A${String(out.length).padStart(3, '0')}`, formula: parsed.canonical, mining_segment_score: score });
      if (!dup) view.tried_formulas = [...new Set([...view.tried_formulas, parsed.canonical])].sort();
    }
  }
  return out;
}

test('GP 确定性（§4 第 1 条）：同种子同输入两次逐字节相同；换种子不同；同一视图调两次同一批', () => {
  const a = offlineRound(11, 60); const b = offlineRound(11, 60); const c = offlineRound(12, 60);
  assert.equal(sha(a.join('\n')), sha(b.join('\n')));
  assert.notEqual(sha(a.join('\n')), sha(c.join('\n')));
  const g = gp.createGp({ seed: 11, space: DSL_SPACE, holdingPeriod: 5 });
  const v = Object.freeze({ round_id: 'MR-X', market: 'CN_A', space: {}, holding_periods: [5], mining_scores: [], tried_formulas: [] });
  assert.deepEqual(g.nextBatch(v, { n: 10 }), g.nextBatch(v, { n: 10 }));
  assert.equal(new Set(a).size > 40, true, 'mostly new formulas');
});

test('GP 只产出合法的 DSL（§4 第 2 条）：过 dsl.parse、只用冻结空间里的读数与算子、≤ 20 记号、≤ 5 层；进化过的批也一样', () => {
  const all = [];
  for (let seed = 1; seed <= 8; seed += 1) {
    const g = gp.createGp({ seed, space: DSL_SPACE, holdingPeriod: 5 });
    all.push(...g.nextBatch(Object.freeze({ round_id: 'MR-X', market: 'CN_A', space: {}, holding_periods: [5], mining_scores: [], tried_formulas: [] }), { n: 40 }));
  }
  all.push(...offlineRound(3, 90).slice(40));
  for (const text of all) {
    const p = dsl.parse(text, DSL_SPACE);
    assert.ok(p.tokens <= 20 && p.depth <= 5 && p.depth >= 1, text);
    assert.ok(p.readings.every((r) => SPACE.readings.some((x) => x.name === r)), text);
    assert.equal(p.canonical, text, 'emitted in canonical form');
  }
  const ops = new Set(all.flatMap((t) => dsl.parse(t, DSL_SPACE).operators));
  assert.ok(['rank', 'ts_mean', 'ts_corr', 'neutralize_industry', 'div'].every((o) => ops.has(o)), [...ops].join(','));
});

test('适应度只用挖掘段（§4 第 2 条）：中性化后的 rank IC 均值减长度惩罚；验证折或留出段的面板一喂就抛错', () => {
  const parsed = dsl.parse('rank(-ret_1d)', DSL_SPACE);
  const s = scoring.miningScore(parsed, MINING, { holding_period: 5, neutralization: 'LINEAR_RAW_V1' });
  assert.equal(typeof s.score, 'number');
  assert.ok(s.ic_days > 500, `${s.ic_days}`);
  assert.deepEqual(s.neutralization, { industry: 'APPLIED', size: 'APPLIED', version: 'LINEAR_RAW_V1', pre_transform: 'NONE', size_regressor: 'LOG_TOTAL_MV' });
  assert.ok(s.score > 0, `planted reversal shows up as positive IC (${s.score})`);
  const tokens = parsed.tokens;
  assert.equal(gp.fitnessOf({ mining_segment_score: s.score, tokens }), s.score - gp.GP_PARAMS.length_penalty_per_token * tokens);
  assert.ok(gp.fitnessOf({ mining_segment_score: 0.05, tokens: 12 }) < gp.fitnessOf({ mining_segment_score: 0.05, tokens: 4 }));
  assert.equal(gp.fitnessOf({ mining_segment_score: null, tokens: 4 }), null);

  const val = adapter.buildPanel({ sources: sources(), space: SPACE, segment: 'VALIDATION', from: '2023-10-02', to: '2024-03-29' });
  assert.throws(() => scoring.miningScore(parsed, val, { holding_period: 5, neutralization: 'LINEAR_RAW_V1' }), code(/MINE_SCORE_NOT_MINING_SEGMENT/));
  const lying = { ...val, segment: 'MINING' };
  assert.throws(() => scoring.miningScore(parsed, lying, { holding_period: 5, neutralization: 'LINEAR_RAW_V1' }), code(/MINE_SCORE_NOT_MINING_SEGMENT/));
  const ho = { ...MINING, segment: 'HOLDOUT' };
  assert.throws(() => scoring.miningScore(parsed, ho, { holding_period: 5, neutralization: 'LINEAR_RAW_V1' }), code(/MINE_SCORE_NOT_MINING_SEGMENT/));
  assert.throws(() => scoring.miningScore(parsed, { ...MINING, industry: undefined }, { holding_period: 5, neutralization: 'LINEAR_RAW_V1' }), code(/MINE_EVAL_INDUSTRY_MISSING/));
  const neu = scoring.neutralizedValues(parsed, MINING, { neutralization: 'LINEAR_RAW_V1' });
  const n01 = MINING.codes.indexOf('N01.SZ'); const early = MINING.dates.indexOf(fx.calendar[fx.calendar.indexOf('2021-03-01') + 30]);
  assert.equal(MINING.universe[early][n01], false);
  assert.ok(Number.isFinite(scoring.neutralizedValues(parsed, { ...MINING, universe: MINING.universe.map((r) => r.map(() => true)) }, { neutralization: 'LINEAR_RAW_V1' }).values[early][n01]));
  assert.ok(Number.isNaN(neu.values[early][n01]), 'names outside the universe are not neutralized or scored');
});

test('打分的标签与股票池：开盘到开盘的前推收益只在面板之内；不在池里的名字不进 IC', () => {
  const fwd = scoring.forwardReturns(MINING, 5);
  const T = MINING.dates.length;
  for (let t = T - 5; t < T; t += 1) assert.ok(fwd[t].every(Number.isNaN), 'no label past the panel end');
  const j = MINING.codes.indexOf('S01.SH');
  const ex = MINING.labels.exec_open;
  assert.equal(fwd[100][j], ex[105][j] / ex[100][j] - 1);
  assert.ok(MINING.universe.some((row) => row.some((u) => !u)), 'the fixture has names outside the universe');
  const values = MINING.dates.map((_, t) => MINING.codes.map((c, k) => (MINING.universe[t][k] ? fwd[t][k] : 1e6 * k)));
  const ic = scoring.dailyRankIc(values, fwd, MINING.universe);
  const finite = ic.filter(Number.isFinite);
  assert.ok(finite.length > 500 && finite.every((x) => Math.abs(x - 1) < 1e-9), 'masked names do not enter the IC');
});

test('只看 generatorView：视图带验证折、留出段、选择或 G-MINE 字段就拒绝；模块不引用数据、打分、留出段、门或任何网络模块', () => {
  const g = gp.createGp({ seed: 5, space: DSL_SPACE, holdingPeriod: 5 });
  const v = { round_id: 'MR-X', market: 'CN_A', space: {}, holding_periods: [5], mining_scores: [], tried_formulas: [] };
  for (const k of ['validation', 'holdout', 'selection', 'gmine_passes', 'validation_scores', 'race', 'paper']) {
    assert.throws(() => g.nextBatch({ ...v, [k]: [] }, { n: 3 }), code(/MINE_GP_VIEW_FIELD_NOT_ALLOWED/), k);
  }
  assert.throws(() => g.nextBatch({ ...v, mining_scores: [{ candidate_id: 'x', formula: 'rank(pb)', mining_segment_score: 0.1, validation_ic: 0.2 }] }, { n: 3 }),
    code(/MINE_GP_VIEW_FIELD_NOT_ALLOWED/));
  const src = fs.readFileSync(path.join(ROOT, 'services/mining-sandbox/gp/index.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['../dsl', 'crypto']);
  for (const f of ['services/mining-sandbox/gp/index.js', 'services/mining-sandbox/scoring/index.js', 'services/mining-sandbox/data-adapter/index.js', 'services/mining-sandbox/data-adapter/csv.js',
    'services/mining-sandbox/generators/index.js', 'services/mining-sandbox/segments.js']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of ['http', 'https', 'net', 'tls', 'dgram', 'dns', 'child_process', 'worker_threads']) assert.ok(!new RegExp(`require\\(\\s*['"](node:)?${m}['"]`).test(s), `${f} requires ${m}`);
    assert.ok(!/\bfetch\s*\(/.test(s), `${f} calls fetch`);
  }
});

test('生成方：GP 要整数种子；大模型认得、但没有交换目录与计量就不建；不认识的方式拒绝', () => {
  assert.throws(() => gp.createGp({ seed: 1.5, space: DSL_SPACE, holdingPeriod: 5 }), code(/MINE_GP_SEED_REQUIRED/));
  assert.throws(() => gp.createGp({ seed: 1, space: DSL_SPACE, holdingPeriod: 0 }), code(/MINE_GP_HOLDING_PERIOD/));
  const g = generators.generatorFor({ mode: 'AI_MINED_GP', gp_seed: 9 }, { space: DSL_SPACE, holdingPeriod: 5 });
  assert.equal(g.mode, 'AI_MINED_GP');
  assert.equal(g.seed, 9);
  assert.deepEqual(g.params, gp.GP_PARAMS);
  assert.throws(() => generators.generatorFor({ mode: 'AI_MINED_LLM', model: 'deepseek-v4-pro', model_knowledge_cutoff: '2026-08-13' }, { space: DSL_SPACE, holdingPeriod: 5 }),
    code(/MINE_LLM_GENERATOR_OPTIONS_MISSING/));
  assert.equal(generators.assertGeneratorEnabled({ mode: 'AI_MINED_LLM' }), 'AI_MINED_LLM');
  assert.deepEqual(generators.ENABLED, { AI_MINED_GP: true, AI_MINED_LLM: true });
  assert.throws(() => generators.generatorFor({ mode: 'HUMAN' }, { space: DSL_SPACE, holdingPeriod: 5 }), code(/MINE_GENERATOR_UNKNOWN/));
  assert.ok(Object.isFrozen(gp.GP_PARAMS));
});
