'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bridge = require('../adapters/replay-core-bridge');
const CacheJobs = require('../adapters/replay-core-bridge/cache_jobs');
const Backfill = require('../adapters/replay-core-bridge/carry_backfill');
const M1 = require('../adapters/replay-core-bridge/carry_m1');
const Onb = require('../adapters/replay-core-bridge/carry_onboarding');

const tmp = (p = 'qrp-carry-onb-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = process.env[bridge.ROOT_ENV];
const FIXTURE = path.join(__dirname, '_carry_v2_onboarding_fixture.js');
const BACKFILL = path.join(__dirname, '..', 'adapters', 'replay-core-bridge', 'carry_backfill.js');
const SKIP = !ROOT && `${bridge.ROOT_ENV} 未设置(需要钉住的 smartflow 检出)`;
const SYN = { name: 'SYN', start: Date.UTC(2024, 0, 15), end: Date.UTC(2024, 1, 15) };

function fixture(args, cwd) {
  const r = spawnSync(process.execPath, [FIXTURE, args[0], path.resolve(ROOT), ...args.slice(1)], { cwd: cwd || os.tmpdir(), env: bridge.childEnv(), encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 1 << 26 });
  return { status: r.status, out: r.stdout, err: String(r.stderr || '').trim() };
}
const fixtureJson = (args) => { const r = fixture(args); assert.equal(r.status, 0, r.err); return JSON.parse(r.out); };

/** 回填两遍,各一个新进程(A 遍只记结果;B 遍与 A 遍比 G3);返回 B 遍回执。 */
function runBackfill(args, out) {
  fs.mkdirSync(out, { recursive: true });
  let last = null;
  for (const pass of ['A', 'B']) {
    const a = { group: 'SYN', ...args, again: pass === 'B' ? path.join(out, 'a0-4-backfill.SYN.A.json') : null };
    const argsFile = path.join(out, `args.${pass}.json`);
    fs.writeFileSync(argsFile, JSON.stringify(a));
    const r = spawnSync(process.execPath, [BACKFILL, '--root', path.resolve(ROOT), '--args', argsFile, '--out', out], { cwd: os.tmpdir(), env: bridge.childEnv(), encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 1 << 26 });
    last = { status: r.status, err: String(r.stderr || '').trim(), receipt: r.status === 0 ? JSON.parse(fs.readFileSync(path.join(out, `a0-4-backfill.SYN.${pass}.json`), 'utf8')) : null };
    if (r.status !== 0) return last;
  }
  return last;
}

// ---- 纯函数 -------------------------------------------------------------------------------------------------------------

test('jobs_sha256 = PR #48 证明的口径(Python json.dumps 默认分隔符)', () => {
  const jobs = [{ payload_sha256: 'a'.repeat(64), harness_output_sha256: 'b'.repeat(64) }, { payload_sha256: 'c'.repeat(64), harness_output_sha256: 'd'.repeat(64) }];
  assert.equal(Onb.jobsSha256(jobs), '9ebe95f39ac80b0fa9fd59b2c48089d17c6bcb72823e17495f71dca62884ff06');
  assert.equal(Onb.jobsSha256([]), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
});

test('restoreNative:数组按旧引擎的类型还原,数值不变;形状不符拒绝', () => {
  const native = { equity: [5000, 5000.5, 4999.25], held: [0, 1], events: [], episodes: [], counts: {}, diag: {}, acc: {}, identity: {}, params: {} };
  const r = Backfill.restoreNative(native);
  assert.ok(r.equity instanceof Float64Array);
  assert.ok(r.held instanceof Uint8Array);
  assert.deepEqual(Array.from(r.equity), native.equity);
  assert.deepEqual(Array.from(r.held), native.held);
  assert.equal(r.events, native.events);
  assert.throws(() => Backfill.restoreNative({ ...native, held: [0, 2.5] }), /RESTORE_SHAPE:held/);
  assert.throws(() => Backfill.restoreNative({ ...native, equity: [1, null] }), /RESTORE_SHAPE:equity/);
  assert.throws(() => Backfill.restoreNative({ ...native, acc: null }), /RESTORE_SHAPE:acc/);
  assert.throws(() => Backfill.restoreNative([]), /RESTORE_SHAPE:native/);
});

test('载荷内容 sha256:与 V8 内部表示无关(同形对象被推广后的 0、单 / 双字节串),内容不同则不同', () => {
  const v8 = require('v8');
  const mk = () => ({ X: 0.5, MMR: 0.01, mode: 'RULES', idleRate: 0 });
  const a = mk();
  const before = v8.serialize(a);
  const generalised = { ...a, idleRate: 0.05 }; // 跑数器 R4 的写法:同形字段被推广为双精度
  const b = mk();
  assert.notDeepEqual(v8.serialize(b), before, '同内容的 v8 字节随进程里的形状演变而变(本测试要复现的就是这一点)');
  assert.equal(Backfill.contentDigest(b), Backfill.contentDigest(a));
  assert.notEqual(Backfill.contentDigest(generalised), Backfill.contentDigest(a));
  const twoByte = Buffer.from('CARRY', 'utf16le').toString('utf16le');
  assert.equal(Backfill.contentDigest({ strategy: twoByte }), Backfill.contentDigest({ strategy: 'CARRY' }));
  const D = Backfill.contentDigest;
  assert.notEqual(D([0]), D([-0]));
  assert.notEqual(D([undefined]), D(new Array(1)));
  assert.notEqual(D([1, 2]), D(new Float64Array([1, 2])));
  assert.notEqual(D(new Map([['a', 1]])), D({ a: 1 }));
  assert.notEqual(D({ a: 1, b: 2 }), D({ b: 2, a: 1 }));
  assert.notEqual(D('1'), D(1));
  assert.equal(D(v8.deserialize(v8.serialize({ m: new Map([[1, [1.5, null]]]), t: new Uint8Array([1, 0]) }))), D({ m: new Map([[1, [1.5, null]]]), t: new Uint8Array([1, 0]) }));
  assert.throws(() => D({ f: () => 1 }), /CONTENT_DIGEST_UNSUPPORTED:function/);
  assert.throws(() => D(new Set([1])), /CONTENT_DIGEST_UNSUPPORTED:Set/);
});

test('判定对象比较:六个对象逐个;关键数与 K2 原值逐字节', () => {
  const sealed = { gates: { a: 1 }, verdict: { result: 'INSUFFICIENT' }, table: {}, alts: {}, rV1Link: {}, seenData: 's', inputs: { x: 1 } };
  assert.equal(Onb.compareVerdict({ ...sealed, inputs: { x: 2 } }, sealed).identical, true);
  const d = Onb.compareVerdict({ ...sealed, gates: { a: 2 } }, sealed);
  assert.equal(d.identical, false);
  assert.deepEqual(d.rows.find((r) => r.object === 'gates').diffs, ['$.gates.a']);
  const want = Onb.SPEC.verdict_expected;
  const v = { result: want.result, failingK: want.failingK, next: want.next, criteria: { K1: { pass: false, ...want.K1, margin: 0.01 }, K2: { pass: true, ...want.K2, bar: 0.05 }, K3: { pass: true, ...want.K3 }, K4: { pass: true, value: want.K4 }, K5: { pass: true, value: want.K5 } } };
  assert.equal(Onb.expectedVerdictFigures(v).identical, true);
  assert.equal(Onb.expectedVerdictFigures({ ...v, criteria: { ...v.criteria, K4: { value: 0.0053787674798 } } }).identical, false);
});

test('两遍比较:只有写明的易变字段可以不同', () => {
  const a = tmp();
  const b = tmp();
  const both = (n, x, y) => { fs.mkdirSync(path.dirname(path.join(a, n)), { recursive: true }); fs.mkdirSync(path.dirname(path.join(b, n)), { recursive: true }); fs.writeFileSync(path.join(a, n), x); fs.writeFileSync(path.join(b, n), y); };
  both('m1.receipt.json', '{"x":1}\n', '{"x":1}\n');
  both('a0-2/V2_W1.json', '{"resultsSha256":"r","generatedAt":"t1"}\n', '{"resultsSha256":"r","generatedAt":"t2"}\n');
  both('a0-2/V2_VERDICT.json', '{"verdict":1,"inputs":{"tests":{"sha256":"p"}}}\n', '{"verdict":1,"inputs":{"tests":{"sha256":"q"}}}\n');
  both('a0-2/V2_TESTS.json', '{"startTime":1}\n', '{"startTime":2}\n');
  let r = Onb.sealCompare(a, b);
  assert.equal(r.pass, true, JSON.stringify(r.rows));
  assert.deepEqual([r.byte_identical, r.identical_except_volatile, r.projection_compared], [1, 2, 1]);
  both('a0-2/V2_W2.json', '{"resultsSha256":"r","generatedAt":"t1"}\n', '{"resultsSha256":"s","generatedAt":"t1"}\n');
  fs.writeFileSync(path.join(a, 'only-a.json'), '{}');
  r = Onb.sealCompare(a, b);
  assert.equal(r.pass, false);
  assert.equal(r.different, 1);
  assert.equal(r.missing, 1);
  both('a0-4/a0-4-backfill.receipt.json', '{"generatedAt":"t1"}\n', '{"generatedAt":"t2"}\n');
  // A0-4 的参数文件:只差本遍目录的绝对路径 → 换成 <PASS_DIR> 后逐字节相同;别的不同照样是 DIFFERENT
  both('a0-4/args.G.A.json', `{"jobs":["${a}/a0-3/jobs/CARRY"],"again":null}\n`, `{"jobs":["${b}/a0-3/jobs/CARRY"],"again":null}\n`);
  both('a0-4/args.G.B.json', `{"jobs":["${a}/a0-3/jobs/CARRY"],"windows":["IS"]}\n`, `{"jobs":["${b}/a0-3/jobs/CARRY"],"windows":["OOS"]}\n`);
  const p = Onb.sealCompare(a, b);
  assert.equal(p.rows.find((x) => x.file === 'a0-4/args.G.A.json').verdict, 'IDENTICAL_EXCEPT_PASS_PATH');
  assert.equal(p.rows.find((x) => x.file === 'a0-4/args.G.B.json').verdict, 'DIFFERENT');
  assert.equal(Onb.sealCompare(a, b).rows.find((x) => x.file === 'a0-4/a0-4-backfill.receipt.json').verdict, 'DIFFERENT');
});

test('M1 小工具:字段路径(键里有点)、日历整月、前向数值键拒写', () => {
  assert.equal(M1.getField({ code: { 'scripts/a.js': 'h' } }, 'code.scripts/a.js'), 'h');
  assert.equal(M1.getField({ a: { b: { c: 1 } } }, 'a.b.c'), 1);
  assert.equal(M1.getField({ a: {} }, 'a.b'), undefined);
  const f = Date.parse('2026-10-02T16:00:00Z');
  assert.equal(M1.completeMonths(f, Date.parse('2026-11-02T15:59:59Z')), 0);
  assert.equal(M1.completeMonths(f, Date.parse('2026-11-02T16:00:00Z')), 1);
  assert.equal(M1.completeMonths(f, Date.parse('2027-12-31T00:00:00Z')), 14);
  assert.equal(M1.completeMonths(null, f), 0);
  assert.doesNotThrow(() => M1.assertNoForwardValues({ rows_by_type: { MTM: 3 }, max_identity_residual_usdt: 0 }));
  assert.throws(() => M1.assertNoForwardValues({ trace: [{ a7: 0.1 }] }), /FORWARD_VALUE_LEAK:\$\.trace\[0\]\.a7/);
  assert.throws(() => M1.assertNoForwardValues({ x: { equity: 5000 } }), /FORWARD_VALUE_LEAK/);
});

test('M1-1 记录核对:文本来源同一行要有 anchor 与值;JSON 来源按字段;不符与无先前记录分开计', () => {
  const pkgRoot = tmp();
  fs.mkdirSync(path.join(pkgRoot, 'docs', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'docs', 'a.md'), 'signed text');
  const sha = require('crypto').createHash('sha256').update('signed text').digest('hex');
  fs.writeFileSync(path.join(pkgRoot, 'docs', 'evidence', 'e.json'), JSON.stringify({ acceptance: { sha256: sha } }));
  fs.writeFileSync(path.join(pkgRoot, 'docs', 'b.md'), 'other');
  const spec = {
    history_sources: { K2: { kind: 'TEXT', from: 'k2' }, EV: { kind: 'JSON', path: 'docs/evidence/e.json' } },
    history: [
      { group: 'g', path: 'docs/a.md', view: 'FILE', recorded: [{ source: 'K2', value: sha.slice(0, 8), anchor: 'a.md' }, { source: 'EV', field: 'acceptance.sha256' }] },
      { group: 'g', path: 'docs/b.md', view: 'FILE', recorded: [] },
      { group: 'g', path: 'docs/a.md', view: 'PREFIX:6', recorded: [{ source: 'K2', value: 'deadbeef', anchor: 'a.md' }] },
    ],
  };
  const k2Text = `| \`docs/a.md\` | \`${sha.slice(0, 8)}…\` |\n| \`docs/a.md\` 前缀 | \`deadbeef…\` |`;
  const r = M1.historyCheck({ pkgRoot, k2Text, spec, pin: {} });
  assert.deepEqual([r.matched, r.no_prior_record, r.mismatched, r.pass], [1, 1, 1, false]);
  const moved = M1.historyCheck({ pkgRoot, k2Text: `docs/a.md\n${sha.slice(0, 8)}`, spec: { ...spec, history: [spec.history[0]] }, pin: {} });
  assert.equal(moved.rows[0].recorded[0].provenance, 'TEXT_LINE_MISSING');
  assert.equal(moved.pass, false);
});

test('规格:身份与 K2 一致;历史清单的来源都已登记', () => {
  const S = Onb.SPEC;
  assert.equal(S.identity.strategy_ref, 'CARRY_V2_SHADOW_10000USDT');
  assert.equal(S.identity.case_ref, 'RRC-CARRY-V2-10000USDT-V8-1-M0');
  assert.equal(S.k2.sha256, '319a055d58e0c1d3fe1d4042cf592680deaca7e097d8e398c42bc1bfc19cc1ba');
  for (const h of S.history) for (const r of h.recorded) assert.ok(S.history_sources[r.source], r.source);
  const keys = S.history.map((h) => `${h.path}#${h.view}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(S.history.filter((h) => h.group === 'evidence').length, 16);
  assert.equal(Object.values(S.pr48.groups).reduce((n, g) => n + g.jobs, 0), 70);
});

// ---- 钉住的 smartflow 上 ----------------------------------------------------------------------------------------------

test('作业输出还原 = 旧引擎返回(V2 口径一个 sleeve:stableJson、类型、逐元素 Object.is、sleeveSummary)', { skip: SKIP }, () => {
  const r = fixtureJson(['RESTORE', tmp('qrp-carry-arch-')]);
  assert.deepEqual(r, { ...r, stableEqual: true, equityType: 'Float64Array', heldType: 'Uint8Array', legacyEquityType: 'Float64Array', legacyHeldType: 'Uint8Array', equityObjectIs: true, heldObjectIs: true, summaryEqual: true });
});

for (const [label, win] of [['V1 windowLines', SYN], ['V2 windowLinesV2(平 4.5% 闲置利率)', { ...SYN, idleFlat: 0.045 }]]) {
  test(`回填重组(${label}):小窗口回填结果 = 跑数器直接算;按载荷内容对号(载荷文件逐字节核过),作业全用上`, { skip: SKIP }, () => {
    const base = tmp();
    const archive = path.join(base, 'archive');
    fs.mkdirSync(archive);
    const jobs = path.join(base, 'jobs');
    const w = fixture(['JOBS', jobs, archive, JSON.stringify(win)], base);
    assert.equal(w.status, 0, w.err);
    const manifest = JSON.parse(fs.readFileSync(path.join(jobs, CacheJobs.manifestFile('CARRY')), 'utf8'));
    assert.equal(manifest.harness_verdict, 'BYTE_IDENTICAL');
    assert.equal(manifest.jobs.length, 14);
    const want = fixtureJson(['DIRECT', archive, JSON.stringify(win)]);
    const out = path.join(base, 'a0-4');
    const r = runBackfill({ data: archive, windows: [win], jobs: [jobs] }, out);
    assert.equal(r.status, 0, r.err);
    const row = r.receipt.windows[0];
    assert.equal(row.resultsSha256, want.resultsSha256);
    assert.equal(row.G3.pass, true);
    assert.equal(row.jobs_same_both_passes, true);
    assert.equal(row.sleeves, 14);
    assert.deepEqual([r.receipt.jobs_used, r.receipt.jobs_unused, r.receipt.calls], [14, 0, 14]);
    assert.ok(row.calls.every((c) => /^[0-9a-f]{64}$/.test(c.content_sha256) && typeof c.raw_identical === 'boolean'));
    // 调用顺序不是对号依据:清单里的作业顺序打乱,结果不变
    const shuffled = path.join(base, 'jobs-shuffled');
    fs.cpSync(jobs, shuffled, { recursive: true });
    const m2 = { ...manifest, jobs: [...manifest.jobs].reverse() };
    fs.writeFileSync(path.join(shuffled, CacheJobs.manifestFile('CARRY')), `${JSON.stringify(m2, null, 1)}\n`);
    const r2 = runBackfill({ data: archive, windows: [win], jobs: [shuffled] }, path.join(base, 'a0-4-shuffled'));
    assert.equal(r2.status, 0, r2.err);
    assert.equal(r2.receipt.windows[0].resultsSha256, want.resultsSha256);
    // 负向:作业输出与 harness 记录不符 → 拒绝;清单里缺一个作业 → 拒绝
    const bad = path.join(base, 'jobs-bad');
    fs.cpSync(jobs, bad, { recursive: true });
    const m3 = JSON.parse(JSON.stringify(manifest));
    m3.jobs[3].harness_output_sha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(bad, CacheJobs.manifestFile('CARRY')), `${JSON.stringify(m3, null, 1)}\n`);
    const r3 = runBackfill({ data: archive, windows: [win], jobs: [bad] }, path.join(base, 'a0-4-bad'));
    assert.notEqual(r3.status, 0);
    assert.match(r3.err, /BACKFILL_OUTPUT_DIFFERENT/);
    const m4 = { ...manifest, jobs: manifest.jobs.slice(1) };
    fs.writeFileSync(path.join(bad, CacheJobs.manifestFile('CARRY')), `${JSON.stringify(m4, null, 1)}\n`);
    const r4 = runBackfill({ data: archive, windows: [win], jobs: [bad] }, path.join(base, 'a0-4-missing'));
    assert.notEqual(r4.status, 0);
    assert.match(r4.err, /BACKFILL_JOB_NOT_FOUND:[0-9a-f]{16}:call=\d+$/);
    // 载荷文件被改过(与清单的 payload_sha256 不符)→ 建索引时就拒绝
    const tampered = path.join(base, 'jobs-tampered');
    fs.cpSync(jobs, tampered, { recursive: true });
    const j0 = JSON.parse(fs.readFileSync(path.join(tampered, manifest.jobs[0].job_file), 'utf8'));
    fs.appendFileSync(path.join(tampered, j0.payload_file), Buffer.from([0]));
    const r5 = runBackfill({ data: archive, windows: [win], jobs: [tampered] }, path.join(base, 'a0-4-tampered'));
    assert.notEqual(r5.status, 0);
    assert.match(r5.err, /PAYLOAD_SHA256_MISMATCH/);
  });
}

test('M1-3 / M1-4:影子自己的 fold 核链与不变量,只出计数;截止日以后的文件拒收;改内容即链断', { skip: SKIP }, () => {
  const all = tmp('qrp-carry-ledger-');
  const made = fixtureJson(['LEDGER', all, 'OK']);
  assert.deepEqual(made.files, ['2026-10-04.jsonl', '2026-10-05.jsonl', '2026-10-06.jsonl', '2026-10-07.jsonl']);
  const late = fixture(['LEDGER_CHECK', all, '2026-10-06']);
  assert.notEqual(late.status, 0);
  assert.match(late.err, /LEDGER_FILE_AFTER_CUTOFF:2026-10-07/);
  const copy = tmp('qrp-carry-ledger-copy-');
  fs.mkdirSync(path.join(copy, 'ledger'));
  for (const f of made.files.filter((x) => x.slice(0, 10) <= '2026-10-06')) fs.copyFileSync(path.join(all, 'ledger', f), path.join(copy, 'ledger', f));
  const r = fixtureJson(['LEDGER_CHECK', copy, '2026-10-06']);
  assert.equal(r.m13.fold, 'PASS', JSON.stringify(r.m13.fold_error));
  assert.equal(r.m13.hash_chain, 'INTACT');
  assert.equal(r.m13.seq_strict_plus_one, true);
  assert.deepEqual([r.m13.worker_live, r.m13.f_start, r.m13.records], [1, 1, 13]);
  assert.equal(r.m13.max_identity_residual_usdt, 0);
  assert.equal(r.m13.code_manifest.files, 13);
  assert.equal(r.m13.code_manifest.identical, 13);
  assert.equal(r.m13.pass, true);
  assert.deepEqual(r.m14.rows_by_type, { WORKER_LIVE: 1, SETTLEMENT: 4, F_START: 1, MTM: 2, DECISION: 1, MISSING: 2, MISSING_FINAL: 1, CODE_CHANGE: 1 });
  assert.deepEqual(r.m14.missing_by_what.FUNDING_ROW.reasons, { ROW_NOT_POSTED: 1 });
  assert.equal(r.m14.missing_final_by_what.FUNDING_ROW.items[0].instant, '2026-10-04T16:00:00.000Z');
  assert.deepEqual(r.m14.missing_open_at_cutoff, { rows: 1, by_what: { DTB3: 1 } });
  assert.equal(r.m14.code_change.length, 1);
  assert.equal(r.m14.forward_months.b.f_start, '2026-10-04T08:00:00.000Z');
  assert.equal(r.m14.forward_months.through, '2026-10-07T00:00:00.000Z');
  assert.deepEqual(r.shown_missing_final, { key: r.shown_missing_final.key, what: 'FUNDING_ROW', sleeve: 'ETH', instant: '2026-10-04T16:00:00.000Z', reason: 'ROW_NOT_POSTED', openSeq: 10, closeSeq: 12 });
  assert.equal(r.decision_trace.kind, 'NONE');
  assert.deepEqual(r.decision_trace.settlement_record_seqs, [2, 5]);
  assert.deepEqual(r.decision_trace.kline_record_seqs, [7]);
  assert.match(r.decision_trace.why_no_fill, /entry condition not met/);
  assert.ok(!JSON.stringify(r).includes('"a7"'));
  const bad = tmp('qrp-carry-ledger-bad-');
  const madeBad = fixtureJson(['LEDGER', bad, 'TAMPER']);
  fs.rmSync(path.join(bad, 'ledger', madeBad.files[3]));
  const rb = fixtureJson(['LEDGER_CHECK', bad, '2026-10-06']);
  assert.equal(rb.m13.fold, 'FAIL');
  assert.equal(rb.m13.fold_error.code, 'HASH_MISMATCH');
  assert.equal(rb.m13.hash_chain, 'BROKEN');
  assert.equal(rb.m13.pass, false);
});
