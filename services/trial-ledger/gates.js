'use strict';

/**
 * G-TRIAL-PRE、G-TRIAL-SEAL —— 研究框架修订（2026-11-10，过拟合控制）§2.4，接进海外与 A 股封存结论导入器（同一套 importVerdicts）。
 *
 * 只对本修订生效之后才冻结的 K2 生效（冻结页 1 补充第 4 条：11-11 之后冻结的研究规格）。之前冻结的题照原样导入，锁行逐字节不变。
 * 门只会拒绝导入（失败即关，错误码 TRIAL_LEDGER_*），从不改写结论：不把任何结论变成「不做」，也不替代、不跳过导入器已有的校验
 * （导入器先跑完原有校验，再跑这两道门）。
 *
 *   G-TRIAL-PRE（K2 冻结时）：K2 文本里写出的每个台账 id（TRL-<16 位>）都已有 PREREGISTERED 行，k2_sha256 等于这份 K2，
 *     登记时间不晚于 k2_frozen_at；本族在这份 K2 下的每个 PREREGISTERED 行也都写在 K2 里；K2 至少写出一个本族的 id。
 *   G-TRIAL-SEAL（封存导入时，RESULT / READING）：本族每个预登记行都有结果行；运行日志（entry.run_log，按 sha256 绑定，
 *     RESEARCH_RUN_LOG_V1）里本族的每个账本都有试验行；本族本题的 OVERFIT_DISCLOSURE_V1 已存在。
 */
const ledger = require('./index');

/** 冻结页 1 补充第 4 条：对 11-11 之后冻结的研究规格生效（取 2026-11-11 00:00 CST 起，含当天）。 */
const EFFECTIVE_FROM = '2026-11-11T00:00:00+08:00';
const EFFECTIVE_DATE = '2026-11-11';
const RUN_LOG_SCHEMA = 'RESEARCH_RUN_LOG_V1';
const ID_IN_TEXT = /TRL-[0-9a-f]{16}/g;

const { need } = ledger.internals;

/**
 * 这一题是否过两道门。
 * entry.k2_frozen_at（ISO 时间，带时区）≥ EFFECTIVE_FROM → 过门；封存日期在生效日及以后、却没写 k2_frozen_at 的 → 拒绝（判断不了，失败即关）。
 */
function applies(entry) {
  if (!entry.k2 || entry.kind === 'DRAFT') return { applies: false, reason: entry.k2 ? 'DRAFT_NOT_FROZEN' : 'NO_K2' };
  if (entry.k2_frozen_at !== undefined && entry.k2_frozen_at !== null) {
    const t = Date.parse(entry.k2_frozen_at);
    need(typeof entry.k2_frozen_at === 'string' && /[zZ]|[+-]\d{2}:\d{2}$/.test(entry.k2_frozen_at) && Number.isFinite(t), 'K2_FROZEN_AT_INVALID', `${entry.id}:${entry.k2_frozen_at}`);
    return { applies: t >= Date.parse(EFFECTIVE_FROM), reason: t >= Date.parse(EFFECTIVE_FROM) ? 'FROZEN_AFTER_AMENDMENT' : 'FROZEN_BEFORE_AMENDMENT' };
  }
  need(!(typeof entry.sealed_on === 'string' && entry.sealed_on >= EFFECTIVE_DATE), 'K2_FROZEN_AT_MISSING', entry.id);
  return { applies: false, reason: 'SEALED_BEFORE_AMENDMENT' };
}

