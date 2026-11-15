'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const core = require('../tools/causality-harness/lib/core');
const gate = require('../services/causality-gate');
const cli = require('../tools/causality-harness/run');

/**
 * G-CAUSAL 公用工具（研究框架修订 2026-11-12 草稿 rev 1 §3.3、§3.5）：先红后绿。
 * 每项测试一对合成夹具：红的故意不因果、工具必须判 FAIL；绿的是同一读数的因果写法、三项全 PASS。Node 与 Python 两个运行器各跑一遍。
 */
const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'tools', 'causality-harness', 'fixtures');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const python = spawnSync('python3', ['-c', 'import sys; print(sys.version_info >= (3, 8))']).stdout?.toString().trim() === 'True';
const pandas = python && spawnSync('python3', ['-I', '-c', 'import pandas']).status === 0;

const cache = new Map();
function run(manifest, opts = {}) {
  const key = `${manifest}|${JSON.stringify(opts)}`;
  if (!cache.has(key)) cache.set(key, core.runManifest(manifest, { codeRoot: ROOT, registeredBy: 'TEST', registeredAt: '2026-11-15T14:00:00Z', ...opts }));
  return cache.get(key);
}
const byEntry = (doc) => Object.fromEntries(doc.functions.map((f) => [f.entry, f]));
const states = (f) => `${f.t_c1} ${f.t_c2} ${f.t_c3}`;

/** 期望：红的只在它针对的测试上 FAIL（全天分母、居中窗口、全样本归一化、跨调用缓存这类同时也过不了 T-C2）。 */
const EXPECT = {
  participationFullDay: 'FAIL FAIL PASS', participationPriorDays: 'PASS PASS PASS',
  fractalAtPeak: 'FAIL FAIL PASS', fractalAtConfirmation: 'PASS PASS PASS',
  nextBarDirectionWithFallback: 'PASS FAIL PASS', priorBarDirection: 'PASS PASS PASS',
  expandingMeanWithCache: 'PASS PASS FAIL', expandingMeanFixtureParams: 'PASS PASS PASS',
  centeredMeanAt: 'FAIL FAIL PASS', trailingMeanAt: 'PASS PASS PASS',
  rankByFullSampleZ: 'FAIL FAIL PASS', rankByDailyReturn: 'PASS PASS PASS',
  memoCenteredMean: 'FAIL FAIL PASS', globalMemoCenteredMean: 'FAIL FAIL PASS',
};
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const EXPECT_PY = {
  ...Object.fromEntries(Object.entries(EXPECT).filter(([k]) => k !== 'globalMemoCenteredMean').map(([k, v]) => [snake(k), v])),
  rolling_std_pandas: 'PASS PASS PASS', centered_rolling_pandas: 'FAIL FAIL PASS',
};

test('Node 运行器：14 个合成夹具先红后绿——草稿点名的全天分母参与率与事后确认的分型判 FAIL，各自的因果写法三项全 PASS', () => {
  const doc = run(path.join(FIX, 'manifest.node.json'));
  const got = Object.fromEntries(Object.entries(byEntry(doc)).map(([k, f]) => [k, states(f)]));
  assert.deepEqual(got, EXPECT);
  const f = byEntry(doc);
  assert.match(f.participationFullDay.fail_reasons.t_c1, /^MISMATCH:\d+$/);
  assert.match(f.fractalAtPeak.fail_reasons.t_c1, /^MISMATCH:\d+$/);
  // 不一致记前 20 处：函数、t、c、两边的值；每处都在 t ≤ c
  for (const m of f.fractalAtPeak.mismatches) assert.ok(Date.parse(m.t) <= Date.parse(m.c) && m.full !== m.other, JSON.stringify(m));
  assert.ok(f.participationFullDay.mismatches.length === gate.MAX_MISMATCHES);
  // 截断看不出，只有换掉未来才看得出：不一致全在 T-C2
  assert.ok(f.nextBarDirectionWithFallback.mismatches.length && f.nextBarDirectionWithFallback.mismatches.every((m) => m.test === 'T-C2'));
  // T-C3：读夹具目录外的缓存、连数据库端口，都被记下（函数吞掉了异常也一样）
  const kinds = f.expandingMeanWithCache.forbidden_attempts.map((a) => `${a.phase}:${a.kind}`);
  assert.ok(kinds.includes('CALL:FS_READ') && kinds.includes('CALL:NET_CONNECT'), kinds.join(','));
  assert.equal(f.expandingMeanFixtureParams.forbidden_attempts.length, 0); // 夹具目录内可读
  for (const fn of doc.functions) assert.equal(fn.sandbox.mode, 'PERMISSION_MODEL+STUBS', fn.entry);
});

