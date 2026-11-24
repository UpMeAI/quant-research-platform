'use strict';
/**
 * Q1 接缝（队列核心在另一个 PR，claude/research-queue-core；两个 PR 各自合并）。接缝是文件契约，不是数据库：
 *   输入  task.json = §3.2 task 表的子集（task_id, host, agent_host, kind, market, template_id, template_sha256, attempt_no）+ bundle.json；
 *   输出  result.json = RQ_AGENT_RESULT_V1（status DONE | WAITING | RETRY | DEFER | BLOCKED_DETERMINISTIC）+ 产物文件。
 * 任务进程从不写队列库（带租约令牌的写入只有消费者做）。transitionFor 把结果映射成 §3.3 / §3.7 的状态变化，给 Q1 的消费者直接调用或照抄。
 */
const { agentHostFor, err } = require('./routing');

const KINDS = ['AI_REVIEW_CARD', 'AI_CHECK', 'AI_MECH_NOTE', 'AI_MECH_REVIEW'];
const TASK_ID = /^RQT-(LINUX|HK)-\d{8}-[0-9a-f]{8}$/;
/** §3.7 T3：1 分钟 → 1 小时，6 次，然后 WAITING_PROVIDER（小时探测）；从不 FAILED。 */
const PROVIDER_TRIES = 6;
const PROVIDER_BACKOFF_S = [60, 300, 900, 1800, 3600];
const DEFER_S = 1800;
const STATUSES = ['DONE', 'WAITING', 'RETRY', 'DEFER', 'BLOCKED_DETERMINISTIC'];

function parseAgentTask(row) {
  const bad = (d) => err('RQ_SEAM_TASK_INVALID', d);
  if (!row || typeof row !== 'object') throw bad('not an object');
  if (typeof row.task_id !== 'string' || !TASK_ID.test(row.task_id)) throw bad('task_id');
  for (const k of ['host', 'agent_host']) if (!['LINUX', 'HK'].includes(row[k])) throw bad(k);
  if (!KINDS.includes(row.kind)) throw err('RQ_AGENT_KIND_UNSUPPORTED', String(row.kind));
  const want = agentHostFor(row.market);
  if (row.agent_host !== want) throw err('RQ_AGENT_HOST_MISMATCH', `${row.market} needs agent_host ${want}, task has ${row.agent_host}`);
  for (const k of ['template_id', 'template_sha256']) if (typeof row[k] !== 'string' || row[k] === '') throw bad(k);
  if (!Number.isInteger(row.attempt_no) || row.attempt_no < 0) throw bad('attempt_no');
  return { task_id: row.task_id, host: row.host, agent_host: row.agent_host, kind: row.kind, market: row.market, template_id: row.template_id, template_sha256: row.template_sha256, attempt_no: row.attempt_no };
}

function transitionFor(result, ctx = {}) {
  if (!result || !STATUSES.includes(result.status)) throw err('RQ_SEAM_RESULT_INVALID', String(result && result.status));
  const reason = result.reason_code || null;
  switch (result.status) {
    case 'DONE': return { to_state: 'EVIDENCE_WRITTEN', reason_code: null };
    case 'WAITING': return { to_state: result.wait_state, reason_code: reason, alert: result.alert || null };
    case 'DEFER': return { to_state: 'READY', reason_code: reason, not_before_s: ctx.defer_s || DEFER_S };
    case 'RETRY': {
      const tries = Math.max(1, ctx.provider_tries || 1);
      if (tries >= PROVIDER_TRIES) return { to_state: 'WAITING_PROVIDER', reason_code: reason };
      const wait = Number.isInteger(result.retry_after_s) ? result.retry_after_s : PROVIDER_BACKOFF_S[tries - 1];
      return { to_state: 'READY', reason_code: reason, not_before_s: wait };
    }
    default: return { to_state: 'BLOCKED_DETERMINISTIC', reason_code: reason, remediation: result.remediation || null, defect_code: result.defect_code || null };
  }
}

module.exports = { KINDS, STATUSES, PROVIDER_TRIES, PROVIDER_BACKOFF_S, parseAgentTask, transitionFor };