function checkPre(entry, k2Bytes, rows) {
  const k2Sha = entry.k2.sha256;
  const named = [...new Set(k2Bytes.toString('utf8').match(ID_IN_TEXT) || [])];
  need(named.length, 'PRE_NO_TRIAL_ID_IN_K2', entry.id);
  const regs = rows.filter((r) => r.row_kind === 'REGISTRATION');
  const frozenAt = Date.parse(entry.k2_frozen_at);
  for (const id of named) {
    const reg = regs.find((r) => r.trial_id === id);
    need(reg, 'PRE_NOT_REGISTERED', `${entry.id}:${id}`);
    need(reg.registration_mode === 'PREREGISTERED', 'PRE_NOT_PREREGISTERED', `${entry.id}:${id}:${reg.registration_mode}`);
    need(reg.k2_sha256 === k2Sha, 'PRE_K2_SHA256_MISMATCH', `${entry.id}:${id}`);
    need(Date.parse(reg.registered_at) <= frozenAt, 'PRE_REGISTERED_AFTER_FREEZE', `${entry.id}:${id}:${reg.registered_at}`);
  }
  const mine = regs.filter((r) => r.family_id === entry.strategy_ref && r.k2_sha256 === k2Sha && r.registration_mode === 'PREREGISTERED');
  need(mine.length, 'PRE_NO_TRIAL_FOR_FAMILY', `${entry.id}:${entry.strategy_ref}`);
  for (const r of mine) need(named.includes(r.trial_id), 'PRE_TRIAL_NOT_NAMED_IN_K2', `${entry.id}:${r.trial_id}`);
  return mine.map((r) => r.trial_id).sort();
}

function parseRunLog(entry, bytes) {
  let doc;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { return need(false, 'SEAL_RUN_LOG_NOT_JSON', entry.id); }
  need(doc && doc.schema === RUN_LOG_SCHEMA && Array.isArray(doc.runs), 'SEAL_RUN_LOG_INVALID', entry.id);
  need(doc.k2_sha256 === entry.k2.sha256, 'SEAL_RUN_LOG_K2_MISMATCH', entry.id);
  for (const run of doc.runs) need(run && typeof run.family_id === 'string' && ledger.SHA64.test(run.rule_config_hash || ''), 'SEAL_RUN_LOG_ROW_INVALID', entry.id);
  return doc;
}

function checkSeal(entry, preIds, runLogBytes, rows) {
  const k2Sha = entry.k2.sha256;
  for (const id of preIds) need(rows.some((r) => r.trial_id === id && r.row_kind !== 'REGISTRATION'), 'SEAL_RESULT_MISSING', `${entry.id}:${id}`);
  need(runLogBytes, 'SEAL_RUN_LOG_MISSING', entry.id);
  const log = parseRunLog(entry, runLogBytes);
  const known = new Set(rows.filter((r) => r.family_id === entry.strategy_ref && r.k2_sha256 === k2Sha).map((r) => r.rule_config_hash));
  const runs = log.runs.filter((r) => r.family_id === entry.strategy_ref);
  for (const run of runs) need(known.has(run.rule_config_hash), 'SEAL_UNREGISTERED_RUN', `${entry.id}:${run.config_label || run.rule_config_hash.slice(0, 12)}`);
  const disclosure = ledger.disclosures({ family_id: entry.strategy_ref, k2_sha256: k2Sha });
  need(disclosure.length, 'SEAL_DISCLOSURE_MISSING', `${entry.id}:${entry.strategy_ref}`);
  return { runs: runs.length, disclosure_id: disclosure[disclosure.length - 1].disclosure_id, disclosure_hash: disclosure[disclosure.length - 1].record_hash };
}

/**
 * 导入器调用：已有校验全部通过之后。不过门的题返回 { applies: false }，导入器照原样写锁（不加任何字段）。
 * @param {object} entry  登记表一题
 * @param {{k2Bytes: () => Buffer, runLogBytes: () => Buffer|null}} files  按 sha256 复验后取 K2 与运行日志字节（只在过门时才读）
 */
function check(entry, { k2Bytes, runLogBytes = () => null }) {
  const scope = applies(entry);
  if (!scope.applies) return { applies: false, reason: scope.reason };
  const rows = ledger.trialRows();
  const preIds = checkPre(entry, k2Bytes(), rows);
  const sealing = entry.kind === 'RESULT' || entry.kind === 'READING';
  const seal = sealing ? checkSeal(entry, preIds, runLogBytes(), rows) : null;
  return { applies: true, effective_from: EFFECTIVE_FROM, k2_frozen_at: entry.k2_frozen_at, pre: 'PASS', seal: seal ? 'PASS' : 'NOT_A_SEAL', trial_ids: preIds, ...(seal ? { run_log_runs: seal.runs, disclosure_id: seal.disclosure_id, disclosure_hash: seal.disclosure_hash } : {}) };
}

module.exports = { EFFECTIVE_FROM, EFFECTIVE_DATE, RUN_LOG_SCHEMA, applies, check, internals: { checkPre, checkSeal, parseRunLog } };
