'use strict';
/**
 * Q3c: what the consumer stages for one agent attempt (task.json + bundle.json, the Q2 seam). Pure: the caller reads the admitted input file and hands the parsed JSON in,
 * and hands in the registry-view builder (the host-side builder in registries.js); this module reads and writes nothing.
 *   AI_REVIEW_CARD: the input is a REVIEW_AI_FACT_PACK_V1; the bundle wraps it with the week and the market's registry view.
 *   AI_CHECK:       the input is the RQ_AGENT_BUNDLE_V1 itself (the check pack was built by the producer side).
 */
const { isObj } = require('./canon');
const { parseAgentTask, KINDS } = require('./queue-seam');
const { err } = require('./routing');

const COLUMNS = ['task_id', 'host', 'agent_host', 'kind', 'market', 'template_id', 'template_sha256', 'attempt_no'];

function stageFiles({ row, input, buildRegistry }) {
  if (!isObj(row) || !KINDS.includes(row.kind)) throw err('RQ_STAGE_KIND_UNSUPPORTED', String(row && row.kind));
  const task = parseAgentTask(Object.fromEntries(COLUMNS.map((k) => [k, row[k]])));
  if (!isObj(input)) throw err('RQ_STAGE_INPUT_INVALID', 'not an object');
  if (task.kind === 'AI_REVIEW_CARD') {
    if (!Array.isArray(input.facts) || input.facts.length === 0 || typeof input.week !== 'string') throw err('RQ_STAGE_INPUT_INVALID', 'fact pack needs week and facts');
    if (input.market !== task.market) throw err('RQ_STAGE_MARKET_MISMATCH', `${input.market} vs ${task.market}`);
    if (typeof buildRegistry !== 'function') throw err('RQ_STAGE_INPUT_INVALID', 'registry builder');
    return { task, bundle: { schema: 'RQ_AGENT_BUNDLE_V1', market: task.market, week_id: input.week, pack: input, registry: buildRegistry(task.market) } };
  }
  if (input.schema !== 'RQ_AGENT_BUNDLE_V1' || !isObj(input.pack)) throw err('RQ_STAGE_INPUT_INVALID', 'check bundle');
  if (input.market !== task.market) throw err('RQ_STAGE_MARKET_MISMATCH', `${input.market} vs ${task.market}`);
  return { task, bundle: input };
}

module.exports = { COLUMNS, stageFiles };
