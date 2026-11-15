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

/**
 * W46 L6 的裁定（协调会话 2026-11-15 17:51 CST，queue.log「W46 L6_WORDING_RULING」，按上面 X08 的先例）：R_US_ETF_1 四个单元的
 * verdictState 写结论词＋证据强度标签（K2 §5.2：区间跨 0 的写「点估计，区间跨 0」），不引封存原文里「方向判对的概率」那半句：
 * desk 的 L6 拒收预测用词（portfolio-desk src/decision-contracts.js PREDICTIVE_TERMS），整周停在 LOOP_CHECK。
 * 封存文件不动：原文仍在行的 resultFile（sha256 不变）里 verdict_detail.<detail>.evidence_strength_zh。导出时现场核对裁定与
 * 封存文件一致（单元 id、结论词、95% 区间是否跨 0、登记的读取路径），不符就拒绝导出，不回退到原文。
 */
const RUE1_RULED = Object.freeze({
  'UC-RUE1-SPY': Object.freeze({ detail: 0, unit: 'UC-SPY', verdict: '不做', crossesZero: false }),
  'UC-RUE1-QQQ': Object.freeze({ detail: 1, unit: 'UC-QQQ', verdict: '不做', crossesZero: false }),
  'US5-RUE1-VOO': Object.freeze({ detail: 4, unit: 'V5-VOO', verdict: '做', crossesZero: true }),
  'US5-RUE1-SPMO': Object.freeze({ detail: 5, unit: 'V5-SPMO', verdict: '做', crossesZero: false }),
});
const STRENGTH_LABEL_ZH = Object.freeze({ CROSSES_ZERO: '点估计，区间跨 0', CLEAR_OF_ZERO: '95% 区间不跨 0' });
const ruledStateText = (rule) => `${rule.verdict}（${rule.crossesZero ? STRENGTH_LABEL_ZH.CROSSES_ZERO : STRENGTH_LABEL_ZH.CLEAR_OF_ZERO}）`;

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

/** RUE1_RULED 的一行，对着封存文件现场核对；一处不符就拒绝（RETURN_SEALED_STATE_NOT_AS_RULED）。 */
function ruledState(entry, read) {
  const rule = RUE1_RULED[entry.id];
  const at = `verdict_detail.${rule.detail}`;
  const unit = read.doc && Array.isArray(read.doc.verdict_detail) ? read.doc.verdict_detail[rule.detail] : null;
  const ci = unit && Array.isArray(unit.ci95) && unit.ci95.length === 2 && unit.ci95.every(Number.isFinite) ? unit.ci95 : null;
  const holds = entry.read.decision === `${at}.decision` && entry.read.strength === `${at}.evidence_strength_zh`
    && unit !== null && unit.id === rule.unit && unit.decision === rule.verdict && ci !== null && (ci[0] <= 0 && ci[1] >= 0) === rule.crossesZero;
  return holds ? ruledStateText(rule) : fail('RETURN_SEALED_STATE_NOT_AS_RULED', entry.id);
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
  const verdictState = Object.hasOwn(RUE1_RULED, entry.id) ? ruledState(entry, read) : stateOf(read, entry.id, entry.state_zh || null);
  return [{ id: lock.result_id, ...base, verdict: verdictWord(read.verdict.decision, entry.id), verdictState }];
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

module.exports = { LEDGERS, RUE1_RULED, SealedReturnError, UNDECIDED_ZH, X08_LINES, notImported, ruledStateText, sealedRows, verdictWord };
