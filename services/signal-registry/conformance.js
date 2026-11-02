'use strict';
/**
 * SIGNAL_REGISTRY_V1 对 STRATEGY_SCOREBOARD_V1 的一致性：两边都有的每个字段逐一比较，要求 0 差异（规格 §7）。
 *
 *   窗口（每块的汇总行 signalKey '*' 对记分牌同名块的 bookSinceStart / currentVersion / previousVersion）：
 *     state reasonCode from to segmentIds closed open wins losses flats pnlBasis winRate avgR expectancyT costs
 *   状态拆分（bookSinceStart / currentVersion）：state reasonCode from to segmentIds untaggedClosed untaggedOpen，
 *     每条轴的 state reasonCode 与格子键次序，每格 key closed open sample winRate avgR netPnl
 *   逐笔：记分牌标签里有结果的每一笔，登记簿该笔的 pnl、rMultiple、平仓时刻
 *   拆分守恒：同一块里各信号行的 closed open wins losses flats 之和 = 汇总行
 *
 * 值按记分牌导出的样子比较（canonical JSON 相等），不设容差。
 */
const { SPLIT_WINDOWS, WINDOWS, canonicalJson } = require('./index');

const WINDOW_FIELDS = Object.freeze(['state', 'reasonCode', 'from', 'to', 'segmentIds', 'closed', 'open', 'wins', 'losses', 'flats', 'pnlBasis',
  'winRate', 'avgR', 'expectancyT', 'costs']);
const SPLIT_FIELDS = Object.freeze(['state', 'reasonCode', 'from', 'to', 'segmentIds', 'untaggedClosed', 'untaggedOpen']);
const CELL_FIELDS = Object.freeze(['key', 'closed', 'open', 'sample', 'winRate', 'avgR', 'netPnl']);
const SUM_FIELDS = Object.freeze(['closed', 'open', 'wins', 'losses', 'flats']);

function compareBook(book, rows, scoreboard) {
  const differences = [];
  let compared = 0;
  const same = (where, a, b) => {
    compared += 1;
    const x = a === undefined ? null : a;
    const y = b === undefined ? null : b;
    if (canonicalJson(x) !== canonicalJson(y)) differences.push({ path: where, registry: x, scoreboard: y });
  };
  if (book.ledgerId !== scoreboard.ledgerId || book.period.to !== scoreboard.period.to) {
    differences.push({ path: `${book.ledgerId}`, registry: book.period.to, scoreboard: scoreboard.period.to });
    return { compared, differences };
  }
  for (const block of book.blocks) {
    const sbBlock = block.partId ? (scoreboard.parts || []).find((p) => p.partId === block.partId) : scoreboard;
    const at = `${book.ledgerId}${block.partId ? `:${block.partId}` : ''}`;
    if (!sbBlock) { differences.push({ path: at, registry: 'BLOCK', scoreboard: null }); continue; }
    const r = block.rollup;
    for (const w of WINDOWS) for (const f of WINDOW_FIELDS) same(`${at}.windows.${w}.${f}`, r.windows[w][f], sbBlock.windows[w][f]);
    const sbSplit = sbBlock.stateSplit || null;
    if (!sbSplit) same(`${at}.stateSplit.present`, r.stateSplit.windows === null, true);
    else {
      for (const f of ['state', 'reasonCode', 'since']) same(`${at}.stateSplit.${f}`, r.stateSplit[f], sbSplit[f]);
      for (const w of SPLIT_WINDOWS) {
        const mine = r.stateSplit.windows[w];
        const theirs = sbSplit.windows[w];
        for (const f of SPLIT_FIELDS) same(`${at}.stateSplit.${w}.${f}`, mine[f], theirs[f]);
        if (!theirs.axes) { same(`${at}.stateSplit.${w}.axes`, mine.axes, null); continue; }
        for (const [axis, a] of Object.entries(theirs.axes)) {
          const m = mine.axes[axis] || {};
          same(`${at}.stateSplit.${w}.${axis}.state`, m.state, a.state);
          same(`${at}.stateSplit.${w}.${axis}.reasonCode`, m.reasonCode, a.reasonCode);
          same(`${at}.stateSplit.${w}.${axis}.keys`, (m.cells || []).map((c) => c.key), (a.cells || []).map((c) => c.key));
          (a.cells || []).forEach((c, i) => {
            for (const f of CELL_FIELDS) same(`${at}.stateSplit.${w}.${axis}.${c.key}.${f}`, ((m.cells || [])[i] || {})[f], c[f]);
          });
        }
      }
      for (const tag of sbSplit.tags) {
        if (!tag.outcome) continue;
        const t = book.trades.find((x) => x.tradeId === String(tag.tradeId));
        same(`${at}.trade.${tag.tradeId}.pnl`, t ? t.pnl : null, tag.outcome.netPnl);
        same(`${at}.trade.${tag.tradeId}.rMultiple`, t ? t.rMultiple : null, tag.outcome.resultR);
        same(`${at}.trade.${tag.tradeId}.closedAt`, t ? t.exitAt : null, tag.outcome.closedAt);
      }
    }
    const mineRows = rows.filter((x) => block.rowIds.includes(x.rowId));
    if (!mineRows.length) continue;
    for (const w of WINDOWS) {
      if (r.windows[w].state !== 'MEASURED') continue;
      for (const f of SUM_FIELDS) {
        compared += 1;
        const total = mineRows.reduce((s, x) => s + (x.windows[w][f] || 0), 0);
        if (total !== r.windows[w][f]) differences.push({ path: `${at}.partition.${w}.${f}`, registry: total, scoreboard: r.windows[w][f] });
      }
    }
  }
  return { compared, differences };
}

/** 整本登记簿对它读过的那几份记分牌（`scoreboards` 按 ledgerId）。 */
function compareRegistry(registry, scoreboards) {
  const books = registry.books.map((b) => {
    const sb = scoreboards[b.ledgerId];
    if (!sb) return { ledgerId: b.ledgerId, compared: 0, differences: [{ path: b.ledgerId, registry: 'BOOK', scoreboard: null }] };
    return { ledgerId: b.ledgerId, scoreboardHash: sb.hash, ...compareBook(b, registry.rows.filter((r) => r.ledgerId === b.ledgerId), sb) };
  });
  return {
    contract: 'SIGNAL_REGISTRY_V1_SCOREBOARD_CONFORMANCE', registryHash: registry.hash,
    compared: books.reduce((s, b) => s + b.compared, 0), differences: books.reduce((s, b) => s + b.differences.length, 0), books,
  };
}

module.exports = { CELL_FIELDS, SPLIT_FIELDS, SUM_FIELDS, WINDOW_FIELDS, compareBook, compareRegistry };
