'use strict';
/**
 * W46 L6 裁定（协调会话 2026-11-15 17:51 CST，queue.log「W46 L6_WORDING_RULING」）：回程文件 sealedVerdicts[] 的任何文字
 * 都不得带 desk 的预测用词。W46 的 scratch 演练里 R_US_ETF_1 四行原样引了封存原文「方向判对的概率 99%」，desk 的
 * loop-check 在 CONTRACT / L6 拒收（PREDICTIVE_CONTENT），周一的周编会停在 LOOP_CHECK。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const returns = require('../services/desk-review-routing/return');
const sealed = require('../services/desk-review-routing/sealed');
const overseas = require('../services/overseas-sealed-verdicts');
const ashare = require('../services/ashare-sealed-verdicts');
const schema = require('./_json_schema');

const RETURN_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'desk-schemas', 'qrp-research-return.v1.schema.json'), 'utf8'));
/** desk 的禁用词表原样（portfolio-desk src/decision-contracts.js:13-16，desk 152186f 上的 PREDICTIVE_TERMS）；desk 检出在旁边时下面逐字核对。 */
const DESK_PREDICTIVE_TERMS = Object.freeze([
  '预计', '预测', '目标价', '概率', '看涨', '看跌', '大概率', '将会', '必然', '必将', '预期收益',
  'forecast', 'expected return', 'probability', 'target price', 'hit rate', 'win rate', 'expectancy',
]);
const AUTH = 'TEST_SEALED_AUTHORITY';
const AT = '2026-11-16T02:30:00.000Z';
const UC = 'US_CORE_9000USD_3X_GATEOBS';
const US5 = 'US_V5_ETF_3000USD';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();

