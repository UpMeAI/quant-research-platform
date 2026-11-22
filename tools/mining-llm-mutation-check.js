#!/usr/bin/env node
'use strict';

/**
 * RF1116 LLM_GEN 的变异检查：对生成方的每一道护栏各做一个小改动（让它失效），核对测试一定变红。变红 = 杀死；仍然全绿 = 幸存（护栏没人测，要补测试）。
 *   node tools/mining-llm-mutation-check.js [--only M07,M12] [--write docs/evidence/mining-llm-mutation-v1/MUTATION_RESULTS.json]
 * 先跑一遍没改动的基线（必须全绿），再逐个变异：改文件 → 跑对应的测试文件（node --test）→ 无论如何都还原文件。
 * 在 Mac 上用 ~/bin/heavy-run --light --label <who/what> -- node tools/mining-llm-mutation-check.js 跑（一个任务串行跑完所有变异）。
 * 只改仓库里的源文件与配置，不连网络、不读密钥；工作区里这些文件有未提交的改动时拒绝跑（还原用的是内存里的原文，不是 git）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UNIT = 'tests/mining_llm_generator.test.js';
const ROUND = 'tests/mining_llm_round.test.js';
const RUNNER = 'tests/mining_round_runner.test.js';
const LLM = 'services/mining-sandbox/llm/index.js';
const STEP = 'services/mining-llm-step/index.js';
const RRI = 'services/mining-sandbox/round-runner/index.js';
const RRC = 'services/mining-rounds/index.js';
const CFG = 'config/mining_llm_generator.v1.json';
const RUNSH = 'deploy/research-lane/round-runner/run.sh';

/** 每个变异：file 里的 find 恰好出现一次，换成 replace；tests 是要跑的测试文件。 */
const MUTANTS = [
  { id: 'M01', guard: 'request body: only the five plain-completion keys', file: LLM, find: "for (const k of Object.keys(body)) need(REQUEST_KEYS.includes(k), 'REQUEST_FIELD_NOT_ALLOWED', k);", replace: "for (const k of Object.keys(body)) need(true, 'REQUEST_FIELD_NOT_ALLOWED', k);", tests: [UNIT] },
  { id: 'M02', guard: 'request body: stream must be false', file: LLM, find: "need(body.stream === false, 'REQUEST_FIELD_NOT_ALLOWED', 'stream');", replace: "need(true, 'REQUEST_FIELD_NOT_ALLOWED', 'stream');", tests: [UNIT] },
  { id: 'M03', guard: 'request body: model must be the pinned one', file: LLM, find: "need(body.model === config.model.api_model, 'REQUEST_MODEL_NOT_PINNED', String(body.model));", replace: "need(true, 'REQUEST_MODEL_NOT_PINNED', String(body.model));", tests: [UNIT] },
  { id: 'M04', guard: 'request body: messages are plain strings with system/user roles', file: LLM, find: "need(isObj(m) && Object.keys(m).sort().join() === 'content,role' && ['system', 'user'].includes(m.role) && typeof m.content === 'string', 'REQUEST_MESSAGE_INVALID', isObj(m) ? Object.keys(m).join() : typeof m);", replace: "need(true, 'REQUEST_MESSAGE_INVALID', '');", tests: [UNIT] },
  { id: 'M05', guard: 'request body: max_tokens never above the configured value', file: LLM, find: "body.max_tokens <= config.request.max_tokens, 'REQUEST_MAX_TOKENS'", replace: "body.max_tokens <= 1e9, 'REQUEST_MAX_TOKENS'", tests: [UNIT] },
  { id: 'M06', guard: 'holdout blindness: generator view key whitelist', file: LLM, find: "for (const k of Object.keys(view)) need(VIEW_KEYS.includes(k), 'VIEW_FIELD_NOT_ALLOWED', k);", replace: "for (const k of Object.keys(view)) need(true, 'VIEW_FIELD_NOT_ALLOWED', k);", tests: [UNIT] },
  { id: 'M07', guard: 'holdout blindness: score entry key whitelist', file: LLM, find: "need(SCORE_KEYS.includes(k), 'VIEW_FIELD_NOT_ALLOWED', `mining_scores.${k}`);", replace: "need(true, 'VIEW_FIELD_NOT_ALLOWED', `mining_scores.${k}`);", tests: [UNIT] },
  { id: 'M08', guard: 'holdout blindness: the prompt carries no holdout date', file: LLM, find: "    'Scores of formulas already tried in this round (highest first):',", replace: "    `Later period starts ${segs.SEGMENTS.HOLDOUT.from}.`,\n    'Scores of formulas already tried in this round (highest first):',", tests: [UNIT] },
  { id: 'M09', guard: 'no predictive instruction in the prompt', file: LLM, find: "const system = 'You write factor formulas in a small formula language for a research sandbox. '", replace: "const system = 'You predict which stocks will rise and write factor formulas in a small formula language for a research sandbox. '", tests: [UNIT] },
  { id: 'M10', guard: 'response model: a model that is not the pinned one is a mismatch', file: LLM, find: "return { ok: false, outcome: 'WAITING_MODEL_MISMATCH', model_reported: typeof model === 'string' ? model : null, served_version: null };", replace: "return { ok: true, model_reported: typeof model === 'string' ? model : null, served_version: model };", tests: [UNIT, ROUND] },
  { id: 'M11', guard: 'only the first n lines are taken', file: LLM, find: "formulas: all.slice(0, n)", replace: "formulas: all", tests: [UNIT, ROUND] },
  { id: 'M12', guard: 'config: release date not after the holdout start', file: CFG, find: '"release_date": "2026-08-13",\n    "knowledge_cutoff": null,\n    "cutoff_used": "2026-08-13",', replace: '"release_date": "2026-10-20",\n    "knowledge_cutoff": null,\n    "cutoff_used": "2026-10-20",', tests: [UNIT] },
  { id: 'M13', guard: 'config pins deepseek-v4-pro (no silent switch)', file: CFG, find: '"api_model": "deepseek-v4-pro"', replace: '"api_model": "deepseek-flash"', tests: [UNIT] },
  { id: 'M14', guard: 'config: holdout start is the frozen one', file: LLM, find: "need(m.holdout_start === segs.SEGMENTS.HOLDOUT.from, 'CONFIG_INVALID',", replace: "need(true, 'CONFIG_INVALID',", tests: [UNIT] },
  { id: 'M15', guard: 'key: file mode must not be open to group or others', file: STEP, find: "if ((st.mode & 0o077) !== 0) return absent('MODE_TOO_OPEN');", replace: '', tests: [UNIT] },
  { id: 'M16', guard: 'quota error is a quota wait', file: STEP, find: "if (status === 402) return 'WAITING_QUOTA';", replace: "if (status === 402) return 'WAITING_RATE_LIMITED';", tests: [UNIT] },
  { id: 'M17', guard: 'a rate limit is never read as a concurrency limit / stop', file: STEP, find: "if (status === 429) return 'WAITING_RATE_LIMITED';", replace: "if (status === 429) return 'STOPPED_REQUEST_INVALID';", tests: [UNIT] },
  { id: 'M18', guard: 'no blind retry after a failure', file: STEP, find: "const r = await callModel({ body: req.body, config, key: keyState.key, transport });", replace: "let r = await callModel({ body: req.body, config, key: keyState.key, transport });\n    if (r.outcome !== 'OK') r = await callModel({ body: req.body, config, key: keyState.key, transport });", tests: [UNIT, ROUND] },
  { id: 'M19', guard: 'request checked again before sending (step side)', file: STEP, find: "  try { llm.checkRequestBody(body, config); } catch (e) {\n    if (!(e instanceof llm.LlmError)) throw e;\n    return { ...EMPTY, outcome: 'STOPPED_REQUEST_INVALID', raw_error: redact(e.message, key) };\n  }", replace: '', tests: [UNIT] },
  { id: 'M20', guard: 'egress lock: https to any other host is refused', file: STEP, find: "if (t.protocol !== 'https:' || !allowed(t.host, t.port)) refuse(`${what}:${t.protocol}//${t.host}:${t.port}`);", replace: '', tests: [UNIT] },
  { id: 'M21', guard: 'egress lock: raw sockets to other hosts are refused', file: STEP, find: "if (t.path || !allowed(t.host, t.port)) refuse(`${what}:${t.path ? `path:${t.path}` : `${t.host}:${t.port}`}`);", replace: '', tests: [UNIT] },
  { id: 'M22', guard: 'egress lock: fetch is disabled', file: STEP, find: "globalThis.fetch = () => Promise.reject(new EgressError('fetch'));", replace: '', tests: [UNIT] },
  { id: 'M23', guard: 'raw errors redact the key', file: STEP, find: "if (key) t = t.split(key).join('[REDACTED]');", replace: '', tests: [UNIT] },
  { id: 'M24', guard: 'the ping record never carries the key', file: STEP, find: "http_status: r.http_status, usage: r.usage, content_chars:", replace: "http_status: r.http_status, key: key.key, usage: r.usage, content_chars:", tests: [UNIT] },
  { id: 'M25', guard: 'a crashed in-flight call is not sent again', file: STEP, find: "if (fs.existsSync(inflight)) { respond({ outcome: 'WAITING_STEP_CRASHED_MID_CALL', sent: true, reason: 'INFLIGHT_MARKER_WITHOUT_RESPONSE' }); continue; }", replace: '', tests: [UNIT] },
  { id: 'M26', guard: 'a tampered request file is refused', file: STEP, find: "if (req.request_sha256 !== sha256(JSON.stringify(req.body))) { respond({ outcome: 'STOPPED_REQUEST_INVALID', raw_error: 'MINE_LLM_REQUEST_SHA_MISMATCH' }); continue; }", replace: '', tests: [UNIT] },
  { id: 'M27', guard: 'per-round token cap is enforced before sending', file: RRI, find: "if (used.tokens_metered + prep.tokens_upper_bound > config.limits.tokens_per_round) {", replace: 'if (false) {', tests: [ROUND] },
  { id: 'M28', guard: 'per-round call cap is enforced before sending', file: RRI, find: "if (used.calls >= config.limits.calls_per_round) {", replace: 'if (false) {', tests: [ROUND] },
  { id: 'M29', guard: 'a call asks only for the formulas still allowed under the 200 cap', file: RRI, find: "want: Math.min(L.config.batch.formulas_per_call, r.cap - r.candidates_scored)", replace: 'want: L.config.batch.formulas_per_call', tests: [ROUND] },
  { id: 'M30', guard: 'waiting states are persisted as call rows', file: RRI, find: "const record = (row) => rounds.recordLlmCall(roundId, { ...blank, ...row }, { recordedAt: now() });", replace: "const record = (row) => (row.outcome === 'OK' ? rounds.recordLlmCall(roundId, { ...blank, ...row }, { recordedAt: now() }) : null);", tests: [ROUND] },
  { id: 'M31', guard: 'a model mismatch stops generation and the batch is not used', file: RRI, find: "if (!it.ok) { // 模型名对不上：这批公式不用，等待", replace: 'if (false) {', tests: [ROUND] },
  { id: 'M32', guard: 'a config changed after the round opened stops generation', file: RRI, find: "if (isLlm) need(r.generator.llm && r.generator.llm.config_sha256 === L.sha256, 'LLM_CONFIG_CHANGED'", replace: "if (false) need(r.generator.llm && r.generator.llm.config_sha256 === L.sha256, 'LLM_CONFIG_CHANGED'", tests: [ROUND] },
  { id: 'M33', guard: 'the caller cannot choose another model', file: RRI, find: "need(generator.model === undefined || generator.model === L.config.model.api_model, 'LLM_MODEL_NOT_PINNED', `model:${generator.model}`);", replace: '', tests: [ROUND] },
  { id: 'M34', guard: 'the generator sees the generator view only (a validation-selection field leaks into it)', file: RRI, find: "const prep = gen.prepare(view, { n: want });", replace: "const prep = gen.prepare({ ...view, selection: rounds.selectionOf(roundId) || [] }, { n: want });", tests: [ROUND] },
  { id: 'M35', guard: 'a crashed step call is metered at the upper bound', file: RRI, find: "tokens_metered: crashed ? prep.tokens_upper_bound : 0, tokens_basis: crashed ? 'UPPER_BOUND' : 'NONE'", replace: "tokens_metered: 0, tokens_basis: 'NONE'", tests: [UNIT, ROUND], expect: 'may survive: the crash path is covered by the step unit test, not by the round test (see PR)' },
  { id: 'M36', guard: 'call rows are appended in sequence', file: RRC, find: "need(row.seq === prior.length + 1, 'MINE_ROUND_LLM_CALL_SEQ'", replace: "need(true, 'MINE_ROUND_LLM_CALL_SEQ'", tests: [ROUND] },
  { id: 'M37', guard: 'call rows only on LLM rounds', file: RRC, find: "need(r.generator.mode === 'AI_MINED_LLM', 'MINE_ROUND_LLM_CALL_NOT_LLM_ROUND', roundId);", replace: '', tests: [ROUND] },
  { id: 'M38', guard: 'the manifest llm block is validated', file: RRC, find: "need(isObj(b) && LLM_BLOCK_KEYS.every((k) => Object.prototype.hasOwnProperty.call(b, k)) && Object.keys(b).length === LLM_BLOCK_KEYS.length, 'MINE_ROUND_GENERATOR_INVALID', 'llm block keys');", replace: '', tests: [ROUND] },
  { id: 'M39', guard: 'the generate container keeps --network none', file: RUNSH, find: 'docker run --rm --name "rf1116-generate-llm" --network none', replace: 'docker run --rm --name "rf1116-generate-llm" --network bridge', tests: [ROUND, RUNNER] },
  { id: 'M40', guard: 'the LLM step mounts only the key and the exchange directory', file: RUNSH, find: '-v "$EXCHANGE:/exchange:rw" --entrypoint node "$IMAGE" services/mining-llm-step/cli.js serve', replace: '-v "$EXCHANGE:/exchange:rw" -v "$HOLDOUT:/data/holdout:ro" --entrypoint node "$IMAGE" services/mining-llm-step/cli.js serve', tests: [RUNNER] },
  { id: 'M41', guard: 'the LLM step is always stopped after generate', file: RUNSH, find: "    docker stop rf1116-llm-step > /dev/null || true\n    exit \"$rc\"\n    ;;\n  resume-llm)", replace: "    exit \"$rc\"\n    ;;\n  resume-llm)", tests: [ROUND] },
  { id: 'M42', guard: 'generate-llm passes the exit code through (75 = waiting)', file: RUNSH, find: "    docker stop rf1116-llm-step > /dev/null || true\n    exit \"$rc\"\n    ;;\n  *)", replace: "    docker stop rf1116-llm-step > /dev/null || true\n    exit 0\n    ;;\n  *)", tests: [ROUND] },
];

