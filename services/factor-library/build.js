#!/usr/bin/env node
'use strict';

/**
 * 因子库的唯一写出口（FACTOR_LIBRARY_V1，一个生产者）。
 *
 *   node services/factor-library/build.js            核对：提交的文件字节 = build() 输出，且每条源文件绑定在钉版提交上 sha256 与字段值一致
 *   node services/factor-library/build.js --write    先核对源文件，全部 MATCH 才写 config/research_factor_library.v1.json
 *
 * 源文件只用 git show 读（不 checkout）；兄弟仓位置取 QRP_V6_ROOT / QRP_SMARTFLOW_ROOT，否则取 QRP 仓的同级目录。
 * 写之前读不到任何一条绑定（UNAVAILABLE）或有一条不符（MISMATCH）都拒绝写（失败即关）。退出码：0 一致；1 不一致或拒写；2 参数错。
 */
const fs = require('fs');
const lib = require('./index');

function main(argv) {
  const args = argv.slice(2);
  const unknown = args.filter((a) => a !== '--write');
  if (unknown.length) { console.error(`未知参数：${unknown.join(' ')}`); return 2; }
  const write = args.includes('--write');
  const doc = lib.build();
  const results = lib.verifySources(doc);
  const bad = results.filter((r) => r.state !== 'MATCH');
  for (const r of results) console.log(`${r.state.padEnd(11)} ${r.factor_id}  ${r.repo}@${r.commit.slice(0, 8)}:${r.path}${r.reason ? `  (${r.reason})` : ''}`);
  for (const r of bad.filter((x) => x.state === 'MISMATCH')) console.error(JSON.stringify(r.problems));
  const out = lib.bytes(doc);
  if (write) {
    if (bad.length) { console.error(`拒绝写：${bad.length} 条绑定不是 MATCH`); return 1; }
    fs.writeFileSync(lib.FILE, out);
    console.log(`已写 ${lib.LIBRARY_PATH}（${doc.factors.length} 个因子，${out.length} 字节）`);
    return 0;
  }
  const current = fs.existsSync(lib.FILE) ? fs.readFileSync(lib.FILE) : null;
  const same = current !== null && current.equals(out);
  console.log(same ? `${lib.LIBRARY_PATH} 与 build() 一致` : `${lib.LIBRARY_PATH} 与 build() 不一致：用 --write 重写，不要手改`);
  return same && !bad.length ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { main };