/** 字符串里第一个禁用词（同 desk wordingProblem 的读法：小写后包含）。 */
const bannedIn = (text) => DESK_PREDICTIVE_TERMS.find((term) => String(text).toLowerCase().includes(term)) || null;
function bannedHits(rows) {
  const hits = [];
  const walk = (node, where) => {
    if (typeof node === 'string') { const term = bannedIn(node); if (term) hits.push(`${where}:${term}`); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${where}[${i}]`)); return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
  };
  rows.forEach((row, i) => walk(row, `$.sealedVerdicts[${i}]`));
  return hits;
}

/** R_US_ETF_1_RESULT_V1.json 的形状：六个单元，四个有判定（与 smartflow 3a635a49 的封存文件同构，数字照抄）。 */
function rue1Doc({ vooCi = [-0.050488, 0.044675], spyUnit = 'UC-SPY' } = {}) {
  const unit = (id, decision, ci95, strength) => ({ id, decision, ci95, evidence_strength_zh: strength, allowed_use_zh: '生产不变' });
  return {
    first_paragraph_zh: 'R-US-ETF-1 结果。',
    verdict_detail: [
      unit(spyUnit, '不做', [-0.136258, -0.007603], '点估计 Δg -0.0757，95% 区间 [-0.1363, -0.0076] 不跨 0；方向判对的概率 99%；日线近似，不是 1 分钟'),
      unit('UC-QQQ', '不做', [-0.197807, -0.024819], '点估计 Δg -0.1162，95% 区间 [-0.1978, -0.0248] 不跨 0；方向判对的概率 100%；日线近似，不是 1 分钟'),
      { id: 'V5-SPY', decision: '不适用', reason_zh: '不适用（勘误 1）' },
      { id: 'V5-QQQ', decision: '不适用', reason_zh: '不适用（勘误 1）' },
      unit('V5-VOO', '做', vooCi, '点估计 Δg +0.0036，区间跨 0（[-0.0505, +0.0447]）；方向判对的概率 56%；日线近似，不是 1 分钟'),
      unit('V5-SPMO', '做', [0.013363, 0.053218], '点估计 Δg +0.0313，95% 区间 [+0.0134, +0.0532] 不跨 0；方向判对的概率 100%；日线近似，不是 1 分钟'),
    ],
  };
}

/** 四个 R_US_ETF_1 登记项，读取路径取真实登记表（登记表漂移时这里跟着变）。 */
function fixture(docOptions) {
  const body = `${JSON.stringify(rue1Doc(docOptions), null, 2)}\n`;
  const repo = tmp('qrp-rue1-repo-');
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'rue1.json'), body);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seal');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const file = { source: 'smartflow', commit, path: 'rue1.json', sha256: sha(body), ref: 'smartflow@x:rue1.json' };
  const real = (id) => overseas.ENTRIES.find((e) => e.id === id);
  const entries = ['UC-RUE1-SPY', 'UC-RUE1-QQQ', 'US5-RUE1-VOO', 'US5-RUE1-SPMO'].map((id) => ({
    id, kind: 'RESULT', sealed_on: '2026-11-05', label_zh: real(id).label_zh, title_zh: real(id).title_zh, strategy_ref: real(id).strategy_ref,
    k2: null, freeze: null, file, read: real(id).read, expect: real(id).expect,
  }));
  const art = tmp('qrp-rue1-art-');
  const out = tmp('qrp-rue1-ev-');
  overseas.stageEvidence({ smartflowRoot: repo, artifactsRoot: art, out, entries });
  overseas.importVerdicts(out, { registeredBy: AUTH, entries });
  return { entries, stores: [{ market: null, store: overseas.STORE, entries, locks: () => overseas.locks() }] };
}

test.beforeEach(() => {
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH;
  delete process.env[returns.SEALED_SWITCH];
  for (const ledger of [overseas.LEDGER(), ashare.LEDGER()]) fs.rmSync(ledger, { force: true });
  overseas.clearCache();
});

test('W46 L6：R_US_ETF_1 四行的 verdictState = 结论词＋证据强度标签，导出的 sealedVerdicts 没有一个 desk 禁用词；符合 desk schema', () => {
  const fx = fixture();
  const payload = returns.buildReturn({ generatedAt: AT, sealedVerdicts: true, sealedStores: fx.stores });
  assert.deepEqual(schema.validate(RETURN_SCHEMA, payload), []);
  assert.deepEqual(bannedHits(payload.sealedVerdicts), []);
  const by = Object.fromEntries(payload.sealedVerdicts.map((r) => [r.id.replace(/^OSV-(.*)-[0-9a-f]{12}$/, '$1'), r]));
  assert.deepEqual(Object.keys(by).sort(), ['UC-RUE1-QQQ', 'UC-RUE1-SPY', 'US5-RUE1-SPMO', 'US5-RUE1-VOO']);
  assert.deepEqual(['UC-RUE1-SPY', 'UC-RUE1-QQQ', 'US5-RUE1-VOO', 'US5-RUE1-SPMO'].map((id) => [by[id].verdict, by[id].verdictState, by[id].book]), [
    ['不做', '不做（95% 区间不跨 0）', UC],
    ['不做', '不做（95% 区间不跨 0）', UC],
    ['做', '做（点估计，区间跨 0）', US5],
    ['做', '做（95% 区间不跨 0）', US5],
  ]);
});

test('W46 L6：封存文件不动，原文仍可按登记的路径从 resultFile 读到（sha256 不变）', () => {
  const fx = fixture();
  const rows = sealed.sealedRows({ stores: fx.stores });
  for (const entry of fx.entries) {
    const lock = overseas.locks().find((l) => l.entry_id === entry.id);
    const bytes = fs.readFileSync(lock.file_ref);
    assert.equal(sha(bytes), entry.file.sha256);
    const row = rows.find((r) => r.id === lock.result_id);
    assert.equal(row.sha256, entry.file.sha256);
    assert.equal(row.resultFile, 'smartflow:rue1.json');
    const original = entry.read.strength.split('.').reduce((node, key) => node[key], JSON.parse(bytes.toString('utf8')));
    assert.match(original, /方向判对的概率/, `${entry.id}: 原文留在封存文件里`);
  }
});

test('W46 L6：裁定与封存文件不符（区间跨 0 与否、单元 id）就拒绝导出，不回退到原文（结论词漂移由导入时的期望结论先拦下）', () => {
  const crossed = fixture({ vooCi: [0.001, 0.044675] });
  assert.throws(() => sealed.sealedRows({ stores: crossed.stores }), /RETURN_SEALED_STATE_NOT_AS_RULED:US5-RUE1-VOO/);
  fs.rmSync(overseas.LEDGER(), { force: true });
  overseas.clearCache();
  const moved = fixture({ spyUnit: 'UC-SPY-MOVED' });
  assert.throws(() => sealed.sealedRows({ stores: moved.stores }), /RETURN_SEALED_STATE_NOT_AS_RULED:UC-RUE1-SPY/);
});

test('W46 L6：登记表里每个 R_US_ETF_1 RESULT 都有裁定，裁定的单元下标与登记的读取路径一致', () => {
  const rue1 = overseas.ENTRIES.filter((e) => e.kind === 'RESULT' && e.file && /R_US_ETF_1_RESULT_V1\.json$/.test(e.file.path));
  assert.deepEqual(rue1.map((e) => e.id).sort(), Object.keys(sealed.RUE1_RULED).sort());
  for (const entry of rue1) {
    const rule = sealed.RUE1_RULED[entry.id];
    assert.equal(entry.read.strength, `verdict_detail.${rule.detail}.evidence_strength_zh`, entry.id);
    assert.equal(entry.read.decision, `verdict_detail.${rule.detail}.decision`, entry.id);
    assert.equal(entry.expect, rule.verdict, entry.id);
    assert.equal(bannedIn(sealed.ruledStateText(rule)), null, entry.id);
  }
});

test('desk 禁用词表与 desk 检出逐字一致（desk 检出不在旁边时跳过）', (t) => {
  const deskFile = path.resolve(__dirname, '..', '..', 'portfolio-desk', 'src', 'decision-contracts.js');
  if (!fs.existsSync(deskFile)) { t.skip('portfolio-desk checkout absent'); return; }
  const { PREDICTIVE_TERMS } = require(deskFile);
  assert.deepEqual([...PREDICTIVE_TERMS], [...DESK_PREDICTIVE_TERMS]);
});
