'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SCHEMAS, validateRecord, validateLedger } = require('../schemas');
const { dataDir } = require('../packages/ledger');

test('Schema 合同:全部台账记录符合 §8 域对象声明', async () => {
  // 先跑一条最小闭环产生真实台账
  await require('./_fixture').setupExperiment();
  const root = path.dirname(dataDir('x'));
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'marketdata') walk(p); }     // 市场日线属适配器自有存储
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root);
  assert.ok(files.length > 0, '未产生任何台账');
  for (const f of files) {
    const rows = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const r of rows) assert.ok(r.schema, `${f} 存在无 schema 记录`);
    const known = rows.filter((r) => SCHEMAS[r.schema]);
    const v = validateLedger(known);
    assert.equal(v.ok, true, `${path.basename(f)}: ${JSON.stringify(v.failures.slice(0, 3))}`);
  }
});

test('Schema 校验器:缺字段报错;显式 null 在可空/任意域合法', () => {
  assert.equal(validateRecord({ schema: 'NOPE' }).ok, false);
  const bad = validateRecord({ schema: 'STRATEGY_RELEASE_V1', release_id: 'x' });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.startsWith('MISSING:')));
});

/**
 * 反分叉守卫(审计发现的结构性偏差):平台内置 ashare-local 适配器与 Ashare-V5
 * 的 VPQ 判定是同一经济逻辑的两份实现(前者用于无 PG 环境的演示与确定性测试)。
 * 本测试在两仓并存时逐条比对冻结常量与判定表 —— 任何一侧漂移立即失败。
 * Ashare-V5 不可达时 skip(CI 单仓也能跑),但绝不静默通过。
 */
test('反分叉守卫:平台 VPQ 判定与 Ashare-V5 源逻辑逐条一致', (t) => {
  const srcPath = '/home/user/Ashare-V5/scripts/phase2_vertical_slice_volume_price.js';
  if (!fs.existsSync(srcPath)) return t.skip('Ashare-V5 不在本机 —— 跳过跨仓一致性比对(非通过)');
  // 源模块顶层 require('pg')(其回测走 PG),本比对只用其纯函数 —— 用最小桩解析 pg,
  // 不安装依赖、不连数据库;桩失效时宁可 skip 也不静默通过。
  let src;
  try {
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    const stubId = require.resolve('./_pg_stub.js');
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'pg') return stubId;
      return origResolve.call(this, request, ...rest);
    };
    try { src = require(srcPath); } finally { Module._resolveFilename = origResolve; }
  } catch (e) { return t.skip(`Ashare-V5 源模块不可加载:${e.message}`); }
  const local = require('../adapters/ashare-local/strategy_vpq');

  assert.equal(local.FWD_DAYS, src.FWD_DAYS, 'FWD_DAYS 漂移');
  for (const k of ['volConfirmRatio', 'volDryRatio', 'stagnationPricePct']) {
    assert.equal(local.CHAMP[k], src.CHAMP[k], `CHAMP.${k} 漂移`);
  }
  // 判定表:同一组 bar 序列 + 同一 volUp/volDry 组合,两侧结论必须逐条相同
  const bars = [];
  let close = 10;
  for (let i = 0; i < 40; i++) {
    close *= 1 + ((i * 7919) % 13 - 6) / 500;
    bars.push({ close: Number(close.toFixed(4)), high: Number((close * 1.01).toFixed(4)), vol: 1e6 + (i % 5) * 1e5 });
  }
  let compared = 0;
  for (let i = 25; i < bars.length; i++) {
    for (const volUp of [true, false]) {
      for (const volDry of [true, false]) {
        assert.equal(
          local.classifyPattern(bars, i, { volUp, volDry }),
          src.classifyPattern(bars, i, { volUp, volDry }),
          `pattern 判定漂移 @i=${i} volUp=${volUp} volDry=${volDry}`,
        );
        compared++;
      }
    }
  }
  assert.ok(compared >= 40, '比对样本过少');
  // 分位函数同口径
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const q of [0.1, 0.2, 0.5, 0.8, 0.9]) {
    assert.equal(local.quantile(sorted, q), src.quantile(sorted, q), `quantile(${q}) 漂移`);
  }
});
