'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { vendor, FILES } = require('../tools/fill-model-vendor/vendor');
const fm = require('../packages/fill-model');

/**
 * 拷贝工具与守卫模板（规格 90814c60 §1）：拷的是 QRP 某个提交的字节，PIN.json 写提交号与每个文件的 sha256；
 * 守卫模板在消费方核对拷来的字节，漂移、缺文件、多余文件都红。用一个合成的「QRP」仓库，不碰真实的 V6 与 smartflow。
 */
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SRC = path.join(__dirname, '..', 'packages', 'fill-model');

function fakeQrp() {
  const root = tmp('qrp-fm-src-');
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'packages', 'fill-model'), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(root, 'packages', 'fill-model', f));
  git('add', '.'); git('commit', '-q', '-m', 'fill-model');
  return { root, commit: git('rev-parse', 'HEAD') };
}

test('拷贝：拷的是提交里的字节，PIN.json 写 QRP 提交号与每个文件的 sha256；工作区后来的改动不会被拷走', () => {
  const qrp = fakeQrp();
  fs.appendFileSync(path.join(qrp.root, 'packages', 'fill-model', 'index.js'), '\n// 未提交的改动\n');
  const target = tmp('qrp-fm-target-');
  const pin = vendor({ qrpRoot: qrp.root, target });
  assert.deepEqual([pin.schema, pin.repository, pin.path, pin.commit, pin.version], ['FILL_MODEL_VENDOR_PIN_V1', 'UpMeAI/quant-research-platform', 'packages/fill-model', qrp.commit, fm.VERSION]);
  for (const f of FILES) {
    const bytes = fs.readFileSync(path.join(target, 'vendor', 'fill-model', f));
    assert.deepEqual(bytes, fs.readFileSync(path.join(SRC, f)), f);
    assert.equal(pin.files[f], sha256(bytes));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'vendor', 'fill-model', 'PIN.json'), 'utf8')), pin);
  // 拷来的库能用
  const lib = require(path.join(target, 'vendor', 'fill-model', 'index.js'));
  assert.equal(lib.SAME_BAR_STOP_FIRST({ high: 106, low: 94, stop: 95, target: 105, position: 'LONG' }), 'STOP');
});

// 模板在加载时登记它自己的 FMV-0：先拷好一份，让 FMV-0 对着它跑（消费方仓库里就是 vendor/fill-model/）
const TOP = (() => { const qrp = fakeQrp(); const target = tmp('qrp-fm-target-'); vendor({ qrpRoot: qrp.root, target }); return path.join(target, 'vendor', 'fill-model'); })();
process.env.FILL_MODEL_VENDOR_DIR = TOP;
const { problems } = require('../tools/fill-model-vendor/fill-model-vendor-guard.test.template.js');

test('守卫模板：原样拷来的目录通过；改了一个字节、缺文件、多了文件都报出来', () => {
  const dir = TOP;
  assert.deepEqual(problems(dir), []);
  const drift = tmp('qrp-fm-drift-');
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(drift, f));
  fs.appendFileSync(path.join(drift, 'series.js'), ' ');
  fs.writeFileSync(path.join(drift, 'local-patch.js'), '');
  fs.rmSync(path.join(drift, 'index.js'));
  assert.deepEqual(problems(drift).sort(), ['FILE_DRIFT:series.js', 'FILE_EXTRA:local-patch.js', 'FILE_MISSING:index.js']);
});
