'use strict';

/**
 * G-COST 覆盖面检查（PAPER_TRADING_COST_MODEL_V1 ★C4）：研究净值行必须收齐登记文件里该市场标为 CHARGED 的每一项；
 * 缺一项、UNKNOWN、金额读不到，整行 NET_PARTIAL，不算净值行（门 COST_MODEL_NET_PARTIAL 拒绝导入，失败即关）。
 * 佣金与滑点的下限不在这里（services/cost-gate 的 FLOORS，附录 1 a3329481，不变）。
 *
 * 唯一来源：vendor/paper-cost-model/PAPER_COST_MODEL_V1.json（登记 r2），PIN.json 钉合同与登记文件的 sha256；
 * 本文件不写任何费率，也不列成本项——哪些项要收、哪些不适用，只读登记文件。
 * 生效：K2 在 COVERAGE_EFFECTIVE_FROM（合同冻结时刻）及以后冻结；更早的 K2 保留各自写明的成本，门不读本检查（见 ../cost-gate 的 check）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONTRACT = 'PAPER_TRADING_COST_MODEL_V1';
const CONTRACT_SHA256 = '1be6e0807995a9501e8b3393427c6367af47cd333e5bf89a0a95c03cc21e76fb';
const COVERAGE_EFFECTIVE_FROM = '2026-11-22T17:35:16+08:00';
const REGISTRY_FILE = 'PAPER_COST_MODEL_V1.json';
const VENDOR_DIR = path.join(__dirname, '..', '..', 'vendor', 'paper-cost-model');
const FLAG_KEYS = Object.freeze({ E1: 'E1' });

class CoverageError extends Error {
  constructor(code, detail) { super(detail ? `COST_MODEL_${code}:${detail}` : `COST_MODEL_${code}`); this.code = `COST_MODEL_${code}`; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new CoverageError(code, detail); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

let cached = null;
/** 读登记文件：先按 PIN.json 复验合同与文件字节的 sha256，不一致失败即关。 */
function loadRegistry(dir = VENDOR_DIR) {
  if (cached && dir === VENDOR_DIR) return cached;
  let pin; let bytes;
  try { pin = JSON.parse(fs.readFileSync(path.join(dir, 'PIN.json'), 'utf8')); bytes = fs.readFileSync(path.join(dir, REGISTRY_FILE)); } catch (e) { return fail('COVERAGE_REGISTRY_MISSING', `${dir}:${e.code || e.message}`); }
  if (!isObj(pin) || pin.contract !== CONTRACT || pin.contractSha256 !== CONTRACT_SHA256 || !isObj(pin.files)) fail('COVERAGE_REGISTRY_PIN_INVALID', dir);
  const actual = sha256(bytes);
  if (pin.files[REGISTRY_FILE] !== actual) fail('COVERAGE_REGISTRY_PIN_MISMATCH', `${REGISTRY_FILE}:${actual}`);
  const doc = JSON.parse(bytes.toString('utf8'));
  if (!isObj(doc) || doc.contract !== CONTRACT || !isObj(doc.markets) || doc.registryRevision !== pin.registryRevision) fail('COVERAGE_REGISTRY_INVALID', dir);
  const out = Object.freeze({ ...doc, sha256: actual });
  if (dir === VENDOR_DIR) cached = out;
  return out;
}

const bookKey = (k) => String(k).replace(/^_/, '');
/** 市场下的簿：登记里只有一个簿（美股）时不必写；其余必须写，且只认登记里的簿名（前导下划线可省）。 */
function booksOf(registry, market, declared) {
  const entry = registry.markets[market];
  if (!isObj(entry)) fail('COVERAGE_NO_MARKET', market);
  const names = Object.keys(entry);
  const wanted = declared === undefined || declared === null ? [] : [].concat(declared);
  if (!wanted.length) {
    if (names.length === 1) return [names[0]];
    fail('COVERAGE_BOOK_MISSING', `${market}:one of ${names.map(bookKey).join('|')}`);
  }
  return wanted.map((w) => {
    const hit = names.find((n) => typeof w === 'string' && bookKey(n) === bookKey(w));
    if (!hit) fail('COVERAGE_BOOK_MISSING', `${market}:${w}`);
    return hit;
  });
}

/**
 * 一行成本拆分的覆盖面。
 * @param {{items?: object[], books?: string|string[], flags?: object}} row 行里自报的 items（合同 §4 的形状）、簿、条件开关
 * @param {string} market 下限市场（CN_A / US / CRYPTO）
 */
function assessCoverage(row, market, registry = loadRegistry()) {
  const books = booksOf(registry, market, row.books);
  const flags = isObj(row.flags) ? row.flags : {};
  const required = new Set(); const registryUnknown = new Set();
  for (const b of books) {
    for (const [item, def] of Object.entries(registry.markets[market][b].items)) {
      if (def.state === 'CHARGED') required.add(item);
      else if (def.state === 'UNKNOWN') registryUnknown.add(item);
      else if (def.state === 'CONDITIONAL' && def.whenOn && flags[FLAG_KEYS[def.whenOn] || def.whenOn] === true) required.add(item);
    }
  }
  const items = Array.isArray(row.items) ? row.items : [];
  const byName = new Map();
  const duplicate = new Set();
  for (const r of items) { if (isObj(r) && typeof r.item === 'string') { if (byName.has(r.item)) duplicate.add(r.item); byName.set(r.item, r); } }
  const missing = []; const unknown = []; const wrongState = []; const unreadable = [];
  for (const name of [...required].sort()) {
    const r = byName.get(name);
    if (!r) missing.push(name);
    else if (duplicate.has(name)) wrongState.push(name);
    else if (r.state === 'UNKNOWN') unknown.push(name);
    else if (r.state !== 'CHARGED') wrongState.push(name);
    else if (typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount < 0) unreadable.push(name);
  }
  const partial = missing.length + unknown.length + wrongState.length + unreadable.length > 0;
  return { state: partial ? 'NET_PARTIAL' : 'COMPLETE', market, books, required: [...required].sort(), missing, unknown, wrong_state: wrongState, unreadable_amount: unreadable,
    registry_unknown_items: [...registryUnknown].sort() };
}

/** 门里用：NET_PARTIAL 即拒绝（NET_PARTIAL 的行不是净值行）。 */
function requireComplete(row, market, at, registry = loadRegistry()) {
  const r = assessCoverage(row, market, registry);
  if (r.state !== 'COMPLETE') {
    const parts = [['missing', r.missing], ['unknown', r.unknown], ['wrong_state', r.wrong_state], ['unreadable_amount', r.unreadable_amount]].filter(([, v]) => v.length).map(([k, v]) => `${k}=${v.join(',')}`);
    fail('NET_PARTIAL', `${at}:${market}/${r.books.map(bookKey).join('+')}:${parts.join(';')}`);
  }
  return r;
}

module.exports = { CONTRACT, CONTRACT_SHA256, COVERAGE_EFFECTIVE_FROM, REGISTRY_FILE, CoverageError, loadRegistry, assessCoverage, requireComplete };
