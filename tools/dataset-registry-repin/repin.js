#!/usr/bin/env node
'use strict';

/**
 * 重钉 KG 数据集登记表（RESEARCH_LIVE_PARITY_V1 ★5 (a)；历史按协调会话 2026-11-17 01:2x 裁定；写入顺序按协调会话 2026-11-17 02:0x 的说明）。
 *
 *   node tools/dataset-registry-repin/repin.js --kg-root <knowledge-graph 仓库> --commit <KG 提交> [--dir <config/dataset-registry>]
 *        [--production-pin ashare-v6=<提交>:<路径>] [--production-pin smartflow=<提交>:<路径>]
 *
 * 先读齐（KG 提交里的两个文件、现在的副本与 PIN），一个字节都不写；然后按这个顺序写，每一步之后崩掉都不丢东西：
 *   1. 新的一份记进历史：history/<版本>-<sha 前 8 位>/ 的两个文件，再是 HISTORY.json 的一条（带两份 sha256，扫描器的必须有）；
 *   2. 换下来的那一份也在历史里（从 1.11.0 起本来就在，这一步只核对字节；不在才补）；
 *   3. 写 config/dataset-registry/ 下的两个现行文件（各自先写临时文件再改名，不会写出半个文件）；
 *   4. 最后写 PIN.json（同样先写临时文件再改名）。PIN.json 是提交点。
 * 第 1、2 步之后崩：PIN、现行文件、历史仍然一致（历史只是多了一份）。第 3 步中间崩：读登记表时 PIN 与文件对不上，失败即关
 * （DATASET_REGISTRY_PIN_DRIFT），check() 报 INTERRUPTED；同一个提交再跑一次就补完（现行文件只认 PIN 的那份或已记进历史的新那份）。
 * 只写 config/dataset-registry/，不删历史里的任何一份。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', '..', 'config', 'dataset-registry');
const REGISTRY_FILE = 'datasets.v1.json';
const SCANNER_FILE = 'dataset-registry-scan.cjs';
const SOURCES = Object.freeze({ [REGISTRY_FILE]: 'data/registry/datasets.v1.json', [SCANNER_FILE]: 'scripts/registry/dataset-registry-scan.cjs' });
const STEPS = Object.freeze(['INCOMING_FILES_WRITTEN', 'INCOMING_KEPT', 'OUTGOING_KEPT', `CONFIG_WRITTEN:${REGISTRY_FILE}`, `CONFIG_WRITTEN:${SCANNER_FILE}`, 'PIN_WRITTEN']);
const SHA64 = /^[0-9a-f]{64}$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const fail = (code, detail) => { throw new Error(`DATASET_REGISTRY_REPIN_${code}${detail ? `:${detail}` : ''}`); };

/** 先写同目录的临时文件再改名：读的一方只会看到旧的或新的整份。 */
function writeAtomic(file, bytes) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

const histFileOf = (dir) => path.join(dir, 'history', 'HISTORY.json');
const readHistory = (dir) => (fs.existsSync(histFileOf(dir)) ? readJson(histFileOf(dir)) : { schema: 'DATASET_REGISTRY_HISTORY_V1', entries: [] });
const dirName = (version, files) => `${version}-${files[REGISTRY_FILE].slice(0, 8)}`;
const shasOf = (bytes) => Object.fromEntries(Object.entries(bytes).map(([f, b]) => [f, sha256(b)]));
const sameFiles = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(SOURCES).every((f) => a[f] === b[f]);

/** 两份 sha256 都要有（扫描器的从这一版起是必填）。 */
function checkFiles(files, where) {
  for (const f of Object.keys(SOURCES)) if (!SHA64.test((files || {})[f] || '')) fail(f === SCANNER_FILE ? 'SCANNER_SHA_MISSING' : 'REGISTRY_SHA_MISSING', where);
}

/** 一份副本放进历史：先写目录里的两个文件（已在就逐字节核对），再在 HISTORY.json 记一条（已在就核对）。 */
function keep(dir, { version, commit, bytes }, step = () => {}, label = 'INCOMING') {
  const files = shasOf(bytes);
  checkFiles(files, `${version}@${commit}`);
  const name = dirName(version, files);
  const target = path.join(dir, 'history', name);
  fs.mkdirSync(target, { recursive: true });
  for (const [f, b] of Object.entries(bytes)) {
    const p = path.join(target, f);
    if (fs.existsSync(p)) { if (!fs.readFileSync(p).equals(b)) fail('HISTORY_CONFLICT', `${name}/${f}`); } else writeAtomic(p, b);
  }
  if (label === 'INCOMING') step('INCOMING_FILES_WRITTEN');
  const hist = readHistory(dir);
  const prior = hist.entries.find((e) => e.dir === name);
  if (prior) {
    if (prior.commit !== commit || prior.version !== version || !sameFiles(prior.files || {}, files)) fail('HISTORY_CONFLICT', name);
  } else {
    hist.entries.push({ version, commit, dir: name, files });
    writeAtomic(histFileOf(dir), `${JSON.stringify(hist, null, 2)}\n`);
  }
  step(`${label}_KEPT`);
  return name;
}

