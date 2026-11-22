'use strict';
/**
 * 测试用的「网络那一步」：跑真的 services/mining-llm-step 的 serve 循环，只把 transport 换成假的 DeepSeek（不连网络）。
 *   node fake-step.js <交换目录> <scenario.json> <calls.jsonl> <密钥文件>
 * scenario.json：{ responses: [{ status, json? | body? | throw?, content?: [行…], model?, usage? }] }，按调用顺序给，用完就重复最后一个。
 * calls.jsonl：每次调用一行（URL、方法、头的名字、Authorization 对不对、请求体）；密钥本身不写。
 */
const fs = require('fs');
const step = require('../../../services/mining-llm-step');

const [dir, scenarioFile, callsLog, keyFile] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const expected = step.readKey({ file: keyFile, variable: 'DEEPSEEK_RESEARCH_API_KEY' });
let k = 0;
const okJson = (r) => ({
  id: `fake-${k}`, object: 'chat.completion', created: 1, model: r.model || 'deepseek-v4-pro', system_fingerprint: 'fp_fake',
  ...(r.noUsage ? {} : { usage: r.usage || { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200 } }),
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: r.content.join('\n') } }],
});
async function transport(req) {
  const r = scenario.responses[Math.min(k, scenario.responses.length - 1)]; k += 1;
  fs.appendFileSync(callsLog, `${JSON.stringify({ url: req.url, method: req.method, header_names: Object.keys(req.headers).sort(),
    auth_ok: Boolean(expected.ok) && req.headers.Authorization === `Bearer ${expected.key}`, body: JSON.parse(req.body) })}\n`);
  if (r.throw) { const e = new Error(`${r.throw} socket hang up`); e.code = r.throw; throw e; }
  if (r.content) return { status: 200, body: JSON.stringify(okJson(r)) };
  return { status: r.status, body: r.body !== undefined ? r.body : JSON.stringify(r.json) };
}
step.serve({ dir, keyFile, transport, pollMs: 10 });
