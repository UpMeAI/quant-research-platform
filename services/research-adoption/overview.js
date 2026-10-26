'use strict';

/**
 * 修订 6 H2–H4 的投影：每张对比卡的「采用决定」一行，以及研究区开头的「研究结论与采用一览」与采用率。
 *
 * 只读、只计数：数字（期末资本、最大回撤、统计结论）都取自已锁定结果的投影；采用决定取自追加式记录的有效那条；
 * 汇总只数题数（已决定 N = 采用 + 不采用，不计「不适用」），采用率 = 采用 ÷ N。页面不重算。
 * 「方向偏差」提示的阈值在修订 6 H4.2 冻结：已决定 ≥ 3 题且采用率 < 50%。
 */
const { keyOf } = require('./index');

const MIN_DECIDED = 3;
const BANNER_ZH = '大部分研究未被采用：研究方向偏离『以优化策略为目的』，需要调整（见当前研究计划）';
const WORDS = Object.freeze({ ADOPT: '采用', NOT_ADOPTED: '不采用' });

const dateOf = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : null);

/**
 * 一张对比卡（或一行）的采用决定。role：COMPARISON／BASELINE／CONTROL；基线与对照固定「不适用」。
 * short_zh 是短写（修订 7：总览的精简一览与对比卡折叠后的一行摘要）：采用／不采用／不适用（…）／待 Owner 决定。
 */
function adoptionOf(record, role = 'COMPARISON') {
  if (role !== 'COMPARISON') {
    const what = role === 'BASELINE' ? '基线' : '对照';
    return {
      state: 'NOT_APPLICABLE', decision: 'NOT_APPLICABLE', label_zh: `不适用（${what}）`, short_zh: `不适用（${what}）`, tone: '',
      follow_up_zh: record && record.kind === 'DECISION' ? record.follow_up_zh : null, decided_on: record && record.kind === 'DECISION' ? dateOf(record.decided_at) : null,
      record_id: record ? record.record_id : null,
    };
  }
  if (record && record.kind === 'DECISION') {
    const label = record.decision === 'ADOPT'
      ? `采用（纸面账户执行，Owner ${dateOf(record.decided_at)} 决定）`
      : `不采用（现行规则不变；后续：${record.follow_up_zh}）`;
    return {
      state: 'DECIDED', decision: record.decision, label_zh: label, short_zh: WORDS[record.decision], tone: record.decision === 'ADOPT' ? 'VALID' : '',
      follow_up_zh: record.follow_up_zh, decided_on: dateOf(record.decided_at), record_id: record.record_id,
    };
  }
  if (record && record.kind === 'RECOMMENDATION') {
    const rec = record.coordinator_recommendation;
    return {
      state: 'RECOMMENDED', decision: null, label_zh: `待 Owner 决定（协调会话建议：${WORDS[rec.recommendation]} —— ${rec.reason_zh}）`, short_zh: '待 Owner 决定', tone: 'DEGRADED',
      follow_up_zh: null, decided_on: null, record_id: record.record_id,
    };
  }
  return { state: 'NONE', decision: null, label_zh: '待 Owner 决定（协调会话尚未给出建议）', short_zh: '待 Owner 决定', tone: 'DEGRADED', follow_up_zh: null, decided_on: null, record_id: null };
}

/** 汇总（H4.1）与方向偏差提示（H4.2）：只计对比行。 */
function summaryOf(rows) {
  const compared = rows.filter((row) => row.role === 'COMPARISON');
  const adopted = compared.filter((row) => row.adoption.decision === 'ADOPT').length;
  const rejected = compared.filter((row) => row.adoption.decision === 'NOT_ADOPTED').length;
  const decided = adopted + rejected;
  const pending = compared.length - decided;
  const rate = decided ? adopted / decided : null;
  const deviates = decided >= MIN_DECIDED && adopted * 2 < decided;
  return {
    decided, adopted, not_adopted: rejected, pending, rate,
    text_zh: `已决定 ${decided} 题：采用 ${adopted}、不采用 ${rejected}，采用率 ${decided ? `${adopted} ÷ ${decided} = ${Math.round(rate * 100)}%` : '—（还没有已决定的题）'}；待决定 ${pending} 题`,
    deviates, banner_zh: deviates ? BANNER_ZH : null,
  };
}

const accountOf = (projection) => {
  const block = projection && (projection.blocks || []).find((item) => item.key === 'account' && item.state === 'AVAILABLE');
  return block ? block.data : null;
};

