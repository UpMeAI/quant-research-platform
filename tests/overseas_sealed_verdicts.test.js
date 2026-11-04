'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const verdicts = require('../services/overseas-sealed-verdicts');
const { validateRecord } = require('../schemas');
const { read } = require('../packages/ledger');

const AUTH = 'TEST_OVERSEAS_AUTHORITY';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();

/** 合成的 smartflow 仓库（一个提交）与协调会话目录；登记表形状同 ENTRIES。 */
function fixture({ decision = '不做' } = {}) {
  const repo = tmp('qrp-osv-sf-');
  const art = tmp('qrp-osv-art-');
  const files = {
    'trading-system-v2/docs/evidence/x/RESULT.json': `${JSON.stringify({ verdict: { decision, evidence_strength: '无候选', allowed_use: '诊断', text_zh: '说明' } })}\n`,
    'trading-system-v2/docs/K2.md': '# K2\n',
    'trading-system-v2/docs/DRAFT_K2.md': '# draft\n',
    'trading-system-v2/docs/SHADOW.md': '# shadow\n',
  };
  git(repo, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seal');
  const commit = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(art, 'FREEZE_1.md'), 'frozen\n');
  const sf = (rel) => ({ source: 'smartflow', commit, path: `trading-system-v2/${rel}`, sha256: sha(files[`trading-system-v2/${rel}`]), ref: `smartflow@x:${rel}` });
  const freeze = { source: 'coordinator', path: 'FREEZE_1.md', sha256: sha('frozen\n'), ref: 'artifacts/coordinator/FREEZE_1.md' };
  const draft = sf('docs/DRAFT_K2.md');
  const entries = [
    { id: 'T-RESULT', label_zh: 'N9', strategy_ref: 'C17_V2_4000USDT', kind: 'RESULT', sealed_on: '2026-11-04', title_zh: '题',
      file: sf('docs/evidence/x/RESULT.json'), k2: sf('docs/K2.md'), freeze,
      read: { decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'verdict.text_zh' }, expect: '不做' },
    { id: 'T-DRAFT', label_zh: 'N10（草稿）', strategy_ref: 'C17_V2_4000USDT', kind: 'DRAFT', sealed_on: '2026-11-05', title_zh: '草稿题',
      file: draft, k2: draft, freeze: null, status_zh: '草稿（未冻结）', note_zh: '等冻结' },
    { id: 'T-STATUS', label_zh: '影子', strategy_ref: 'US_V5_ETF_3000USD', kind: 'STATUS', sealed_on: '2026-11-04', title_zh: '影子题',
      file: sf('docs/SHADOW.md'), k2: null, freeze: null, status_zh: '前向影子运行中', note_zh: '已部署', cites: ['Q6-x'] },
  ];
  return { repo, art, entries, commit };
}

const stageAndImport = (fx, opts = {}) => {
  const out = tmp('qrp-osv-ev-');
  verdicts.stageEvidence({ smartflowRoot: fx.repo, artifactsRoot: fx.art, out, entries: fx.entries });
  return { out, rows: verdicts.importVerdicts(out, { registeredBy: AUTH, entries: fx.entries, ...opts }) };
};

test.beforeEach(() => { process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTH; try { fs.rmSync(verdicts.LEDGER()); } catch (error) { /* 首次 */ } verdicts.clearCache(); });

test('登记表：每题绑定的 sha256 都是 64 位小写十六进制，id 不重复，RESULT 都有期望结论', () => {
  const ids = new Set();
  for (const entry of verdicts.ENTRIES) {
    assert.ok(!ids.has(entry.id), entry.id); ids.add(entry.id);
    for (const { spec } of verdicts.internals.boundFiles(entry)) assert.match(spec.sha256, /^[0-9a-f]{64}$/, `${entry.id}:${spec.path}`);
    if (entry.kind === 'RESULT') assert.ok(entry.expect, entry.id);
    assert.ok(['RESULT', 'DRAFT', 'STATUS'].includes(entry.kind));
  }
  assert.equal(verdicts.ENTRIES.length, 16);
});

test('stage + import：一题一条锁，结论原样读自文件；重复导入是幂等重放，台账旧字节不变', () => {
  const fx = fixture();
  const { out, rows } = stageAndImport(fx);
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.deepEqual(validateRecord(row), { ok: true, problems: [] }); assert.equal(row.production_effect, 'NONE'); }
  assert.equal(rows[0].decision, '不做');
  const before = fs.readFileSync(verdicts.LEDGER());
  const again = verdicts.importVerdicts(out, { registeredBy: AUTH, entries: fx.entries });
  assert.ok(again.every((row) => row.replayHit));
  assert.deepEqual(fs.readFileSync(verdicts.LEDGER()), before);
  const c17 = verdicts.readProjections('C17_V2_4000USDT', { entries: fx.entries });
  assert.deepEqual(c17.map((row) => [row.entry_id, row.state, row.decision_zh]), [['T-RESULT', 'LOCKED_VERIFIED', '不做'], ['T-DRAFT', 'LOCKED_VERIFIED', '草稿（未冻结）']]);
  assert.equal(c17[0].k2_sha256, fx.entries[0].k2.sha256);
  assert.equal(c17[0].result_sha256, fx.entries[0].file.sha256);
  assert.equal(c17[1].result_sha256, null);
  assert.equal(c17[1].k2_sha256, fx.entries[1].file.sha256);
  const us5 = verdicts.readProjections('US_V5_ETF_3000USD', { entries: fx.entries });
  assert.deepEqual(us5[0].cites, ['Q6-x']);
});