test('Python 运行器（统计车道）：同一组夹具，判定与 Node 相同；pandas 输入的滚动均值居中判 FAIL', { skip: !python && 'python3 (>= 3.8) not on PATH' }, () => {
  const doc = run(path.join(FIX, 'manifest.python.json'));
  const got = Object.fromEntries(Object.entries(byEntry(doc)).filter(([k]) => pandas || !k.endsWith('_pandas')).map(([k, f]) => [k, states(f)]));
  const want = Object.fromEntries(Object.entries(EXPECT_PY).filter(([k]) => pandas || !k.endsWith('_pandas')));
  assert.deepEqual(got, want);
  const f = byEntry(doc);
  const kinds = f.expanding_mean_with_cache.forbidden_attempts.map((a) => a.kind);
  assert.ok(kinds.includes('FS_READ') && kinds.some((k) => k.startsWith('NET_')), kinds.join(','));
  for (const fn of doc.functions) assert.equal(fn.sandbox.mode, 'AUDIT_HOOK', fn.entry);
});

test('截点由编排端按 sha256(种子|函数|…) 选出，两个运行器共用；首尾 5%、段边界两侧、每个盘中交易日都在里面；重选逐字节相同', { skip: !python && 'python3 not on PATH' }, () => {
  const node = byEntry(run(path.join(FIX, 'manifest.node.json')));
  const py = byEntry(run(path.join(FIX, 'manifest.python.json')));
  const minutes = JSON.parse(fs.readFileSync(path.join(FIX, 'data', 'minutes.json'), 'utf8'));
  const avail = minutes.map((m) => Date.parse(m.time));
  const session = { open: '09:30', close: '15:00', tz: '+08:00' };
  const sel = core.internals.cutPoints('qrp:a.js#f', avail, { seed: gate.SEED, k: gate.CUT_POINTS, session });
  assert.equal(sel.blocked, null);
  const days = new Set(minutes.map((m) => m.day));
  const cutDays = new Set(sel.cuts.filter((c) => { const h = new Date(c + 8 * 3600e3).toISOString().slice(11, 16); return h > '09:30' && h < '15:00'; }).map((c) => new Date(c + 8 * 3600e3).toISOString().slice(0, 10)));
  assert.deepEqual([...cutDays].sort(), [...days].sort()); // 每个交易日一个盘中截点
  assert.equal(sel.cuts.length, gate.CUT_POINTS);
  const sorted = [...new Set(avail)].sort((a, b) => a - b).slice(0, -1);
  const edge = Math.ceil(0.05 * sorted.length);
  assert.ok(sel.cuts.some((c) => sorted.indexOf(c) < edge) && sel.cuts.some((c) => sorted.indexOf(c) >= sorted.length - edge));
  // 两个运行器的证据里，截点都等于按函数 id 与可得时点重选的结果
  assert.deepEqual(node.participationFullDay.cut_points, core.internals.cutPoints(node.participationFullDay.function_id, avail, { seed: gate.SEED, k: gate.CUT_POINTS, session }).cuts.map((c) => new Date(c).toISOString()));
  const pyCuts = core.internals.cutPoints(py.participation_full_day.function_id, avail, { seed: gate.SEED, k: gate.CUT_POINTS, session }).cuts.map((c) => new Date(c).toISOString());
  assert.deepEqual(py.participation_full_day.cut_points, pyCuts);
  // 段边界两侧各一个
  const bars = JSON.parse(fs.readFileSync(path.join(FIX, 'data', 'daily_zigzag.json'), 'utf8')).map((b) => Date.parse(`${b.date}T15:00:00+08:00`));
  const b = Date.parse('2025-02-03T00:00:00+08:00');
  const withB = core.internals.cutPoints('qrp:a.js#f', bars, { seed: gate.SEED, k: 3, boundaries: ['2025-02-03T00:00:00+08:00'] }).cuts;
  assert.ok(withB.includes(bars.filter((x) => x < b).pop()) && withB.includes(bars.find((x) => x >= b)));
  // 确定性：重跑同一选法逐字节相同
  assert.deepEqual(core.internals.cutPoints('qrp:a.js#f', avail, { seed: gate.SEED, k: gate.CUT_POINTS, session }), sel);
});

