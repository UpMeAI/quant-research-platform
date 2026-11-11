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
 *   门的裁定（entry.trial_gates_ruling，导入规格修订 4）：一页按 sha256 绑定的协调会话裁定，只放行写明的偏差，事实不成立即关。
 *     PRE 记 DEVIATION_ACCEPTED（不记 PASS，也不记「不适用」），原因码只有 DEVIATION_CODES 两个；
 *     披露行的 DSR、PBO 可以是 NOT_APPLICABLE，但披露行必须引用同一页裁定。其余检查照旧。
 *   PRE_CONDITIONAL_ID_NOT_CHOSEN（导入规格修订 6，协调会话 11-12 裁定 52f4c897…）：K2 正文写了只在某个 ★ 备选下才登记的条件 id；
 *     只放行裁定逐个列出的 id，并机器核实 (i) 台账里该 id 没有任何行，(ii) 冻结页对那个 ★ 选的不是这个选项（冻结页按 sha256 复验后读）。
 */
const ledger = require('./index');

/** 冻结页 1 补充第 4 条：对 11-11 之后冻结的研究规格生效（取 2026-11-11 00:00 CST 起，含当天）。 */
const EFFECTIVE_FROM = '2026-11-11T00:00:00+08:00';
const EFFECTIVE_DATE = '2026-11-11';
const RUN_LOG_SCHEMA = 'RESEARCH_RUN_LOG_V1';
const ID_IN_TEXT = /TRL-[0-9a-f]{16}/g;
/** 裁定可接受的 G-TRIAL-PRE 偏差（凯利 m 前推门裁定 §1）。 */
const DEVIATION_CODES = Object.freeze(['PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN', 'PRE_NO_TRIAL_ID_IN_K2', 'PRE_CONDITIONAL_ID_NOT_CHOSEN']);
const CONDITIONAL = 'PRE_CONDITIONAL_ID_NOT_CHOSEN';
const TRIAL_ID_ONE = /^TRL-[0-9a-f]{16}$/;

/** 冻结页里每个 ★ 选了哪个选项：「★n → (x)」与「★a–★b → (x)」两种写法；同一个 ★ 读出两个选项即失败关闭。 */
function starChoices(text) {
  const chosen = new Map();
  const put = (n, x) => { need(!chosen.has(n) || chosen.get(n) === x, 'RULING_FACT_NOT_HOLD', `FREEZE_STAR_AMBIGUOUS:★${n}`); chosen.set(n, x); };
  for (const m of text.matchAll(/★(\d+)\s*[–-]\s*★(\d+)\s*→\s*\(([a-z])\)/g)) for (let n = Number(m[1]); n <= Number(m[2]); n += 1) put(n, m[3]);
  for (const m of text.matchAll(/★(\d+)\s*→\s*\(([a-z])\)/g)) put(Number(m[1]), m[2]);
  return chosen;
}

const { need } = ledger.internals;
const isoAt = (v) => typeof v === 'string' && /[zZ]|[+-]\d{2}:\d{2}$/.test(v) && Number.isFinite(Date.parse(v));

/**
 * 读门的裁定（没有时返回 null）。裁定页按 sha256 复验后，原文必须写出它放行的每个状态与原因码。
 * entry.trial_gates_ruling: { spec, pre?: { status: 'DEVIATION_ACCEPTED', codes[], preregistered_at, first_run_at }, disclosure_not_applicable?: ['dsr','pbo'] }
 */