/**
 * 「研究结论与采用一览」（H3）：每个已锁定的对比结果一行，外加基线（Q0）一行与随机对照（Q3a、Q3a2）各一行（标「不适用」）。
 * 研究计划分轮次时（说明登记里的 `round`），按轮次分组，每轮一个汇总，另给一个累计汇总。
 * `queue` = 说明登记的 research_queue（题名、研究部分、轮次、基线名）；`records` = 有效采用记录（Map，keyOf(result_id, part) → 记录）。
 */
function overviewOf({ baselineProjection, comparisons, queue, records }) {
  if (!queue || !baselineProjection || baselineProjection.state !== 'LOCKED_VERIFIED') return null;
  const locked = comparisons.filter((card) => card.state === 'LOCKED_VERIFIED');
  if (!locked.length) return null;
  const meta = (question) => (queue.questions && queue.questions[question]) || {};
  const roundOf = (question) => (Number.isInteger(meta(question).round) ? meta(question).round : null);
  const rows = [];

  const baseAccount = accountOf(baselineProjection);
  const own = baseAccount && baseAccount.arms.find((arm) => arm.key === 'D');
  const base = queue.baseline || {};
  rows.push({
    question_ref: 'Q0', role: 'BASELINE', title_zh: base.name_zh || '原版评价', part_zh: base.part_zh || '基线',
    capital: own ? { baseline: own.end_capital, candidate: null, diff: null } : null,
    drawdown: own ? { baseline: own.max_drawdown, candidate: null } : null,
    verdict_label: baselineProjection.conclusion.label, adoption: adoptionOf(records.get(keyOf(baselineProjection.result_id)), 'BASELINE'),
    round: null, result_id: baselineProjection.result_id,
  });

  for (const card of locked) {
    const account = accountOf(card);
    const [b, c] = account ? account.arms : [];
    rows.push({
      question_ref: card.question_ref, role: 'COMPARISON', title_zh: meta(card.question_ref).name_zh || card.title_zh, part_zh: meta(card.question_ref).part_zh || '未登记',
      capital: b && c ? { baseline: b.end_capital, candidate: c.end_capital, diff: account.diff_vs_baseline.end_capital } : null,
      drawdown: b && c ? { baseline: b.max_drawdown, candidate: c.max_drawdown } : null,
      verdict_label: card.verdict_label, adoption: adoptionOf(records.get(keyOf(card.result_id)), 'COMPARISON'),
      round: roundOf(card.question_ref), result_id: card.result_id,
    });
    const control = (card.extra_cards || []).find((extra) => extra.state === 'AVAILABLE' && extra.data && Array.isArray(extra.data.parts));
    for (const part of control ? control.data.parts : []) {
      const [code, ...title] = String(part.title_zh).split('：');
      rows.push({
        question_ref: code, role: 'CONTROL', title_zh: title.join('：') || part.title_zh, part_zh: `${meta(card.question_ref).part_zh || '未登记'}（对照）`,
        capital: null, drawdown: null, verdict_label: part.state === 'AVAILABLE' ? part.state_label : '尚未完成',
        adoption: adoptionOf(records.get(keyOf(card.result_id, part.key)), 'CONTROL'), round: roundOf(card.question_ref), result_id: card.result_id, part: part.key,
      });
    }
  }

  // 轮次：基线放在最早一轮；没有登记轮次的题归到「未分轮」
  const rounds = [...new Set(rows.filter((row) => row.role !== 'BASELINE').map((row) => row.round))].sort((x, y) => (x === null) - (y === null) || x - y);
  rows[0].round = rounds.length ? rounds[0] : null;
  const labelOf = (round) => (round === null ? (rounds.length > 1 ? '未分轮' : null) : ((queue.rounds && queue.rounds[String(round)]) || `第 ${round} 轮`));
  const groups = rounds.length ? rounds.map((round) => {
    const members = rows.filter((row) => row.round === round);
    return { round, label_zh: labelOf(round), rows: members, summary: summaryOf(members) };
  }) : [{ round: null, label_zh: null, rows, summary: summaryOf(rows) }];
  return {
    title_zh: '研究结论与采用一览',
    note_zh: '数字取自已锁定的结果文件；基线与随机对照不参与采用率。',
    groups,
    cumulative: groups.length > 1 ? summaryOf(rows) : null,
    row_count: rows.length,
  };
}

module.exports = { MIN_DECIDED, BANNER_ZH, adoptionOf, summaryOf, overviewOf };
