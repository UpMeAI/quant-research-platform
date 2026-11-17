'use strict';

/**
 * GP 生成器 AI_MINED_GP（RF1116 §3.1；P2 规格 §2；★R (a)：一轮只用一种生成方式，种子写进轮次清单）。
 *
 * 在 DSL（../dsl）上做遗传规划：第一批随机长出来，以后每批从本轮已算过分的候选里按锦标赛选亲本，做子树交叉、子树 / 点 / 窗口 / 提升变异。
 *   - 只产出合法的 DSL：每个公式都先过 dsl.parse（冻结空间里的读数、算子、常数网格、回看窗口，≤ 20 记号、≤ 5 层），产出的是规范写法；
 *   - 只看生成方视图（services/mining-rounds 的 generatorView：空间、本轮的挖掘段分数、已试过的公式）。视图里出现别的字段
 *     （验证折、留出段、选择、G-MINE、赛马、模拟盘……）→ MINE_GP_VIEW_FIELD_NOT_ALLOWED；本模块不引用数据、打分、留出段或门，也不连网络；
 *   - 适应度 = 挖掘段分数（中性化后的 rank IC 均值，../scoring 算、执行器记进试验台账）− 长度惩罚 × 记号数（fitnessOf）；
 *   - 确定性：nextBatch 是 (种子, 参数, 空间, 视图) 的纯函数。每批的随机数种子 = sha256(种子 | 本轮已有的尝试数) 的前 4 字节，
 *     所以同种子、同空间、同挖掘段数据 → 逐字节相同的公式串，中断后按台账续上也一样；
 *   - 新颖性：子代的规范写法已试过（视图的 tried_formulas 或本批前面的）就重抽，最多 novelty_retries 次；还重就照样交出去——
 *     执行器把它记成「生成了又被去重」的一次尝试（P2 规格 §2），不藏起来。
 */
const crypto = require('crypto');
const dsl = require('../dsl');

const GP_PARAMS = Object.freeze({
  schema: 'AI_MINED_GP_PARAMS_V1', batch_size: 40, init_max_depth: 4, p_leaf: 0.3, p_leaf_const: 0.1, tournament_size: 3,
  p_crossover: 0.5, p_subtree_mutation: 0.2, p_point_mutation: 0.15, p_window_mutation: 0.1, p_hoist_mutation: 0.05,
  length_penalty_per_token: 0.0005, novelty_retries: 25, build_retries: 200,
});
const VIEW_KEYS = Object.freeze(['round_id', 'market', 'space', 'holding_periods', 'mining_scores', 'tried_formulas']);
const SCORE_KEYS = Object.freeze(['candidate_id', 'formula', 'mining_segment_score']);

class GpError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new GpError(`MINE_GP_${code}`, detail); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const batchSeed = (seed, attempts) => crypto.createHash('sha256').update(`AI_MINED_GP|${seed}|${attempts}`).digest().readUInt32BE(0);

/** 适应度：挖掘段分数减长度惩罚；没有分数（解析不过、去重、算不出）→ null。 */
const fitnessOf = ({ mining_segment_score: s, tokens }, params = GP_PARAMS) => (isNum(s) && Number.isInteger(tokens) ? s - params.length_penalty_per_token * tokens : null);

function checkView(view) {
  if (!view || typeof view !== 'object') fail('VIEW_INVALID');
  for (const k of Object.keys(view)) if (!VIEW_KEYS.includes(k)) fail('VIEW_FIELD_NOT_ALLOWED', k);
  if (!Array.isArray(view.mining_scores) || !Array.isArray(view.tried_formulas)) fail('VIEW_INVALID', 'mining_scores/tried_formulas');
  for (const s of view.mining_scores) for (const k of Object.keys(s || {})) if (!SCORE_KEYS.includes(k)) fail('VIEW_FIELD_NOT_ALLOWED', `mining_scores.${k}`);
}

const clone = (n) => JSON.parse(JSON.stringify(n));
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];
/** 树上所有表达式节点的路径（窗口不算：窗口只能换成别的窗口）。 */
function paths(n, at = [], out = []) {
  if (n.op === 'window') return out;
  out.push(at);
  (n.args || []).forEach((a, k) => paths(a, [...at, k], out));
  return out;
}
const nodeAt = (n, p) => p.reduce((x, k) => x.args[k], n);
function replaceAt(n, p, sub) {
  if (!p.length) return clone(sub);
  const out = clone(n); let x = out;
  for (let k = 0; k < p.length - 1; k += 1) x = x.args[p[k]];
  x.args[p[p.length - 1]] = clone(sub);
  return out;
}

/**
 * @param {{seed: number, space: object, holdingPeriod: number, params?: object}} o  space = 冻结空间的 DSL 部分（../space 的 dslSpaceOf）
 */