function rulingOf(entry, rulingBytes) {
  const r = entry.trial_gates_ruling;
  if (r === undefined || r === null) return null;
  need(r.spec && ledger.SHA64.test(r.spec.sha256 || '') && (r.pre || r.disclosure_not_applicable), 'RULING_INVALID', entry.id);
  const pre = r.pre || null;
  if (pre) {
    need(pre.status === 'DEVIATION_ACCEPTED', 'RULING_PRE_STATUS_INVALID', `${entry.id}:${pre.status}`);
    need(Array.isArray(pre.codes) && pre.codes.length && pre.codes.every((c) => DEVIATION_CODES.includes(c)) && new Set(pre.codes).size === pre.codes.length, 'RULING_PRE_CODE_INVALID', entry.id);
    need(isoAt(pre.preregistered_at) && isoAt(pre.first_run_at), 'RULING_TIME_INVALID', entry.id);
    const cond = pre.conditional_ids;
    need(pre.codes.includes(CONDITIONAL) === (cond !== undefined), 'RULING_CONDITIONAL_IDS_INVALID', entry.id);
    if (cond !== undefined) need(Array.isArray(cond) && cond.length && cond.every((c) => c && TRIAL_ID_ONE.test(c.trial_id || '') && Number.isInteger(c.star) && c.star >= 1 && /^[a-z]$/.test(c.option || ''))
      && new Set(cond.map((c) => c.trial_id)).size === cond.length, 'RULING_CONDITIONAL_IDS_INVALID', entry.id);
  }
  const na = r.disclosure_not_applicable || null;
  if (na) need(Array.isArray(na) && [...na].sort().join(',') === ledger.NOT_APPLICABLE_FIELDS.join(','), 'RULING_DISCLOSURE_FIELDS_INVALID', entry.id);
  const bytes = rulingBytes();
  need(bytes, 'RULING_FILE_MISSING', entry.id);
  const text = bytes.toString('utf8');
  const condWords = pre && pre.conditional_ids ? pre.conditional_ids.flatMap((c) => [c.trial_id, `★${c.star} (${c.option})`]) : [];
  for (const word of [...(pre ? ['DEVIATION_ACCEPTED', ...pre.codes] : []), ...(na ? ['NOT_APPLICABLE'] : []), ...condWords]) need(text.includes(word), 'RULING_TEXT_DOES_NOT_STATE', `${entry.id}:${word}`);
  return { sha256: r.spec.sha256, ref: r.spec.ref, pre, disclosureNotApplicable: na };
}

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

