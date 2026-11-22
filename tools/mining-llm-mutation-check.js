#!/usr/bin/env node
'use strict';

/**
 * RF1116 LLM_GEN 的变异检查：对生成方的每一道护栏各做一个小改动（让它失效），核对测试一定变红。变红 = 杀死；仍然全绿 = 幸存（护栏没人测，要补测试）。
 *   node tools/mining-llm-mutation-check.js [--only M07,M12] [--write docs/evidence/mining-llm-mutation-v1/MUTATION_RESULTS.json [--merge]]
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
  { id: 'M23', guard: 'raw errors redact the key', file: STEP, find: "    t = t.split(key).join('[REDACTED]');\n", replace: '', tests: [UNIT] },
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
  { id: 'M35', guard: 'a crashed step call is metered at the upper bound', file: RRI, find: "const unknownCost = res.sent && (res.outcome === 'WAITING_STEP_CRASHED_MID_CALL' || res.outcome === 'WAITING_PROVIDER_UNAVAILABLE');", replace: "const unknownCost = res.sent && res.outcome === 'WAITING_PROVIDER_UNAVAILABLE';", tests: [ROUND] },
  { id: 'M36', guard: 'call rows are appended in sequence', file: RRC, find: "need(row.seq === prior.length + 1, 'MINE_ROUND_LLM_CALL_SEQ'", replace: "need(true, 'MINE_ROUND_LLM_CALL_SEQ'", tests: [ROUND] },
  { id: 'M37', guard: 'call rows only on LLM rounds', file: RRC, find: "need(r.generator.mode === 'AI_MINED_LLM', 'MINE_ROUND_LLM_CALL_NOT_LLM_ROUND', roundId);", replace: '', tests: [ROUND] },
  { id: 'M38', guard: 'the manifest llm block is validated', file: RRC, find: "need(isObj(b) && LLM_BLOCK_KEYS.every((k) => Object.prototype.hasOwnProperty.call(b, k)) && Object.keys(b).length === LLM_BLOCK_KEYS.length, 'MINE_ROUND_GENERATOR_INVALID', 'llm block keys');", replace: '', tests: [ROUND] },
  { id: 'M39', guard: 'the generate container keeps --network none', file: RUNSH, find: 'docker run --rm --name "rf1116-generate-llm" --network none', replace: 'docker run --rm --name "rf1116-generate-llm" --network bridge', tests: [ROUND, RUNNER] },
  { id: 'M40', guard: 'the LLM step mounts only the key and the exchange directory', file: RUNSH, find: '-v "$EXCHANGE:/exchange:rw" --entrypoint node "$IMAGE" services/mining-llm-step/cli.js serve', replace: '-v "$EXCHANGE:/exchange:rw" -v "$HOLDOUT:/data/holdout:ro" --entrypoint node "$IMAGE" services/mining-llm-step/cli.js serve', tests: [RUNNER] },
  { id: 'M42', guard: 'generate-llm passes the exit code through (75 = waiting)', file: RUNSH, find: '    exit "$rc"\n    ;;\n  resume-llm)', replace: '    exit 0\n    ;;\n  resume-llm)', tests: [ROUND] },
  { id: 'M43', guard: 'fail closed: a reply with no usage block makes the round wait and its formulas are not used', file: RRI, find: "if (reported === null) { // 计量不明就失败即关", replace: 'if (false) { // 计量不明就失败即关', tests: [ROUND] },
  { id: 'M44', guard: 'consecutive empty replies stop the round', file: RRI, find: "if (trailing >= config.limits.empty_replies_stop) {", replace: 'if (false) {', tests: [ROUND] },
  { id: 'M45', guard: 'a timeout or reset after sending is metered at the upper bound', file: RRI, find: "const unknownCost = res.sent && (res.outcome === 'WAITING_STEP_CRASHED_MID_CALL' || res.outcome === 'WAITING_PROVIDER_UNAVAILABLE');", replace: "const unknownCost = res.sent && res.outcome === 'WAITING_STEP_CRASHED_MID_CALL';", tests: [ROUND] },
  { id: 'M46', guard: 'the key mount exists only when the key file does (Docker would create a directory)', file: RUNSH, find: 'if [ -f "$KEY_FILE" ]; then KEYM=', replace: 'if true; then KEYM=', tests: [ROUND, RUNNER] },
  { id: 'M47', guard: 'the LLM step is stopped by an EXIT trap', file: RUNSH, find: "  trap 'docker stop rf1116-llm-step > /dev/null 2>&1 || true' EXIT\n", replace: '', tests: [ROUND, RUNNER] },
  { id: 'M48', guard: 'holdout results carry the round generator (scoring side)', file: 'services/mining-sandbox/round-runner/holdout-scoring.js', find: "formula: c.formula, generator: c.generator,", replace: "formula: c.formula, generator: 'AI_MINED_GP',", tests: [ROUND] },
  { id: 'M49', guard: 'holdout results carry the round generator (runner side)', file: RRI, find: "parsed: dsl.parse(p.formulas.get(id), f.dslSpace), generator: generatorMode })),", replace: "parsed: dsl.parse(p.formulas.get(id), f.dslSpace) })),", tests: [ROUND] },
  { id: 'M50', guard: 'a budget or ability stop selects on the attempts so far', file: 'services/mining-sandbox/round-runner/cli.js', find: 'if (g.llm.generation_closed && g.total > 0) {', replace: 'if (false) {', tests: [ROUND] },
  { id: 'M51', guard: 'llm-init withdraws requests left by the previous run', file: 'services/mining-sandbox/round-runner/cli.js', find: 'withdrawn: llmMod.withdrawUnanswered(exchange)', replace: 'withdrawn: []', tests: [ROUND] },
  { id: 'M52', guard: 'generate withdraws this round\'s stale requests before writing a new one', file: RRI, find: 'llmMod.withdrawUnanswered(dir, { roundId, keepKey: useKey, now });', replace: '', tests: [ROUND] },
  { id: 'M53', guard: 'a withdrawn key is never taken as an answer', file: RRI, find: "if (prev && prev.outcome === 'WITHDRAWN_BY_RUNNER') useKey = `${key}-w${n}`; else break;", replace: 'break;', tests: [ROUND] },
  { id: 'M54', guard: 'egress lock: raw dgram sockets cannot send or connect', file: STEP, find: "for (const m of ['send', 'connect']) dgram.Socket.prototype[m] = function refusedUdp() { return refuse(`dgram.Socket.${m}`); };", replace: '', tests: [UNIT] },
  { id: 'M55', guard: 'raw errors redact the key suffixes an upstream echoes', file: STEP, find: "for (let n = Math.min(16, key.length - 1); n >= 4; n -= 1) t = t.split(key.slice(-n)).join('[REDACTED]');", replace: '', tests: [UNIT] },
  { id: 'M56', guard: 'raw errors drop masked-key echoes', file: STEP, find: ".replace(/[A-Za-z0-9_-]*\\*{2,}[A-Za-z0-9_-]*/g, '[REDACTED]')", replace: '', tests: [UNIT] },
  { id: 'M57', guard: 'only a bare fence marker line is dropped (a fenced formula still counts)', file: LLM, find: "if (/^```[A-Za-z0-9_+-]*$/.test(line)) { dropped += 1; continue; }", replace: "if (line.startsWith('```')) { dropped += 1; continue; }", tests: [UNIT] },
  { id: 'M58', guard: 'the token bound is at least one token per byte', file: LLM, find: "a + Buffer.byteLength(m.content, 'utf8') + 8, 0);", replace: "a + Math.ceil(Buffer.byteLength(m.content, 'utf8') / 2) + 8, 0);", tests: [UNIT] },
  { id: 'M59', guard: 'the exchange directory has the sticky bit', file: LLM, find: 'const EXCHANGE_MODE = 0o1777;', replace: 'const EXCHANGE_MODE = 0o777;', tests: [ROUND] },
  { id: 'M60', guard: 'the probe sends the production max_tokens', file: LLM, find: "content: 'Reply with the single word OK.' }], config });", replace: "content: 'Reply with the single word OK.' }], config, maxTokens: 64 });", tests: [UNIT] },
  { id: 'M61', guard: 'config: the empty-reply stop must be a positive integer', file: LLM, find: ' && isPosInt(c.limits.empty_replies_stop), ', replace: ', ', tests: [UNIT] },
  { id: 'M62', guard: 'in-flight requests are never withdrawn (they may have been billed)', file: LLM, find: "    if (fs.existsSync(path.join(dir, `${exchangeName(req.key)}.inflight`))) continue; // 调用途中的不撤回：可能已经计费，由 findCrashed / generate 按上界记账\n", replace: '', tests: [ROUND] },
  { id: 'M63', guard: 'a crashed in-flight request is recorded at the upper bound before anything new is sent', file: RRI, find: 'if (crashed.length) {', replace: 'if (false) {', tests: [ROUND] },
  { id: 'M64', guard: 'a stopped (empty replies) round stays stopped on resume', file: RRI, find: "    if (prior[i].outcome === 'STOPPED_EMPTY_REPLIES') continue;\n", replace: '', tests: [ROUND] },
  { id: 'M65', guard: 'a selected round is refused on resume before any probe', file: RRI, find: "  need(!rounds.selectionOf(roundId), 'GENERATION_CLOSED', `${roundId}: validation-fold selection recorded`);", replace: '', tests: [ROUND] },
  { id: 'M66', guard: 'a holdout result is never silently labelled with a default generator', file: 'services/mining-sandbox/round-runner/holdout-scoring.js', find: "for (const c of candidates) if (c.generator !== 'AI_MINED_GP' && c.generator !== 'AI_MINED_LLM') fail('GENERATOR_MISSING', c.candidate_id);", replace: '', tests: [ROUND] },
  { id: 'M67', guard: 'LLM runs are mutually exclusive (busy check before llm-init)', file: RUNSH, find: '    echo "run.sh: another LLM run is active', replace: '    true "run.sh: another LLM run is active', tests: [ROUND] },
  { id: 'M68', guard: 'the EXIT trap is set only after the step container started', file: RUNSH, find: '--entrypoint node "$IMAGE" services/mining-llm-step/cli.js serve --exchange /exchange\n  trap \'docker stop', replace: '--entrypoint node "$IMAGE" services/mining-llm-step/cli.js serve --exchange /exchange || true\n  trap \'docker stop', tests: [ROUND] },
  { id: 'M69', guard: 'the busy check fails closed when docker ps itself fails', file: RUNSH, find: '|| { echo "run.sh: cannot list containers (docker ps failed); not starting an LLM run" >&2; exit 74; }', replace: '|| true', tests: [ROUND] },
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
  const merge = argv.includes('--merge'); // keep the other entries of the existing results file, replace the ones re-run (a targeted re-run after a test fix)
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
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
    results.push({ id: m.id, guard: m.guard, file: m.file, tests: m.tests, result: killed ? 'KILLED' : 'SURVIVED', failing: r.failing.slice(0, 5), head, ...(m.expect ? { note: m.expect } : {}) });
    process.stdout.write(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.guard}${killed ? `  <- ${r.failing[0] || `exit ${r.status}`}` : ''}\n`);
  }
  let all = results;
  if (merge && outFile && fs.existsSync(path.join(ROOT, outFile))) {
    const prior = JSON.parse(fs.readFileSync(path.join(ROOT, outFile), 'utf8')).results.filter((x) => !results.some((y) => y.id === x.id));
    all = [...prior, ...results].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  const summary = { schema: 'MINING_LLM_MUTATION_RESULTS_V1', baseline: 'GREEN', mutants: all.length, killed: all.filter((x) => x.result === 'KILLED').length,
    survived: all.filter((x) => x.result === 'SURVIVED').map((x) => x.id), bad: all.filter((x) => x.result === 'BAD_MUTANT').map((x) => x.id), heads: [...new Set(all.map((x) => x.head).filter(Boolean))], results: all };
  if (outFile) { fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true }); fs.writeFileSync(path.join(ROOT, outFile), `${JSON.stringify(summary, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, bad: summary.bad, heads: summary.heads })}\n`);
  return summary.survived.length || summary.bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MUTANTS, listFailures };
