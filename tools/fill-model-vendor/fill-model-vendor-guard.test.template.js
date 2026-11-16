'use strict';

/**
 * 守卫测试模板：消费方（V6、smartflow）拷到自己的 tests/ 里用，node:test 与 jest 都能跑。
 * 拷来的 vendor/fill-model/ 必须是 PIN.json 写的那个 QRP 提交的原样字节（统一成交模型库 FILL_MODEL_LIBRARY_V1，规格 90814c60 §1）。
 * 改库只在 QRP 改，再用 QRP 的 tools/fill-model-vendor/vendor.js 重拷、重钉；在这里改字节，本测试就红。
 * 目录默认是本文件上一级的 vendor/fill-model/；环境变量 FILL_MODEL_VENDOR_DIR 可以覆盖。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const test = global.test || require('node:test').test;
const VENDOR = process.env.FILL_MODEL_VENDOR_DIR || path.join(__dirname, '..', 'vendor', 'fill-model');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** 拷来的目录与 PIN.json 的差异；空数组 = 一致。 */
function problems(dir = VENDOR) {
  const out = [];
  const pinFile = path.join(dir, 'PIN.json');
  if (!fs.existsSync(pinFile)) return [`PIN_MISSING:${pinFile}`];
  let pin;
  try { pin = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch { return ['PIN_NOT_JSON']; }
  if (pin.schema !== 'FILL_MODEL_VENDOR_PIN_V1' || pin.repository !== 'UpMeAI/quant-research-platform' || !/^[0-9a-f]{40}$/.test(pin.commit || '') || !pin.files) out.push('PIN_INVALID');
  for (const [file, hash] of Object.entries(pin.files || {})) {
    const f = path.join(dir, file);
    if (!fs.existsSync(f)) { out.push(`FILE_MISSING:${file}`); continue; }
    if (sha256(fs.readFileSync(f)) !== hash) out.push(`FILE_DRIFT:${file}`);
  }
  for (const f of fs.readdirSync(dir)) if (f !== 'PIN.json' && !(pin.files && f in pin.files)) out.push(`FILE_EXTRA:${f}`);
  return out;
}

test('FMV-0 vendored fill-model bytes equal the QRP commit pinned in PIN.json', () => {
  assert.deepStrictEqual(problems(VENDOR), []);
});

module.exports = { problems };
