#!/usr/bin/env node
'use strict';
/**
 * 从一份 desk 收件箱生成 SIGNAL_REGISTRY_V1 的测试夹具（tests/fixtures/signal-registry/inbox）：
 *   记分牌（每本最新一份）、成交台账（全部）按字节复制，自带哈希可验；
 *   周复盘只留 period、generatedAt、tradeReviews，期末持仓快照只留 sessionDate、generatedAt、lots[].lotId，
 *   写成 SIGNAL_REGISTRY_INPUT_PROJECTION_V1 并登记原文件的哈希（原文件含账本风控参数与账户说明，公开仓库不放）。
 *
 *   node tests/support/build-signal-registry-fixture.js --inbox <desk inbox 根目录> [--out tests/fixtures/signal-registry/inbox]
 */
const fs = require('fs');
const path = require('path');
const R = require('../../services/signal-registry');

function main(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i += 2) f[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!f.inbox) throw new Error('MISSING_FLAG:inbox');
  const src = path.resolve(f.inbox);
  const out = path.resolve(f.out || path.join(__dirname, '..', 'fixtures', 'signal-registry', 'inbox'));
  fs.rmSync(out, { recursive: true, force: true });
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), text); };
  const project = (ref, contract, fields) => `${JSON.stringify({ projection: 'SIGNAL_REGISTRY_INPUT_PROJECTION_V1', of: { contract, file: ref.file, hash: ref.hash }, ...fields }, null, 1)}\n`;
  for (const id of Object.keys(R.BOOKS)) {
    const inputs = R.readBookInputs(src, id);
    put(inputs.scoreboard.ref.file, fs.readFileSync(path.join(src, inputs.scoreboard.ref.file)));
    for (const l of inputs.ledgers) put(l.ref.file, fs.readFileSync(path.join(src, l.ref.file)));
    for (const r of inputs.reviews) {
      put(r.ref.file, project(r.ref, 'STRATEGY_REVIEW_V1', { period: r.json.period, generatedAt: r.json.generatedAt, tradeReviews: r.json.tradeReviews || [] }));
    }
    if (inputs.snapshot) {
      const s = inputs.snapshot;
      put(s.ref.file, project(s.ref, 'POSITION_LEDGER_SNAPSHOT_V1', { sessionDate: s.json.sessionDate, generatedAt: s.json.generatedAt,
        lots: (s.json.lots || []).map((l) => ({ lotId: l.lotId })) }));
    }
  }
  process.stdout.write(`${out}\n`);
}

main(process.argv.slice(2));
