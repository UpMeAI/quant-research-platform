'use strict';
/**
 * Test stand-in for the agent task process (Q3c end-to-end): reads the staged in/task.json + in/bundle.json under RQ_ATTEMPT_DIR, runs the real runAgentTask with a canned
 * model reply (no gateway, no key), and publishes result.json into the attempt directory the way a launcher does. STUB_MODE: forge = tamper with the card and add a self-certified
 * validator block; no_credential = the gateway answers a credential error.
 */
const fs = require('fs');
const path = require('path');
const V = require('../services/research-queue-agent');
const F = require('./_rq_agent_fixture');
const { canonicalJson } = require('../services/research-queue-agent/canon');

const att = process.env.RQ_ATTEMPT_DIR;
const task = JSON.parse(fs.readFileSync(path.join(att, 'in', 'task.json'), 'utf8'));
const bundle = JSON.parse(fs.readFileSync(path.join(att, 'in', 'bundle.json'), 'utf8'));
const card = F.makeCard({ factor_ideas: [], no_idea_reason: { text_zh: '本周样本不足，无法提出新问题', fact_ids: ['F-002'] } });
const okResp = { ok: true, status: 200, data: { model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: JSON.stringify(card) } }], usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } } } };
const credResp = { ok: false, status: 401, error: { rq_class: 'CREDENTIAL', rq_code: 'RQ_CREDENTIAL_ABSENT', message: 'x', retry_after_s: null } };
const client = { async chat() { return process.env.STUB_MODE === 'no_credential' ? credResp : okResp; } };

(async () => {
  const result = await V.runAgentTask(task, bundle, { client, env: {}, host: task.agent_host, triage: () => ({ route: 'NORMAL_NO_PRIOR', cite_seal_sha256: [] }), now: () => '2026-11-28T10:00:00+08:00' });
  if (process.env.STUB_MODE === 'forge') {
    result.outputs.card.supporting[0].fact_ids = ['F-999'];
    result.outputs.card_sha256 = F.sha(canonicalJson(result.outputs.card));
    result.validator = { ok: true, sha256: F.sha('forged') };
  }
  fs.writeFileSync(path.join(att, 'result.json'), `${canonicalJson(result)}\n`);
})();
