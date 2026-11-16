'use strict';

/**
 * 挖掘沙箱的 DSL（研究框架修订 2026-11-16，签字文本 fd22876f / 签字页 39f8c17c，§3.2；§8.3 第 6 条；P1）。
 *
 * 两种生成方式（大模型、遗传规划）产出的都只是这种公式文本；沙箱不产出权重、仓位或交易指令（§3.1）。
 * 解析时就拒绝（错误码 MINE_DSL_*），不等到求值：
 *   - 白名单外的算子（MINE_DSL_OPERATOR_NOT_WHITELISTED）；
 *   - 超过 20 个记号（MINE_DSL_TOO_LONG）或嵌套超过 5 层（MINE_DSL_TOO_DEEP）；
 *   - 没登记的读数（MINE_DSL_READING_UNREGISTERED）；常数不在登记的网格里（MINE_DSL_CONSTANT_NOT_IN_GRID）；
 *   - 回看窗口不在登记的窗口里或超过 250 个交易日（MINE_DSL_LOOKBACK_INVALID）；参数个数不对（MINE_DSL_ARITY）；写法不对（MINE_DSL_SYNTAX）。
 *
 * 写法：`rank(ts_mean(close, 20) / ts_std(close, 20))`。
 *   记号 = 算子名、读数名、数字、四则运算符（含一元负号）；括号与逗号不算记号。
 *   层数 = 算子与运算的嵌套深度（读数、常数、窗口是 0 层）。
 * 读数、常数网格、回看窗口都取自冻结的 MINING_SPACE_V1（../space.js）；本模块不读行情、不写台账、不调用模型接口。
 */
const crypto = require('crypto');

const MAX_TOKENS = 20;
const MAX_DEPTH = 5;
const MAX_LOOKBACK = 250;

/** 白名单（§3.2）：截面、时序、四则与 sign / abs / log。args：x = 表达式，n = 回看窗口（登记的整数）。 */
const OPERATORS = Object.freeze({
  rank: Object.freeze({ kind: 'CROSS_SECTION', args: ['x'] }),
  zscore: Object.freeze({ kind: 'CROSS_SECTION', args: ['x'] }),
  neutralize_industry: Object.freeze({ kind: 'CROSS_SECTION', args: ['x'] }),
  neutralize_size: Object.freeze({ kind: 'CROSS_SECTION', args: ['x'] }),
  ts_mean: Object.freeze({ kind: 'TIME_SERIES', args: ['x', 'n'], min_n: 1 }),
  ts_std: Object.freeze({ kind: 'TIME_SERIES', args: ['x', 'n'], min_n: 2 }),
  ts_delta: Object.freeze({ kind: 'TIME_SERIES', args: ['x', 'n'], min_n: 1 }),
  ts_rank: Object.freeze({ kind: 'TIME_SERIES', args: ['x', 'n'], min_n: 2 }),
  ts_corr: Object.freeze({ kind: 'TIME_SERIES', args: ['x', 'x', 'n'], min_n: 3 }),
  sign: Object.freeze({ kind: 'ELEMENTWISE', args: ['x'] }),
  abs: Object.freeze({ kind: 'ELEMENTWISE', args: ['x'] }),
  log: Object.freeze({ kind: 'ELEMENTWISE', args: ['x'] }),
});
const BINARY = Object.freeze({ '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' });

class DslError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new DslError(`MINE_DSL_${code}`, detail); };

/** 记号：标识符、数字（十进制，可带小数点）、运算符、括号、逗号。 */
function lex(text) {
  if (typeof text !== 'string' || !text.trim()) fail('SYNTAX', 'EMPTY');
  const out = [];
  const re = /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|([+\-*/(),]))/y;
  let i = 0;
  while (i < text.length) {
    if (/^\s*$/.test(text.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) fail('SYNTAX', `UNEXPECTED_CHARACTER@${i}`);
    if (m[1]) out.push({ t: 'IDENT', v: m[1], at: i });
    else if (m[2]) out.push({ t: 'NUM', v: Number(m[2]), raw: m[2], at: i });
    else out.push({ t: m[3], v: m[3], at: i });
    i = re.lastIndex;
  }
  return out;
}

/**
 * 解析成语法树（不核对白名单与空间，先保证写法）。
 * 节点：{ op: 'reading', name } | { op: 'const', value } | { op: 'window', value } | { op: <算子名|add|sub|mul|div|neg>, args: [...] }
 */
function parseTree(text) {
  const toks = lex(text);
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => { const k = toks[p]; if (!k || (t && k.t !== t)) fail('SYNTAX', `EXPECTED_${t || 'TOKEN'}@${k ? k.at : 'END'}`); p += 1; return k; };
  function expr() {
    let node = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) { const o = take().t; node = { op: BINARY[o], args: [node, term()] }; }
    return node;
  }
  function term() {
    let node = unary();
    while (peek() && (peek().t === '*' || peek().t === '/')) { const o = take().t; node = { op: BINARY[o], args: [node, unary()] }; }
    return node;
  }
  function unary() {
    if (peek() && peek().t === '-') { take(); return { op: 'neg', args: [unary()] }; }
    return primary();
  }
  function primary() {
    const k = peek();
    if (!k) fail('SYNTAX', 'UNEXPECTED_END');
    if (k.t === 'NUM') { take(); return { op: 'const', value: k.v, raw: k.raw }; }
    if (k.t === '(') { take('('); const e = expr(); take(')'); return e; }
    if (k.t === 'IDENT') {
      take();
      if (peek() && peek().t === '(') {
        take('(');
        const args = [];
        if (peek() && peek().t !== ')') { args.push(expr()); while (peek() && peek().t === ',') { take(','); args.push(expr()); } }
        take(')');
        return { op: k.v, args, call: true };
      }
      return { op: 'reading', name: k.v };
    }
    return fail('SYNTAX', `UNEXPECTED_${k.t}@${k.at}`);
  }
  const tree = expr();
  if (p !== toks.length) fail('SYNTAX', `TRAILING@${toks[p].at}`);
  return { tree, tokens: toks.filter((k) => !['(', ')', ','].includes(k.t)).length };
}