test('隔离：跨调用的模块缓存在同一进程里会让 T-C1 假通过；MODULE_RELOAD 与 PROCESS_PER_CALL 都把它判 FAIL', () => {
  // 同一进程里连调：前缀调用读到整段调用留下的值，看起来「前缀等价」
  const features = require('../tools/causality-harness/fixtures/node/features');
  const bars = JSON.parse(fs.readFileSync(path.join(FIX, 'data', 'daily_swing.json'), 'utf8'));
  const fullOut = features.memoCenteredMean(bars);
  const prefixOut = features.memoCenteredMean(bars.slice(0, 30));
  assert.deepEqual(prefixOut, fullOut.slice(0, 30));
  assert.notDeepEqual(features.centeredMeanAt(bars.slice(0, 30), 29), features.centeredMeanAt(bars, 29));
  const m = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.node.json'), 'utf8'));
  const dir = tmp('qrp-cg-iso-');
  const file = path.join(dir, 'm.json');
  fs.writeFileSync(file, JSON.stringify({ ...m, fixture_dir: path.join(FIX, 'data'), functions: m.functions.filter((f) => ['memoCenteredMean', 'priorBarDirection', 'expandingMeanWithCache'].includes(f.entry)) }));
  const strict = byEntry(core.runManifest(file, { codeRoot: ROOT, registeredBy: 'TEST', isolation: 'PROCESS_PER_CALL', k: 4 }));
  assert.equal(strict.memoCenteredMean.t_c1, 'FAIL');
  assert.equal(strict.memoCenteredMean.isolation, 'PROCESS_PER_CALL');
  assert.equal(states(strict.priorBarDirection), 'PASS PASS PASS');
  assert.equal(states(strict.expandingMeanWithCache), 'PASS PASS FAIL');
  assert.equal(byEntry(run(path.join(FIX, 'manifest.node.json'))).memoCenteredMean.isolation, 'MODULE_RELOAD');
  assert.throws(() => core.runManifest(file, { codeRoot: ROOT, registeredBy: 'TEST', isolation: 'NONE' }), /ISOLATION_INVALID/);
});

/** 在临时目录里放一个最小清单（夹具目录 data/，函数文件 f.js），返回清单路径。 */
function mini({ rows, fn = 'module.exports.f = (bars) => bars.map((b) => b.close);', input = {}, extra = {}, manifest = {} }) {
  const dir = tmp('qrp-cg-mini-');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'bars.json'), JSON.stringify(rows));
  fs.writeFileSync(path.join(dir, 'f.js'), fn);
  const m = { schema: 'CAUSALITY_MANIFEST_V1', study_ref: 'MINI', k2_sha256: 'a'.repeat(64), code_repo: 'mini', fixture_dir: 'data', ...manifest,
    functions: [{ path: 'f.js', entry: 'f', inputs: [{ name: 'bars', file: 'bars.json', availability: { rule: 'DATE_AT', field: 'date', time: '15:00', tz: '+08:00' }, ...input }], call: { order: ['bars'] }, output: { align: 'ALIGNED', to: 'bars' }, ...extra }] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return { dir, file: path.join(dir, 'manifest.json') };
}
const days = (n) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 2 + i)).toISOString().slice(0, 10), close: 10 + i }));

