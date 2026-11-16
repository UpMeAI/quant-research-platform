#!/usr/bin/env node
'use strict';

/**
 * 统一成交模型库的因果证据用的合成夹具（确定性，种子固定）：data/minutes.json、data/daily.json、data/ticks.json。
 *   node docs/evidence/fill-model-v1/make-fixtures.js
 * 只有合成数据，没有任何真实行情。重跑得到逐字节相同的文件。
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'data');
function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r3 = (x) => Number(x.toFixed(3));
const pad = (n) => String(n).padStart(2, '0');
const cnTime = (date, minuteOfDay, seconds = 0) => `${date}T${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}:${pad(seconds)}+08:00`;

function minutes() {
  const rand = prng(20261117);
  const out = [];
  let price = 10;
  for (const date of ['2026-01-05', '2026-01-06']) {
    for (let k = 1; k <= 120; k += 1) { // 09:31 … 11:30 收完的 1 分钟线（time = 结束时刻）
      const open = price;
      const close = open * (1 + (rand() - 0.5) * 0.008);
      const high = Math.max(open, close) * (1 + rand() * 0.002);
      const low = Math.min(open, close) * (1 - rand() * 0.002);
      out.push({ time: cnTime(date, 9 * 60 + 30 + k), open: r3(open), high: r3(high), low: r3(low), close: r3(close), volume: 10000 + Math.floor(rand() * 90000) });
      price = close;
    }
  }
  return out;
}

function daily() {
  const rand = prng(20261118);
  const out = [];
  let close = 20;
  let prevLow = 19.5;
  const day = new Date(Date.UTC(2025, 10, 3));
  while (out.length < 40) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      const gapDown = rand() < 0.15;
      const open = gapDown ? prevLow * (1 - 0.005 - rand() * 0.01) : close * (1 + (rand() - 0.5) * 0.01);
      const c = open * (1 + (rand() - 0.5) * 0.03);
      const high = Math.max(open, c) * (1 + rand() * 0.01);
      const low = Math.min(open, c) * (1 - rand() * 0.01);
      out.push({ date: day.toISOString().slice(0, 10), open: r3(open), high: r3(high), low: r3(low), close: r3(c), volume: 2000000 + Math.floor(rand() * 6000000) });
      close = c; prevLow = low;
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

function ticks() {
  const rand = prng(20261119);
  const out = [];
  let price = 50;
  for (const date of ['2026-01-05', '2026-01-06']) {
    for (let s = 0; s < 180 * 20; s += 20) { // 09:30:00 起每 20 秒一笔，一个小时
      price *= 1 + (rand() - 0.5) * 0.004;
      out.push({ time: cnTime(date, 9 * 60 + 30 + Math.floor(s / 60), s % 60), price: r3(price) });
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, rows] of [['minutes', minutes()], ['daily', daily()], ['ticks', ticks()]]) fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(rows)}\n`);
