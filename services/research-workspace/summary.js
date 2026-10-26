'use strict';

/**
 * UX 修订 7 J1：策略详情默认页签「总览」的投影（第一层「总」）。
 *
 * 只读、只挑数：一句话结论、关键数字卡、研究结论与采用一览（精简）、现在生效的规则与待办，
 * 全部取自已锁定的回测结果投影、对比结果投影、修订 6 的采用一览（有效采用记录）和说明登记；不重算任何数字，
 * 只做取整、比较大小和计数。一句话结论由这里的模板生成（J1.1、J5.4），页面只显示。
 * 每张数字卡与每个待办都带一个去处（section + block／card），页面据此链接到细节。
 */
const { isMainRow } = require('../baseline-evaluation');

/** 句子里的金额：取整到个位、千分位（「3,418」），与验收的例句同一写法。 */
const whole = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : null);
const dateOf = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : null);
const blockData = (projection, key) => {
  const block = projection && (projection.blocks || []).find((item) => item.key === key && item.state === 'AVAILABLE');
  return block ? block.data : null;
};

/** 比较对象：本策略之外、不是现金的第一个账户（US_V5 是 SPY 买入持有）。 */
const comparatorOf = (account) => (account ? account.arms.find((arm) => arm.key !== 'D' && arm.key !== 'CASH') || null : null);
const ownOf = (account) => (account ? account.arms.find((arm) => arm.key === 'D') || null : null);

/**
 * 已采用的改进：采用的对比题；组合题（说明登记 combines）算作它所组合的各题，去重后按题号排。
 * 例：Q1、Q4、Q5（= Q4 + Q1）都采用 → 两项改进（Q1、Q4）。
 */
function adoptedImprovements(rows, questions) {
  const refs = new Set();
  for (const row of rows) {
    if (row.role !== 'COMPARISON' || row.adoption.decision !== 'ADOPT') continue;
    const parts = (questions[row.question_ref] && questions[row.question_ref].combines) || [row.question_ref];
    parts.forEach((ref) => refs.add(ref));
  }
  return [...refs].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }))
    .map((ref) => ({ question_ref: ref, name_zh: (questions[ref] && questions[ref].name_zh) || ref }));
}

/** 研究中期末最高的候选（只看对比行，已锁定结果里的候选期末资本）。 */
function bestCandidate(rows) {
  return rows.filter((row) => row.role === 'COMPARISON' && row.capital && Number.isFinite(row.capital.candidate))
    .reduce((best, row) => (!best || row.capital.candidate > best.capital.candidate ? row : best), null);
}

/**
 * J1.1 一句话结论（服务端模板）：
 *   「现行版本样本外期末 {本策略}，{低于|高于|等于} {比较对象}的 {期末}（{结论}）；已采用 N 项改进（…）[，待 Owner 决定 M 题]，研究中期末最高的是…」
 * 没有锁定的回测结果时写回测状态与原因；没有锁定的对比结果时只写第一段。
 */
function sentenceOf({ conclusion, account, overview, questions, engine = null }) {
  if (!conclusion || conclusion.result_state !== 'LOCKED_VERIFIED') {
    return `${conclusion && conclusion.label ? conclusion.label : '尚未回测'}：${(conclusion && (conclusion.reason || conclusion.result_reason)) || '原因未提供'}`;
  }
  const own = ownOf(account); const cmp = comparatorOf(account);
  let head;
  if (own && cmp) {
    const relation = own.end_capital < cmp.end_capital ? '低于' : own.end_capital > cmp.end_capital ? '高于' : '等于';
    head = `现行版本样本外期末 ${whole(own.end_capital)}，${relation} ${cmp.label}的 ${whole(cmp.end_capital)}（${conclusion.label}）`;
  } else head = `现行版本回测结论：${conclusion.label}`;
  // CRYPTO_Q0_RESULT_V1 增补 1 §2.2 第 1 条 ★(a)：近似引擎的标签分句紧跟结论头（只对非 LEGACY 档案、flag = true）
  if (engine) head = `${head}；所用引擎为${engine}，结论最高只能是证据不足`;
  if (!overview) return head;
  const rows = overview.groups.flatMap((group) => group.rows);
  const improvements = adoptedImprovements(rows, questions);
  const summary = overview.cumulative || overview.groups[overview.groups.length - 1].summary;
  const adopted = improvements.length
    ? `已采用 ${improvements.length} 项改进（${improvements.map((item) => item.name_zh).join('、')}）` : '还没有采用任何改进';
  const pending = summary.pending ? `，待 Owner 决定 ${summary.pending} 题` : '';
  const best = bestCandidate(rows);
  let tail = '';
  if (best && own && best.capital.candidate > own.end_capital) {
    const combo = Boolean(questions[best.question_ref] && questions[best.question_ref].combines);
    tail = combo ? `，研究中期末最高的是组合版本（${best.question_ref}）：${whole(best.capital.candidate)}`
      : `，研究中期末最高的候选是 ${best.question_ref}「${best.title_zh}」：${whole(best.capital.candidate)}`;
  } else if (best && own) tail = '，研究中没有候选的期末高于现行版本';
  return `${head}；${adopted}${pending}${tail}`;
}

