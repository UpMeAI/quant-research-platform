#!/usr/bin/env node
'use strict';
/**
 * 台账 × Schema 一致性校验(零依赖)。
 * 用法:node schemas/validate.js [数据目录](默认 QRP_DATA_DIR 或 var/ledger)
 * 退出码:0 全部符合;1 存在不符合 Schema 的记录(Contract 与实现漂移即报错)。
 */
const fs = require('fs');
const path = require('path');
const { validateRecord, SCHEMAS } = require('./index');

const root = process.argv[2] || process.env.QRP_DATA_DIR || path.join(__dirname, '..', 'var', 'ledger');

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // marketdata/ 是**适配器自有**的市场原始数据(日线),不是平台域对象台账 —— 不在 §8 合同内
    if (e.isDirectory()) { if (e.name !== 'marketdata') walk(p, out); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const files = walk(root);
if (!files.length) {
  console.log(`无台账可校验(${root})—— 先跑 npm run mvp:ashare 生成数据`);
  process.exit(0);
}
let total = 0; let bad = 0; const unknown = new Map();
for (const f of files) {
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const [i, r] of rows.entries()) {
    total++;
    if (!r.schema) { bad++; console.error(`${path.relative(root, f)}#${i}: 缺 schema 字段`); continue; }
    // 未登记 schema = 无合同对象混进了域台账 —— 计为不符合(此前只打印不判失败,是合同漂移的逃逸口)
    if (!SCHEMAS[r.schema]) {
      bad++; unknown.set(r.schema, (unknown.get(r.schema) || 0) + 1);
      console.error(`${path.relative(root, f)}#${i}: 未登记 schema「${r.schema}」—— 域台账只接受 §8 已声明对象`);
      continue;
    }
    const v = validateRecord(r);
    if (!v.ok) { bad++; console.error(`${path.relative(root, f)}#${i} [${r.schema}] ${v.problems.join(', ')}`); }
  }
}
console.log(`校验 ${files.length} 个台账文件 / ${total} 条记录:不符合 ${bad} 条`);
if (unknown.size) {
  console.log('未登记 Schema(必须在 schemas/index.js 登记后才允许入账):');
  for (const [k, n] of unknown) console.log(`  ${k} × ${n}`);
}
process.exit(bad ? 1 : 0);
