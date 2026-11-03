'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAdapter } = require('../adapters/registry');
const bridge = require('../adapters/replay-core-bridge');
const CacheJobs = require('../adapters/replay-core-bridge/cache_jobs');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-rc-cache-'));
const ROOT = process.env[bridge.ROOT_ENV];
const FIXTURE = path.join(__dirname, '_replay_core_cache_fixture.js');
const SKIP = !ROOT && `${bridge.ROOT_ENV} 未设置(真实缓存作业需要钉住的 smartflow 检出)`;

function withoutRoot(fn) {
  const saved = process.env[bridge.ROOT_ENV];
  delete process.env[bridge.ROOT_ENV];
  try { return fn(); } finally { if (saved !== undefined) process.env[bridge.ROOT_ENV] = saved; }
}

/** 在钉住的 smartflow 上用 smartflow 自己的合成夹具跑写作业端(注入数据,与 tier2 的管线测试同一做法)。 */
function fixtureJobs(name, out) {
  const r = spawnSync(process.execPath, [FIXTURE, path.resolve(ROOT), name, out],
    { cwd: out, env: bridge.childEnv(), encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(out, CacheJobs.manifestFile(name)), 'utf8'));
}

/** 共同验收:每个作业经注册的适配器重跑,输出字节 = 写作业时 harness 自跑的字节;harness 本身与旧引擎逐字节一致。 */
function assertJobsReproduce(manifest, out, market) {
  assert.equal(manifest.kind, CacheJobs.MANIFEST_KIND);
  assert.equal(manifest.core_version_hash, bridge.PIN.core.version_hash);
  assert.equal(manifest.smartflow_commit, bridge.PIN.smartflow.commit);
  assert.equal(manifest.harness_verdict, 'BYTE_IDENTICAL');
  assert.ok(manifest.harness.length > 0);
  assert.ok(manifest.harness.every((h) => h.verdict === 'BYTE_IDENTICAL'), JSON.stringify(manifest.harness.map((h) => h.verdict)));
  assert.ok(manifest.jobs.length > 0);
  const adapter = getAdapter(market);
  for (const j of manifest.jobs) {
    const job = JSON.parse(fs.readFileSync(path.join(out, j.job_file), 'utf8'));
    assert.equal(job.payload_sha256, j.payload_sha256);
    const art = adapter.run_backtest({ execution_model: { replay_core_job: job, job_dir: out } });
    assert.equal(art.result_hash, j.harness_output_sha256, `${j.job_file} 适配器输出 = harness 自跑输出`);
  }
  const s = adapter.snapshot({ cache_dir: out });
  assert.equal(s.coverage.jobs, manifest.jobs.length);
  assert.equal(s.coverage.payload_ok, manifest.jobs.length);
}

test('写作业端未接通即显式失败:没有 smartflow 根 / 未知来源 / 缺参数 / 已有清单不覆盖', () => {
  const out = tmpDir();
  withoutRoot(() => {
    assert.throws(() => bridge.writeCacheJobs('CARRY', { data: out }, out), /REPLAY_CORE_SOURCE_NOT_CONFIGURED:QRP_SMARTFLOW_ROOT/);
  });
  assert.throws(() => CacheJobs.checkArgs('NOPE', {}), /CACHE_SOURCE_UNSUPPORTED:NOPE/);
  assert.throws(() => CacheJobs.checkArgs('CARRY', {}), /USAGE:data/);
  assert.throws(() => CacheJobs.checkArgs('C17_CACHE', {}), /USAGE:cache/);
  assert.throws(() => CacheJobs.checkArgs('C17_AGENT_LIVE', {}), /USAGE:cache/);
  assert.throws(() => CacheJobs.checkArgs('US_V5_RECORDS', { records: out, from: '2026-10-05' }), /USAGE:to/);
  assert.deepEqual(CacheJobs.checkArgs('CARRY', { data: out }).windows, ['IS', 'OOS']);
  fs.writeFileSync(path.join(out, CacheJobs.manifestFile('CARRY')), '{}');
  assert.throws(() => CacheJobs.assertFresh(out, 'CARRY'), /CACHE_JOBS_EXIST:CARRY/);
  assert.equal(CacheJobs.SOURCES.CARRY.strategy, 'CARRY');
  assert.equal(CacheJobs.SOURCES.US_V5_RECORDS.strategy, 'US_V5');
  for (const s of ['C17_CACHE', 'C17_AGENT_LIVE', 'C17_V2_LIVE']) assert.equal(CacheJobs.SOURCES[s].strategy, 'C17');
});

