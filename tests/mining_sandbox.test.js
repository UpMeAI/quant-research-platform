'use strict';
/**
 * 挖掘沙箱 P1（研究框架修订 2026-11-16，签字 fd22876f / 39f8c17c，§3.2、§3.5、§3.6；§8.3 第 6、11、12 条）。先红后绿，全部是合成数据。
 *   - DSL：白名单外的算子、超长或超深、没登记的读数、网格外的常数、非法窗口，都在解析时被拒；
 *   - 求值器：只往回看（前缀上的结果 = 全量结果的前缀）；
 *   - MINING_SPACE_V1：算子要先有因果证据（role FEATURE，三项 PASS）；冻结页写出 sha；
 *   - 隔离：沙箱进程写生产路径失败；
 *   - 中性化：G-MINE 的 IC 类读数不是中性化后的值 → 拒绝。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dsl = require('../services/mining-sandbox/dsl');
const evaluator = require('../services/mining-sandbox/evaluator');
const space = require('../services/mining-sandbox/space');
const gate = require('../services/mining-gate');

const ROOT = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const SPACE = { readings: ['close', 'volume', 'turnover'], constants: [1, 2, 0.5], lookbacks: [5, 10, 20, 60, 250] };
const nest = (k) => `${'abs('.repeat(k)}close${')'.repeat(k)}`;

test('DSL：合法公式解析成规范写法；记号（算子、读数、数字、运算符）与层数按约定计', () => {
  const p = dsl.parse('rank(ts_mean(close, 20) / ts_std(close, 20))', SPACE);
  assert.equal(p.canonical, 'rank((ts_mean(close,20)/ts_std(close,20)))');
  assert.equal(p.sha256, sha(p.canonical));
  assert.deepEqual([p.tokens, p.depth, p.readings, p.operators], [8, 3, ['close'], ['div', 'rank', 'ts_mean', 'ts_std']]);
  assert.equal(dsl.parse('rank( ts_mean( close ,20 )/ts_std(close,20) )', SPACE).canonical, p.canonical);
  assert.equal(dsl.parse('-abs(close) * 2 + log(volume)', SPACE).canonical, '(((-abs(close))*2)+log(volume))');
  assert.equal(dsl.parse('ts_corr(close, volume, 60)', SPACE).depth, 1);
  // 正好 20 个记号、正好 5 层：过
  const twenty = dsl.parse('-(((close + close) + (close + close)) + ((close + close) + (close + close)) + (close + close))', SPACE);
  assert.deepEqual([twenty.tokens, twenty.depth], [20, 5]);
  assert.throws(() => dsl.parse(`-close${' + close'.repeat(9)}`, SPACE), code(/MINE_DSL_TOO_DEEP:10>5/)); // 20 个记号，但左结合的长链有 10 层
  assert.equal(dsl.parse(nest(5), SPACE).depth, 5);
  assert.equal(dsl.parse('ts_mean(close, 250)', SPACE).operators[0], 'ts_mean');
});

test('DSL（§8.3 第 6 条）：白名单外的算子、超长、超深、没登记的读数、网格外常数、非法窗口、参数个数、写法——解析时就拒绝', () => {
  const refuses = (text, re, s = SPACE) => assert.throws(() => dsl.parse(text, s), code(re), text);
  refuses('ts_max(close, 20)', /MINE_DSL_OPERATOR_NOT_WHITELISTED:ts_max/);
  refuses('exp(close)', /MINE_DSL_OPERATOR_NOT_WHITELISTED:exp/);
  refuses(`close${' + close'.repeat(10)}`, /MINE_DSL_TOO_LONG:21>20/);
  refuses(nest(6), /MINE_DSL_TOO_DEEP:6>5/);
  refuses('rank(pe_ttm)', /MINE_DSL_READING_UNREGISTERED:pe_ttm/);
  refuses('close * 3', /MINE_DSL_CONSTANT_NOT_IN_GRID:3/);
  refuses('ts_mean(close, 30)', /MINE_DSL_LOOKBACK_INVALID:30/);
  refuses('ts_mean(close, 251)', /MINE_DSL_LOOKBACK_INVALID:251/, { ...SPACE, lookbacks: [...SPACE.lookbacks, 251] });
  refuses('ts_mean(close, volume)', /MINE_DSL_LOOKBACK_INVALID:volume:NOT_A_NUMBER/);
  refuses('ts_std(close, 1)', /MINE_DSL_LOOKBACK_INVALID/, { ...SPACE, lookbacks: [1, 20] });
  refuses('ts_mean(close)', /MINE_DSL_ARITY:ts_mean:1≠2/);
  refuses('rank', /MINE_DSL_ARITY:rank:CALLED_WITHOUT_ARGUMENTS/);
  refuses('rank(close', /MINE_DSL_SYNTAX/);
  refuses('close $ 2', /MINE_DSL_SYNTAX:UNEXPECTED_CHARACTER/);
  refuses('', /MINE_DSL_SYNTAX:EMPTY/);
  // 冻结的空间只开了一部分算子、或把上限收紧：照空间
  refuses('zscore(close)', /MINE_DSL_OPERATOR_NOT_IN_SPACE:zscore/, { ...SPACE, operators: ['rank'] });
  refuses(`close${' + close'.repeat(5)}`, /MINE_DSL_TOO_LONG:11>10/, { ...SPACE, max_tokens: 10 });
  refuses(nest(3), /MINE_DSL_TOO_DEEP:3>2/, { ...SPACE, max_depth: 2 });
  assert.throws(() => dsl.parse('close', null), code(/MINE_DSL_SPACE_MISSING/));
});

/** 合成面板：12 天 × 4 个标的。 */
function panel(days = 12) {
  const dates = Array.from({ length: days }, (_, i) => `2026-01-${String(i + 5).padStart(2, '0')}`);
  const codes = ['A', 'B', 'C', 'D'];
  const close = dates.map((_, t) => codes.map((_, j) => 10 + j + Math.sin(t + j) * (j + 1)));
  const volume = dates.map((_, t) => codes.map((_, j) => 1000 + 37 * ((t * 7 + j * 3) % 11)));
  return { dates, codes, readings: { close, volume, turnover: volume }, industry: dates.map(() => ['X', 'X', 'Y', 'Y']), size: dates.map(() => [1e9, 2e9, 5e9, 8e9]) };
}

