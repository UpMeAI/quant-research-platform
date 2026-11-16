'use strict';

/**
 * 逐个账本的成交模型声明 FILL_MODEL_DECLARATION —— 引擎建模验收合同 §2.2 第 2 条（签字文本 8d214ddf），实施规格 90814c60 §3。
 * config/fill_model_declarations.v1.json：每个账本每一段一条（共 12 条），写 K 线间隔、检查频率（节奏规则）、单子与成交规则、实盘常量的出处、
 * 环境开关（协调会话读到的值与时刻）和锁（钉住的提交上源码里的常量）。这里只做结构校验；锁的核对在 tests/fill_model_declarations.test.js。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fm = require('../../packages/fill-model');

const FILE = path.join(__dirname, '..', '..', 'config', 'fill_model_declarations.v1.json');
const SCHEMA = 'FILL_MODEL_DECLARATIONS_V1';
const BOOKS = Object.freeze(['CN_A.INDEX_SLEEVE', 'CN_A.STOCK_FIVE_STAGE', 'US.US_V5', 'US.US_CORE', 'CRYPTO.C17', 'CRYPTO.QUICK_SHOT']);
const WHERE = Object.freeze(['HK_PM2', 'MAC_V6_SCHEDULER']);
const SHA64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

class DeclarationError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new DeclarationError(`FILL_DECLARATION_${code}`, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/** 一条锁：仓库在 pins 里、正则能编译且只有一个捕获组、写出期望的源码文字（可加数值）。 */
function checkLock(lock, pins, at) {
  need(isObj(lock) && isText(lock.id) && pins[lock.repo] && isText(lock.path) && isText(lock.pattern) && typeof lock.expect === 'string', 'LOCK_INVALID', `${at}:${lock && lock.id}`);
  let re;
  try { re = new RegExp(lock.pattern); } catch { return fail('LOCK_PATTERN_INVALID', `${at}:${lock.id}`); }
  need(new RegExp(`${re.source}|`).exec('').length === 2, 'LOCK_PATTERN_INVALID', `${at}:${lock.id}:needs exactly one capture group`);
  need(lock.value === undefined || (typeof lock.value === 'number' && Number.isFinite(lock.value)), 'LOCK_INVALID', `${at}:${lock.id}:value`);
}

/** 结构校验：返回解析后的文档；任何一处不合即抛 FILL_DECLARATION_*。 */
function validate(doc) {
  need(isObj(doc) && doc.schema === SCHEMA, 'SCHEMA_INVALID', doc && doc.schema);
  for (const k of ['signed_text', 'signature', 'spec']) need(isObj(doc.contract_ref) && isText(doc.contract_ref[k] && doc.contract_ref[k].path) && SHA64.test(doc.contract_ref[k].sha256 || ''), 'CONTRACT_REF_INVALID', k);
  need(isObj(doc.pins) && Object.keys(doc.pins).length > 0, 'PINS_INVALID');
  for (const [repo, pin] of Object.entries(doc.pins)) need(isObj(pin) && SHA40.test(pin.commit || '') && isText(pin.env_root) && isText(pin.sibling) && typeof pin.package_dir === 'string', 'PINS_INVALID', repo);
  need(isObj(doc.env_read) && isText(doc.env_read.read_by) && isText(doc.env_read.read_at) && Number.isFinite(Date.parse(doc.env_read.read_at)), 'ENV_READ_INVALID');
  need(Array.isArray(doc.declarations), 'DECLARATIONS_INVALID');
  const seen = new Set();
  for (const [i, d] of doc.declarations.entries()) {
    const at = `declarations[${i}]`;
    need(isObj(d) && BOOKS.includes(d.book) && isText(d.segment) && isText(d.bar), 'ROW_INVALID', `${at}:${d && d.book}`);
    const key = `${d.book}/${d.segment}`;
    need(!seen.has(key), 'ROW_DUPLICATE', key);
    seen.add(key);
    need(isObj(d.cadence) && fm.CADENCE_RULES.includes(d.cadence.rule) && isObj(d.cadence.params), 'CADENCE_INVALID', key);
    need(Array.isArray(d.rules) && d.rules.length > 0 && d.rules.every((r) => fm.PRICE_RULES.includes(r)), 'RULES_INVALID', key);
    need(isObj(d.params), 'ROW_INVALID', `${key}:params`);
    need(Array.isArray(d.live_refs) && d.live_refs.length > 0 && d.live_refs.every((r) => /^[a-z0-9-]+:[^:]+:\d+(-\d+)?$/.test(r) && doc.pins[r.split(':')[0]]), 'LIVE_REFS_INVALID', key);
    need(Array.isArray(d.env) && d.env.every((e) => isObj(e) && isText(e.name) && (e.value === null || typeof e.value === 'string') && WHERE.includes(e.where)), 'ENV_INVALID', key);
    need(Array.isArray(d.locks), 'LOCKS_INVALID', key);
    d.locks.forEach((l) => checkLock(l, doc.pins, key));
    need(d.locks.length > 0 || isText(d.unlocked_reason_zh), 'LOCKS_INVALID', `${key}:no lock and no unlocked_reason_zh`);
  }
  for (const b of BOOKS) need(doc.declarations.filter((d) => d.book === b).length === 2, 'BOOK_SEGMENTS_INVALID', b);
  return doc;
}

