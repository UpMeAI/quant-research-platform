#!/usr/bin/env node
'use strict';
/**
 * 测试夹具子进程(replay_core_cache_jobs.test.js 用):在钉住的 smartflow 检出上,用 smartflow 自己的合成夹具注入数据跑写作业端。
 *   node _replay_core_cache_fixture.js <smartflow 根> <CARRY|C17_CACHE|C17_AGENT_LIVE|C17_V2_LIVE|US_V5_RECORDS> <out>
 * 注入数据的做法与 smartflow tests/replay-core-golden-tier2.test.js 的管线测试相同;夹具在写作业端包好输入构造器之后才加载。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const CacheJobs = require('../adapters/replay-core-bridge/cache_jobs');

const DAY_MS = 86_400_000;

const FIXTURES = {
  CARRY: (req) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-carry-archive-'));
    req('scripts/lib/replay-core-golden/fixtures/carry-archive.js').writeCarryArchive(dir);
    return { args: { data: dir, windows: [{ name: 'SYN', start: Date.UTC(2024, 0, 15), end: Date.UTC(2024, 2, 15) }] }, cleanup: dir };
  },
  C17_CACHE: (req) => ({ args: { cache: 'synthetic' }, inject: { dataset: req('scripts/lib/replay-core-golden/fixtures/c17-synthetic.js').makeC17Dataset() } }),
  C17_AGENT_LIVE: (req) => {
    const Live = req('scripts/lib/c17-live-replay.js');
    const { syntheticDataset, legs } = req('tests/helpers/c17-synthetic-dataset.js');
    const start = Date.parse(Live.CACHE_SOURCE_START);
    const end = Date.parse('2026-09-14T00:00:00Z');
    const raw = syntheticDataset({ startMs: start, days: (end - start) / DAY_MS, warmupDays: 82, specs: [
      { symbol: 'BTCUSDT', base: 60000, drift: legs(6, 0.00006), noise: 0.0009, volume: 20, seed: 11 },
      { symbol: 'ETHUSDT', base: 2500, drift: legs(5, -0.00007), noise: 0.001, volume: 300, seed: 22 }] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-live-agent-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sourceStartMs: start, evaluationStartMs: Date.parse(Live.CACHE_EVALUATION_START), endMs: end }));
    return { args: { cache: dir }, inject: { loadDataset: () => raw }, cleanup: dir };
  },
  C17_V2_LIVE: (req) => {
    const PARAMS = req('scripts/lib/production-parameter-versions.js');
    const U = req('src/services/c17-v2-universe.js');
    const { syntheticDataset, legs } = req('tests/helpers/c17-synthetic-dataset.js');
    const START = Date.parse(PARAMS.versionsOf('C17_V2_4000USDT.capitalUsdt')[0].effectiveFrom);
    const raw = syntheticDataset({ startMs: Math.floor(START / DAY_MS) * DAY_MS - 36 * DAY_MS, days: 50, warmupDays: 36, specs: [
      { symbol: 'BTCUSDT', base: 60000, drift: legs(6, 0.00006), noise: 0.0009, volume: 20, seed: 11 },
      { symbol: 'ETHUSDT', base: 2500, drift: legs(5, -0.00007), noise: 0.001, volume: 300, seed: 22 },
      { symbol: 'SOLUSDT', base: 150, drift: legs(4, 0.00009), noise: 0.0012, volume: 4e5, seed: 33 }] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-live-v2-'));
    for (let k = 0; k < 40; k += 1) {
      U.writeRecord(U.buildRecord({ selection: { nonMajors: [{ symbol: 'SOLUSDT' }], exits: [], funnel: {}, candidates: [{ symbol: 'SOLUSDT', floors: { F3: { value: 120 } } }] },
        nowMs: START + 5 * 60000 + k * 4 * 3_600_000, inputs: [] }), dir);
    }
    return { args: { cache: 'synthetic', records: dir }, inject: { dataset: raw }, cleanup: dir };
  },
  US_V5_RECORDS: (req) => {
    const F = req('tests/helpers/us-v5-book-replay-fixture.js');
    const R = req('scripts/lib/strategy-review.js');
    return { args: { records: 'synthetic', from: '2026-10-05', to: '2026-10-09', timeRule: { maxHoldDays: 20, reversionMaxHoldDays: 7 } },
      inject: { records: F.weekRecords(), StrategyModule: F.StrategyModule, book: F.book, sessions: R.sessionsBetween('2026-10-05', '2026-10-09'), windowSessions: F.SESSIONS } };
  },
};

/** 决策输入日志的磁盘路径:用 smartflow 自己的 appendRecord 写一周记录,再按 usV5Records 读回(只打印条数)。 */
function readBack(root, out) {
  const pkg = path.join(root, 'trading-system-v2');
  const req = (rel) => require(path.join(pkg, rel));
  const F = req('tests/helpers/us-v5-book-replay-fixture.js');
  const log = req('src/services/us-decision-input-log.js');
  const env = { US_DECISION_INPUTS_DIR: out };
  const records = F.weekRecords();
  for (const r of records) if (log.appendRecord('us-v5', r, { env, nowMs: Date.parse(r.startedAt) }).state !== 'WRITTEN') throw new Error('FIXTURE_WRITE_FAILED');
  const read = (from, to) => { try { return CacheJobs.usV5Records(req, { records: out, from, to }).length; } catch (e) { return String(e.message); } };
  process.stdout.write(JSON.stringify({ written: records.length, read: read('2026-10-05', '2026-10-09'), outside: read('2026-01-05', '2026-01-09') }));
}

function main([root, name, out]) {
  if (name === 'US_V5_READ_BACK') { readBack(root, out); return; }
  const make = FIXTURES[name];
  if (!make) throw new Error(`USAGE:fixture ${name}`);
  let made = null;
  try {
    CacheJobs.captureCacheJobs(root, name, null, out, {
      prepare: (req) => { made = make(req); return made; },
    });
  } finally {
    if (made && made.cleanup) fs.rmSync(made.cleanup, { recursive: true, force: true });
  }
}

try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`); process.exitCode = 1; }
