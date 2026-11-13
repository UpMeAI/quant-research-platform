'use strict';

/**
 * 回程文件的可选块 sealedVerdicts[]（desk 复盘闭环修订 8，FREEZE_1 sha256 154a829a…）：两本封存结论台账的投影，不带新的判断。
 * 这些行是研究结论，不是 Owner 的决定（§2）：不写采用记录，不进「等你决定」；「不做」只来自封存结果本身，INSUFFICIENT 不写成拒绝。
 * 只收 RESULT（§3）：前向影子（STATUS）、只报读数（READING）、草稿不进这一块。每行现场复验封存文件的 sha256，不符就拒绝导出。
 * 默认关闭：desk 上线之前不得导出这一块（§5），开关见 return.js。
 */
const overseas = require('../overseas-sealed-verdicts');
const ashare = require('../ashare-sealed-verdicts');
const routing = require('./index');

const STORES = Object.freeze([
  Object.freeze({ market: null, store: overseas.STORE, entries: overseas.ENTRIES, locks: () => overseas.locks() }),
  Object.freeze({ market: 'CN', store: ashare.STORE, entries: ashare.ENTRIES, locks: () => ashare.locks() }),
]);
const LEDGERS = Object.freeze(['research/overseas_sealed_verdicts.jsonl', 'research/ashare_sealed_verdicts.jsonl']);
const MARKET_OF = Object.freeze({ C17_V2_4000USDT: 'CRYPTO', QUICK_SHOT_V3_1000USDT: 'CRYPTO', US_V5_ETF_3000USD: 'US', US_CORE_9000USD_3X_GATEOBS: 'US' });

/** 修订 8 §4 的裁定：UC-X08 的 V1、V2_SPMO 记「做」，verdictState 写未判定（转前向）；V2_SPY「不做」；两条 V3 仍未判定，不进这一块。 */
const UNDECIDED_ZH = '未判定（转前向）';
const X08_LINES = Object.freeze({ V1: Object.freeze({ action: 'UNDECIDED', verdict: '做', state: UNDECIDED_ZH }), V2_SPMO: Object.freeze({ action: 'UNDECIDED', verdict: '做', state: UNDECIDED_ZH }),
  V2_SPY: Object.freeze({ action: '不做', verdict: '不做', state: null }) });

class SealedReturnError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new SealedReturnError(code, detail); };

/** 文件里的结论词 → 做 / 不做。「不做（无候选）」这类带限定语的只取结论词，限定语留在 verdictState。 */
function verdictWord(raw, id) {
  if (typeof raw === 'string' && raw.startsWith('不做')) return '不做';
  if (typeof raw === 'string' && raw.startsWith('做')) return '做';
  return fail('RETURN_SEALED_VERDICT_NOT_DO_OR_DONT', `${id}:${raw}`);
}

/**
 * 研究原始状态：登记的 read.state；否则结论词之外的统计态（如 INSUFFICIENT）；否则文件写的证据强度；
 * 都没有时用登记的 state_zh（导入规格修订 4：结果文件对「通过」的对象不写状态字，登记表写冻结 K2 判定表的原词）。
 */
function stateOf({ state, verdict }, id, stateZh = null) {
  const raw = verdict.raw;
  const value = state || (raw && !/^(做|不做)$/.test(raw) ? raw : verdict.strength) || stateZh;
  return value || fail('RETURN_SEALED_STATE_MISSING', id);
}

function resultFileOf(spec) {
  return spec.source === 'coordinator' ? `artifacts/coordinator/${spec.path}` : `${spec.source === 'smartflow' ? 'smartflow' : 'Ashare-V6'}:${spec.path}`;
}

function rowsOf({ entry, lock, read, market, deskLink }) {
  const base = { market, book: lock.strategy_ref, resultFile: resultFileOf(entry.file), sha256: lock.file_sha256, commit: entry.file.commit || null, sealedAt: lock.sealed_on,
    origin: deskLink ? 'REVIEW_CANDIDATE' : 'QRP_PROGRAM', deskLink };
  if (entry.read.final) {
    if (entry.id !== 'UC-X08') fail('RETURN_SEALED_LINES_NOT_RULED', entry.id);
    const final = read.doc[entry.read.final];
    return Object.entries(X08_LINES).map(([line, rule]) => {
      if (!final[line] || final[line].action !== rule.action) fail('RETURN_SEALED_LINE_NOT_AS_RULED', `${entry.id}:${line}`);
      return { id: `${lock.result_id}:${line}`, ...base, verdict: rule.verdict, verdictState: rule.state || final[line].verdict };
    });
  }
  return [{ id: lock.result_id, ...base, verdict: verdictWord(read.verdict.decision, entry.id), verdictState: stateOf(read, entry.id, entry.state_zh || null) }];
}

/** 这个结果当前的 desk 回链（result_hash = 文件 sha256，或 result_ref = QRP:<result_id>:LOCKED）。没有就是 null，不编造。 */
function deskLinkOf(links, lock) {
  const ref = `QRP:${lock.result_id}:LOCKED`;
  const found = links.filter((link) => link.result_hash === lock.file_sha256 || link.result_ref === ref).map((link) => routing.deskOriginOf(link)).filter(Boolean)
    .sort((a, b) => (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0))[0];
  return found ? { candidateId: found.candidateId, questionKey: found.questionKey, linkId: found.linkId } : null;
}

/** 每题当前的锁按登记表顺序投影成行；登记表里没有的锁、复验不过的文件一律拒绝。 */
function sealedRows({ links = [], stores = STORES } = {}) {
  const rows = [];
  for (const { market, store, entries, locks } of stores) {
    const heads = new Map();
    for (const lock of locks()) heads.set(lock.entry_id, lock);
    for (const entryId of heads.keys()) if (!entries.some((entry) => entry.id === entryId)) fail('RETURN_SEALED_ENTRY_NOT_REGISTERED', entryId);
    for (const entry of entries) {
      const lock = heads.get(entry.id);
      if (!lock || entry.kind !== 'RESULT' || lock.kind !== 'RESULT') continue;
      const rowMarket = market || MARKET_OF[lock.strategy_ref] || fail('RETURN_SEALED_MARKET_UNKNOWN', lock.strategy_ref);
      rows.push(...rowsOf({ entry, lock, read: overseas.verifiedVerdict(entry, lock, store), market: rowMarket, deskLink: deskLinkOf(links, lock) }));
    }
  }
  return rows;
}

/** 登记为 RESULT 而台账里还没有锁的题（导出摘要用，不进回程文件）。 */
function notImported({ stores = STORES } = {}) {
  return stores.flatMap(({ entries, locks }) => {
    const locked = new Set(locks().filter((lock) => lock.kind === 'RESULT').map((lock) => lock.entry_id));
    return entries.filter((entry) => entry.kind === 'RESULT' && !locked.has(entry.id)).map((entry) => entry.id);
  });
}

module.exports = { STORES, LEDGERS, SealedReturnError, UNDECIDED_ZH, X08_LINES, notImported, sealedRows, verdictWord };
