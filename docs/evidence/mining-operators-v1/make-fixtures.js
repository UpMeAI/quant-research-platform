#!/usr/bin/env node
'use strict';

/**
 * 挖掘沙箱白名单算子的因果证据用的合成夹具（确定性，种子固定）：data/series.json（一个标的 260 个交易日）、data/panel.json（60 天 × 8 个标的）。
 *   node docs/evidence/mining-operators-v1/make-fixtures.js
 * 只有合成数据，没有任何真实行情。重跑得到逐字节相同的文件。
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'data');
function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r4 = (x) => Number(x.toFixed(4));
function weekdays(from, n) {
  const out = []; const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function series() {
  const rand = prng(20261116);
  let v = 10; let y = 5;
  return weekdays('2025-01-02', 260).map((date) => {
    v *= 1 + (rand() - 0.5) * 0.04; y = 0.7 * y + (rand() - 0.5) * 2;
    return { date, value: r4(v), y: r4(y) };
  });
}

function panel() {
  const rand = prng(20261117);
  const codes = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08'];
  const industry = ['BANK', 'BANK', 'TECH', 'TECH', 'TECH', 'ENERGY', 'ENERGY', 'BANK'];
  const out = [];
  for (const date of weekdays('2025-03-03', 60)) {
    codes.forEach((code, i) => out.push({ date, code, value: r4((rand() - 0.5) * 4), industry: industry[i], size: r4(1e9 * (1 + i) * (0.8 + rand() * 0.4)) }));
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'series.json'), `${JSON.stringify(series())}\n`);
fs.writeFileSync(path.join(OUT, 'panel.json'), `${JSON.stringify(panel())}\n`);
