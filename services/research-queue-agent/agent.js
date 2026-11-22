'use strict';
/**
 * 无工具代理运行时（★RQ15 (a)，§5.2）。代码建包、调网关、验 JSON、只用验证器错误码重问；模型没有 shell、文件、网络或任何工具，它写的东西从不被执行。
 *
 * 流程（每个请求最多发一次，错误一律交回队列）：
 *   一次「尝试」= 首答 + 允许的 1 次修订（卡与核对各 1 次）；flash 在同一任务上两次独立尝试都被验证器拒 → 写质量闸记录 → 恰好一次 pro 模型
 *   （RQ_AGENT_PRO_FALLBACK，不修订）；pro 也被拒 → BLOCKED_DETERMINISTIC + 补救。网关错误按类映射，不消耗尝试。
 * 模型：非思考模式，temperature 0，response_format json_object，max_tokens ≤ 4000。模型名、purpose、上限都读 config/rq_deepseek_gateway.v1.json。
 * 不读文件、不碰网络（只有 ./gateway-client.js 的 unix socket）；cli.js 才做文件读写。
 */
const cfg = require('../../config/rq_deepseek_gateway.v1.json');
const { canonicalJson, sha256, isObj, scrubSecrets } = require('./canon');
const { checkPack, splitPackByRow } = require('./facts');
const { validateCheckReport } = require('./check-report');
const { validateCard } = require('./card');
const { buildIdeaRecords, packSha } = require('./factor-idea');
const { routeIdea, assertAgentHost, preregProposal, err } = require('./routing');
const { proposeAdmission } = require('./mechanism-admission-stub');
const { parseAgentTask } = require('./queue-seam');
const prompts = require('./prompts');

const MODELS = Object.freeze({ FLASH: cfg.purposes.RQ_AGENT.models[0], PRO: cfg.purposes.RQ_AGENT_PRO_FALLBACK.models[0] });
const MAX_TOKENS = cfg.purposes.RQ_AGENT.max_tokens;
const ATTEMPTS = 2;
const REVISIONS = 1;
const KEY_NAME = /DEEPSEEK|API_?KEY|SECRET|(^|_)TOKEN($|_)/i;
const KEY_VALUE = /sk-[A-Za-z0-9]{16,}/;

/** AQ-34：代理的环境里不许有任何密钥或 DEEPSEEK 变量。 */
function assertKeylessEnv(env) {
  for (const [k, v] of Object.entries(env || {})) {
    if (KEY_NAME.test(k) || (typeof v === 'string' && KEY_VALUE.test(v))) throw err('RQ_AGENT_ENV_HAS_KEY', `variable ${KEY_NAME.test(k) ? k : '(key-shaped value)'}`);
  }
}

const body = (model, messages) => ({ model, messages, max_tokens: MAX_TOKENS, temperature: 0, response_format: { type: 'json_object' }, stream: false });
const contentOf = (data) => {
  const m = data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message;
  return m && typeof m.content === 'string' ? m.content : '';
};
const uniq = (a) => [...new Set(a)];

/** 网关错误 → 队列结果。从不是 FAILED。 */
function gatewayFailure(res) {
  const e = res.error || {};
  const base = { reason_code: e.rq_code || 'RQ_GATEWAY_BAD_REPLY' };
  if (e.rq_code === 'RQ_PEAK_REFUSED') return { status: 'DEFER', ...base };
  switch (e.rq_class) {
    case 'CREDENTIAL': return { status: 'WAITING', wait_state: 'WAITING_CREDENTIAL', alert: 'RQ_CREDENTIAL', ...base };
    case 'QUOTA': return { status: 'WAITING', wait_state: 'WAITING_QUOTA', ...base };
    case 'PROVIDER': return { status: 'RETRY', provider_error: true, retry_after_s: Number.isInteger(e.retry_after_s) ? e.retry_after_s : null, ...base };
    default: return { status: 'BLOCKED_DETERMINISTIC', ...base };
  }
}

/**
 * 一个输入（一张卡或一个核对部分）从问到验：flash 两次尝试，必要时一次 pro。
 * @returns {{ok: true, value, model, hash} | {ok: false, outcome: object}}
 */