function checkPre(entry, k2Bytes, rows, ruling = null, freezeBytes = () => null) {
  const k2Sha = entry.k2.sha256;
  const named = [...new Set(k2Bytes.toString('utf8').match(ID_IN_TEXT) || [])];
  const codes = ruling && ruling.pre ? ruling.pre.codes : [];
  const noIds = codes.includes('PRE_NO_TRIAL_ID_IN_K2');
  const lateOk = codes.includes('PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN');
  if (noIds) need(!named.length, 'RULING_FACT_NOT_HOLD', `${entry.id}:PRE_NO_TRIAL_ID_IN_K2`);
  else need(named.length, 'PRE_NO_TRIAL_ID_IN_K2', entry.id);
  // PRE_CONDITIONAL_ID_NOT_CHOSEN：裁定列出的条件 id 不要求登记，但两条事实都要在台账与冻结页里成立
  const cond = codes.includes(CONDITIONAL) ? ruling.pre.conditional_ids : [];
  if (cond.length) {
    const fb = freezeBytes();
    need(fb, 'RULING_FREEZE_MISSING', entry.id);
    const chosen = starChoices(fb.toString('utf8'));
    for (const c of cond) {
      need(named.includes(c.trial_id), 'RULING_FACT_NOT_HOLD', `${entry.id}:${c.trial_id}:NOT_IN_K2`);
      need(!rows.some((r) => r.trial_id === c.trial_id), 'RULING_FACT_NOT_HOLD', `${entry.id}:${c.trial_id}:HAS_ROWS`);
      need(chosen.has(c.star), 'RULING_FACT_NOT_HOLD', `${entry.id}:★${c.star}:NOT_RULED_IN_FREEZE`);
      need(chosen.get(c.star) !== c.option, 'RULING_FACT_NOT_HOLD', `${entry.id}:★${c.star} (${c.option}):CHOSEN_IN_FREEZE`);
    }
  }
  const condIds = new Set(cond.map((c) => c.trial_id));
  const regs = rows.filter((r) => r.row_kind === 'REGISTRATION');
  const frozenAt = Date.parse(entry.k2_frozen_at);
  const firstRunAt = lateOk ? Date.parse(ruling.pre.first_run_at) : null;
  let late = 0;
  const onTime = (reg) => {
    if (Date.parse(reg.registered_at) <= frozenAt) return;
    need(lateOk, 'PRE_REGISTERED_AFTER_FREEZE', `${entry.id}:${reg.trial_id}:${reg.registered_at}`);
    need(Date.parse(reg.registered_at) <= firstRunAt, 'PRE_REGISTERED_AFTER_FIRST_RUN', `${entry.id}:${reg.trial_id}:${reg.registered_at}`);
    late += 1;
  };
  for (const id of named) {
    if (condIds.has(id)) continue;
    const reg = regs.find((r) => r.trial_id === id);
    need(reg, 'PRE_NOT_REGISTERED', `${entry.id}:${id}`);
    need(reg.registration_mode === 'PREREGISTERED', 'PRE_NOT_PREREGISTERED', `${entry.id}:${id}:${reg.registration_mode}`);
    need(reg.k2_sha256 === k2Sha, 'PRE_K2_SHA256_MISMATCH', `${entry.id}:${id}`);
    onTime(reg);
  }
  const mine = regs.filter((r) => r.family_id === entry.strategy_ref && r.k2_sha256 === k2Sha && r.registration_mode === 'PREREGISTERED');
  need(mine.length, 'PRE_NO_TRIAL_FOR_FAMILY', `${entry.id}:${entry.strategy_ref}`);
  if (noIds) for (const r of mine) onTime(r);
  else for (const r of mine) need(named.includes(r.trial_id), 'PRE_TRIAL_NOT_NAMED_IN_K2', `${entry.id}:${r.trial_id}`);
  const ids = mine.map((r) => r.trial_id).sort();
  if (!ruling || !ruling.pre) return { state: 'PASS', ids };
  // 裁定写的每个原因码都要在台账里成立：写了「冻结后登记」就得真有晚于冻结的行；登记时刻与裁定一致
  if (lateOk) need(late > 0, 'RULING_FACT_NOT_HOLD', `${entry.id}:PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN`);
  const lastAt = mine.map((r) => r.registered_at).sort((a, b) => Date.parse(a) - Date.parse(b)).pop();
  need(Date.parse(lastAt) === Date.parse(ruling.pre.preregistered_at), 'RULING_FACT_NOT_HOLD', `${entry.id}:preregistered_at:${lastAt}`);
  return { state: 'DEVIATION_ACCEPTED', ids,
    deviation: { codes: [...codes], k2_frozen_at: entry.k2_frozen_at, preregistered_at: ruling.pre.preregistered_at, first_run_at: ruling.pre.first_run_at, late_registrations: late,
      ...(cond.length ? { conditional_ids: cond.map((c) => ({ trial_id: c.trial_id, star: c.star, option: c.option })) } : {}) } };
}

function parseRunLog(entry, bytes) {
  let doc;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch { return need(false, 'SEAL_RUN_LOG_NOT_JSON', entry.id); }
  need(doc && doc.schema === RUN_LOG_SCHEMA && Array.isArray(doc.runs), 'SEAL_RUN_LOG_INVALID', entry.id);
  need(doc.k2_sha256 === entry.k2.sha256, 'SEAL_RUN_LOG_K2_MISMATCH', entry.id);
  for (const run of doc.runs) need(run && typeof run.family_id === 'string' && ledger.SHA64.test(run.rule_config_hash || ''), 'SEAL_RUN_LOG_ROW_INVALID', entry.id);
  return doc;
}

