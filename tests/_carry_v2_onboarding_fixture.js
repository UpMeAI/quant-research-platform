#!/usr/bin/env node
'use strict';
/**
 * 测试夹具子进程(carry_v2_onboarding.test.js 用),在钉住的 smartflow 检出上运行,smartflow 一字不改:
 *   RESTORE      <root> <archive>                    一个 V2 口径 sleeve:旧引擎返回 vs 作业输出规范字节 → restoreNative
 *   JOBS         <root> <out> <archive> <window JSON> 写 CARRY 作业(V1 窗口走 carryTier2;带 idleFlat 的窗口走 windowLinesV2)
 *   DIRECT       <root> <archive> <window JSON>       跑数器直接算线(旧引擎),打印 sha256(stableJson(lines))
 *   LEDGER       <root> <ledgerRoot> <mode>           用影子自己的 seal 写一份合成账本(mode = OK | TAMPER)
 *   LEDGER_CHECK <root> <ledgerRoot> <cutoff>         carry_m1.ledgerCheck,打印回执片段
 * 合成归档用 smartflow 自己的 fixtures/carry-archive.js(写作业端包好构造器之后才加载)。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CacheJobs = require('../adapters/replay-core-bridge/cache_jobs');
const { restoreNative } = require('../adapters/replay-core-bridge/carry_backfill');
const M1 = require('../adapters/replay-core-bridge/carry_m1');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pkg = (root) => path.join(root, 'trading-system-v2');
const reqOf = (root) => (rel) => require(path.join(pkg(root), rel));
const HOUR = 3_600_000;
const DAY = 86_400_000;

function ensureArchive(req, dir) {
  if (!fs.existsSync(path.join(dir, 'fetch-log.jsonl'))) req('scripts/lib/replay-core-golden/fixtures/carry-archive.js').writeCarryArchive(dir);
}

function restore(root, archive) {
  const req = reqOf(root);
  ensureArchive(req, archive);
  const L = req('scripts/research/funding-basis-carry-lib.js');
  const runner = req('scripts/research/funding-basis-carry-run.js');
  const T2 = req('scripts/lib/replay-core-golden/tier2.js');
  const Core = req('scripts/lib/replay-core');
  const { carryInputFromLegacy } = req('scripts/lib/replay-core-adapters/carry.js');
  const { data } = T2.loadAll(archive);
  const win = { name: 'SYN', start: Date.UTC(2024, 0, 15), end: Date.UTC(2024, 1, 15) };
  const d = data.get('BTCUSDT');
  const sp = L.alignHourly(d.spotBars, win.start, win.end);
  const pp = L.alignHourly(d.perpBars, win.start, win.end);
  const mp = L.alignHourly(d.markBars, win.start, win.end);
  const input = { start: win.start, end: win.end, spot: sp.slots, perp: pp.slots, mark: mp.slots, spotPrev: sp.prevClose, perpPrev: pp.prevClose, settlements: d.settlements, capital: L.PARAMS.SLEEVE_CAPITAL };
  const opts = { X: L.PARAMS.X, MMR: L.PARAMS.MMR, costs: L.COSTS.BASE, mode: 'RULES', idleRate: 0, idleYields: L.flatYields(0.045, win.start, win.end), idleSeries: 'DTB3' };
  const legacy = L.simulateSleeve(input, opts);
  const out = Core.run(carryInputFromLegacy(input, opts));
  const restored = restoreNative(JSON.parse(Core.canonBytes(out).toString('utf8')).native);
  const sameNumbers = (a, b) => a.length === b.length && Array.from(a).every((x, i) => Object.is(x, b[i]));
  process.stdout.write(JSON.stringify({
    stableEqual: runner.stableJson(restored) === runner.stableJson(legacy),
    equityType: restored.equity.constructor.name, heldType: restored.held.constructor.name,
    legacyEquityType: legacy.equity.constructor.name, legacyHeldType: legacy.held.constructor.name,
    equityObjectIs: sameNumbers(restored.equity, legacy.equity), heldObjectIs: sameNumbers(restored.held, legacy.held),
    summaryEqual: runner.stableJson(runner.sleeveSummary(restored, win)) === runner.stableJson(runner.sleeveSummary(legacy, win)),
    events: legacy.events.length,
  }));
}

function jobs(root, out, archive, win) {
  CacheJobs.captureCacheJobs(root, 'CARRY', null, out, {
    prepare: (req) => {
      ensureArchive(req, archive);
      if (win.idleFlat == null) return { args: { data: archive, windows: [win] } };
      // V2 口径的合成窗口:tier2 的 recordSleeves 包住跑数器自己的 windowLinesV2(与 carryTier2 的 W1/W2/FULL 分支同一调用)
      const T2 = req('scripts/lib/replay-core-golden/tier2.js');
      const runner = req('scripts/research/funding-basis-carry-run.js');
      const L = req('scripts/research/funding-basis-carry-lib.js');
      T2.carryTier2 = ({ dataDir }) => {
        const { data, manifestSha256 } = T2.loadAll(dataDir);
        const sleeves = T2.recordSleeves(() => runner.windowLinesV2(data, win, L.flatYields(win.idleFlat, win.start, win.end)));
        return [T2.windowReceipt({ golden: { id: 'G2', scriptPaths: ['scripts/research/funding-basis-carry-lib.js', 'scripts/research/funding-basis-carry-run.js'] },
          window: `${win.name} V2`, tier: 2, sleeves, extra: { dataManifestSha256: manifestSha256 } })];
      };
      return { args: { data: archive, windows: [win.name] } };
    },
  });
}

function direct(root, archive, win) {
  const req = reqOf(root);
  const L = req('scripts/research/funding-basis-carry-lib.js');
  const runner = req('scripts/research/funding-basis-carry-run.js');
  const T2 = req('scripts/lib/replay-core-golden/tier2.js');
  const { data } = T2.loadAll(archive);
  const lines = win.idleFlat == null ? runner.windowLines(data, win) : runner.windowLinesV2(data, win, L.flatYields(win.idleFlat, win.start, win.end));
  process.stdout.write(JSON.stringify({ resultsSha256: sha256(runner.stableJson(lines)) }));
}

/** 合成账本:WORKER_LIVE、F_START、两个 sleeve 的结算、缺项与最终缺项、一条 NONE 决定、平仓时的 MTM。 */
function ledger(root, ledgerRoot, mode) {
  const req = reqOf(root);
  const Lg = req('src/services/carry-v2-shadow/ledger.js');
  const Store = req('src/services/carry-v2-shadow/store.js');
  const store = Store.createStore(ledgerRoot);
  const state = Lg.initState();
  const t0 = Date.UTC(2026, 9, 4, 0, 0, 0);
  const emit = (body) => { const rec = Lg.seal(state, body); Lg.apply(state, rec); store.append(rec); return rec; };
  emit({ type: 'WORKER_LIVE', valueAt: t0, postedAt: t0, acceptanceSha256: 'x', codeCommit: 'c', codeHashes: {}, libSha256: 'l', host: 'h', node: 'v18.20.8' });
  const f = t0 + 8 * HOUR;
  for (const s of ['BTC', 'ETH']) emit({ type: 'SETTLEMENT', sleeve: s, valueAt: f - 8 * HOUR, postedAt: t0 + HOUR, fundingTime: f - 8 * HOUR, fundingRate: 0.0001, markPrice: 100, held: false, q: 0, amount: 0, amountFref: null, history: true });
  emit({ type: 'F_START', valueAt: f, postedAt: f, fundingTime: f, symbol: 'BTCUSDT', workerLiveAt: t0 });
  for (const s of ['BTC', 'ETH']) emit({ type: 'SETTLEMENT', sleeve: s, valueAt: f, postedAt: f + 60_000, fundingTime: f, fundingRate: 0.0001, markPrice: 100, held: false, q: 0, amount: 0, amountFref: null });
  const T = f + HOUR;
  for (const s of ['BTC', 'ETH']) emit({ type: 'MTM', sleeve: s, valueAt: T, postedAt: T + 60_000, boundary: T, S: 100, F: 100.1, equity: 5000, cash: 5000, q: 0, w: 0 });
  emit({ type: 'DECISION', sleeve: 'BTC', valueAt: f, postedAt: T + 61_000, at: T, decidedAt: f, a7: 0.01, valid: 1, negRun: 0, effIn: false, dropped: [], inputs: { fundingTimes: [f], windowFrom: f - 7 * DAY }, kind: 'NONE', fresh: true, execAt: null });
  emit({ type: 'MISSING', sleeve: 'ETH', valueAt: f + 8 * HOUR, postedAt: f + 9 * HOUR, key: `FUNDING_ROW:ETH:${f + 8 * HOUR}`, what: 'FUNDING_ROW', instant: f + 8 * HOUR, reason: 'ROW_NOT_POSTED', retries: 0, detail: { heldQ: 0, fRef: null } });
  emit({ type: 'MISSING', sleeve: 'BTC', valueAt: f + DAY, postedAt: f + DAY, key: `DTB3:BTC:2026-10-05`, what: 'DTB3', instant: f + DAY, reason: 'DTB3_OBSERVATION_PENDING', retries: 0, detail: { baseCash: 5000 } });
  emit({ type: 'MISSING_FINAL', sleeve: 'ETH', valueAt: f + 8 * HOUR, postedAt: Date.UTC(2026, 9, 6, 1), key: `FUNDING_ROW:ETH:${f + 8 * HOUR}` });
  emit({ type: 'CODE_CHANGE', valueAt: Date.UTC(2026, 9, 6, 2), postedAt: Date.UTC(2026, 9, 6, 2), from: 'aaaa', to: 'bbbb', codeCommit: 'bbbb', manifestSha256: 'm' });
  // 截止日之后的一天(拷贝时不取)
  emit({ type: 'RESOLVED', sleeve: 'BTC', valueAt: Date.UTC(2026, 9, 7, 1), postedAt: Date.UTC(2026, 9, 7, 1), key: 'DTB3:BTC:2026-10-05', detail: {} });
  if (mode === 'TAMPER') {
    const file = path.join(store.ledgerDir, '2026-10-05.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const r = JSON.parse(lines[0]);
    r.fundingRate = 0.0002; // 改内容不改哈希
    lines[0] = JSON.stringify(r);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
  }
  process.stdout.write(JSON.stringify({ files: store.ledgerFiles(), records: state.seq }));
}

function ledgerCheckOut(root, ledgerRoot, cutoff) {
  const req = reqOf(root);
  const r = M1.ledgerCheck({ Ledger: req('src/services/carry-v2-shadow/ledger.js'), Store: req('src/services/carry-v2-shadow/store.js'), ledgerRoot, cutoff, pkgRoot: pkg(root) });
  M1.assertNoForwardValues(r);
  process.stdout.write(JSON.stringify(r));
}

function main([mode, root, ...rest]) {
  if (mode === 'RESTORE') return restore(root, rest[0]);
  if (mode === 'JOBS') return jobs(root, rest[0], rest[1], JSON.parse(rest[2]));
  if (mode === 'DIRECT') return direct(root, rest[0], JSON.parse(rest[1]));
  if (mode === 'LEDGER') return ledger(root, rest[0], rest[1]);
  if (mode === 'LEDGER_CHECK') return ledgerCheckOut(root, rest[0], rest[1]);
  throw new Error(`USAGE:fixture ${mode}`);
}

try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${String(e && e.message).split('\n')[0]}\n`); process.exitCode = 1; }
