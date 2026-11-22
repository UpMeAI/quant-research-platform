'use strict';

/**
 * Renders the K2 text, the validation report, the freeze page and the refusal file. Everything the agent wrote is data placed into a fixed template;
 * there is no free layout, no formula and no model call. Same inputs give the same bytes.
 */
const trials = require('../trial-ledger');
const { sha256, canonicalJson, prettyJson } = require('./common');
const rf1118 = require('./rf1118');

const NONE_LINE = '无';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Components and params as they will be read by V7; a malformed shape renders as empty so that V7 (not the renderer) refuses it. */
const compsOf = (a) => (Array.isArray(a.rule_config.components) ? a.rule_config.components : []);
const paramsOf = (a) => (isObj(a.rule_config.params) ? a.rule_config.params : {});

const dataToken = (d) => `\`DATA:${d.dataset_id}${d.series ? `#series=${d.series}` : ''}@${d.registry_version}#${d.registry_sha256}|PIT=${d.pit}|VENDOR=${d.vendor}${d.basis ? `|BASIS=${d.basis}` : ''}${d.hist ? `|HIST=${d.hist}` : ''}\``;

/** Trial id of an arm, before it is registered (the id depends only on family, study and label, ledger section 9 item 2). */
const trialIdOf = (draft, arm) => trials.trialIdOf({ family_id: draft.family_id, study_ref: draft.study_ref, config_label: arm.config_label });

function line4(items) {
  if (!items.length) return NONE_LINE;
  return items.map((it) => (it.category === 'AI_MINED_CANDIDATE' ? `AI_MINED_CANDIDATE（候选 ${it.candidate_id}；轮次 ${it.round_id}）` : it.category)).join('；');
}

function authorLine(a) {
  const who = a.kind === 'AI_PREREG_AGENT'
    ? `作者 AI_PREREG_AGENT（模型 ${a.model}；提示准入 sha ${a.prompt_sha256}；schema sha ${a.schema_sha256}；主机 ${a.host}）`
    : `作者 HUMAN_SESSION（会话 ${a.session_ref}）`;
  return `${who}；冻结者 K2_FREEZE_PROGRAM_V1，验证报告 sha 见冻结页`;
}

function renderK2(draft, { priorTableSha256 }) {
  const s = draft.section0;
  const d = draft.desk_items;
  const lines = [];
  const L = (x = '') => lines.push(x);
  L(`# ${draft.title_zh}（${draft.draft_id}）`);
  L();
  L(`- 研究名：${draft.study_ref}`);
  L(`- 市场：${draft.market}`);
  L(`- 族：${draft.family_id}`);
  L(`- 草稿修订：${draft.revision}`);
  L('- 渲染：K2_FREEZE_PROGRAM_V1 按 K2_DRAFT_V1 渲染；正文不含公式，判定表只取冻结模板。');
  L();
  L('## 0 机制与角色');
  L();
  L(`**机制**：${s.mechanism_ids.join('、')}：${s.mechanism_text_zh}`);
  L(`**预期失效方式**：${s.failure_mode_zh}`);
  L(`**可能被哪条现行规则解释**：${s.explained_by_zh}`);
  L(`**AI 输入**：${line4(s.ai_inputs)}`);
  L(`**作者与冻结者**：${authorLine(draft.authored_by)}`);
  L();
  L(`先前结论表 sha256：${priorTableSha256}`);
  L();
  L('### 0.1 数据输入');
  L();
  for (const di of draft.data_inputs) L(`- ${dataToken(di)}（区间 ${di.range.from} 至 ${di.range.to}；段标签 ${di.segment_label}）`);
  L();
  L('### 0.2 AI 输入明细');
  L();
  if (!s.ai_inputs.length) L(`- ${NONE_LINE}`);
  s.ai_inputs.forEach((it, i) => L(`- 第 ${i + 1} 项：${it.ref}（${it.desc_zh}）`));
  L();
  L('### 0.3 G-CAUSAL 范围');
  L();
  const c = draft.causality;
  if (Array.isArray(c.functions)) for (const f of c.functions) L(`- \`CF:${f}\``);
  if (typeof c.not_applicable_code === 'string') L(`- G-CAUSAL N/A: ${c.not_applicable_code}`);
  L();
  L('## 1 研究题（周复盘验收 §5.7 八项）');
  L();
  L(`1. 候选号：${d.candidate_ref}；ruleRef：${d.rule_ref}`);
  L(`2. 要改什么、在哪段数据上比：${d.change_and_window_zh}`);
  L(`3. 冻结的判定口径：${d.decision_criteria_zh}`);
  L(`4. 数据限制：${d.data_limits_zh}`);
  L(`5. 第二轮仍 INSUFFICIENT 时：${d.round2_plan_zh}`);
  L(`6. 研究槽租约：${d.lease_ref}`);
  L(`7. 「做」之后的计量计划：${d.measurement_plan_zh}`);
  L(`8. paper 验证的预签停止条件：${d.paper_stop_zh}`);
  L();
  L('## 2 臂');
  L();
  L('| 配置名 | 角色 | 阶段 | 组成 | 参数 |');
  L('|---|---|---|---|---|');
  for (const a of draft.arms) {
    const comps = compsOf(a).map((x) => (isObj(x) ? `${x.kind}:${x.id}` : '?')).join('、');
    const params = Object.keys(paramsOf(a)).sort().map((k) => `${k}=${typeof paramsOf(a)[k] === 'object' ? '?' : paramsOf(a)[k]}`).join('；');
    L(`| ${a.config_label} | ${a.role} | ${a.stage} | ${comps} | ${params} |`);
  }
  L();
  L(`比较对象：${draft.comparison.baseline_label}（${draft.comparison.kind}）`);
  L(`样本区间：${draft.sample.from} 至 ${draft.sample.to}；计划观测数 ${draft.sample.n_obs_planned}`);
  L();
  L('## 3 判定表（冻结模板）');
  L();
  L(`- 模板：${String(draft.decision_table.template_id)}`);
  const tp = isObj(draft.decision_table.params) ? draft.decision_table.params : {};
  for (const k of Object.keys(tp).sort()) L(`- ${k} = ${typeof tp[k] === 'object' ? '?' : tp[k]}`);
  L();
  L('## 4 功效（功效工具算出）');
  L();
  L(`- effect_size_sd = ${draft.power.effect_size_sd}；alpha = ${draft.power.alpha}；power_target = ${draft.power.power_target}；n_required = ${draft.power.n_required}`);
  L();
  L('## 5 预登记试验编号');
  L();
  L('| 配置名 | 角色 | 阶段 | 试验编号 |');
  L('|---|---|---|---|');
  for (const a of draft.arms) L(`| ${a.config_label} | ${a.role} | ${a.stage} | ${trialIdOf(draft, a)} |`);
  L();
  return `${lines.join('\n')}\n`;
}