test('可得时点失败即关：算不出可得时点的行、输入里带标签列、盘中输入没有盘中截点，T-C1 与 T-C2 都判 FAIL；规则写错直接报错', () => {
  const one = (o) => core.runManifest(mini(o).file, { registeredBy: 'TEST', k: 3 }).functions[0];
  const bad = one({ rows: [...days(5), { date: 'n/a', close: 1 }] });
  assert.equal(states(bad), 'FAIL FAIL PASS');
  assert.equal(bad.fail_reasons.t_c1, 'AVAILABILITY_UNKNOWN:bars[5]');
  const label = one({ rows: days(6).map((r) => ({ ...r, fwd_ret_5d: 0.01 })), manifest: { label_fields: ['fwd_ret_5d'] } });
  assert.equal(label.fail_reasons.t_c1, 'LABEL_IN_INPUT:bars.fwd_ret_5d');
  const intraday = one({ rows: days(6).map((r) => ({ time: `${r.date}T15:00:00+08:00`, close: r.close })), input: { availability: { rule: 'FIELD', field: 'time' }, intraday: true }, extra: { session: { open: '09:30', close: '15:00', tz: '+08:00' } } });
  assert.equal(intraday.fail_reasons.t_c1, 'NO_INTRADAY_CUT');
  const naive = one({ rows: days(4).map((r) => ({ time: `${r.date}T15:00:00`, close: r.close })), input: { availability: { rule: 'FIELD', field: 'time' } } });
  assert.match(naive.fail_reasons.t_c1, /^AVAILABILITY_UNKNOWN/); // 不带时区的时间不认
  assert.throws(() => one({ rows: days(4), input: { availability: { rule: 'RULED_LAG', field: 'date', time: '15:00', tz: '+08:00', lag_seconds: 86400 } } }), /AVAILABILITY_RULE_INVALID/);
  assert.throws(() => one({ rows: days(4), input: { availability: { rule: 'BUSINESS_DATE', field: 'date' } } }), /AVAILABILITY_RULE_INVALID/);
  // 报表按 ann_date 次日 00:00 可知：DATE_AT + offset_days
  const at = core.internals.availabilityOf({ rule: 'DATE_AT', field: 'ann_date', time: '00:00', tz: '+08:00', offset_days: 1 }, 't');
  assert.equal(new Date(at({ ann_date: '20250430' })).toISOString(), '2025-04-30T16:00:00.000Z');
  // 运行器出错（入口不是函数）也判 FAIL，T-C3 记运行器失败
  const noEntry = one({ rows: days(5), fn: 'module.exports.g = 1;' });
  assert.equal(states(noEntry), 'FAIL FAIL FAIL');
  assert.match(noEntry.fail_reasons.t_c3, /^INIT_FAILED/);
});

