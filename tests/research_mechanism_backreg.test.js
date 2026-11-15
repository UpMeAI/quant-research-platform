'use strict';
/**
 * 机制补登记的覆盖核对（研究框架修订 2026-11-12 FREEZE_1 §4.5；补登记计划 RF1112_BACKREG_PLAN_20261116）：
 *   - 登记表写明它按哪一版总表补登记（sources.master_table：path、revision、sha256）；
 *   - 本机有那一版总表时（协调会话目录不在 git 里，CI 上没有就跳过）：
 *     研究层的每一行（选股择时、账户、风控、不适用（执行））都至少有一条 entry，市场与总表一致；诊断、工程行一条也不登记（E16）；
 *     登记表里以总表编号为 item_id 的 entry 都对得上总表的一行；
 *   - 每个机制至少被一条 entry 引用（不留空登记）。
 * 只读：不写任何文件。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const mech = require('../services/research-mechanism-register');

const ROOT = path.join(__dirname, '..');
const RAW = JSON.parse(fs.readFileSync(mech.FILE, 'utf8'));
/** 协调会话目录的上一级（QRP 共享检出在它下面）；可用 QRP_ARTIFACTS_PARENT 指到别处（例如在临时 worktree 里核对）。 */
const PARENT = process.env.QRP_ARTIFACTS_PARENT || path.join(ROOT, '..');
const RESEARCH_LAYERS = Object.freeze(['选股择时层', '账户层', '风控层', '不适用（执行）']);
const MARKET_OF = Object.freeze({ A股: ['CN_A'], 美股: ['US_EQUITY'], 加密: ['CRYPTO'], 跨市场: ['CN_A', 'US_EQUITY', 'CRYPTO'] });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('补登记：登记表写明所据总表（path、revision、sha256）；每个机制都被引用', () => {
  const src = RAW.sources && RAW.sources.master_table;
  assert.ok(src, 'sources.master_table');
  assert.equal(src.path, 'artifacts/coordinator/RESEARCH_MASTER_TABLE_20261110.json');
  assert.ok(Number.isInteger(src.revision) && src.revision > 0);
  assert.match(src.sha256, /^[0-9a-f]{64}$/);
  const used = new Set(mech.REGISTER.entries.flatMap((e) => e.mechanism_ids));
  const unused = mech.REGISTER.mechanisms.map((m) => m.mechanism_id).filter((id) => !used.has(id));
  assert.deepEqual(unused, [], '没有被任何 entry 引用的机制');
});

test('补登记：本机有那一版总表时，研究层每行都登记、诊断与工程行不登记、市场一致', (t) => {
  const src = RAW.sources.master_table;
  const file = path.join(PARENT, src.path);
  if (!fs.existsSync(file)) { t.skip('协调会话目录的总表不在本机'); return; }
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== src.sha256) { t.skip(`本机总表不是登记所据的那一版（rev ${src.revision}）`); return; }
  const table = JSON.parse(bytes.toString('utf8'));
  assert.equal(table.revision, src.revision);
  const rows = new Map(table.items.map((i) => [i.id, i]));
  // 一行在同一市场有几个封存单元时，item_id 写 <总表编号>#<单元>；按 # 前的编号对总表
  const baseId = (itemId) => itemId.split('#')[0];
  for (const e of mech.REGISTER.entries) if (e.item_id.includes('#')) assert.match(e.item_id, /^[^#\s]+#[^#\s]+$/, e.item_id);
  const byItem = new Map();
  for (const e of mech.REGISTER.entries) byItem.set(baseId(e.item_id), [...(byItem.get(baseId(e.item_id)) || []), e]);
  const missing = [];
  const wrongMarket = [];
  const registeredNonResearch = [];
  for (const row of table.items) {
    const entries = byItem.get(row.id) || [];
    if (RESEARCH_LAYERS.includes(row.layer)) {
      if (!entries.length) missing.push(row.id);
      for (const e of entries) if (!MARKET_OF[row.market].includes(e.market)) wrongMarket.push(`${row.id}:${row.market}→${e.market}`);
    } else if (entries.length) registeredNonResearch.push(`${row.id}:${row.layer}`);
  }
  assert.deepEqual(missing, [], '研究层行都要登记');
  assert.deepEqual(wrongMarket, [], '市场与总表一致');
  assert.deepEqual(registeredNonResearch, [], '诊断、工程行不登记（E16）');
  // 不是总表编号的 item_id 只能来自层登记（study_ref 或层登记的 id）
  const layer = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'research_layer_register.v1.json'), 'utf8'));
  const layerIds = new Set(layer.entries.map((e) => e.id));
  const orphan = mech.REGISTER.entries.filter((e) => !rows.has(baseId(e.item_id)) && !layerIds.has(baseId(e.item_id))).map((e) => e.item_id);
  assert.deepEqual(orphan, [], 'item_id 要么是总表编号，要么是层登记的 id');
});