test('失败关闭：结论与登记不符、sha256 不符、没有完成权威，都整批拒绝且不写', () => {
  const fx = fixture({ decision: '做' });
  const out = tmp('qrp-osv-ev-');
  verdicts.stageEvidence({ smartflowRoot: fx.repo, artifactsRoot: fx.art, out, entries: fx.entries });
  assert.throws(() => verdicts.importVerdicts(out, { registeredBy: AUTH, entries: fx.entries }), /VERDICT_NOT_AS_REGISTERED/);
  assert.equal(read(verdicts.LEDGER()).length, 0);
  const bad = fx.entries.map((entry) => (entry.id === 'T-DRAFT' ? { ...entry, file: { ...entry.file, sha256: 'f'.repeat(64) }, k2: { ...entry.file, sha256: 'f'.repeat(64) } } : entry));
  assert.throws(() => verdicts.stageEvidence({ smartflowRoot: fx.repo, artifactsRoot: fx.art, out: tmp('qrp-osv-ev-'), entries: bad }), /STAGE_SHA256_MISMATCH/);
  assert.throws(() => verdicts.importVerdicts(out, { registeredBy: 'SOMEONE', entries: fx.entries }), /NOT_AUTHORIZED/);
});

test('同题换文件须 supersedes + 缺陷引用 + 理由；旧锁保留', () => {
  const fx = fixture();
  stageAndImport(fx);
  const old = verdicts.headLock('T-RESULT');
  // 另一份封存文件（结论相同，字节不同）
  const fx2 = fixture();
  const resultPath = path.join(fx2.repo, 'trading-system-v2/docs/evidence/x/RESULT.json');
  const body = `${JSON.stringify({ verdict: { decision: '不做', evidence_strength: '无候选', allowed_use: '诊断', text_zh: '更正后的说明' } })}\n`;
  fs.writeFileSync(resultPath, body);
  git(fx2.repo, 'commit', '-q', '-am', 'reseal');
  const commit = git(fx2.repo, 'rev-parse', 'HEAD');
  const entries = fx2.entries.map((entry) => ({ ...entry, file: { ...entry.file, commit }, ...(entry.k2 ? { k2: { ...entry.k2, commit } } : {}) }));
  entries[0] = { ...entries[0], file: { ...entries[0].file, sha256: sha(body) } };
  const out = tmp('qrp-osv-ev-');
  verdicts.stageEvidence({ smartflowRoot: fx2.repo, artifactsRoot: fx2.art, out, entries });
  assert.throws(() => verdicts.importVerdicts(out, { registeredBy: AUTH, entries }), /ALREADY_LOCKED/);
  assert.throws(() => verdicts.importVerdicts(out, { registeredBy: AUTH, entries, supersedes: { 'T-RESULT': old.result_id } }), /SUPERSEDE_REQUIRES_DEFECT_AND_REASON/);
  assert.throws(() => verdicts.importVerdicts(out, { registeredBy: AUTH, entries, supersedes: { 'T-DRAFT': 'OSV-NOPE' } }), /ALREADY_LOCKED/);
  const rows = verdicts.importVerdicts(out, { registeredBy: AUTH, entries, supersedes: { 'T-RESULT': old.result_id }, defectRef: 'D-1', reason: '更正' });
  assert.equal(rows[0].supersedes_ref, old.result_id);
  assert.ok(rows.slice(1).every((row) => row.replayHit));
  assert.equal(verdicts.locks().filter((row) => row.entry_id === 'T-RESULT').length, 2);
  assert.equal(verdicts.readProjections('C17_V2_4000USDT', { entries })[0].text_zh, '更正后的说明');
});

test('页面投影每次读都现场复验：文件漂移显示 INVALID，文件缺失显示 MISSING，不显示结论', () => {
  const fx = fixture();
  const { out } = stageAndImport(fx);
  const file = verdicts.internals.evidencePath(out, fx.entries[0].file);
  fs.writeFileSync(file, '{"verdict":{"decision":"做"}}\n');
  verdicts.clearCache();
  const [row] = verdicts.readProjections('C17_V2_4000USDT', { entries: fx.entries });
  assert.equal(row.state, 'INVALID');
  assert.equal(row.decision_zh, undefined);
  fs.rmSync(file);
  verdicts.clearCache();
  assert.equal(verdicts.readProjections('C17_V2_4000USDT', { entries: fx.entries })[0].state, 'MISSING');
});
