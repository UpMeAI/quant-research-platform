'use strict';
// Render supplied evidence only. No reconciliation or business calculations here.
const literal = (value) => String(value ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function block(value) {
  const text = JSON.stringify(value, null, 2);
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((s) => s.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}json\n${text}\n${fence}`;
}
function renderReport(result) {
  const lines = ['# 复盘研究记录', `状态：${literal(result.status)}`,
    `输入校验：${literal(result.inputPackSha256)}`, '', '## 确定性事实'];
  for (const fact of result.facts || []) lines.push('', block(fact));
  if (result.status !== 'ACCEPTED' || result.checker?.ok !== true || !result.note) {
    lines.push('', '仅保留确定性事实，模型内容不展示。');
    return lines.join('\n');
  }
  lines.push('', '## 已核查的复盘内容');
  for (const claim of result.note.claims) lines.push('', `${literal(claim.text)} [${claim.refs.map(literal).join(', ')}]`);
  if (result.note.directions.length) lines.push('', '## 待研究的问题');
  for (const direction of result.note.directions) {
    lines.push('', `问题：${literal(direction.question)}`, `机制：${literal(direction.mechanism)}`,
      `对照组：${literal(direction.control)}`, `所需数据：${literal(direction.requiredData)}`,
      `依据：${direction.refs.map(literal).join(', ')}`, '仅作为研究候选，未写入研究分诊。');
    if (direction.dedupe === 'DEDUPE_PENDING') lines.push('机制去重尚未完成。');
  }
  return lines.join('\n');
}
module.exports = { renderReport };
