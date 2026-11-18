'use strict';
/**
 * RF1116 第 2 轮的机制登记（协调会话 2026-11-18 12:07 裁定 Decision 2 = (a) 收窄）：
 *   - 只登记 APPROVED 候选引用的 5 个截面机制 SEL.XSEC.{VALUE_YIELD, LOW_TURNOVER, REVERSAL, LOW_VOLATILITY, PRICE_VOLUME_CORR}；
 *     SEL.XSEC.SMALL_SIZE 不登记（22 个小市值候选是评分中性化留下的市值暴露，不是机制，复审全部 REJECTED）；
 *   - 由总表 rev 92 的 RF1116-CN_A 一行引用（item_id = strategy_ref = RF1116-CN_A，A 股，在研、没有结论块）；
 *   - 登记表绑定总表 rev 92（RESEARCH_MASTER_TABLE_20261110.rev92.json，sha256 b14b51cb…）；
 *   - 这 5 个机制在 CN_A 的分诊路由是 NORMAL_NO_PRIOR（同机制同市场没有先前结论），登记机制说明时 G-MECH 不会是 NOT_DO_SETTLED。
 * 只读：不写任何文件。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const mech = require('../services/research-mechanism-register');

const RAW = JSON.parse(fs.readFileSync(mech.FILE, 'utf8'));
const XSEC = Object.freeze(['SEL.XSEC.VALUE_YIELD', 'SEL.XSEC.LOW_TURNOVER', 'SEL.XSEC.REVERSAL', 'SEL.XSEC.LOW_VOLATILITY', 'SEL.XSEC.PRICE_VOLUME_CORR']);
const AS_OF = '2026-11-18T12:30:00+08:00';

test('RF1116 截面机制：5 个登记在选股择时层、决策点选标的，没有 parent；SMALL_SIZE 不登记', () => {
  const byId = new Map(mech.REGISTER.mechanisms.map((m) => [m.mechanism_id, m]));
  for (const id of XSEC) {
    assert.ok(mech.isRegistered(id), id);
    const m = byId.get(id);
    assert.equal(m.layer, 'SELECTION_TIMING', id);
    assert.equal(m.decision_point, 'SELECT', id);
    assert.equal(m.parent, undefined, id);
  }
  assert.equal(mech.isRegistered('SEL.XSEC.SMALL_SIZE'), false);
  assert.deepEqual(mech.REGISTER.mechanisms.map((m) => m.mechanism_id).filter((id) => id.startsWith('SEL.XSEC.')).sort(), [...XSEC].sort());
});

test('RF1116 截面机制：由 RF1116-CN_A 一条 entry 引用（A 股，在研，没有结论块）', () => {
  const entries = mech.REGISTER.entries.filter((e) => e.item_id.split('#')[0] === 'RF1116-CN_A');
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.item_id, 'RF1116-CN_A');
  assert.equal(e.strategy_ref, 'RF1116-CN_A');
  assert.equal(e.market, 'CN_A');
  assert.deepEqual([...e.mechanism_ids].sort(), [...XSEC].sort());
  assert.equal(e.conclusion, undefined);
  assert.equal(e.classified_by, 'coordinator-proposal');
  // 别的 entry 不引用 SEL.XSEC.*
  assert.deepEqual(mech.REGISTER.entries.filter((x) => x !== e && x.mechanism_ids.some((id) => id.startsWith('SEL.XSEC.'))).map((x) => x.item_id), []);
});

test('登记表绑定的总表不早于 rev 92（RF1116-CN_A 那一行所在的一版）；这一版是 rev 92 时 sha256 照抄', () => {
  // 之后的登记 PR 会把 sources.master_table 换到更新的一版（行是否都在由 research_mechanism_backreg 对那一版核）
  const src = RAW.sources.master_table;
  const m = /^artifacts\/coordinator\/master-table-revs\/RESEARCH_MASTER_TABLE_20261110\.rev(\d+)\.json$/.exec(src.path);
  assert.ok(m, src.path);
  assert.equal(Number(m[1]), src.revision);
  assert.ok(src.revision >= 92, `rev ${src.revision}`);
  if (src.revision === 92) assert.equal(src.sha256, 'b14b51cb17d6d8645e7a53fb2f61bdbcce0fd8ee53fe172b6d7b9922002c61dc');
});

test('RF1116 截面机制在 CN_A 的分诊：同机制同市场没有先前结论 → NORMAL_NO_PRIOR，不是 NOT_DO_SETTLED', () => {
  for (const id of XSEC) {
    const table = mech.query({ mechanism_ids: [id], market: 'CN_A' }, { marks: [], asOf: AS_OF });
    assert.equal(table.route, 'NORMAL_NO_PRIOR', id);
  }
});