async function askUntilValid({ client, task, system, admission, user, validate, kindLabel, ctx }) {
  const failures = [];
  const call = async (purpose, model, messages, extra = {}) => {
    const res = await client.chat({ purpose, task_id: task.task_id, admission_sha256: admission, body: body(model, messages), ...extra });
    return res;
  };
  const note = (c) => ctx.calls.push(c);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    let last = null;
    for (let revision = 0; revision <= REVISIONS; revision++) {
      const res = await call('RQ_AGENT', MODELS.FLASH, messages);
      if (!res.ok) { note({ purpose: 'RQ_AGENT', model: MODELS.FLASH, attempt, revision, http_status: res.status, rq_code: res.error.rq_code, validator_codes: [] }); return { ok: false, outcome: gatewayFailure(res) }; }
      const content = contentOf(res.data);
      const v = validate(content);
      const codes = uniq(v.errors.map((e) => e.code));
      last = { codes, output_sha256: sha256(content) };
      note({ purpose: 'RQ_AGENT', model: MODELS.FLASH, attempt, revision, http_status: 200, validator_codes: codes, output_sha256: last.output_sha256 });
      if (v.ok) return { ok: true, value: v, model: MODELS.FLASH };
      messages = [...messages, { role: 'assistant', content }, { role: 'user', content: `The answer was rejected by the validator with these error codes: ${codes.join(', ')}. Return the corrected JSON object only.` }];
    }
    failures.push({ attempt_no: attempt, validator_codes: last.codes, output_sha256: last.output_sha256 });
  }

  if (ctx.proUsed) return { ok: false, outcome: { status: 'BLOCKED_DETERMINISTIC', reason_code: 'RQ_PRO_ALREADY_USED', ...remediation(kindLabel) } };
  const record = { schema: 'RQ_FLASH_QUALITY_GATE_RECORD_V1', task_id: task.task_id, kind: task.kind, model: MODELS.FLASH, failures };
  record.record_id = `QG-${sha256(canonicalJson(record)).slice(0, 16)}`;
  if (ctx.writeQualityRecord) ctx.writeQualityRecord(record);
  ctx.proUsed = true;
  ctx.quality_gate = { record_id: record.record_id, pro_called: true };
  const res = await call('RQ_AGENT_PRO_FALLBACK', MODELS.PRO, [{ role: 'system', content: system }, { role: 'user', content: user }], { quality_gate: record });
  if (!res.ok) { note({ purpose: 'RQ_AGENT_PRO_FALLBACK', model: MODELS.PRO, attempt: 3, revision: 0, http_status: res.status, rq_code: res.error.rq_code, validator_codes: [] }); return { ok: false, outcome: gatewayFailure(res) }; }
  const content = contentOf(res.data);
  const v = validate(content);
  const codes = uniq(v.errors.map((e) => e.code));
  note({ purpose: 'RQ_AGENT_PRO_FALLBACK', model: MODELS.PRO, attempt: 3, revision: 0, http_status: 200, validator_codes: codes, output_sha256: sha256(content) });
  if (v.ok) return { ok: true, value: v, model: MODELS.PRO };
  return { ok: false, outcome: { status: 'BLOCKED_DETERMINISTIC', reason_code: 'RQ_PRO_FALLBACK_FAILED', ...remediation(kindLabel), pro_validator_codes: codes } };
}

const remediation = (kind) => ({
  remediation: { kind: 'PROMPT_TEMPLATE_OR_VALIDATOR_FIX', for_kind: kind },
  ...(kind === 'AI_CHECK' ? { defect_code: 'CHECKER_DEFECT' } : {}),
});

function mergeReports(parts, matrixOrder, task, admission, model) {
  const rank = new Map(matrixOrder.map((id, i) => [id, i]));
  const items = parts.flatMap((p) => p.items).sort((a, b) => rank.get(a.req_id) - rank.get(b.req_id));
  const hold_reasons = parts.flatMap((p) => p.hold_reasons);
  return { verdict: parts.some((p) => p.verdict === 'HOLD') ? 'HOLD' : 'CONSISTENT', items, hold_reasons, unknowns: parts.flatMap((p) => p.unknowns) };
}

const registryView = (reg) => ({
  mechanisms: reg.mechanisms.map((m) => ({ mechanism_id: m.mechanism_id, layer: m.layer, decision_point: m.decision_point })),
  readings: Object.entries(reg.readings).map(([id, r]) => ({ id, pit_available_at: r.pit_available_at, origin: r.origin })),
  holding_periods: reg.holding_periods,
});

/**
 * @param {object} taskRow  §3.2 task 行的子集（queue-seam.parseAgentTask 校验）
 * @param {object} bundle   RQ_AGENT_BUNDLE_V1 {market, week_id, pack, registry?, existing_idea_count?, author_required?}
 * @param {{client, env?: object, host: 'LINUX'|'HK', triage?: Function, now?: Function, writeQualityRecord?: Function, maxPackTokens?: number}} opts
 */
