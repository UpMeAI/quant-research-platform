'use strict';
/**
 * A 股两个研究模块的登记 config/ashare_research_modules.v1.json（Owner 2026-11-07；队列 #21 的数据侧）：
 *   1. 形状：整本账本 ASHARE_V6_PAPER 是上级、只计一次；「宽基 ETF」= 指数簿、「个股 / 行业 ETF」= 个股簿，各一次；
 *   2. 结论只写「做」或「不做」：统计标签不当结论，仍在研究的题没有结论、写预计日期和判定规则；
 *   3. 每个出处都有 sha256；本机有源文件时现场核对（Ashare-V6 按提交 git show，协调会话目录与研究数据按文件），
 *      并核对登记的结论与封存结果文件里的字段一致。没有源文件的机器上，这一组跳过并写明原因。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'config', 'ashare_research_modules.v1.json');
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const V6_ROOT = path.resolve(process.env.QRP_ASHARE_V6_ROOT || path.join(ROOT, '..', 'Ashare-V6'));
const COORDINATOR_DIR = path.resolve(process.env.QRP_COORDINATOR_DIR || path.join(ROOT, '..', 'artifacts', 'coordinator'));
const SHA64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const moduleOf = (id) => doc.modules.find((item) => item.module_id === id);

/** 所有出处：任何带 sha256 的对象。 */
function refsOf(value, at = '$', out = []) {
  if (Array.isArray(value)) value.forEach((item, i) => refsOf(item, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    if (typeof value.sha256 === 'string') out.push({ at, ref: value });
    for (const [key, item] of Object.entries(value)) refsOf(item, `${at}.${key}`, out);
  }
  return out;
}
/** 所有带 decision 键的对象（不含 read 里的字段路径）。 */
function decisionsOf(value, at = '$', out = []) {
  if (Array.isArray(value)) value.forEach((item, i) => decisionsOf(item, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    if ('decision' in value) out.push({ at, decision: value.decision });
    // `read` names where the decision sits in the sealed file (a field path), not a decision
    for (const [key, item] of Object.entries(value)) if (key !== 'read') decisionsOf(item, `${at}.${key}`, out);
  }
  return out;
}
const v6Available = () => fs.existsSync(path.join(V6_ROOT, '.git'));
const v6Bytes = (ref) => execFileSync('git', ['-C', V6_ROOT, 'show', `${ref.commit}:${ref.path}`], { maxBuffer: 64 * 1024 * 1024 });

test('形状：上级账本只计一次，宽基 ETF = 指数簿，个股 / 行业 ETF = 个股簿，各一项', () => {
  assert.equal(doc.contract, 'QRP_ASHARE_RESEARCH_MODULES_V1');
  assert.equal(doc.acceptance_ref, 'artifacts/coordinator/ASHARE_STRATEGY_SPLIT_V1_FREEZE_1.md');
  assert.match(doc.acceptance_sha256, SHA64);
  assert.deepEqual([doc.parent.desk_book, doc.parent.market, doc.parent.counted_once], ['ASHARE_V6_PAPER', 'CN', true]);
  assert.deepEqual(doc.modules.map((item) => [item.order, item.module_id, item.label_zh, item.book, item.component, item.research_line]), [
    [1, 'CN_A_BROAD_ETF', '宽基 ETF', 'INDEX_BOOK', 'INDEX', 'R-ETF-1'],
    [2, 'CN_A_STOCK_SECTOR_ETF', '个股 / 行业 ETF', 'STOCK_BOOK', 'STOCK', 'R-STK-1'],
  ]);
  assert.deepEqual(doc.q0.applies_to, doc.modules.map((item) => item.module_id));
});

test('结论只写「做」或「不做」：统计标签不当结论，研究进行中的题没有结论', () => {
  assert.deepEqual(doc.verdict_rule.values, ['做', '不做']);
  assert.equal(doc.verdict_rule.in_progress_label_zh, '研究进行中');
  for (const { at, decision } of decisionsOf(doc)) assert.ok(doc.verdict_rule.values.includes(decision), `${at}: ${decision}`);
  for (const item of doc.modules) {
    for (const verdict of item.verdicts) {
      assert.equal(verdict.state, 'CONCLUDED', verdict.id);
      assert.ok(doc.verdict_rule.values.includes(verdict.decision), verdict.id);
      assert.ok(!doc.verdict_rule.values.includes(verdict.statistical_label), `${verdict.id}: the statistical label is not a decision`);
      assert.match(verdict.sealed_on, DAY);
    }
    for (const open of [...item.in_progress, ...(item.module_id === doc.q0.applies_to[0] ? [doc.q0] : [])]) {
      assert.equal(open.state, 'IN_PROGRESS', open.id || 'q0');
      assert.equal(open.state_label_zh, '研究进行中');
      assert.equal('decision' in open, false, `${open.id || 'q0'} is still running: no decision`);
    }
    for (const open of item.in_progress) {
      assert.match(open.expected_by, DAY, open.id);
      assert.match(open.decided_by_zh, /做/, open.id);
      assert.match(open.decided_by_zh, /不做/, open.id);
    }
  }
  assert.match(doc.q0.expected_end, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  assert.equal(doc.q0.sealed, false, 'the Q0 end is an estimate, not a sealed fact');
});

test('数据还没有研究线的地方写占位符，不写「尚未接入」', () => {
  const gaps = doc.modules.flatMap((item) => item.coverage_gaps);
  assert.deepEqual(gaps.map((gap) => [gap.id, gap.state]), [['CN_A_SECTOR_ETF', 'NOT_INITIATED']]);
  for (const gap of gaps) assert.match(gap.placeholder_zh, /^待交付 · /);
  assert.equal(JSON.stringify(doc).includes('尚未接入'), false);
});

test('每个出处都按 sha256 绑定；Ashare-V6 的出处带 40 位提交', () => {
  const refs = refsOf(doc);
  assert.ok(refs.length >= 15);
  for (const { at, ref } of refs) {
    assert.match(ref.sha256, SHA64, at);
    assert.ok(['Ashare-V6', 'coordinator', 'research-data'].includes(ref.source), `${at}: ${ref.source}`);
    if (ref.source === 'Ashare-V6') assert.match(ref.commit, SHA40, at);
    if (ref.source === 'coordinator') assert.equal(path.basename(ref.path), ref.path, at);
  }
  for (const item of doc.modules.flatMap((entry) => entry.in_progress)) {
    if (item.arm_commit) assert.match(item.arm_commit.commit, SHA40, item.id);
  }
});

test('本机有源文件时：sha256 现场核对，登记的结论与封存文件一致', (t) => {
  if (!v6Available() || !fs.existsSync(COORDINATOR_DIR)) {
    t.skip(`source files not on this host (Ashare-V6 ${V6_ROOT}, coordinator ${COORDINATOR_DIR})`);
    return;
  }
  for (const { at, ref } of refsOf(doc)) {
    if (ref.source === 'Ashare-V6') assert.equal(sha256(v6Bytes(ref)), ref.sha256, `${at}: ${ref.ref}`);
    else if (ref.source === 'coordinator') assert.equal(sha256(fs.readFileSync(path.join(COORDINATOR_DIR, ref.path))), ref.sha256, `${at}: ${ref.path}`);
    else if (fs.existsSync(ref.path)) assert.equal(sha256(fs.readFileSync(ref.path)), ref.sha256, `${at}: ${ref.path}`);
  }
  const etf = moduleOf('CN_A_BROAD_ETF').verdicts.find((item) => item.id === 'R-ETF-1');
  const sealed = JSON.parse(v6Bytes(etf.files.result).toString('utf8'));
  const at = (pathText) => pathText.split('.').reduce((value, key) => value?.[key], sealed);
  assert.deepEqual([at(etf.read.decision), at(etf.read.statistical_label), at(etf.read.consequence)],
    [etf.decision, etf.statistical_label, 'FORWARD_PAPER_SHADOW_PRODUCTION_UNCHANGED']);
  const addendum = JSON.parse(v6Bytes(etf.files.addendum_1_result).toString('utf8'));
  assert.equal(addendum.decision.decision, '做');
  const shadow = JSON.parse(v6Bytes(etf.runs_as.files[0]).toString('utf8'));
  assert.deepEqual([shadow.key, shadow.version, shadow.effectiveFrom, shadow.effectiveTo], ['INDEX_ETF_VG_SHADOW', 'v2', etf.runs_as.t_start, null]);
  const sleeve = JSON.parse(v6Bytes(moduleOf('CN_A_BROAD_ETF').production_rule.files[0]).toString('utf8'));
  assert.deepEqual([sleeve.key, sleeve.version, sleeve.effectiveFrom, sleeve.effectiveTo, sleeve.payload.paperScope.accountId],
    ['INDEX_SLEEVE', 'v5-etf-limit-band-all-funds', '2026-10-20', null, moduleOf('CN_A_BROAD_ETF').account_id]);
  assert.deepEqual([sleeve.payload.paperSizing.sectorSleeveFraction, sleeve.payload.paperSizing.sectorQuota], [0.25, 3],
    'the sector ETFs the coverage gap names trade in the index book');
  const stock = moduleOf('CN_A_STOCK_SECTOR_ETF').in_progress.find((item) => item.id === 'R-STK-1');
  const freeze = fs.readFileSync(path.join(COORDINATOR_DIR, stock.files[0].path), 'utf8');
  assert.match(freeze, /^# R_STK_1_K2_V1_FREEZE_1/);
  assert.ok(freeze.includes(stock.arm_commit.commit), 'the frozen page names the arm commit');
  assert.ok(freeze.includes(stock.inertness.evidence.sha256.slice(0, 16)), 'the frozen page names the inertness evidence');
  assert.ok(freeze.includes('INERTNESS_PASS'));
});