const load = (file = FILE) => validate(JSON.parse(fs.readFileSync(file, 'utf8')));

/** 锁的数值：源码文字里只有数字、下划线、空格和 * + 时按算式求值（60_000、5 * 60 * 1000、9 * 60 + 30），否则 null。 */
function numericValue(text) {
  if (!/^[0-9_.\s*+]+$/.test(text)) return null;
  return text.replace(/_/g, '').split('+').reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f.trim()), 1), 0);
}

/** 一个钉住仓库的根：环境变量（例如 QRP_V6_ROOT）优先，否则取 QRP 仓库旁边的同名目录；不在或没有那个提交时返回 null。 */
function rootOf(pin, { env = process.env, qrpRoot = path.join(__dirname, '..', '..') } = {}) {
  const candidates = [env[pin.env_root], path.resolve(qrpRoot, '..', pin.sibling), path.resolve(qrpRoot, '..', '..', pin.sibling)].filter(Boolean);
  for (const root of candidates) {
    try { execFileSync('git', ['-C', root, 'cat-file', '-e', `${pin.commit}^{commit}`], { stdio: 'ignore' }); return root; } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 锁的核对：在钉住的提交上读源文件（git show <提交>:<路径>，只读），按正则取出常量的源码文字，与 expect 逐字相等；写了 value 的再按算式比数值。
 * 返回每条锁的结果 { id, repo, path, state: PASS | FAIL | SKIPPED, actual?, reason? }；仓库不在时 SKIPPED（带原因），不算通过。
 */
function verifyLocks(doc, { roots = null, env = process.env } = {}) {
  const rootFor = (repo) => (roots && repo in roots ? roots[repo] : rootOf(doc.pins[repo], { env }));
  const cache = new Map();
  const out = [];
  for (const d of doc.declarations) {
    for (const lock of d.locks) {
      const pin = doc.pins[lock.repo];
      const root = rootFor(lock.repo);
      const base = { book: d.book, segment: d.segment, id: lock.id, repo: lock.repo, path: lock.path };
      if (!root) { out.push({ ...base, state: 'SKIPPED', reason: `${lock.repo} not found (${pin.env_root} or ../${pin.sibling}) at ${pin.commit.slice(0, 8)}` }); continue; }
      const file = pin.package_dir ? `${pin.package_dir}/${lock.path}` : lock.path;
      const key = `${root}|${pin.commit}|${file}`;
      if (!cache.has(key)) {
        try { cache.set(key, execFileSync('git', ['-C', root, 'show', `${pin.commit}:${file}`], { maxBuffer: 1 << 26 }).toString('utf8')); } catch { cache.set(key, null); }
      }
      const text = cache.get(key);
      if (text === null) { out.push({ ...base, state: 'FAIL', reason: 'FILE_NOT_AT_COMMIT' }); continue; }
      const hit = new RegExp(lock.pattern).exec(text);
      if (!hit) { out.push({ ...base, state: 'FAIL', reason: 'PATTERN_NOT_FOUND' }); continue; }
      const actual = hit[1];
      const valueOk = lock.value === undefined || numericValue(actual) === lock.value;
      out.push({ ...base, state: actual === lock.expect && valueOk ? 'PASS' : 'FAIL', actual, ...(actual === lock.expect && valueOk ? {} : { reason: `expect ${lock.expect}${lock.value !== undefined ? ` (= ${lock.value})` : ''}` }) });
    }
  }
  return out;
}

module.exports = { FILE, SCHEMA, BOOKS, WHERE, DeclarationError, validate, load, numericValue, rootOf, verifyLocks };