function listFailures(out) {
  return [...new Set((out.match(/^✖ .+$/gm) || []).map((l) => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')).filter((l) => !/^✖ tests\//.test(l)))];
}
function runTests(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  return { status: r.status, failing: listFailures(`${r.stdout || ''}\n${r.stderr || ''}`) };
}

function main(argv) {
  const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
  const outFile = argv.includes('--write') ? argv[argv.indexOf('--write') + 1] : null;
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...new Set(MUTANTS.map((m) => m.file))], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) { process.stderr.write(`refusing to run: uncommitted changes in mutated files:\n${dirty}\n`); return 2; }
  const files = [...new Set(MUTANTS.flatMap((m) => m.tests))];
  const base = runTests(files);
  if (base.status !== 0) { process.stderr.write(`baseline is not green: ${JSON.stringify(base.failing)}\n`); return 2; }
  const results = [];
  for (const m of MUTANTS.filter((x) => !only || only.has(x.id))) {
    const abs = path.join(ROOT, m.file);
    const original = fs.readFileSync(abs, 'utf8');
    const count = original.split(m.find).length - 1;
    if (count !== 1) { process.stderr.write(`${m.id}: find text occurs ${count} times in ${m.file}\n`); results.push({ id: m.id, guard: m.guard, file: m.file, result: 'BAD_MUTANT', occurrences: count }); continue; }
    let r;
    try { fs.writeFileSync(abs, original.replace(m.find, () => m.replace)); r = runTests(m.tests); } finally { fs.writeFileSync(abs, original); }
    const killed = r.status !== 0;
    results.push({ id: m.id, guard: m.guard, file: m.file, tests: m.tests, result: killed ? 'KILLED' : 'SURVIVED', failing: r.failing.slice(0, 5), ...(m.expect ? { note: m.expect } : {}) });
    process.stdout.write(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.guard}${killed ? `  <- ${r.failing[0] || `exit ${r.status}`}` : ''}\n`);
  }
  const summary = { schema: 'MINING_LLM_MUTATION_RESULTS_V1', baseline: 'GREEN', mutants: results.length, killed: results.filter((x) => x.result === 'KILLED').length,
    survived: results.filter((x) => x.result === 'SURVIVED').map((x) => x.id), bad: results.filter((x) => x.result === 'BAD_MUTANT').map((x) => x.id), results };
  if (outFile) { fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true }); fs.writeFileSync(path.join(ROOT, outFile), `${JSON.stringify(summary, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, bad: summary.bad })}\n`);
  return summary.survived.length || summary.bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MUTANTS, listFailures };
