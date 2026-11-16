#!/usr/bin/env node
'use strict';

/**
 * 重钉 KG 数据集登记表（RESEARCH_LIVE_PARITY_V1 ★5 (a)；历史按协调会话 2026-11-17 01:2x 裁定）。
 *
 *   node tools/dataset-registry-repin/repin.js --kg-root <knowledge-graph 仓库> --commit <KG 提交> [--dir <config/dataset-registry>]
 *        [--production-pin ashare-v6=<提交>:<路径>] [--production-pin smartflow=<提交>:<路径>]
 *
 *   1. 换下来的那一份（PIN.json 现在钉的）原样留在 history/<版本>-<sha 前 8 位>/，HISTORY.json 记上（已经在就核对字节，不一样即停）；
 *   2. 从 KG 提交 git show 出 data/registry/datasets.v1.json 与 scripts/registry/dataset-registry-scan.cjs，写进 config/dataset-registry/；
 *   3. 新的一份也记进历史（历史总包含现在钉的这一份）；改写 PIN.json（commit、两份 sha256、registry_version；生产两端的钉版按参数更新，没给就照旧并提醒）。
 * 只写 config/dataset-registry/，不删历史里的任何一份。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', '..', 'config', 'dataset-registry');
const SOURCES = Object.freeze({ 'datasets.v1.json': 'data/registry/datasets.v1.json', 'dataset-registry-scan.cjs': 'scripts/registry/dataset-registry-scan.cjs' });
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** 一份副本放进历史：目录不存在就拷进去；存在就逐字节核对。HISTORY.json 没有这一条就加上。 */
function keep(dir, { version, commit, bytes }) {
  const files = Object.fromEntries(Object.entries(bytes).map(([f, b]) => [f, sha256(b)]));
  const name = `${version}-${files['datasets.v1.json'].slice(0, 8)}`;
  const target = path.join(dir, 'history', name);
  fs.mkdirSync(target, { recursive: true });
  for (const [f, b] of Object.entries(bytes)) {
    const p = path.join(target, f);
    if (fs.existsSync(p)) { if (!fs.readFileSync(p).equals(b)) throw new Error(`DATASET_REGISTRY_REPIN_HISTORY_CONFLICT:${name}/${f}`); } else fs.writeFileSync(p, b);
  }
  const histFile = path.join(dir, 'history', 'HISTORY.json');
  const hist = fs.existsSync(histFile) ? readJson(histFile) : { schema: 'DATASET_REGISTRY_HISTORY_V1', entries: [] };
  const prior = hist.entries.find((e) => e.dir === name);
  if (prior) {
    if (prior.commit !== commit || prior.files['datasets.v1.json'] !== files['datasets.v1.json']) throw new Error(`DATASET_REGISTRY_REPIN_HISTORY_CONFLICT:${name}`);
  } else hist.entries.push({ version, commit, dir: name, files });
  fs.writeFileSync(histFile, `${JSON.stringify(hist, null, 2)}\n`);
  return name;
}

/**
 * @param {{kgRoot: string, commit: string, dir?: string, productionPins?: object[]|null}} o
 * @returns {{outgoing: string, incoming: string, pin: object}}
 */
function repin({ kgRoot, commit, dir = DIR, productionPins = null }) {
  if (!kgRoot || !/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('DATASET_REGISTRY_REPIN_ARGUMENTS');
  const oldPin = readJson(path.join(dir, 'PIN.json'));
  const oldBytes = Object.fromEntries(Object.keys(SOURCES).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  for (const [f, b] of Object.entries(oldBytes)) if (sha256(b) !== oldPin.files[f]) throw new Error(`DATASET_REGISTRY_REPIN_CURRENT_DRIFT:${f}`);
  const outgoing = keep(dir, { version: oldPin.registry_version, commit: oldPin.commit, bytes: oldBytes });
  const newBytes = Object.fromEntries(Object.entries(SOURCES).map(([f, src]) => [f, execFileSync('git', ['-C', kgRoot, 'show', `${commit}:${src}`], { maxBuffer: 1 << 28 })]));
  const version = JSON.parse(newBytes['datasets.v1.json'].toString('utf8')).version;
  for (const [f, b] of Object.entries(newBytes)) fs.writeFileSync(path.join(dir, f), b);
  const incoming = keep(dir, { version, commit, bytes: newBytes });
  const pin = { ...oldPin, commit, registry_version: version, files: Object.fromEntries(Object.entries(newBytes).map(([f, b]) => [f, sha256(b)])),
    production_pins: productionPins || oldPin.production_pins };
  fs.writeFileSync(path.join(dir, 'PIN.json'), `${JSON.stringify(pin, null, 2)}\n`);
  return { outgoing, incoming, pin, production_pins_updated: Boolean(productionPins) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const pins = [];
  args.forEach((a, i) => { if (a === '--production-pin') { const [repository, rest] = args[i + 1].split('='); const [c, p] = rest.split(':'); pins.push({ repository, commit: c, path: p }); } });
  const out = repin({ kgRoot: opt('--kg-root'), commit: opt('--commit'), dir: opt('--dir') || DIR, productionPins: pins.length ? pins : null });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.production_pins_updated) process.stderr.write('note: production_pins unchanged; pass --production-pin for V6 and smartflow once they re-pin\n');
}

module.exports = { DIR, SOURCES, repin, internals: { keep } };
