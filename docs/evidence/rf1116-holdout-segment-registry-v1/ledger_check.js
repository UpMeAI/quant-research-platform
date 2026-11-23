'use strict';
// Diagnostic on a COPY of the lane's research ledger (never the live one): what does openRound say with the segment registry and the 2026-12 open-rounds exception?
//   QRP_DATA_DIR=<copy dir, containing research/mining_rounds.jsonl, mining_selections.jsonl, holdout_vault.jsonl> node ledger_check.js
// Every attempt that succeeds appends to the COPY.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const rounds = require(path.join(root, 'services/mining-rounds'));

const dir = process.env.QRP_DATA_DIR;
const all = fs.readFileSync(path.join(dir, 'research/mining_rounds.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const heads = new Map(); for (const r of all) heads.set(r.round_id, r);
const ref = heads.get('MR-CN_A-2026-11-2a1d2c9c82');
const base = (over = {}) => ({
  market: 'CN_A', space: ref.space, holding_periods: ref.holding_periods,
  generator: { mode: 'AI_MINED_LLM', model: 'deepseek-v4-pro', model_knowledge_cutoff: '2026-08-13' }, rulings: ref.rulings, selection_rule: ref.selection_rule, ...over,
});
const trial = (label, over) => {
  try { const row = rounds.openRound(base(over)); return { label, result: 'OPENED', round_id: row.round_id, month: row.month, holdout: row.holdout }; } catch (e) { return { label, result: 'REFUSED', code: String(e.message).split('\n')[0] }; }
};
const unclosed = () => rounds.roundsOf('CN_A').filter((r) => !rounds.TERMINAL.includes(r.status)).length;

const out = [];
out.push({ label: 'ledger rows (round, status, holdout)', rows: [...heads.values()].map((r) => ({ round_id: r.round_id, status: r.status, holdout: r.holdout })), unclosed: unclosed() });
out.push(trial('A November round, registry selects (2026-11-24 10:00 CST)', { openedAt: '2026-11-24T10:00:00+08:00' }));
out.push(trial('B December round, explicit R1 window (the legacy path; refused as before)', { openedAt: '2026-12-01T20:50:00+08:00', holdout: { from: '2026-10-19', to: '2026-12-31' } }));
out.push(trial('C December round 1, registry selects (2026-12-01 20:50 CST); two November rounds unclosed', { openedAt: '2026-12-01T20:50:00+08:00' }));
out.push(trial('D December round 2, registry selects (2026-12-02 20:50 CST)', { openedAt: '2026-12-02T20:50:00+08:00' }));
out.push({ label: 'unclosed rounds now', unclosed: unclosed() });
out.push(trial('E December round 3, registry selects (R2 is full)', { openedAt: '2026-12-03T20:50:00+08:00' }));
out.push(trial('F January round on a full R2, registry selects', { openedAt: '2027-01-05T20:50:00+08:00' }));
out.push(trial('G December round with an explicit R1 window after registry rows exist', { openedAt: '2026-12-04T20:50:00+08:00', holdout: { from: '2026-10-19', to: '2026-12-31' } }));
console.log(JSON.stringify(out, null, 1));