test('T-C3 加载段与调用段：仓库自己的数据文件（含加载时 require 的 .json）不声明就判 FAIL，声明进 static_reads（记 sha256，文件或目录）才可读；列目录可以；写文件一律不行', () => {
  const lazy = `const fs = require('fs'); const path = require('path');
    let cfg = null; module.exports.f = (bars) => { cfg = cfg || JSON.parse(fs.readFileSync(path.join(__dirname, 'cfg.json'), 'utf8')); return bars.map((b) => b.close * cfg.k); };`;
  const atLoad = `const cfg = require('./cfg.json'); module.exports.f = (bars) => bars.map((b) => b.close * cfg.k);`;
  // 加载时读进「全量历史」：不声明的话，三项测试里只有 T-C3 拦得住（前缀与全段都读同一份文件，T-C1、T-C2 看不出）
  const history = `const hist = require('./cfg.json'); module.exports.f = (bars) => bars.map((b) => b.close * hist.k);`;
  const dirRead = `const fs = require('fs'); const path = require('path'); const dir = path.join(__dirname, 'conf');
    module.exports.f = (bars) => { const k = fs.readdirSync(dir).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).k).reduce((a, b) => a + b, 0); return bars.map((b) => b.close * k); };`;
  const listOnly = `const fs = require('fs'); module.exports.f = (bars) => { const n = fs.readdirSync(__dirname).length; return bars.map((b) => b.close + n * 0); };`;
  const writes = `const fs = require('fs'); module.exports.f = (bars) => { try { fs.writeFileSync(require('os').tmpdir() + '/cg-x', 'x'); } catch {} return bars.map((b) => b.close); };`;
  const go = (fn, extra = {}) => {
    const m = mini({ rows: days(8), fn, extra });
    fs.writeFileSync(path.join(m.dir, 'cfg.json'), '{"k":2}');
    fs.mkdirSync(path.join(m.dir, 'conf'));
    fs.writeFileSync(path.join(m.dir, 'conf', 'a.json'), '{"k":1}');
    fs.writeFileSync(path.join(m.dir, 'conf', 'b.json'), '{"k":3}');
    return core.runManifest(m.file, { registeredBy: 'TEST', k: 3 }).functions[0];
  };
  const lazyFail = go(lazy);
  assert.equal(states(lazyFail), 'FAIL FAIL FAIL');
  assert.equal(lazyFail.fail_reasons.t_c3, 'FS_READ:<code>/cfg.json');
  const declared = go(lazy, { static_reads: ['cfg.json'] });
  assert.equal(states(declared), 'PASS PASS PASS');
  assert.deepEqual(declared.static_reads, [{ path: 'cfg.json', kind: 'FILE', sha256: require('crypto').createHash('sha256').update('{"k":2}').digest('hex') }]);
  const loaded = go(atLoad);
  assert.equal(states(loaded), 'FAIL FAIL FAIL');
  assert.deepEqual(loaded.forbidden_attempts.map((a) => `${a.phase}:${a.kind}:${a.target}`), ['LOAD:FS_READ:<code>/cfg.json']);
  const hist = go(history, { static_reads: ['cfg.json'] });
  assert.equal(states(hist), 'PASS PASS PASS');
  assert.deepEqual(hist.load_reads, ['<code>/cfg.json']); // 声明过的加载期读取照样逐条披露
  assert.equal(states(go(dirRead)), 'FAIL FAIL FAIL');
  const dir = go(dirRead, { static_reads: ['conf'] });
  assert.equal(states(dir), 'PASS PASS PASS');
  assert.deepEqual([dir.static_reads[0].kind, dir.static_reads[0].files], ['DIR', 2]);
  assert.equal(states(go(listOnly)), 'PASS PASS PASS'); // 列目录只得到文件名，不算读数据
  const w = go(writes);
  assert.equal(w.t_c3, 'FAIL');
  assert.match(w.fail_reasons.t_c3, /^FS_WRITE:/);
});

test('读数只有一种值（全空、全报错、恒定）判不过：过滤字段与行不符、读数全为空的「防线看起来在」也拦得住', () => {
  const one = (fn, rows = days(8)) => core.runManifest(mini({ rows, fn }).file, { registeredBy: 'TEST', k: 3 }).functions[0];
  const constant = one('module.exports.f = (bars) => bars.map(() => 1);');
  assert.equal(states(constant), 'FAIL PASS PASS');
  assert.equal(constant.fail_reasons.t_c1, 'DEGENERATE_OUTPUT:1_distinct_of_8');
  // 守卫按 date 过滤，行里只有 trade_date：每个点都过滤成空，读数全为 null
  const inert = `module.exports.f = (bars) => bars.map((b, i) => { const seen = bars.slice(0, i + 1).filter((r) => r.date <= b.trade_date); return seen.length ? seen[seen.length - 1].close : null; });`;
  const rows = days(8).map((r) => ({ trade_date: r.date, close: r.close, date: undefined }));
  const res = core.runManifest(mini({ rows: rows.map(({ date: _d, ...r }) => r), fn: inert, input: { availability: { rule: 'DATE_AT', field: 'trade_date', time: '15:00', tz: '+08:00' } } }).file, { registeredBy: 'TEST', k: 3 }).functions[0];
  assert.equal(res.fail_reasons.t_c1, 'DEGENERATE_OUTPUT:1_distinct_of_8');
  assert.deepEqual(res.readings_summary, { count: 8, distinct: 1, null_or_error: 8 });
  const ok = one('module.exports.f = (bars) => bars.map((b) => b.close);');
  assert.deepEqual(ok.readings_summary, { count: 8, distinct: 8, null_or_error: 0 });
});