function checkSeal(entry, preIds, runLogBytes, rows, ruling = null) {
  const k2Sha = entry.k2.sha256;
  for (const id of preIds) need(rows.some((r) => r.trial_id === id && r.row_kind !== 'REGISTRATION'), 'SEAL_RESULT_MISSING', `${entry.id}:${id}`);
  need(runLogBytes, 'SEAL_RUN_LOG_MISSING', entry.id);
  const log = parseRunLog(entry, runLogBytes);
  // 裁定写的首次计算时刻与运行日志一致（日志写了时才比）
  if (ruling && ruling.pre && log.first_run_at !== undefined) need(Date.parse(log.first_run_at) === Date.parse(ruling.pre.first_run_at), 'RULING_FACT_NOT_HOLD', `${entry.id}:first_run_at:${log.first_run_at}`);
  const known = new Set(rows.filter((r) => r.family_id === entry.strategy_ref && r.k2_sha256 === k2Sha).map((r) => r.rule_config_hash));
  const runs = log.runs.filter((r) => r.family_id === entry.strategy_ref);
  for (const run of runs) need(known.has(run.rule_config_hash), 'SEAL_UNREGISTERED_RUN', `${entry.id}:${run.config_label || run.rule_config_hash.slice(0, 12)}`);
  const disclosure = ledger.disclosures({ family_id: entry.strategy_ref, k2_sha256: k2Sha });
  need(disclosure.length, 'SEAL_DISCLOSURE_MISSING', `${entry.id}:${entry.strategy_ref}`);
  const head = disclosure[disclosure.length - 1];
  // DSR「不适用」只能出自裁定：披露行引用的裁定页就是这一题绑定的那一页
  const notApplicable = head.dsr === 'NOT_APPLICABLE';
  if (notApplicable) {
    need(ruling && ruling.disclosureNotApplicable, 'SEAL_DISCLOSURE_NOT_APPLICABLE_WITHOUT_RULING', `${entry.id}:${head.disclosure_id}`);
    const cited = head.inputs && head.inputs.not_applicable;
    need(cited && cited.ruling_sha256 === ruling.sha256, 'SEAL_DISCLOSURE_RULING_MISMATCH', `${entry.id}:${head.disclosure_id}`);
  }
  return { runs: runs.length, disclosure_id: head.disclosure_id, disclosure_hash: head.record_hash, notApplicable };
}

/**
 * 导入器调用：已有校验全部通过之后。不过门的题返回 { applies: false }，导入器照原样写锁（不加任何字段）。
 * @param {object} entry  登记表一题
 * @param {{k2Bytes: () => Buffer, runLogBytes: () => Buffer|null, rulingBytes: () => Buffer|null, freezeBytes: () => Buffer|null}} files  按 sha256 复验后取 K2、运行日志、门的裁定与冻结页字节（只在过门时才读；冻结页只在有条件 id 时读）
 */
function check(entry, { k2Bytes, runLogBytes = () => null, rulingBytes = () => null, freezeBytes = () => null }) {
  const scope = applies(entry);
  if (!scope.applies) {
    need(!entry.trial_gates_ruling, 'RULING_ON_UNGATED_ENTRY', entry.id);
    return { applies: false, reason: scope.reason };
  }
  const ruling = rulingOf(entry, rulingBytes);
  const rows = ledger.trialRows();
  const pre = checkPre(entry, k2Bytes(), rows, ruling, freezeBytes);
  const sealing = entry.kind === 'RESULT' || entry.kind === 'READING';
  const seal = sealing ? checkSeal(entry, pre.ids, runLogBytes(), rows, ruling) : null;
  return { applies: true, effective_from: EFFECTIVE_FROM, k2_frozen_at: entry.k2_frozen_at, pre: pre.state, seal: seal ? 'PASS' : 'NOT_A_SEAL', trial_ids: pre.ids,
    ...(pre.deviation ? { pre_deviation: pre.deviation } : {}),
    ...(seal ? { run_log_runs: seal.runs, disclosure_id: seal.disclosure_id, disclosure_hash: seal.disclosure_hash } : {}),
    ...(seal && seal.notApplicable ? { disclosure_not_applicable: [...ledger.NOT_APPLICABLE_FIELDS] } : {}),
    ...(ruling ? { ruling_ref: ruling.ref, ruling_sha256: ruling.sha256 } : {}) };
}

module.exports = { EFFECTIVE_FROM, EFFECTIVE_DATE, RUN_LOG_SCHEMA, DEVIATION_CODES, applies, check, internals: { checkPre, checkSeal, parseRunLog, rulingOf, starChoices } };
