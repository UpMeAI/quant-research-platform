'use strict';
/**
 * Diagnostic for RF1116 amendment 2026-11 (CN_A extra round): what does openRound say for CN_A on a COPY of the lane's round ledger?
 *   QRP_DATA_DIR=<copy of out/qrp-data> node ledger_check.js <repo root to test>
 * It WRITES to the data dir it is given when a round opens, so give it a copy, never the lane's directory. The inputs (space, rulings, selection rule)
 * come from round 2's manifest in that same ledger; the generator is the pinned LLM one (no llm block, as in the synthetic rounds).
 * Steps run in order on the same copy: a round that opens stays open for the next step.
 */
const fs = require('fs'); const path = require('path');
const repo = process.argv[2];
const rounds = require(path.join(repo, 'services/mining-rounds'));
const dir = process.env.QRP_DATA_DIR;
const all = fs.readFileSync(path.join(dir, 'research/mining_rounds.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const r2 = all.filter((r) => r.round_id === 'MR-CN_A-2026-11-2a1d2c9c82').pop();
const base = (over = {}) => ({
  market: 'CN_A', space: r2.space, holding_periods: r2.holding_periods,
  generator: { mode: 'AI_MINED_LLM', model: 'deepseek-v4-pro', model_knowledge_cutoff: '2026-08-13' },
  holdout: { from: '2026-10-19', to: '2026-12-31' }, rulings: r2.rulings, selection_rule: r2.selection_rule, ...over });
const trial = (label, over) => {
  try { const row = rounds.openRound(base(over)); return { step: label, result: 'OPENED', round_id: row.round_id, month: row.month }; }
  catch (e) { return { step: label, result: 'REFUSED', code: e.code || String(e.message), detail: e.detail }; }
};
const NEXT = { from: '2027-01-04', to: '2027-03-31' };
const out = [
  trial('1 CN_A, holdout 2026-10-19..12-31, opened Mon 2026-11-23 08:30 CST', { openedAt: '2026-11-23T00:30:00.000Z' }),
  trial('2 a further round, same holdout, 2026-11-23 17:00 CST', { openedAt: '2026-11-23T09:00:00.000Z' }),
  trial('3 a further round, new holdout after 12-31 (skips the holdout checks), 2026-11-23 17:00 CST', { openedAt: '2026-11-23T09:00:00.000Z', holdout: NEXT }),
  trial('4 CN_A December round, same holdout, 2026-12-01 09:00 CST', { openedAt: '2026-12-01T01:00:00.000Z' }),
  trial('5 CN_A December round, new holdout, 2026-12-01 09:00 CST', { openedAt: '2026-12-01T01:00:00.000Z', holdout: NEXT }),
];
const heads = new Map(); for (const r of fs.readFileSync(path.join(dir, 'research/mining_rounds.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)) heads.set(r.round_id, r);
console.log(JSON.stringify({ steps: out, rounds_after: [...heads.values()].map((r) => ({ round_id: r.round_id, status: r.status, month: r.month, holdout: r.holdout })) }, null, 1));