test('逐时点函数的 FIELD 写法（smartflow 的 ctx.asOf）：t 取主输入该行的字段，写进参数对象的键；可同时注入行号与字段', () => {
  const fn = `module.exports.f = (bars, ctx) => { const seen = bars.filter((b) => b.closeTime <= ctx.asOf); return seen.length ? seen[seen.length - 1].close : null; };
    module.exports.leaky = (bars, ctx) => { const i = bars.findIndex((b) => b.closeTime === ctx.asOf); return bars[Math.min(i + 1, bars.length - 1)].close; };
    module.exports.both = (bars, i, ctx) => (bars[i].closeTime <= ctx.asOf ? bars[i].close / bars[Math.max(0, i - 1)].close : null);
    module.exports.bothLeaky = (bars, i, ctx) => (bars[i].closeTime <= ctx.asOf ? bars[Math.min(i + 1, bars.length - 1)].close : null);`;
  const rows = days(10).map((r) => ({ closeTime: Date.parse(`${r.date}T16:00:00-05:00`), close: r.close }));
  const shape = { call: { order: ['bars'], params: [{ market: 'US' }], at: { position: 1, value: 'FIELD', field: 'closeTime', key: 'asOf' } }, output: { align: 'AT_POINT', to: 'bars' } };
  const m = mini({ rows, fn, input: { availability: { rule: 'FIELD', field: 'closeTime' } }, extra: shape });
  const manifest = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  const two = { ...manifest.functions[0], call: { order: ['bars'], params: [{ market: 'US' }], at: [{ position: 1, value: 'FIELD', field: 'closeTime', key: 'asOf' }, { position: 1, value: 'INDEX' }] } }; // 依次：先把 asOf 写进 ctx，再在 1 号位插入行号 → f(bars, i, ctx)
  manifest.functions.push({ ...manifest.functions[0], entry: 'leaky' }, { ...two, entry: 'both' }, { ...two, entry: 'bothLeaky' });
  fs.writeFileSync(m.file, JSON.stringify(manifest));
  const f = byEntry(core.runManifest(m.file, { registeredBy: 'TEST', k: 4 }));
  assert.equal(states(f.f), 'PASS PASS PASS');
  assert.equal(f.leaky.t_c1, 'FAIL');
  assert.equal(states(f.both), 'PASS PASS PASS');
  assert.equal(f.bothLeaky.t_c1, 'FAIL');
});