test('求值器：时序、截面与中性化的数对得上；只往回看——前缀面板上的结果等于全量结果的前缀', () => {
  const p = panel();
  const r = evaluator.run('ts_mean(close, 5)', SPACE, p);
  assert.ok(r.values.slice(0, 4).every((row) => row.every(Number.isNaN)));
  const want = [0, 1, 2, 3, 4].reduce((a, t) => a + p.readings.close[t][2], 0) / 5;
  assert.ok(Math.abs(r.values[4][2] - want) < 1e-12);
  const rk = evaluator.run('rank(close)', SPACE, p).values[0];
  assert.deepEqual([...rk].sort(), [0, 1 / 3, 2 / 3, 1].sort());
  const ni = evaluator.run('neutralize_industry(close)', SPACE, p).values[3];
  assert.ok(Math.abs(ni[0] + ni[1]) < 1e-12 && Math.abs(ni[2] + ni[3]) < 1e-12);
  const formula = 'rank(ts_mean(close, 5) / ts_std(volume, 5)) - zscore(ts_corr(close, volume, 5))';
  const full = evaluator.run(formula, SPACE, p).values;
  for (const k of [6, 8, 10]) {
    const pre = { ...p, dates: p.dates.slice(0, k), readings: Object.fromEntries(Object.entries(p.readings).map(([n, m]) => [n, m.slice(0, k)])), industry: p.industry.slice(0, k), size: p.size.slice(0, k) };
    assert.deepEqual(evaluator.run(formula, SPACE, pre).values, full.slice(0, k), `prefix ${k}`);
  }
  assert.throws(() => evaluator.run('close', { ...SPACE, readings: ['close'] }, { ...p, dates: [...p.dates].reverse() }), code(/MINE_EVAL_PANEL_DATES_NOT_ASCENDING/));
  assert.throws(() => evaluator.run('neutralize_size(close)', SPACE, { ...p, size: undefined }), code(/MINE_EVAL_SIZE_MISSING/));
});

