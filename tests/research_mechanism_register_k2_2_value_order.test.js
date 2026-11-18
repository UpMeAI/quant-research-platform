'use strict';
/**
 * K2-② 主线先于价值（三层合同修订 3 §3，Owner 2026-11-16 23:55 签 e4304f9b；K2 草稿 K2_MAINLINE_BEFORE_VALUE_V1 ★M (a)）的机制登记：
 *   - 新机制 SEL.VALUE.MARGIN_RANK：选股择时层，决策点选标的，标题「主线内按价值排序选股」，没有 parent；
 *   - 由总表 rev 94 的 R-STK-MAINLINE-VALUE-ORDER 一行引用（strategy_ref ASHARE_V6_PAPER，A 股，在研、没有结论块），只引用这一个 id（★M (a)：第 1 行只写它）；
 *   - D4 那条 entry 不变（仍只引用 SEL.SCREEN.FUNDAMENTAL）：按价值排序越过「只排除、不参与排序」那条线，是另一个机制，不挂到 D4 的前向影子上；
 *   - 登记表绑定总表 rev 94；
 *   - CN_A 分诊：同机制同市场没有先前结论 → NORMAL_NO_PRIOR（不是 ATTACH_TO_SHADOW），在研一条 = 本题。
 * 只读：不写任何文件。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const mech = require('../services/research-mechanism-register');

const RAW = JSON.parse(fs.readFileSync(mech.FILE, 'utf8'));
const ID = 'SEL.VALUE.MARGIN_RANK';
const ITEM = 'R-STK-MAINLINE-VALUE-ORDER';
const AS_OF = '2026-11-18T18:00:00+08:00';

test('K2-② 机制：SEL.VALUE.MARGIN_RANK 登记在选股择时层、决策点选标的，标题照 ★M (a)，没有 parent', () => {
  assert.ok(mech.isRegistered(ID), ID);
  const m = mech.REGISTER.mechanisms.find((x) => x.mechanism_id === ID);
  assert.equal(m.layer, 'SELECTION_TIMING');
  assert.equal(m.decision_point, 'SELECT');
  assert.equal(m.title_zh, '主线内按价值排序选股');
  assert.equal(m.parent, undefined);
  assert.deepEqual(mech.REGISTER.mechanisms.map((x) => x.mechanism_id).filter((x) => x.startsWith('SEL.VALUE.')), [ID]);
});

test('K2-② 机制：由总表那一行的一条 entry 引用（A 股，在研，没有结论块），只引用这一个 id；D4 的 entry 不变', () => {
  const entries = mech.REGISTER.entries.filter((e) => e.item_id.split('#')[0] === ITEM);
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.item_id, ITEM);
  assert.equal(e.strategy_ref, 'ASHARE_V6_PAPER');
  assert.equal(e.market, 'CN_A');
  assert.deepEqual(e.mechanism_ids, [ID]);
  assert.equal(e.conclusion, undefined);
  assert.equal(e.classified_by, 'coordinator-proposal');
  assert.deepEqual(mech.REGISTER.entries.filter((x) => x !== e && x.mechanism_ids.includes(ID)).map((x) => x.item_id), []);
  const d4 = mech.REGISTER.entries.filter((x) => x.item_id === 'D4');
  assert.equal(d4.length, 1);
  assert.deepEqual(d4[0].mechanism_ids, ['SEL.SCREEN.FUNDAMENTAL']);
});

test('登记表绑定的总表不早于 rev 94（K2-② 那一行所在的一版）；这一版是 rev 94 时 sha256 照抄', () => {
  const src = RAW.sources.master_table;
  const m = /^artifacts\/coordinator\/master-table-revs\/RESEARCH_MASTER_TABLE_20261110\.rev(\d+)\.json$/.exec(src.path);
  assert.ok(m, src.path);
  assert.equal(Number(m[1]), src.revision);
  assert.ok(src.revision >= Number('94'), `rev ${src.revision}`);
  if (src.revision === Number('94')) assert.equal(src.sha256, 'bb3caebd07669cb0a57ec485ea890ad62e1c1b5b05da5f4e103a5eaf1cf7dea9');
});

test('K2-② 机制在 CN_A 的分诊：没有先前结论 → NORMAL_NO_PRIOR（不挂到 D4 影子上），在研一条 = 本题', () => {
  const table = mech.query({ mechanism_ids: [ID], market: 'CN_A' }, { marks: [], asOf: AS_OF });
  assert.equal(table.route, 'NORMAL_NO_PRIOR');
  const [row] = table.by_id;
  assert.equal(row.mechanism_id, ID);
  assert.equal(row.prior, null);
  assert.deepEqual(row.conclusions, []);
  assert.deepEqual(row.in_progress, [{ item_id: ITEM, strategy_ref: 'ASHARE_V6_PAPER' }]);
});