test('runCacheJobs:作业输出与清单记录的 harness 字节不符即判 DIFFERENT,不吞掉', () => {
  const v = CacheJobs.verdictOf([{ job_file: 'a', harness_output_sha256: 'x' }], () => 'x');
  assert.deepEqual([v.verdict, v.identical, v.different], ['BYTE_IDENTICAL', 1, 0]);
  const w = CacheJobs.verdictOf([{ job_file: 'a', harness_output_sha256: 'x' }, { job_file: 'b', harness_output_sha256: 'y' }], (j) => (j.job_file === 'a' ? 'x' : 'z'));
  assert.deepEqual([w.verdict, w.identical, w.different], ['DIFFERENT', 1, 1]);
  assert.equal(CacheJobs.verdictOf([], () => 'x').verdict, 'NO_JOBS');
});

test('CARRY:研究归档(carry 跑数器的真实目录格式)→ 每个 sleeve 一个作业,适配器重跑逐字节一致', { skip: SKIP }, () => {
  const out = tmpDir();
  try {
    const m = fixtureJobs('CARRY', out);
    assert.equal(m.source, 'CARRY');
    assert.equal(m.strategy, 'CARRY');
    assert.match(m.source_identity[0].dataManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(m.jobs.length, m.harness.reduce((n, h) => n + h.sleeves, 0)); // 每个 sleeve 一次核心运行
    assertJobsReproduce(m, out, 'CRYPTO');
    // 同一归档再写一遍:载荷哈希完全相同(作业是数据的确定函数)
    const again = tmpDir();
    try {
      const m2 = fixtureJobs('CARRY', again);
      assert.deepEqual(m2.jobs.map((j) => j.payload_sha256), m.jobs.map((j) => j.payload_sha256));
    } finally { fs.rmSync(again, { recursive: true, force: true }); }
    const ran = bridge.runCacheJobs(out, 'CARRY');
    assert.equal(ran.verdict, 'BYTE_IDENTICAL');
    assert.equal(ran.identical, m.jobs.length);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('C17_CACHE:数据集(loadFuturesDataset 同形)→ 每个情景一个作业,适配器重跑逐字节一致', { skip: SKIP }, () => {
  const out = tmpDir();
  try {
    const m = fixtureJobs('C17_CACHE', out);
    assert.equal(m.strategy, 'C17');
    assert.deepEqual(m.harness.map((h) => h.window.split(' ').pop()), ['BASE', 'ADVERSE']);
    assert.equal(m.jobs.length, 2);
    assertJobsReproduce(m, out, 'CRYPTO');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('C17_AGENT_LIVE:线上回放的每次调用(臂 × 止盈期)一个作业,止盈叠加随作业带走', { skip: SKIP }, () => {
  const out = tmpDir();
  try {
    const m = fixtureJobs('C17_AGENT_LIVE', out);
    assert.equal(m.jobs.length, 3);
    assert.deepEqual(m.harness.map((h) => h.window.split(' ')[3]), ['PRE_EFFICIENCY', 'PRE_EFFICIENCY', 'EFFICIENCY_PAPER']);
    assert.ok(m.jobs.every((j) => j.options.skipInputHash === true));
    assertJobsReproduce(m, out, 'CRYPTO');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('C17_V2_LIVE:线上回放(parity 缓存 + 名单记录)的一次调用一个作业,适配器重跑逐字节一致', { skip: SKIP }, () => {
  const out = tmpDir();
  try {
    const m = fixtureJobs('C17_V2_LIVE', out);
    assert.equal(m.jobs.length, 1);
    assert.match(m.harness[0].window, /^C17_V2 live replay C17_V2 /);
    assert.match(m.source_identity[0].replayVersion, /^C17_V2_LIVE_REPLAY_V1:[0-9a-f]{64}:[0-9a-f]{64}$/);
    assertJobsReproduce(m, out, 'CRYPTO');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('US_V5_RECORDS:扫描记录 → 账本回放交给出场规则的持仓,一个作业,适配器重跑逐字节一致', { skip: SKIP }, () => {
  const out = tmpDir();
  try {
    const m = fixtureJobs('US_V5_RECORDS', out);
    assert.equal(m.strategy, 'US_V5');
    assert.equal(m.jobs.length, 1);
    assertJobsReproduce(m, out, 'US_EQUITY');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('US_V5_RECORDS 磁盘路径:按日志自己的目录变量读回全部记录;区间里没有记录即拒绝,不落到缺省目录', { skip: SKIP }, () => {
  const out = tmpDir();
  try {
    const r = spawnSync(process.execPath, [FIXTURE, path.resolve(ROOT), 'US_V5_READ_BACK', out], { cwd: out, env: bridge.childEnv(), encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.ok(got.written > 0);
    assert.equal(got.read, got.written);
    assert.equal(got.outside, 'US_V5_RECORDS_EMPTY:2026-01-05..2026-01-09');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
