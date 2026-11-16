'use strict';
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const datasetRegistry = require('../services/dataset-registry');
const { repin, check, STEPS } = require('../tools/dataset-registry-repin/repin');

/**
 * 重钉工具崩溃安全 + 历史里扫描器 sha 必填（协调会话 2026-11-17 02:0x）。先红后绿；全部是合成的 KG 仓库与 config 临时副本。
 * 写入顺序：新的一份进历史（文件、再 HISTORY.json）→ 换下来的那份核对在历史里 → 现行文件 → PIN.json。
 */
const FIXTURE = path.join(__dirname, 'fixtures', 'dataset-registry-kg368');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const OLD = JSON.parse(fs.readFileSync(path.join(datasetRegistry.DIR, 'PIN.json'), 'utf8'));

/** 合成 KG 仓库：一次提交，给定的登记表与扫描器字节。 */
function kgCommit({ registry = fs.readFileSync(path.join(FIXTURE, 'datasets.v1.json')), scanner = fs.readFileSync(path.join(FIXTURE, 'dataset-registry-scan.cjs')) } = {}) {
  const root = tmp('qrp-kg-r-');
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'data', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'registry', 'datasets.v1.json'), registry);
  if (scanner) { fs.mkdirSync(path.join(root, 'scripts', 'registry'), { recursive: true }); fs.writeFileSync(path.join(root, 'scripts', 'registry', 'dataset-registry-scan.cjs'), scanner); }
  git('add', '.'); git('commit', '-q', '-m', 'registry');
  return { root, commit: git('rev-parse', 'HEAD') };
}
const copyConfig = () => { const dir = tmp('qrp-dr-r-'); fs.cpSync(datasetRegistry.DIR, dir, { recursive: true }); return dir; };
/** 目录树：相对路径 → sha256（判断两次结果逐字节一样）。 */
function tree(dir, rel = '', out = {}) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) tree(dir, r, out); else out[r] = sha(fs.readFileSync(path.join(dir, r)));
  }
  return out;
}
// 新的一份两个文件都与现在的不同（扫描器多一行注释），这样「只写了一个现行文件」的中间态也测得到
const SCANNER2 = Buffer.concat([fs.readFileSync(path.join(FIXTURE, 'dataset-registry-scan.cjs')), Buffer.from('// synthetic scanner revision\n')]);

test('写入顺序：新的一份进历史 → 换下来的那份在历史里 → 现行文件 → PIN.json', () => {
  const k = kgCommit({ scanner: SCANNER2 });
  const dir = copyConfig();
  const seen = [];
  repin({ kgRoot: k.root, commit: k.commit, dir, onStep: (s) => seen.push(s) });
  assert.deepEqual(seen, [...STEPS]);
  assert.deepEqual(check(dir), { state: 'CONSISTENT', commit: k.commit });
});

test('每一步之后崩掉：配置仍然一致（或可识别的写到一半、读时失败即关），历史不丢，同一提交再跑一次补完且与一次跑完逐字节相同', () => {
  const k = kgCommit({ scanner: SCANNER2 });
  const clean = copyConfig();
  repin({ kgRoot: k.root, commit: k.commit, dir: clean });
  const want = tree(clean);
  const oldPinBytes = fs.readFileSync(path.join(datasetRegistry.DIR, 'PIN.json'));
  for (const at of STEPS) {
    const dir = copyConfig();
    assert.throws(() => repin({ kgRoot: k.root, commit: k.commit, dir, onStep: (s) => { if (s === at) throw new Error(`INJECTED:${s}`); } }), new RegExp(`INJECTED:${at}`));
    const st = check(dir);
    const files = Object.keys(tree(dir));
    assert.deepEqual(files.filter((f) => f.includes('.tmp-')), [], `${at}: no torn temp files`);
    if (at === 'PIN_WRITTEN') {
      assert.deepEqual(st, { state: 'CONSISTENT', commit: k.commit }, at);
    } else if (at.startsWith('CONFIG_WRITTEN')) {
      assert.deepEqual(st, { state: 'INTERRUPTED', commit: OLD.commit, resume_commit: k.commit }, at);
      assert.throws(() => datasetRegistry.pinned({ dir }), /DATASET_REGISTRY_PIN_DRIFT/, `${at}: a half-written pin is never read`);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'PIN.json')), oldPinBytes, at);
      // 写到一半时换一个提交重钉 → 拒绝，不碰
      const other = kgCommit();
      assert.throws(() => repin({ kgRoot: other.root, commit: other.commit, dir }), /DATASET_REGISTRY_REPIN_CURRENT_DRIFT/, at);
    } else {
      assert.deepEqual(st, { state: 'CONSISTENT', commit: OLD.commit }, at);
      assert.equal(datasetRegistry.pinned({ dir }).commit, OLD.commit, at);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'PIN.json')), oldPinBytes, at);
    }
    // 历史在每一步之后都能读、都有现在钉的那份
    const h = datasetRegistry.history({ dir });
    assert.ok(h.has(`${OLD.registry_version}#${OLD.files['datasets.v1.json']}`), at);
    const again = repin({ kgRoot: k.root, commit: k.commit, dir });
    assert.equal(again.resumed, at.startsWith('CONFIG_WRITTEN'), at);
    assert.deepEqual(tree(dir), want, `${at}: resumed run equals a clean run`);
    assert.deepEqual(check(dir), { state: 'CONSISTENT', commit: k.commit });
  }
});

