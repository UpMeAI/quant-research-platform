#!/usr/bin/env node
'use strict';

/**
 * 把 QRP 的统一成交模型库（packages/fill-model，FILL_MODEL_LIBRARY_V1）原样拷进另一个仓库的 vendor/fill-model/，旁边写 PIN.json。
 * 规格 FILL_MODEL_LIBRARY_V1_SPEC（90814c60）§1：做法同数据集登记表的 PIN（V6 的 DRV、smartflow 的 DRS）。
 *
 *   node tools/fill-model-vendor/vendor.js --target <消费方仓库根> [--commit <QRP 提交>] [--qrp-root <QRP 仓库根>]
 *
 * 拷的是 QRP 某个提交里的字节（git show <提交>:packages/fill-model/<文件>），不是工作区；不写 --commit 时取 QRP 的 HEAD。
 * PIN.json：QRP 提交号与每个文件的 sha256。消费方再加守卫测试（tools/fill-model-vendor/fill-model-vendor-guard.test.template.js）。
 * 只写 <target>/vendor/fill-model/，不改消费方别的文件，不开 PR。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILES = Object.freeze(['index.js', 'series.js']);
const SOURCE_DIR = 'packages/fill-model';
const PIN_SCHEMA = 'FILL_MODEL_VENDOR_PIN_V1';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 26 });

/** 拷贝并写 PIN.json；返回 PIN。目标目录里已有的同名文件被覆盖，别的文件原样留着（守卫测试会把它们当成多余文件报出来）。 */
function vendor({ qrpRoot = path.join(__dirname, '..', '..'), target, commit = null }) {
  if (!target) throw new Error('FILL_MODEL_VENDOR_TARGET_REQUIRED');
  const sha = commit || git(qrpRoot, 'rev-parse', 'HEAD').toString().trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`FILL_MODEL_VENDOR_COMMIT_INVALID:${sha}`);
  const dir = path.join(target, 'vendor', 'fill-model');
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const f of FILES) {
    const bytes = git(qrpRoot, 'show', `${sha}:${SOURCE_DIR}/${f}`);
    fs.writeFileSync(path.join(dir, f), bytes);
    files[f] = sha256(bytes);
  }
  const version = (/const VERSION = '([^']+)';/.exec(fs.readFileSync(path.join(dir, 'index.js'), 'utf8')) || [])[1] || null;
  const pin = { schema: PIN_SCHEMA, repository: 'UpMeAI/quant-research-platform', path: SOURCE_DIR, commit: sha, version, files };
  fs.writeFileSync(path.join(dir, 'PIN.json'), `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const pin = vendor({ target: opt('--target'), commit: opt('--commit'), qrpRoot: opt('--qrp-root') || undefined });
  process.stdout.write(`${JSON.stringify(pin, null, 2)}\n`);
}

module.exports = { FILES, SOURCE_DIR, PIN_SCHEMA, vendor };
