/**
 * DIAG-XM-1 prereg V1 §3 and §6.1–6.2: the L1 reading for every calendar day 2006-01-01 .. 2026-09-30, from the producer's
 * own band engine (KG worker-cf/src/l1-risk-budget/bands.ts) on the signed §4 archives, read by replay-s4.ts's
 * loadArchives / buildSeries (which refuse any archive whose sha256 is not the signed one). No band logic here: this file
 * only picks, for each day d, the latest complete row of each market (CN: date <= d; US and CRYPTO: date <= d-1) and calls
 * linkK on that triple.
 *
 *   cd <KG checkout>/worker-cf && node --import tsx <this file> --kg <KG checkout> --inputs <dir with H00300.CSI.json
 *     H00905.CSI.json SPY.json btc_daily.csv> --out <l1-readings.json>
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

async function main() {
const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const kg = arg('--kg'), inputs = arg('--inputs'), out = arg('--out');
if (!kg || !inputs || !out) { console.error('usage: --kg <dir> --inputs <dir> --out <file>'); process.exit(2); }

const bands = await import(path.join(kg, 'worker-cf/src/l1-risk-budget/bands.ts'));
const s4 = await import(path.join(kg, 'worker-cf/scripts/l1-risk-budget/replay-s4.ts'));

const files = { h00300: path.join(inputs, 'H00300.CSI.json'), h00905: path.join(inputs, 'H00905.CSI.json'), spy: path.join(inputs, 'SPY.json'), btc: path.join(inputs, 'btc_daily.csv') };
const { bytes, problems } = s4.loadArchives(files);
if (problems.length) { console.log(JSON.stringify({ ok: false, problems })); process.exit(1); }
const M = s4.buildSeries(bytes);

type Row = { date: string; band: string; windowComplete: boolean };
const MARKET_OF: Record<string, 'CN' | 'US' | 'CRYPTO'> = { CN: 'CN', US: 'US', CR: 'CRYPTO' };
const paths: Record<string, Row[]> = {};
for (const [m, s] of Object.entries(M) as Array<[string, { path: Row[] }]>) paths[MARKET_OF[m]!] = s.path;

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Latest row with date <= limit (ISO), or null; a row before both windows are full reads L9 (null), as the producer. */
function bandAt(rows: Row[], limit: string, cursor: { i: number }): string | null {
  while (cursor.i + 1 < rows.length && rows[cursor.i + 1]!.date <= limit) cursor.i += 1;
  const row = cursor.i >= 0 && rows[cursor.i]!.date <= limit ? rows[cursor.i]! : null;
  return row && row.windowComplete ? row.band : null;
}

const cursors = { CN: { i: -1 }, US: { i: -1 }, CRYPTO: { i: -1 } };
const readings: unknown[] = [];
for (let t = Date.parse('2006-01-01T00:00:00Z'); t <= Date.parse('2026-09-30T00:00:00Z'); t += DAY) {
  const d = iso(t), prev = iso(t - DAY);
  const b = { CN: bandAt(paths.CN!, d, cursors.CN), US: bandAt(paths.US!, prev, cursors.US), CRYPTO: bandAt(paths.CRYPTO!, prev, cursors.CRYPTO) };
  const link = bands.linkK(b);
  readings.push({ d, bands: b, applied: link.applied, stress: link.stressMarkets, k: Object.fromEntries(Object.entries(link.markets).map(([m, v]: [string, any]) => [m, { k: v.k, kBand: v.kBand, capped: v.linkageCapped }])) });
}

const bandRows = Object.fromEntries(Object.entries(paths).map(([m, rows]) => [m, {
  first: rows[0]!.date, last: rows.at(-1)!.date, firstComplete: rows.find((r) => r.windowComplete)?.date ?? null,
  complete: Object.fromEntries(['N', 'C', 'S'].map((x) => [x, rows.filter((r) => r.windowComplete && r.band === x).length])),
}]));
const sha = (p: string) => createHash('sha256').update(bytes[p]).digest('hex');
const doc = { schema: 'DIAG_XM_1_L1_READINGS_V1', archives: Object.fromEntries(Object.keys(files).map((k) => [k, sha(k)])), bandRows, readings };
const text = JSON.stringify(doc) + '\n';
writeFileSync(out, text);
console.log(JSON.stringify({ ok: true, days: readings.length, bandRows, sha256: createHash('sha256').update(text).digest('hex') }));
}
main().catch((error) => { console.error(error); process.exit(1); });
