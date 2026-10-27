'use strict';

/**
 * Desk 契约的 `hash` 字段算法（portfolio-desk `src/canonical.js` 的 `contentHash`）：去掉 `hash` 键之后，
 * 深层按键排序、紧凑分隔的 JSON，再取 sha256。数组保持原顺序；键按码位顺序排；对象里的 undefined 丢掉，
 * 数组里的 undefined 与非有限数字抛错。
 *
 * 不复用 services/research-adoption 的 canonical()：它靠 JSON.stringify 的 replacer 重排键，遇到「5」「15」这类整数形的键时，
 * JS 对象总是把它们按数值放在最前，排出来与 desk 的逐键拼接不同。那个函数决定已写入的采用记录号，不能改，所以这里另写一份与 desk 逐字节一致的。
 */
const crypto = require('crypto');

function canonicalJson(value, at = '$') {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => {
      if (item === undefined) throw new Error(`CANONICAL_UNDEFINED_IN_ARRAY:${at}[${index}]`);
      return canonicalJson(item, `${at}[${index}]`);
    }).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], `${at}.${key}`)}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`CANONICAL_NON_FINITE_NUMBER:${at}`);
  return JSON.stringify(value);
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** sha256(canonicalJson(去掉 hashField 的 payload))。 */
function contentHash(payload, hashField = 'hash') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('CANONICAL_NOT_AN_OBJECT');
  const body = {};
  for (const key of Object.keys(payload)) if (key !== hashField) body[key] = payload[key];
  return sha256(canonicalJson(body));
}

module.exports = { canonicalJson, contentHash, sha256 };