function createGp({ seed, space, holdingPeriod, params = GP_PARAMS } = {}) {
  if (!Number.isInteger(seed)) fail('SEED_REQUIRED', seed);
  if (!Number.isInteger(holdingPeriod) || holdingPeriod < 1) fail('HOLDING_PERIOD', holdingPeriod);
  if (!space || !Array.isArray(space.readings) || !space.readings.length || !Array.isArray(space.constants) || !Array.isArray(space.lookbacks)) fail('SPACE_INVALID');
  const calls = (Array.isArray(space.operators) ? space.operators : Object.keys(dsl.OPERATORS)).filter((o) => Object.prototype.hasOwnProperty.call(dsl.OPERATORS, o)).sort();
  const ops = [...calls, ...Object.values(dsl.BINARY), 'neg'];
  const kindOf = (op) => (dsl.OPERATORS[op] ? `${dsl.OPERATORS[op].kind}/${dsl.OPERATORS[op].args.join('')}` : op === 'neg' ? 'NEG' : 'BINARY');
  const windows = (op) => space.lookbacks.filter((w) => w >= (dsl.OPERATORS[op].min_n || 1)).sort((a, b) => a - b);
  const legal = (tree) => { try { return dsl.parse(dsl.canonicalOf(tree), space); } catch (e) { if (e instanceof dsl.DslError) return null; throw e; } };

  function leaf(rng) { return rng() < params.p_leaf_const ? { op: 'const', value: pick(rng, space.constants) } : { op: 'reading', name: pick(rng, space.readings) }; }
  function grow(rng, depth, root = false) {
    if (!root && (depth <= 0 || rng() < params.p_leaf)) return leaf(rng);
    const op = pick(rng, ops);
    const spec = dsl.OPERATORS[op];
    if (spec) return { op, args: spec.args.map((a) => (a === 'n' ? { op: 'window', value: pick(rng, windows(op)) } : grow(rng, depth - 1))) };
    if (op === 'neg') return { op, args: [grow(rng, depth - 1)] };
    return { op, args: [grow(rng, depth - 1), grow(rng, depth - 1)] };
  }
  function randomFormula(rng) {
    for (let k = 0; k < params.build_retries; k += 1) { const p = legal(grow(rng, params.init_max_depth, true)); if (p && p.depth >= 1) return p; }
    return fail('BUILD_EXHAUSTED');
  }
  const tournament = (rng, pop) => {
    let best = null;
    for (let k = 0; k < params.tournament_size; k += 1) { const c = pick(rng, pop); if (!best || c.fitness > best.fitness) best = c; }
    return best;
  };
  function mutatePoint(rng, tree) {
    const p = pick(rng, paths(tree)); const n = nodeAt(tree, p);
    if (n.op === 'reading') return replaceAt(tree, p, { op: 'reading', name: pick(rng, space.readings) });
    if (n.op === 'const') return replaceAt(tree, p, { op: 'const', value: pick(rng, space.constants) });
    const same = ops.filter((o) => kindOf(o) === kindOf(n.op));
    const op = pick(rng, same);
    const args = n.args.map((a, k) => (a.op === 'window' ? { op: 'window', value: windows(op).includes(a.value) ? a.value : pick(rng, windows(op)) } : nodeAt(tree, [...p, k])));
    return replaceAt(tree, p, { op, args });
  }
  function mutateWindow(rng, tree) {
    const ts = paths(tree).filter((p) => dsl.OPERATORS[nodeAt(tree, p).op] && dsl.OPERATORS[nodeAt(tree, p).op].kind === 'TIME_SERIES');
    if (!ts.length) return mutatePoint(rng, tree);
    const p = pick(rng, ts); const n = nodeAt(tree, p);
    return replaceAt(tree, p, { op: n.op, args: n.args.map((a) => (a.op === 'window' ? { op: 'window', value: pick(rng, windows(n.op)) } : a)) });
  }
  function breed(rng, pop) {
    const u = rng(); const a = tournament(rng, pop).tree;
    let c = params.p_crossover;
    if (u < c) { const b = tournament(rng, pop).tree; return replaceAt(a, pick(rng, paths(a)), nodeAt(b, pick(rng, paths(b)))); }
    c += params.p_subtree_mutation;
    if (u < c) return replaceAt(a, pick(rng, paths(a)), grow(rng, 2));
    c += params.p_point_mutation;
    if (u < c) return mutatePoint(rng, a);
    c += params.p_window_mutation;
    if (u < c) return mutateWindow(rng, a);
    const inner = paths(a).filter((p) => nodeAt(a, p).args);
    return clone(nodeAt(a, pick(rng, inner)));
  }
  function child(rng, pop) {
    if (pop.length < 2) return randomFormula(rng);
    for (let k = 0; k < params.build_retries; k += 1) { const p = legal(breed(rng, pop)); if (p && p.depth >= 1) return p; }
    return randomFormula(rng);
  }

  /**
   * 下一批公式（规范写法）。view = generatorView 的输出；n = 本批要几个（执行器按剩下的上限给）。
   * @returns {string[]}
   */
  function nextBatch(view, { n = params.batch_size } = {}) {
    checkView(view);
    if (!Number.isInteger(n) || n < 1) fail('BATCH_SIZE', n);
    const rng = mulberry32(batchSeed(seed, view.mining_scores.length));
    const pop = [];
    for (const s of [...view.mining_scores].sort((x, y) => (x.candidate_id < y.candidate_id ? -1 : x.candidate_id > y.candidate_id ? 1 : 0))) {
      if (!isNum(s.mining_segment_score) || typeof s.formula !== 'string') continue;
      let p = null; try { p = dsl.parse(s.formula, space); } catch (e) { if (!(e instanceof dsl.DslError)) throw e; }
      if (p) pop.push({ tree: p.tree, fitness: fitnessOf({ mining_segment_score: s.mining_segment_score, tokens: p.tokens }, params) });
    }
    const seen = new Set(view.tried_formulas); const out = [];
    for (let k = 0; k < n; k += 1) {
      let p = child(rng, pop);
      for (let r = 0; r < params.novelty_retries && (seen.has(p.canonical)); r += 1) p = child(rng, pop);
      seen.add(p.canonical); out.push(p.canonical);
    }
    return out;
  }

  return Object.freeze({ mode: 'AI_MINED_GP', seed, params, holdingPeriod, nextBatch });
}

module.exports = { GP_PARAMS, VIEW_KEYS, SCORE_KEYS, GpError, createGp, fitnessOf, internals: { mulberry32, batchSeed, paths, replaceAt } };