const depthOf = (n) => (n.args ? 1 + Math.max(0, ...n.args.map(depthOf)) : 0);

/**
 * 解析并按冻结的搜索空间核对。space：{ readings: [名…], constants: [数…], lookbacks: [整数…], operators?: [白名单子集], max_tokens?, max_depth? }
 * （MINING_SPACE_V1 的那几项，../space.js 的 dslSpaceOf；上限只能比 20 / 5 更紧）。
 * 返回 { tree, canonical, sha256, tokens, depth, readings: [用到的读数], operators: [用到的算子] }。
 */
function parse(text, space) {
  if (!space || !Array.isArray(space.readings) || !Array.isArray(space.constants) || !Array.isArray(space.lookbacks)) fail('SPACE_MISSING');
  const maxTokens = Math.min(MAX_TOKENS, space.max_tokens || MAX_TOKENS); const maxDepth = Math.min(MAX_DEPTH, space.max_depth || MAX_DEPTH);
  const allowedOps = Array.isArray(space.operators) ? new Set(space.operators) : null;
  const { tree, tokens } = parseTree(text);
  if (tokens > maxTokens) fail('TOO_LONG', `${tokens}>${maxTokens}`);
  const readings = new Set(space.readings); const constants = new Set(space.constants); const lookbacks = new Set(space.lookbacks);
  const usedReadings = new Set(); const usedOps = new Set();
  function check(n, role = 'x') {
    if (n.op === 'reading') {
      if (role === 'n') fail('LOOKBACK_INVALID', `${n.name}:NOT_A_NUMBER`);
      if (Object.prototype.hasOwnProperty.call(OPERATORS, n.name)) fail('ARITY', `${n.name}:CALLED_WITHOUT_ARGUMENTS`);
      if (!readings.has(n.name)) fail('READING_UNREGISTERED', n.name);
      usedReadings.add(n.name);
      return n;
    }
    if (n.op === 'const') {
      if (role === 'n') {
        if (!Number.isInteger(n.value) || n.value > MAX_LOOKBACK || !lookbacks.has(n.value)) fail('LOOKBACK_INVALID', n.raw);
        return { op: 'window', value: n.value };
      }
      if (!constants.has(n.value)) fail('CONSTANT_NOT_IN_GRID', n.raw);
      return { op: 'const', value: n.value };
    }
    if (role === 'n') fail('LOOKBACK_INVALID', `${n.op}:NOT_A_NUMBER`);
    if (n.call) {
      const spec = Object.prototype.hasOwnProperty.call(OPERATORS, n.op) ? OPERATORS[n.op] : null;
      if (!spec) fail('OPERATOR_NOT_WHITELISTED', n.op);
      if (allowedOps && !allowedOps.has(n.op)) fail('OPERATOR_NOT_IN_SPACE', n.op);
      if (n.args.length !== spec.args.length) fail('ARITY', `${n.op}:${n.args.length}≠${spec.args.length}`);
      usedOps.add(n.op);
      const args = n.args.map((a, i) => check(a, spec.args[i]));
      const win = spec.args.indexOf('n');
      if (win >= 0 && args[win].value < spec.min_n) fail('LOOKBACK_INVALID', `${n.op}:${args[win].value}<${spec.min_n}`);
      return { op: n.op, args };
    }
    usedOps.add(n.op);
    return { op: n.op, args: n.args.map((a) => check(a, 'x')) };
  }
  const checked = check(tree);
  const depth = depthOf(checked);
  if (depth > maxDepth) fail('TOO_DEEP', `${depth}>${maxDepth}`);
  const canonical = canonicalOf(checked);
  return { tree: checked, canonical, sha256: crypto.createHash('sha256').update(canonical).digest('hex'), tokens, depth,
    readings: [...usedReadings].sort(), operators: [...usedOps].sort() };
}

/** 规范写法（去重与「已试过的公式清单」用）：全括号、无空格。 */
function canonicalOf(n) {
  if (n.op === 'reading') return n.name;
  if (n.op === 'const' || n.op === 'window') return String(n.value);
  if (n.op === 'neg') return `(-${canonicalOf(n.args[0])})`;
  const sym = Object.entries(BINARY).find(([, v]) => v === n.op);
  if (sym) return `(${canonicalOf(n.args[0])}${sym[0]}${canonicalOf(n.args[1])})`;
  return `${n.op}(${n.args.map(canonicalOf).join(',')})`;
}

module.exports = { MAX_TOKENS, MAX_DEPTH, MAX_LOOKBACK, OPERATORS, BINARY, DslError, lex, parseTree, parse, canonicalOf, internals: { depthOf } };
