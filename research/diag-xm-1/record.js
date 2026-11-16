'use strict';
// DIAG-XM-1: one RESULT row per registered trial (21 PREREGISTERED), numbers only from the sealed result. Run from the QRP root
// with QRP_PRODUCT_MILESTONE_AUTHORITY set.  node record.js <registered.jsonl> <DIAG_XM_1_RESULT_V1.json> <seal commit> [--dry-run]
const fs = require('fs'); const crypto = require('crypto'); const path = require('path');
const ledger = require(path.resolve('services/trial-ledger'));
const [regPath, resultPath, seal] = process.argv.slice(2); const dry = process.argv.includes('--dry-run');
const buf = fs.readFileSync(resultPath); const sha = crypto.createHash('sha256').update(buf).digest('hex'); const res = JSON.parse(buf.toString('utf8'));
if (res.schema !== 'DIAG_XM_1_RESULT_V1') throw new Error('NOT_XM1_RESULT');
const BOOK = { US_V5_ETF_3000USD: 'US_V5', US_CORE_9000USD_3X_GATEOBS: 'US_CORE', C17_V2_4000USDT: 'C17', QUICK_SHOT_V3_1000USDT: 'QS', INDEX_BOOK: 'CN_INDEX', ASHARE_V6_PAPER: 'CN_STOCK' };
const series = { path: `quant-research-platform@${seal}:docs/evidence/diag-xm-1/DIAG_XM_1_RESULT_V1.json`, sha256: sha };
const by = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
const out = [];
for (const r of fs.readFileSync(regPath, 'utf8').trim().split('\n').map(JSON.parse)) {
  const b = BOOK[r.family_id]; const lab = r.config_label; const unknown = {}; let window; let mdd;
  if (lab.startsWith('XM1_LIVE')) { const x = res.live.books[b]; window = { from: x.first, to: x.last }; mdd = x.maxDrawdown; }
  else if (lab === 'XM1_REPLAY') { const x = res.replay.books[b]; window = { from: x.first, to: x.last }; mdd = x.maxDrawdown; }
  else {
    const e = res.l1.effect[b]; window = { from: e.window[0], to: e.window[1] };
    mdd = e[lab === 'XM1_REPLAY_L1_BANDS' ? 'BANDS' : 'LINK'].maxDrawdown;
    unknown.sr_monthly_delta = 'DIAGNOSTIC_NO_MONTHLY_SERIES';
  }
  const result = { window, eval: { costs: null, timing: null, code_sha: '317c8a295e35cd05e4d8b903c77eba42b7c40787' }, metrics: { mdd },
    series_ref: series, study_verdict: '只报（诊断）', unknown };
  if (dry) { out.push({ trial_id: r.trial_id, label: lab, family: r.family_id, window, mdd }); continue; }
  const row = ledger.recordResult(r.trial_id, result, { registeredBy: by });
  out.push({ trial_id: row.trial_id, row_kind: row.row_kind, eval_hash: row.eval_hash, record_hash: row.record_hash });
}
process.stdout.write(out.map((x) => JSON.stringify(x)).join('\n') + '\n');
