'use strict';
/** 生成 ./data 下的合成夹具（确定性，无随机源）。改了这里要重跑：node tools/causality-harness/fixtures/make-data.js */
const fs = require('fs');
const path = require('path');
const out = (f, v) => fs.writeFileSync(path.join(__dirname, f), `${JSON.stringify(v, null, 0).replace(/},{/g, '},\n{')}\n`);
const days = (n, from = Date.UTC(2025, 0, 2)) => { const r = []; for (let d = from; r.length < n; d += 86400000) { const w = new Date(d).getUTCDay(); if (w !== 0 && w !== 6) r.push(new Date(d).toISOString().slice(0, 10)); } return r; };
const round = (x) => Math.round(x * 1e4) / 1e4;
// 单边上涨、根根收阳
out('data/daily_trend.json', days(60).map((d, i) => ({ date: d, open: round(100 + i * 0.8), high: round(101.2 + i * 0.8), low: round(99.6 + i * 0.8), close: round(100.6 + i * 0.8), volume: 1000 + (i % 7) * 37 })));
// 锯齿：奇数根是顶
out('data/daily_zigzag.json', days(60).map((d, i) => { const base = 100 + i * 0.05 + (i % 2 ? 1.5 : 0); return { date: d, open: round(base - 0.3), high: round(base + 0.5), low: round(base - 0.8), close: round(base + (i % 3 ? 0.2 : -0.2)), volume: 800 + (i % 5) * 51 }; }));
// 盘中：8 个交易日，上午 09:40–11:30、下午 13:10–15:00 每 10 分钟一根（时点为该根的结束时刻，+08:00）
const slots = []; for (let m = 9 * 60 + 40; m <= 11 * 60 + 30; m += 10) slots.push(m); for (let m = 13 * 60 + 10; m <= 15 * 60; m += 10) slots.push(m);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
out('data/minutes.json', days(8).flatMap((d, di) => slots.map((m, si) => ({ time: `${d}T${hhmm(m)}:00+08:00`, day: d, volume: 100 + ((di * 7 + si * 13) % 29) * 5 }))));
// 面板：4 个代码 × 30 日
const codes = ['AAA', 'BBB', 'CCC', 'DDD'];
out('data/panel.json', days(30).flatMap((d, i) => codes.map((c, k) => ({ date: d, code: c, close: round(50 + k * 10 + Math.sin(i * 0.7 + k) * 3 + i * (k - 1.5) * 0.2) }))));
out('data/params.json', { scale: 1 });
out('outside/full_history.json', { note: 'synthetic; exists only to be refused by the T-C3 sandbox' });