test('历史条目必须带扫描器的 sha256：仓库里的每一条都带且与目录字节一致；缺了读历史即拒；重钉写出的新条目带上', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(datasetRegistry.DIR, 'history', 'HISTORY.json'), 'utf8'));
  assert.ok(doc.entries.length >= 1);
  for (const e of doc.entries) {
    assert.deepEqual(Object.keys(e.files).sort(), ['dataset-registry-scan.cjs', 'datasets.v1.json'], e.dir);
    for (const [f, h] of Object.entries(e.files)) {
      assert.match(h, /^[0-9a-f]{64}$/, `${e.dir}/${f}`);
      assert.equal(sha(fs.readFileSync(path.join(datasetRegistry.DIR, 'history', e.dir, f))), h, `${e.dir}/${f}`);
    }
  }
  const dir = copyConfig();
  const hist = JSON.parse(fs.readFileSync(path.join(dir, 'history', 'HISTORY.json'), 'utf8'));
  delete hist.entries[0].files['dataset-registry-scan.cjs'];
  fs.writeFileSync(path.join(dir, 'history', 'HISTORY.json'), JSON.stringify(hist, null, 2));
  assert.throws(() => datasetRegistry.history({ dir }), /DATASET_REGISTRY_HISTORY_INVALID:.*dataset-registry-scan\.cjs sha256 missing/);
  // 重钉工具也认这条：PIN 或历史缺扫描器 sha 即停，一个字节都不写
  const before = tree(dir);
  const k = kgCommit({ scanner: SCANNER2 });
  const pinNoScanner = copyConfig();
  const pin = JSON.parse(fs.readFileSync(path.join(pinNoScanner, 'PIN.json'), 'utf8'));
  delete pin.files['dataset-registry-scan.cjs'];
  fs.writeFileSync(path.join(pinNoScanner, 'PIN.json'), JSON.stringify(pin, null, 2));
  const pinBefore = tree(pinNoScanner);
  assert.throws(() => repin({ kgRoot: k.root, commit: k.commit, dir: pinNoScanner }), /DATASET_REGISTRY_REPIN_SCANNER_SHA_MISSING:PIN\.json/);
  assert.deepEqual(tree(pinNoScanner), pinBefore);
  // KG 提交里没有扫描器 → 读的时候就失败，不写
  const noScanner = kgCommit({ scanner: null });
  const clean = copyConfig();
  const cleanBefore = tree(clean);
  assert.throws(() => repin({ kgRoot: noScanner.root, commit: noScanner.commit, dir: clean }));
  assert.deepEqual(tree(clean), cleanBefore);
  assert.deepEqual(tree(dir), before);
  // 正常重钉：新条目带两份 sha256
  repin({ kgRoot: k.root, commit: k.commit, dir: clean });
  const added = JSON.parse(fs.readFileSync(path.join(clean, 'history', 'HISTORY.json'), 'utf8')).entries.find((e) => e.commit === k.commit);
  assert.equal(added.files['dataset-registry-scan.cjs'], sha(SCANNER2));
});