/** J1.2 关键数字卡：数字原样取自锁定结果与采用一览；页面格式化。`isMain`：档案的主数字行判别（非 LEGACY 档案按 q0_reading）。 */
function tilesOf({ backtest, account, overview, isMain = isMainRow }) {
  const tiles = [];
  const own = ownOf(account); const cmp = comparatorOf(account);
  if (own) {
    tiles.push({ key: 'end_capital', label_zh: `现行对比 ${cmp ? cmp.label : '比较对象'}的期末`, own: own.end_capital,
      comparator: cmp ? cmp.end_capital : null, comparator_label: cmp ? cmp.label : null, window: { start: account.start, end: account.end }, link: { section: 'runtime', block: 'account' } });
    tiles.push({ key: 'max_drawdown', label_zh: '最大回撤', own: own.max_drawdown, comparator: cmp ? cmp.max_drawdown : null,
      comparator_label: cmp ? cmp.label : null, link: { section: 'runtime', block: 'account' } });
  }
  const winrate = blockData(backtest, 'winrate');
  const main = winrate && (winrate.rows.find(isMain) || winrate.rows.find((row) => row.segment === 'OOS'));
  // 费用写法：LEGACY_V1 写「5 bps」；非 LEGACY 档案写自己的费用词（CRYPTO_Q0_RESULT_V1 §3.2）
  if (main) tiles.push({ key: 'winrate', label_zh: '样本外胜率与赔率', win_rate: main.win_rate, payoff: main.payoff, n: main.n,
    row_zh: `${main.segment_label} · ${main.cost_label !== undefined ? main.cost_label : `${main.cost_bps} bps`} · ${main.phase_label}`, link: { section: 'runtime', block: 'winrate' } });
  const kelly = blockData(backtest, 'kelly');
  if (kelly) tiles.push({ key: 'half_kelly', label_zh: '半凯利', f_half: kelly.f_half, supported: kelly.supported, link: { section: 'runtime', block: 'kelly' } });
  if (overview) {
    const s = overview.cumulative || overview.groups[overview.groups.length - 1].summary;
    tiles.push({ key: 'adoption_rate', label_zh: '采用率', adopted: s.adopted, decided: s.decided, pending: s.pending, rate: s.rate, link: { section: 'research' } });
  }
  if (own) tiles.push({ key: 'underwater', label_zh: '最长水下期与「期末是否回到最高点」', sessions: own.longest_underwater_sessions,
    recovered: own.recovered, peak: own.peak || null, link: { section: 'runtime', block: 'account' } });
  return tiles;
}

/** J1.3 研究结论与采用一览（精简）：修订 6 的表只留题号、中文题名、期末差值、统计结论、采用决定；每行点进对应对比卡。 */
function adoptionOf(overview, comparisons) {
  if (!overview) return null;
  const cardOf = new Map(comparisons.filter((card) => card.result_id).map((card) => [card.result_id, card.question_ref]));
  return {
    title_zh: overview.title_zh,
    groups: overview.groups.map((group) => ({
      label_zh: group.label_zh,
      rows: group.rows.map((row) => ({
        question_ref: row.question_ref, role: row.role, title_zh: row.title_zh,
        capital: row.capital, verdict_label: row.verdict_label, decision_zh: row.adoption.short_zh,
        link: row.role === 'BASELINE' ? { section: 'runtime', block: 'account' } : { section: 'research', card: cardOf.get(row.result_id) || row.question_ref },
      })),
      summary_zh: group.summary.text_zh,
    })),
    cumulative_zh: overview.cumulative ? overview.cumulative.text_zh : null,
    banner_zh: (overview.cumulative || overview.groups[overview.groups.length - 1].summary).banner_zh || null,
  };
}