async function runAgentTask(taskRow, bundle, opts) {
  assertKeylessEnv(opts.env === undefined ? process.env : opts.env);
  const task = parseAgentTask(taskRow);
  assertAgentHost(task, opts.host);
  const now = opts.now || (() => new Date().toISOString());
  const ctx = { calls: [], proUsed: false, quality_gate: null, writeQualityRecord: opts.writeQualityRecord };
  const result = (r) => scrubSecrets({ schema: 'RQ_AGENT_RESULT_V1', task_id: task.task_id, kind: task.kind, at: now(), calls: ctx.calls, ...(ctx.quality_gate ? { quality_gate: ctx.quality_gate } : {}), outputs: {}, ...r });
  const blocked = (code, detail) => result({ status: 'BLOCKED_DETERMINISTIC', reason_code: code, detail: detail === undefined ? null : String(detail) });

  if (!isObj(bundle) || bundle.schema !== 'RQ_AGENT_BUNDLE_V1' || bundle.market !== task.market || !isObj(bundle.pack) || bundle.pack.market !== task.market) return blocked('RQ_BUNDLE_INVALID');
  const isCard = task.kind === 'AI_REVIEW_CARD';
  const admissions = prompts.loadAdmissions();
  const adm = admissions.byKind[task.kind];
  if (!adm) return blocked('RQ_PROMPT_NOT_ADMITTED', task.kind);
  const system = prompts.TEXTS[task.kind];
  const pack = bundle.pack;
  const maxTok = opts.maxPackTokens || undefined;

  const pc = checkPack(pack, { purpose: isCard ? 'CARD' : 'CHECK', check_admission_sha256: admissions.byKind.AI_CHECK && admissions.byKind.AI_CHECK.system_sha256, author_required: !!bundle.author_required, maxTokens: isCard ? maxTok : Infinity });
  if (pc.errors.length) return blocked(pc.errors[0].code, pc.errors[0].detail);

  if (isCard) {
    if (typeof bundle.week_id !== 'string' || !isObj(bundle.registry)) return blocked('RQ_BUNDLE_INVALID', 'week_id/registry');
    const vctx = { pack, registry: bundle.registry, market: task.market, week_id: bundle.week_id, existing_idea_count: bundle.existing_idea_count || 0 };
    const user = JSON.stringify({ market: task.market, week_id: bundle.week_id, facts: pack.facts, repeated_pattern_counts: pack.code_counts || [], registry: registryView(bundle.registry) });
    const r = await askUntilValid({ client: opts.client, task, system, admission: adm.system_sha256, user, validate: (raw) => validateCard(raw, vctx), kindLabel: task.kind, ctx });
    if (!r.ok) return result(r.outcome);
    const card = { schema: 'REVIEW_AI_CARD_V1', task_id: task.task_id, ...r.value.card, prompt_admission_sha256: adm.system_sha256, model: r.model };
    const card_sha256 = sha256(canonicalJson(card));
    const ideas = buildIdeaRecords(card, vctx, { card_sha256, prompt_admission_sha256: adm.system_sha256, model: r.model });
    const routes = ideas.map((i) => routeIdea(i, { registry: bundle.registry, triage: opts.triage }));
    const proposals = [];
    ideas.forEach((idea, i) => {
      if (routes[i].state === 'WAITING_MECHANISM_ADMISSION') proposals.push(proposeAdmission(idea));
      else if (routes[i].state === 'PREREG_PROPOSED') proposals.push(preregProposal(idea));
    });
    const counts = {};
    for (const rt of routes) counts[rt.state] = (counts[rt.state] || 0) + 1;
    return result({ status: 'DONE', outputs: { card, card_sha256, factor_ideas: ideas, idea_routes: routes, proposals,
      metrics: { market: task.market, week_id: bundle.week_id, ideas: ideas.length, no_idea_reason_cited: card.no_idea_reason !== null, routes: counts } } });
  }

  const parts = splitPackByRow(pack, { maxTokens: maxTok });
  if (opts.maxPackTokens === undefined && parts.length === 0) return blocked('PACK_MATRIX_MISSING');
  const reports = [];
  let model = MODELS.FLASH;
  for (const part of parts) {
    const user = JSON.stringify({ task_id: task.task_id, facts: part.facts, evidence_matrix: part.evidence_matrix });
    const r = await askUntilValid({ client: opts.client, task, system, admission: adm.system_sha256, user, validate: (raw) => validateCheckReport(raw, part), kindLabel: task.kind, ctx });
    if (!r.ok) return result(r.outcome);
    if (r.model === MODELS.PRO) model = MODELS.PRO;
    reports.push(r.value.report);
  }
  const merged = mergeReports(reports, pack.evidence_matrix.map((m) => m.req_id));
  if (!validateCheckReport(merged, pack).ok) return blocked('RQ_CHECK_MERGE_INVALID');
  const check_report = { schema: 'RQ_CHECK_REPORT_V1', task_id: task.task_id, ...merged, prompt_admission_sha256: adm.system_sha256, model };
  return result({ status: 'DONE', outputs: { check_report, check_report_sha256: sha256(canonicalJson(check_report)), fact_pack_sha256: packSha(pack) } });
}

module.exports = { MODELS, MAX_TOKENS, ATTEMPTS, REVISIONS, assertKeylessEnv, runAgentTask, gatewayFailure };