test('中性化（§8.3 第 12 条）：打分前按行业、市值中性化并记 APPLIED；G-MINE 的 IC、单调性、衰减读数没有这一记 → MINE_NOT_NEUTRALIZED', () => {
  const p = panel();
  const n = evaluator.neutralizeForScoring(evaluator.run('close', SPACE, p), p, { neutralization: 'LINEAR_RAW_V1' });
  assert.deepEqual({ industry: n.neutralization.industry, size: n.neutralization.size }, gate.NEUTRALIZED);
  assert.ok(Math.abs(n.values[2].reduce((a, b) => a + b, 0)) < 1e-9);
  assert.throws(() => evaluator.neutralizeForScoring(evaluator.run('close', SPACE, p), { ...p, industry: undefined }, { neutralization: 'LINEAR_RAW_V1' }), code(/MINE_EVAL_INDUSTRY_MISSING/));
  const thresholds = { ...gate.THRESHOLDS, state: gate.FROZEN, frozen_ref: { path: 'synthetic/FREEZE.md', sha256: 'a'.repeat(64) } };
  const holdout = { ic_mean: 0.05, icir: 0.5, icir_non_overlapping: true, ic_double_horizon: 0.03, quintile_mean_returns: [0.01, 0.02, 0.03, 0.04, 0.05] };
  const raw = { holdout };
  const done = { holdout: { ...holdout, neutralization: n.neutralization } };
  for (const check of [gate.checkIcIcir, gate.checkMonotonicity, gate.checkDecay]) {
    assert.ok(check(raw, { thresholds }).codes.includes('MINE_NOT_NEUTRALIZED'), check.name);
    assert.equal(check(done, { thresholds }).codes.includes('MINE_NOT_NEUTRALIZED'), false, check.name);
  }
  assert.ok(gate.checkIcIcir({ holdout: { ...holdout, neutralization: { industry: 'APPLIED' } } }, { thresholds }).codes.includes('MINE_NOT_NEUTRALIZED'));
});

const EVIDENCE_DIR = path.join(ROOT, 'docs', 'evidence', 'mining-operators-v1');
const evidenceBytes = () => fs.readFileSync(path.join(EVIDENCE_DIR, 'CAUSALITY_EVIDENCE_V1.json'));
function spaceBytes(patch = {}) {
  return Buffer.from(JSON.stringify({ schema: 'MINING_SPACE_V1', space_ref: 'MS-SYNTH-1', market: 'CN_A',
    // 读数要在钉住的数据集登记表里、PIT 记号对得上（协调会话 2026-11-17）：用登记过的 V6_CSI300_INDEX_DAILY（OBSERVED_AT）
    readings: [{ name: 'close', dataset_id: 'V6_CSI300_INDEX_DAILY', pit_available_at: 'OBSERVED_AT (synthetic)' }, { name: 'volume', dataset_id: 'V6_CSI300_INDEX_DAILY', pit_available_at: 'OBSERVED_AT (synthetic)' }],
    operators: ['rank', 'zscore', 'ts_mean', 'ts_std', 'ts_corr', 'abs'], constants: [1, 2], lookbacks: [5, 20, 60], holding_periods: [5], max_tokens: 20, max_depth: 5,
    operator_evidence: { path: 'docs/evidence/mining-operators-v1/CAUSALITY_EVIDENCE_V1.json', sha256: sha(evidenceBytes()) }, ...patch }));
}

test('MINING_SPACE_V1：读数写 PIT 可得时刻、算子在白名单且有因果证据（新增算子要先证）、窗口 ≤ 250、上限只紧不松；冻结页写出 sha', () => {
  const proof = { evidence: JSON.parse(evidenceBytes()), evidenceBytes: evidenceBytes() };
  const b = spaceBytes();
  const s = space.parseSpace(b, proof);
  assert.equal(s.sha256, sha(b));
  assert.deepEqual(space.dslSpaceOf(s).readings, ['close', 'volume']);
  assert.equal(dsl.parse('rank(ts_mean(close, 20))', space.dslSpaceOf(s)).depth, 2);
  assert.throws(() => dsl.parse('neutralize_size(close)', space.dslSpaceOf(s)), code(/MINE_DSL_OPERATOR_NOT_IN_SPACE/));
  const refuses = (patch, re, pr = proof) => assert.throws(() => space.parseSpace(spaceBytes(patch), pr), code(re));
  refuses({ operators: ['rank', 'ts_max'] }, /MINE_SPACE_OPERATOR_NOT_WHITELISTED:ts_max/);
  refuses({ readings: [{ name: 'close', dataset_id: 'V6_CSI300_INDEX_DAILY' }] }, /MINE_SPACE_READING_INVALID/);
  refuses({ readings: [{ name: 'rank', dataset_id: 'X', pit_available_at: 'DATE_AT' }] }, /MINE_SPACE_READING_SHADOWS_OPERATOR/);
  refuses({ lookbacks: [5, 300] }, /MINE_SPACE_LOOKBACKS_INVALID/);
  refuses({ max_tokens: 21 }, /MINE_SPACE_MAX_TOKENS_INVALID/);
  refuses({ max_depth: 6 }, /MINE_SPACE_MAX_DEPTH_INVALID/);
  refuses({ operator_evidence: { path: 'x', sha256: 'b'.repeat(64) } }, /MINE_SPACE_OPERATOR_EVIDENCE_SHA_MISMATCH/);
  // 证据里有个算子没过（或没有这个算子）→ 这个算子不能进空间
  const ev = JSON.parse(evidenceBytes());
  ev.functions = ev.functions.map((f) => (f.function_id.endsWith('#ROWS.zscore') ? { ...f, t_c2: 'FAIL' } : f)).filter((f) => !f.function_id.endsWith('#ROWS.abs'));
  const evBytes = Buffer.from(JSON.stringify(ev));
  const bad = { evidence: ev, evidenceBytes: evBytes };
  refuses({ operator_evidence: { path: 'x', sha256: sha(evBytes) } }, /MINE_SPACE_OPERATOR_NOT_PROVEN_CAUSAL:zscore/, bad);
  refuses({ operators: ['rank', 'abs'], operator_evidence: { path: 'x', sha256: sha(evBytes) } }, /MINE_SPACE_OPERATOR_NOT_PROVEN_CAUSAL:abs/, bad);
  // 冻结页
  const page = Buffer.from(`# MINING_SPACE_V1 冻结\n\n清单 sha256 ${s.sha256}，FROZEN。\n`);
  assert.deepEqual(space.verifyFreeze(s, { path: 'synthetic/FREEZE.md', bytes: page, sha256: sha(page) }), { path: 'synthetic/FREEZE.md', sha256: sha(page) });
  const draft = Buffer.from(`# MINING_SPACE_V1 草稿\n\n清单 sha256 ${s.sha256}。\n`);
  assert.throws(() => space.verifyFreeze(s, { path: 'd', bytes: draft, sha256: sha(draft) }), code(/MINE_SPACE_NOT_FROZEN/));
});