function trlRequest(draft, k2Sha256, segmentLabels) {
  return {
    schema: 'TRIAL_REGISTRATION_REQUEST_V1', draft_id: draft.draft_id, market: draft.market, family_id: draft.family_id, k2_sha256: k2Sha256,
    specs: draft.arms.map((a) => ({ family_id: draft.family_id, market: draft.market, study_ref: draft.study_ref, config_label: a.config_label, stage: a.stage, role: a.role, k2_sha256: k2Sha256,
      rule_config: { components: compsOf(a), params: paramsOf(a) }, window: { from: draft.sample.from, to: draft.sample.to }, segments: segmentLabels,
      source_refs: [`k2:${draft.draft_id}`] })),
  };
}

function renderReport({ draft, draftSha256, k2Sha256, k2FrozenAt, results, programSha256, libSha256 }) {
  return prettyJson({ schema: 'K2_PREREG_VALIDATION_REPORT_V1', program: 'K2_FREEZE_PROGRAM_V1', program_sha256: programSha256, rf1118: { path: rf1118.FREEZE.path, sha256: rf1118.FREEZE.sha256 },
    template_library_sha256: libSha256, draft_id: draft.draft_id, draft_sha256: draftSha256, k2_sha256: k2Sha256, k2_frozen_at: k2FrozenAt, market: draft.market,
    results: results.map(({ v, name, state, codes, reason }) => ({ v, name, state, codes: codes || [], ...(reason ? { reason } : {}) })), all_pass: results.every((r) => r.state === 'PASS' || r.state === 'NOT_APPLICABLE') });
}

function renderPage({ block }) {
  const lines = [
    `# ${block.draft_id} · K2 · FREEZE_PROGRAM_1 · FROZEN`,
    '',
    `- 状态：FROZEN。冻结者 ${block.frozen_by}（程序）；冻结时刻 ${block.k2_frozen_at}（主机钟，+08:00）。`,
    `- 冻结文本 sha256：${block.k2_sha256}；验证报告 sha256：${block.report_sha256}；程序版本 sha256：${block.program_sha256}。`,
    `- 依据：RF1118 修订 2，冻结页 ${block.rf1118.sha256}（生效 ${block.rf1118.effective_from}）。`,
    `- 作者：${block.authored_by.kind}。`,
    `- 预登记试验：${block.trial_ids.join('、')}；族 ${block.family_n.family_id} 的 N（不同配置）= ${block.family_n.n_distinct_configs}。`,
    '- 协调会话事后审计；撤回只用 `…_REVOCATION_1.md` 页，本页不改。',
    '',
    '```json K2_PROGRAM_FREEZE_PAGE_V1',
    JSON.stringify(require('./common').sortKeys(block), null, 1),
    '```',
    '',
  ];
  return Buffer.from(lines.join('\n'));
}

function renderRefusal({ draft, draftSha256, attempt, results, codes, next, programSha256 }) {
  return prettyJson({ schema: 'K2_PREREG_REFUSAL_V1', program: 'K2_FREEZE_PROGRAM_V1', program_sha256: programSha256, draft_id: draft && typeof draft.draft_id === 'string' ? draft.draft_id : null, draft_sha256: draftSha256,
    attempt, next, codes, results: results.map(({ v, name, state, codes: c, reason }) => ({ v, name, state, codes: c || [], ...(reason ? { reason } : {}) })) });
}

module.exports = { renderK2, trlRequest, renderReport, renderPage, renderRefusal, trialIdOf, dataToken, canonicalJson, sha256 };
