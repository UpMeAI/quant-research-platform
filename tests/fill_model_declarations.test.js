'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const decl = require('../services/fill-model-declarations');
const fm = require('../packages/fill-model');

/**
 * 逐个账本的成交模型声明（ENGINE_MODELING_ACCEPTANCE_V1 §2.2 第 2 条，规格 90814c60 §3）：结构校验与锁定测试。
 * 锁定测试按 `git show <钉住的提交>:<路径>` 读 V6（83ab3af1）与 smartflow（3b25fb61）的源文件，核对常量；实盘改了常量，这里就红。
 * 仓库路径：环境变量 QRP_V6_ROOT / QRP_SMARTFLOW_ROOT，否则取 QRP 旁边的 Ashare-V6 / smartflow；都不在时跳过并写明原因。
 */
const DOC = decl.load();
const clone = () => JSON.parse(JSON.stringify(DOC));
const refuses = (doc, code) => assert.throws(() => decl.validate(doc), (e) => e.code === `FILL_DECLARATION_${code}`, code);

test('结构：12 条（6 个账本各 2 段），节奏规则与成交规则都是库里的规则，出处指向钉住的仓库，环境开关写明来源，每条要么有锁、要么写明为什么没锁', () => {
  assert.equal(DOC.declarations.length, 12);
  assert.deepEqual([...new Set(DOC.declarations.map((d) => d.book))], [...decl.BOOKS]);
  assert.deepEqual([DOC.pins['ashare-v6'].commit.slice(0, 8), DOC.pins.smartflow.commit.slice(0, 8)], ['83ab3af1', '3b25fb61']);
  assert.deepEqual([DOC.env_read.read_by, DOC.env_read.read_at], ['coordinator', '2026-11-17T00:16:00+08:00']);
  assert.deepEqual(DOC.contract_ref.spec.sha256.slice(0, 8), '90814c60');
  const usV5Watch = DOC.declarations.find((d) => d.book === 'US.US_V5' && d.segment === 'INTRADAY_WATCH');
  assert.deepEqual(usV5Watch.params.tiers, fm.DEFAULT_TIERS); // 声明的档位 = 库的默认档位 = 实盘（锁）
  const counts = DOC.declarations.map((d) => d.locks.length);
  assert.ok(counts.filter((c) => c > 0).length >= 9, `有锁的条数 ${counts}`);
});

test('结构反例：成交规则不在库里、节奏规则放进成交规则、环境开关没写来源、锁的正则不是一个捕获组、同一段写两次、账本只有一段、没锁也没写原因', () => {
  let d = clone(); d.declarations[0].rules.push('CLOSE_PRICE'); refuses(d, 'RULES_INVALID');
  d = clone(); d.declarations[0].rules.push('POLL_EVERY'); refuses(d, 'RULES_INVALID');
  d = clone(); d.declarations[4].env[0].where = 'SOMEWHERE'; refuses(d, 'ENV_INVALID');
  d = clone(); d.declarations[1].locks[0].pattern = 'DEFAULT_INTERVAL_MS = [0-9_]+;'; refuses(d, 'LOCK_PATTERN_INVALID');
  d = clone(); d.declarations[1].segment = d.declarations[0].segment; refuses(d, 'ROW_DUPLICATE');
  d = clone(); d.declarations[1].book = 'CN_A.STOCK_FIVE_STAGE'; refuses(d, 'BOOK_SEGMENTS_INVALID');
  d = clone(); delete d.declarations[2].unlocked_reason_zh; refuses(d, 'LOCKS_INVALID');
  d = clone(); d.declarations[0].cadence.rule = 'EVERY_TICK'; refuses(d, 'CADENCE_INVALID');
});

const results = decl.verifyLocks(DOC);
const missing = [...new Set(results.filter((r) => r.state === 'SKIPPED').map((r) => r.reason))];

test('锁定：每条锁在钉住的提交上读到的常量与声明逐字相同（60000 毫秒、5 分钟、2% / 60 秒与 4% / 300 秒、:31 分的扫描节奏等）',
  { skip: missing.length ? `钉住的仓库不在本机：${missing.join('；')}` : false }, () => {
    const failed = results.filter((r) => r.state !== 'PASS');
    assert.deepEqual(failed, []);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.deepEqual([byId.V6_INTRADAY_INTERVAL_MS.actual, byId.SF_QS_MONITOR_INTERVAL.actual, byId.SF_LEVERAGED_STOP_TIERS.actual, byId.SF_US_V5_ROUND_LAG.actual, byId.SF_US_V5_OPEN_MIN.actual],
      ['60_000', '5 * 60 * 1000', '{ t1Pct: 2.0, t1TimeoutS: 60, t2Pct: 4.0, t2TimeoutS: 300 }', 'MINUTE_MS', '9 * 60 + 30']);
    assert.ok(results.length >= 20, `锁 ${results.length} 条`);
  });

test('锁定反例：实盘改了常量（合成仓库，60 秒改成 30 秒）→ 锁红；仓库不在 → SKIPPED，不算通过；算式求值', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-fm-lock-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'src', 'intraday'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'intraday', 'intraday-config.js'), 'const DEFAULT_INTERVAL_MS = 30_000;\n');
  git('add', '.'); git('commit', '-q', '-m', 'drift');
  const one = { ...clone(), declarations: [clone().declarations[1]] };
  one.declarations[0].locks = [one.declarations[0].locks[0]];
  one.pins = { ...one.pins, 'ashare-v6': { ...one.pins['ashare-v6'], commit: git('rev-parse', 'HEAD') } };
  const [r] = decl.verifyLocks(one, { roots: { 'ashare-v6': repo } });
  assert.deepEqual([r.state, r.actual], ['FAIL', '30_000']);
  const [s] = decl.verifyLocks(one, { roots: { 'ashare-v6': null } });
  assert.equal(s.state, 'SKIPPED');
  assert.deepEqual(['60_000', '5 * 60 * 1000', '9 * 60 + 30', '0.0005', 'MINUTE_MS'].map(decl.numericValue), [60000, 300000, 570, 0.0005, null]);
});
