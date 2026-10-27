#!/usr/bin/env node
'use strict';
/**
 * 看 Research 的分诊清单（desk 复盘闭环修订 7 §3.5）：最新一份 desk 研究队列里等分诊、本机账本还没有分诊的候选，及期限；
 * 另列本机账本里每个候选当前有效的分诊。只读。
 *
 *   node apps/research-cli/list_desk_triage.js [--desk-root DIR]
 */
const triage = require('../../services/desk-review-routing/triage');

try {
  const argv = process.argv.slice(2);
  if (argv.length && (argv.length !== 2 || argv[0] !== '--desk-root')) throw new Error('USAGE:[--desk-root DIR]');
  const pending = triage.pendingTriage({ deskRoot: argv[1] });
  const recorded = triage.effectiveTriage().map((row) => ({ record_id: row.record_id, candidate_id: row.candidate_id, outcome: row.outcome,
    reason_code: row.reason_code, triaged_at: row.triaged_at }));
  process.stdout.write(`${JSON.stringify({ text_zh: pending.textZh, pending: pending.entries, earliest_due: pending.earliestDue, recorded, production_effect: 'NONE' }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
