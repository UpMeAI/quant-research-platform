'use strict';
/** 规范化 JSON（键排序、紧凑）与 sha256：网关的质量闸记录 id、卡与事实包的哈希都按它算（与 rq_gateway.canonical_json 同形）。 */
const crypto = require('crypto');

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
const canonicalJson = (v) => JSON.stringify(sortKeys(v));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SHA64 = /^[0-9a-f]{64}$/;
/** 密钥形状的字串：任何产物、结果、日志里都不许出现（AQ-21）。 */
const SECRET_SHAPED = /sk-[A-Za-z0-9]{16,}/;
const scrubSecrets = (obj) => JSON.parse(JSON.stringify(obj).replace(/sk-[A-Za-z0-9]{16,}/g, '[REDACTED]'));

module.exports = { canonicalJson, sha256, isObj, SHA64, SECRET_SHAPED, scrubSecrets };