/**
 * J1.4 现在生效的规则版本与待办：
 *   - 现行版本：Desk 目录登记的生效时间与运行方式，运行 case 的版本引用（技术详情）；
 *   - 已采用、待落地：采用记录里写的后续去向（部署状态不在 QRP 记录里，这里不写「已部署」）；
 *   - 待 Owner 决定：对比题里还没有决定的；
 *   - 下一步研究：研究队列里还没锁定的题，以及不采用题记录的后续。
 */
function rulesOf({ strategy, caseRec, overview, queueView, comparisons }) {
  const rows = overview ? overview.groups.flatMap((group) => group.rows).filter((row) => row.role === 'COMPARISON') : [];
  const cardOf = new Map(comparisons.filter((card) => card.result_id).map((card) => [card.result_id, card.question_ref]));
  const item = (row, text) => ({ question_ref: row.question_ref, title_zh: row.title_zh, text_zh: text, link: { section: 'research', card: cardOf.get(row.result_id) || row.question_ref } });
  return {
    current: strategy ? {
      label_zh: `${strategy.name}：Desk 登记 ${dateOf(strategy.effective_from) || '日期未登记'} 起生效，${strategy.mode_label}`,
      version_ref: caseRec ? caseRec.runtime_lane.version_ref : null, as_of: caseRec ? caseRec.runtime_lane.as_of : null,
    } : null,
    adopted: rows.filter((row) => row.adoption.decision === 'ADOPT')
      .map((row) => item(row, `${row.adoption.decided_on ? `Owner ${row.adoption.decided_on} 决定采用；` : ''}后续：${row.adoption.follow_up_zh || '未写后续去向'}`)),
    pending: rows.filter((row) => row.adoption.state !== 'DECIDED').map((row) => item(row, row.adoption.label_zh)),
    next: [
      ...(queueView ? queueView.rows.filter((row) => !row.locked).map((row) => ({
        question_ref: row.question_ref, title_zh: row.name_zh, text_zh: row.status_zh, link: { section: 'research' },
      })) : []),
      ...rows.filter((row) => row.adoption.decision === 'NOT_ADOPTED').map((row) => item(row, `不采用；后续：${row.adoption.follow_up_zh}`)),
    ],
    deploy_note_zh: '部署状态不在 QRP 的记录里；这里只列采用记录写下的后续去向。',
  };
}

/**
 * 总览投影。`notesQueue` = 说明登记的 research_queue（题名、组合关系）；`overview` = 修订 6 的采用一览（可为 null）。
 */
function overviewOf({ strategy, caseRec, conclusion, backtest, comparisons, overview, notesQueue, queueView, isMain = isMainRow, engineClause = false }) {
  const account = blockData(backtest, 'account');
  const verdict = blockData(backtest, 'verdict');
  const engine = engineClause && verdict && verdict.engine_approximation && verdict.engine_label ? verdict.engine_label : null;
  const questions = (notesQueue && notesQueue.questions) || {};
  const locked = (comparisons || []).filter((card) => card.state === 'LOCKED_VERIFIED');
  return {
    title_zh: '总览',
    sentence_zh: sentenceOf({ conclusion, account, overview, questions, engine }),
    state: conclusion ? conclusion.state : null,
    tiles: conclusion && conclusion.result_state === 'LOCKED_VERIFIED' ? tilesOf({ backtest, account, overview, isMain }) : [],
    adoption: adoptionOf(overview, locked),
    rules: rulesOf({ strategy, caseRec, overview, queueView, comparisons: locked }),
    source_zh: '数字取自已锁定的结果文件与采用记录，页面不重算',
  };
}

module.exports = { overviewOf, sentenceOf, adoptedImprovements };