test('隔离（§8.3 第 11 条）：沙箱进程上锁后写生产路径（台账、config、别的仓库）失败，只能写自己的输出目录；沙箱模块不引台账、不引网络', () => {
  const allow = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-out-'));
  const prod = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-prod-'));
  const script = `
    const fs = require('fs'); const path = require('path');
    const iso = require(${JSON.stringify(path.join(ROOT, 'services', 'mining-sandbox', 'isolation'))});
    iso.lockdown({ allowRoot: ${JSON.stringify(allow)} });
    const out = {};
    const tryIt = (k, f) => { try { f(); out[k] = 'OK'; } catch (e) { out[k] = e.code || e.message; } };
    tryIt('own_dir', () => fs.writeFileSync(path.join(${JSON.stringify(allow)}, 'candidates.jsonl'), 'x\\n'));
    tryIt('ledger_append', () => require(${JSON.stringify(path.join(ROOT, 'packages', 'ledger'))}).append(path.join(${JSON.stringify(prod)}, 'research', 'trials.jsonl'), { a: 1 }));
    tryIt('append', () => fs.appendFileSync(path.join(${JSON.stringify(prod)}, 'x.jsonl'), 'x'));
    tryIt('mkdir', () => fs.mkdirSync(path.join(${JSON.stringify(prod)}, 'd')));
    tryIt('rename_out', () => fs.renameSync(path.join(${JSON.stringify(allow)}, 'candidates.jsonl'), path.join(${JSON.stringify(prod)}, 'moved')));
    tryIt('open_w', () => fs.openSync(path.join(${JSON.stringify(prod)}, 'o'), 'w'));
    tryIt('stream', () => fs.createWriteStream(path.join(${JSON.stringify(prod)}, 's')));
    tryIt('read_prod', () => fs.readdirSync(${JSON.stringify(prod)}));
    fs.promises.writeFile(path.join(${JSON.stringify(prod)}, 'p'), 'x').then(() => { out.promises = 'OK'; }, (e) => { out.promises = e.code; })
      .then(() => process.stdout.write(JSON.stringify(out)));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, QRP_DATA_DIR: prod } }).toString());
  assert.deepEqual(out, { own_dir: 'OK', ledger_append: 'MINE_SANDBOX_WRITE_REFUSED', append: 'MINE_SANDBOX_WRITE_REFUSED', mkdir: 'MINE_SANDBOX_WRITE_REFUSED',
    rename_out: 'MINE_SANDBOX_WRITE_REFUSED', open_w: 'MINE_SANDBOX_WRITE_REFUSED', stream: 'MINE_SANDBOX_WRITE_REFUSED', read_prod: 'OK', promises: 'MINE_SANDBOX_WRITE_REFUSED' });
  assert.deepEqual(fs.readdirSync(prod), []);
  // 沙箱的模块：不引台账、不引网络、不起子进程
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(ROOT, 'services', 'mining-sandbox'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const banned of ["require('../../packages/ledger')", "require('../../../packages/ledger')", "require('http')", "require('https')", "require('net')", "require('child_process')"]) {
      assert.equal(src.includes(banned), false, `${path.relative(ROOT, f)}:${banned}`);
    }
  }
});