test('证据：record_hash 由门的同一函数复算；改一个字节就不认；写一次不改，旁边写 .sha256；命令行退出码 2 表示有 FAIL', () => {
  const doc = run(path.join(FIX, 'manifest.node.json'));
  assert.equal(doc.schema, 'CAUSALITY_EVIDENCE_V1');
  assert.equal(doc.contract_ref, 'artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_FREEZE_1.md@c9742ea0');
  assert.equal(doc.harness_version, core.HARNESS_VERSION);
  assert.equal(doc.harness_sha256, core.harnessSha256());
  assert.equal(doc.seed, gate.SEED);
  assert.equal(doc.cut_points_per_function, gate.CUT_POINTS);
  assert.equal(gate.parseEvidence(Buffer.from(JSON.stringify(doc))).record_hash, doc.record_hash);
  const tampered = JSON.parse(JSON.stringify(doc));
  tampered.functions[0].t_c1 = 'PASS';
  delete tampered.functions[0].fail_reasons.t_c1;
  assert.throws(() => gate.parseEvidence(Buffer.from(JSON.stringify(tampered))), /CAUSALITY_EVIDENCE_RECORD_HASH_MISMATCH/);
  const out = path.join(tmp('qrp-cg-ev-'), 'CAUSALITY_EVIDENCE_V1.json');
  const digest = core.writeEvidence(out, doc);
  assert.equal(fs.readFileSync(`${out}.sha256`, 'utf8'), `${digest}  CAUSALITY_EVIDENCE_V1.json\n`);
  assert.throws(() => core.writeEvidence(out, doc), /EVIDENCE_EXISTS/);
  // 同一清单重跑：除登记时刻外逐字节相同
  const again = core.runManifest(path.join(FIX, 'manifest.node.json'), { codeRoot: ROOT, registeredBy: 'TEST', registeredAt: '2026-11-15T14:00:00Z' });
  assert.equal(again.record_hash, doc.record_hash);
  assert.throws(() => cli.parse(['--manifest', 'x']), /usage/);
  assert.throws(() => cli.parse(['--manifest', 'x', '--registered-by', 'y', '--bogus']), /unknown flag/);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/causality-harness/run.js'), '--manifest', mini({ rows: days(6), fn: 'module.exports.f = (b) => b.map((x, i) => (b[i + 1] || x).close);' }).file, '--registered-by', 'TEST']);
  assert.equal(r.status, 2, String(r.stderr));
  assert.match(String(r.stdout), /^FAIL FAIL PASS {2}mini:f\.js#f/);
});

test('code_sha：被测文件已提交且已跟踪文件没改动时写 HEAD；有改动或没跟踪时写 null，原因进 unknown（门见到就拒绝）', () => {
  const m = mini({ rows: days(6) });
  const git = (...a) => execFileSync('git', ['-C', m.dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
  git('init', '-q');
  assert.equal(core.runManifest(m.file, { registeredBy: 'TEST', k: 2 }).unknown.code_sha, 'NO_COMMIT');
  git('add', 'manifest.json'); git('commit', '-q', '-m', 'manifest only');
  const untracked = core.runManifest(m.file, { registeredBy: 'TEST', k: 2 });
  assert.equal(untracked.code_sha, null);
  assert.equal(untracked.unknown.code_sha, 'FUNCTION_FILE_UNTRACKED:f.js');
  git('add', '.'); git('commit', '-q', '-m', 'x');
  const clean = core.runManifest(m.file, { registeredBy: 'TEST', k: 2 });
  assert.equal(clean.code_sha, git('rev-parse', 'HEAD'));
  assert.deepEqual(clean.unknown, {});
  fs.appendFileSync(path.join(m.dir, 'f.js'), '\n// edit\n');
  const dirty = core.runManifest(m.file, { registeredBy: 'TEST', k: 2 });
  assert.equal(dirty.code_sha, null);
  assert.equal(dirty.unknown.code_sha, 'WORKTREE_DIRTY');
  const nogit = core.runManifest(mini({ rows: days(6) }).file, { registeredBy: 'TEST', k: 2 });
  assert.equal(nogit.unknown.code_sha, 'NOT_A_GIT_REPO');
});

test('扰动：受保护的列（可得时点、key_fields、keep_fields）不动，t ≤ c 的行不动；随机游走保持整数列为整数', () => {
  const input = { name: 'p', rows: [1, 2, 3, 4].flatMap((d) => ['A', 'B'].map((code) => ({ date: `2025-01-0${d}`, code, close: 10 + d, vol: 100 * d }))),
    availability: { rule: 'DATE_AT', field: 'date', time: '15:00', tz: '+08:00' }, key_fields: ['code'], keep_fields: [] };
  input.avail = input.rows.map((r) => Date.parse(`${r.date}T15:00:00+08:00`));
  const c = input.avail[3];
  for (const v of core.VARIANTS) {
    const out = core.internals.replaceFuture(input, c, v, 'tag');
    out.forEach((row, i) => {
      assert.equal(row.date, input.rows[i].date); assert.equal(row.code, input.rows[i].code);
      if (input.avail[i] <= c) assert.equal(row, input.rows[i]);
      assert.ok(Number.isInteger(row.vol));
    });
    assert.ok(out.some((row, i) => input.avail[i] > c && (row.close !== input.rows[i].close || row.vol !== input.rows[i].vol)), v);
  }
  // 为什么要两种扰动：单边上涨的序列上，打乱未来行序后未来仍然都高于截点（「下一根方向」类前视看不出），随机游走才会走到截点之下
  const up = { name: 'b', rows: Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, close: 100 + i })), availability: { field: 'date' }, key_fields: [], keep_fields: [] };
  up.avail = up.rows.map((_, i) => i);
  const below = (v) => [...Array(20).keys()].some((c) => core.internals.replaceFuture(up, c, v, `t${c}`)[c + 1].close < up.rows[c].close);
  assert.deepEqual([below('SHUFFLE'), below('WALK')], [false, true]);
});