/** 历史里的一条（按 PIN 的版本与 sha 找），连同目录里两个文件的字节核对。 */
function historyEntry(dir, version, files) {
  const e = readHistory(dir).entries.find((x) => x.version === version && sameFiles(x.files || {}, files));
  if (!e) return null;
  for (const [f, h] of Object.entries(files)) {
    const p = path.join(dir, 'history', e.dir, f);
    if (!fs.existsSync(p) || sha256(fs.readFileSync(p)) !== h) return null;
  }
  return e;
}

/**
 * 配置目录的状态：
 *   CONSISTENT  —— 现行文件与 PIN 一致，PIN 这一份在历史里（逐字节）；
 *   INTERRUPTED —— PIN 这一份在历史里，现行文件每个都是 PIN 的那份或历史里另一份（重钉写到一半），resume_commit 是那一份的提交；
 *   BROKEN      —— 其他。
 */
function check(dir = DIR) {
  const pin = readJson(path.join(dir, 'PIN.json'));
  const cur = Object.fromEntries(Object.keys(SOURCES).map((f) => [f, fs.existsSync(path.join(dir, f)) ? sha256(fs.readFileSync(path.join(dir, f))) : null]));
  const pinned = historyEntry(dir, pin.registry_version, pin.files);
  if (!pinned) return { state: 'BROKEN', reason: 'PIN_NOT_IN_HISTORY' };
  if (Object.keys(SOURCES).every((f) => cur[f] === pin.files[f])) return { state: 'CONSISTENT', commit: pin.commit };
  const others = readHistory(dir).entries.filter((e) => e.dir !== pinned.dir && Object.keys(SOURCES).every((f) => cur[f] === pin.files[f] || cur[f] === e.files[f])
    && historyEntry(dir, e.version, e.files));
  return others.length === 1 ? { state: 'INTERRUPTED', commit: pin.commit, resume_commit: others[0].commit } : { state: 'BROKEN', reason: 'CURRENT_DRIFT' };
}

/**
 * @param {{kgRoot: string, commit: string, dir?: string, productionPins?: object[]|null, onStep?: (step: string) => void}} o
 *   onStep 只给测试用：每一步写完之后调用（在里面抛错 = 在那一步之后崩掉）。
 * @returns {{outgoing: string, incoming: string, pin: object, production_pins_updated: boolean, resumed: boolean}}
 */
function repin({ kgRoot, commit, dir = DIR, productionPins = null, onStep = null }) {
  if (!kgRoot || !/^[0-9a-f]{40}$/.test(commit || '')) fail('ARGUMENTS');
  const step = (name) => { if (onStep) onStep(name); };
  // —— 先读齐，不写 ——
  const oldPin = readJson(path.join(dir, 'PIN.json'));
  checkFiles(oldPin.files, 'PIN.json');
  const newBytes = Object.fromEntries(Object.entries(SOURCES).map(([f, src]) => [f, execFileSync('git', ['-C', kgRoot, 'show', `${commit}:${src}`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })]));
  const version = JSON.parse(newBytes[REGISTRY_FILE].toString('utf8')).version;
  if (typeof version !== 'string' || !version) fail('VERSION_MISSING', commit);
  const newFiles = shasOf(newBytes);
  const outgoingEntry = historyEntry(dir, oldPin.registry_version, oldPin.files);
  const state = check(dir);
  let outgoingBytes;
  if (state.state === 'CONSISTENT') {
    outgoingBytes = Object.fromEntries(Object.keys(SOURCES).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  } else if (state.state === 'INTERRUPTED' && state.resume_commit === commit && outgoingEntry) {
    outgoingBytes = Object.fromEntries(Object.keys(SOURCES).map((f) => [f, fs.readFileSync(path.join(dir, 'history', outgoingEntry.dir, f))]));
  } else {
    // 现行文件与 PIN 对不上、又不是重钉到同一提交写到一半：不碰（同旧版的 CURRENT_DRIFT）
    const drift = Object.keys(SOURCES).find((f) => !fs.existsSync(path.join(dir, f)) || sha256(fs.readFileSync(path.join(dir, f))) !== oldPin.files[f]);
    fail(drift ? 'CURRENT_DRIFT' : 'HISTORY_MISSING_PINNED', drift || `${oldPin.registry_version}@${oldPin.commit}`);
  }
  // —— 写：新的一份进历史 → 换下来的那份在历史里 → 现行文件 → PIN ——
  const incoming = keep(dir, { version, commit, bytes: newBytes }, step, 'INCOMING');
  const outgoing = keep(dir, { version: oldPin.registry_version, commit: oldPin.commit, bytes: outgoingBytes }, step, 'OUTGOING');
  for (const [f, b] of Object.entries(newBytes)) { writeAtomic(path.join(dir, f), b); step(`CONFIG_WRITTEN:${f}`); }
  const pin = { ...oldPin, commit, registry_version: version, files: newFiles, production_pins: productionPins || oldPin.production_pins };
  writeAtomic(path.join(dir, 'PIN.json'), `${JSON.stringify(pin, null, 2)}\n`);
  step('PIN_WRITTEN');
  return { outgoing, incoming, pin, production_pins_updated: Boolean(productionPins), resumed: state.state === 'INTERRUPTED' };
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

module.exports = { DIR, SOURCES, STEPS, repin, check, internals: { keep, historyEntry, writeAtomic } };
