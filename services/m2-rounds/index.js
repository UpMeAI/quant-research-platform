'use strict';

/**
 * 加密 M2 轮次结果（CRYPTO_Q0_RESULT_V1 导入规格增补 2，协调冻结裁定 LOOP_AND_IMPORT_DRAFTS_20261027_FREEZE_1 R2，D1–D8 全部 ★）。
 *
 * 一条策略每一轮一把锁 `M2_ROUND_LOCK_V1`（账本 var/ledger/research/m2_round_evaluations.jsonl）：按 sha256 绑定这一轮的
 * 封存文件、冻结的 K2 与冻结裁定。页面从锁读出四样东西——缺口分解行、组合候选、前向影子计划、成本题。
 *
 * 这一轮没有结论：K2 写明结论只来自前向查看，只有「做 / 不做」。所以轮次锁不是候选对比锁（没有三态、不进采用一览、
 * 不算「待 Owner 决定」），页面也不用「证据不足」形容这一轮。
 *
 * 不重算：页面上的每个数字都是文件里已报的数字，只做四舍五入与正负号排版。K2 里写成文字、文件里没有的东西（规则原文、
 * 判据原文、各分量的「处理」原话）登记在策略档案的 `m2_rounds`，导入器核对 K2 的 sha256（D2 ★）。
 * 「前向影子运行中」只来自 HK 前向登记（config/hk_forward_observations.v1.json，D6 ★）；前向的任何数字在查看结果封存导入之前都不读。
 * 没有 HTTP 写入口，不写生产参数、HK 或 smartflow。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, dataDir, now, append, read } = require('../../packages/ledger');
const profiles = require('../strategy-profiles');
const baselineEvaluation = require('../baseline-evaluation');
const hkForward = require('../hk-forward-observations');

const LOCK_SCHEMA = 'M2_ROUND_LOCK_V1';
const IMPORT_PROFILE_ID = 'docs/contracts/CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE_ADDENDUM_2.md';
const LEDGER = () => path.join(dataDir('research'), 'm2_round_evaluations.jsonl');
const NON_ACTUAL_PATH = /(^|[\\/._-])(fixture|demo|mock|synthetic)([\\/._-]|$)/i;
const SHA64 = /^[0-9a-f]{64}$/;
const ID_ROLES = Object.freeze(['DECOMPOSITION', 'RESULT']);
const ADOPTION_RULE_ZH = '只有做 / 不做，没有「证据不足」中间态；任何采用都须 Owner 签字。';

class M2RoundError extends Error {
  constructor(code, detail) { super(detail ? `${code}:${detail}` : code); this.code = code; this.detail = detail || null; }
}
const fail = (code, detail) => { throw new M2RoundError(code, detail); };
const need = (condition, code, detail) => { if (!condition) fail(code, detail); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => JSON.stringify(value);
const atPath = (doc, dotted) => String(dotted).split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), doc);

// ── 数字排版（只排版，不重算）────────────────────────────────────────────────────

const minus = (value) => (value < 0 ? '−' : '');
const signed = (value, digits = 3) => `${value > 0 ? '+' : minus(value)}${Math.abs(value).toFixed(digits)}`;
const ciText = (pair, digits = 3) => `[${signed(pair[0], digits)}, ${signed(pair[1], digits)}]`;
const whole = (value) => `${minus(value)}${Math.round(Math.abs(value)).toLocaleString('en-US')}`;
const pct1 = (value) => `${(value * 100).toFixed(1)}%`;
/** 概率：< 10% 两位小数，其余一位（5.65%、0.09%、38.9%）。 */
const prob = (value) => `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`;
const straddles = (pair) => Array.isArray(pair) && pair.length === 2 && finite(pair[0]) && finite(pair[1]) && pair[0] < 0 && pair[1] > 0;
const ciOf = (pair, where) => { need(Array.isArray(pair) && pair.length === 2 && pair.every(finite), 'M2_ROUND_FILE_FIELD', where); return pair; };
const num = (value, where) => { need(finite(value), 'M2_ROUND_FILE_FIELD', where); return value; };

// ── 档案与锁 ────────────────────────────────────────────────────────────────────

/** 档案登记的轮次（D2 ★：文字与 sha256 都在档案里）。 */
const roundsOf = (profile) => (profile && Array.isArray(profile.m2_rounds) ? profile.m2_rounds : []);
const specOf = (profile, round) => roundsOf(profile).find((item) => item.round === round) || null;
const idFileOf = (spec) => spec.files.find((file) => ID_ROLES.includes(file.role));

function authority(registeredBy) {
  need(registeredBy, 'M2_ROUND_REGISTERED_BY_REQUIRED');
  const expected = process.env.QRP_PRODUCT_MILESTONE_AUTHORITY;
  need(expected, 'M2_ROUND_AUTHORITY_NOT_CONFIGURED');
  need(registeredBy === expected, 'M2_ROUND_REGISTERED_BY_NOT_AUTHORIZED');
}

function locks(strategyRef = null) {
  return read(LEDGER()).filter((row) => row.schema === LOCK_SCHEMA && (!strategyRef || row.strategy_ref === strategyRef));
}
function headLock(strategyRef, round) {
  const rows = locks(strategyRef).filter((row) => row.round === round);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * 读一个角色文件：存在、sha256 等于档案登记；旁边有 `.sha256` 时内容也必须一致。JSON 文件解析出来。
 * 读不到 → M2_ROUND_FILE_MISSING；不符 → M2_ROUND_FILE_SHA_MISMATCH（锁之后读到的不符同码，页面写校验未通过）。
 */
function readRoleFile(file, expected, { allowNonActual = false } = {}) {
  need(path.isAbsolute(file), 'M2_ROUND_PATH_MUST_BE_ABSOLUTE', file);
  let real;
  try { real = fs.realpathSync(file); } catch { fail('M2_ROUND_FILE_MISSING', `${expected.role}:${expected.name}`); }
  if (!allowNonActual) need(!NON_ACTUAL_PATH.test(real), 'M2_ROUND_NON_ACTUAL_SOURCE', real);
  const bytes = fs.readFileSync(real);
  const actual = sha256(bytes);
  need(actual === expected.sha256, 'M2_ROUND_FILE_SHA_MISMATCH', `${expected.role}:${expected.name}:${expected.sha256.slice(0, 12)}…≠${actual.slice(0, 12)}…`);
  let sidecar = null;
  try { sidecar = /^([0-9a-f]{64})\b/.exec(fs.readFileSync(`${real}.sha256`, 'utf8').trim()); } catch { sidecar = null; }
  if (sidecar !== null || fs.existsSync(`${real}.sha256`)) need(sidecar && sidecar[1] === actual, 'M2_ROUND_FILE_SHA_MISMATCH', `${expected.role}:${expected.name}.sha256`);
  let doc = null;
  if (/\.json$/i.test(real)) {
    try { doc = JSON.parse(bytes.toString('utf8')); } catch { fail('M2_ROUND_FILE_NOT_JSON', `${expected.role}:${expected.name}`); }
    need(isObject(doc), 'M2_ROUND_FILE_NOT_JSON', `${expected.role}:${expected.name}`);
  }
  const stat = fs.statSync(real);
  return { role: expected.role, name: expected.name, path: real, sha256: actual, size: bytes.length, mtimeMs: stat.mtimeMs, doc };
}

/** 角色 → 文件（同一角色可有多份，例如两份冻结裁定）；JSON 角色给出解析后的文档。 */
function readFiles(spec, pathOf, options) {
  const files = spec.files.map((expected) => readRoleFile(pathOf(expected), expected, options));
  const docs = {};
  for (const file of files) if (file.doc && docs[file.role] === undefined) docs[file.role] = file.doc;
  return { files, docs };
}

// ── 读法（档案 `reading` 键选择；两条策略各有自己的文件形状）──────────────────────────

const segWords = (profile) => ({ OOS: profile.segment_words.OOS || '样本外', IS: profile.segment_words.IS || '开发期' });
const marketLabel = (profile) => profiles.comparator(profile, 'MARKET').label_zh;

function gapLine(profile, spec, rows) {
  const w = segWords(profile);
  const part = (seg) => `${signed(seg.value)} ${ciText(seg.ci)}，检出下限 ${seg.mde.toFixed(2)}`;
  return `缺口：${w.OOS} g(当前 D) − g(${marketLabel(profile)}) = ${part(rows.OOS)}；${w.IS} ${part(rows.IS)}。${spec.decomposition.gap_note_zh}`;
}

/** Δg 一格：反事实账本 g 为 null（账户跌穿 0）时写原因，不显示文件里的 Δg（冻结裁定 3 F3）。 */
function deltaCell({ g, endCapital, dg, ci, suffix }, where) {
  if (g === null) return `账户跌穿 0（期末 ${whole(num(endCapital, `${where}.end_capital`))}），g 无定义${suffix}`;
  return `${signed(num(dg, `${where}.delta_g`))} ${ciText(ciOf(ci, `${where}.delta_g_ci`))}${suffix}`;
}

/** C17 停止事件后缀：按出现顺序分组，规则词取档案 q0_reading.halt_events.rule_words 冒号前的短名（「Rule 1」）。 */
function c17HaltSuffix(profile, component, where) {
  const events = (component.halt_events && component.halt_events.events) || [];
  need(Array.isArray(events), 'M2_ROUND_FILE_FIELD', `${where}.halt_events.events`);
  if (!events.length) return '';
  const words = (profile.q0_reading && profile.q0_reading.halt_events && profile.q0_reading.halt_events.rule_words) || {};
  const groups = new Map();
  for (const event of events) {
    const word = words[event.rule];
    need(word, 'M2_ROUND_HALT_RULE_UNKNOWN', `${where}:${event.rule}`);
    const short = word.split('：')[0];
    if (!groups.has(short)) groups.set(short, []);
    groups.get(short).push(event.period_to);
  }
  return `（${[...groups].map(([short, dates]) => `${short} 停止 ${dates.join('、')}`).join('；')}）`;
}

function readC17(profile, spec, docs, baselineLock) {
  const gap = docs.DECOMPOSITION;
  const cand = docs.CANDIDATE;
  need(gap && gap.kind === 'C17_V2_M2_ROUND1_GAP_DECOMPOSITION_V1' && gap.smoke === false, 'M2_ROUND_FILE_KIND', 'DECOMPOSITION');
  need(cand && cand.kind === 'C17_V2_M2_ROUND1_CANDIDATE_V1' && cand.smoke === false, 'M2_ROUND_FILE_KIND', 'CANDIDATE');
  const w = segWords(profile);
  const seg = (key) => {
    const s = gap.segments && gap.segments[key];
    need(isObject(s) && Array.isArray(s.components), 'M2_ROUND_FILE_FIELD', `segments.${key}`);
    return s;
  };
  const OOS = seg('OOS'); const IS = seg('IS');
  const gapRows = Object.fromEntries([['OOS', OOS], ['IS', IS]].map(([key, s]) => [key, {
    value: num(s.gap_g, `segments.${key}.gap_g`), ci: ciOf(s.gap_g_ci, `segments.${key}.gap_g_ci`), mde: num(s.mde80_gap_g, `segments.${key}.mde80_gap_g`),
  }]));

  // 入选：候选规则登记的 spec 开关必须在候选回放的 spec 里打开，spec 里打开的规则开关也必须都登记（§3.3）
  const candSpec = cand.spec;
  need(isObject(candSpec), 'M2_ROUND_FILE_FIELD', 'CANDIDATE.spec');
  const opened = new Set([
    ...(candSpec.majorsOnly === true ? ['majorsOnly'] : []),
    ...Object.entries(isObject(candSpec.research) ? candSpec.research : {}).filter(([, value]) => value === true).map(([key]) => `research.${key}`),
  ]);
  const registered = new Set(spec.candidate.rules.map((rule) => rule.spec_flag));
  need(opened.size === registered.size && [...opened].every((flag) => registered.has(flag)), 'M2_ROUND_SELECTION_MISMATCH', `spec:${[...opened].join(',')}≠档案:${[...registered].join(',')}`);
  const enteredBy = new Map(spec.candidate.rules.filter((rule) => rule.component).map((rule) => [rule.component, rule]));

  const isById = new Map(IS.components.map((item) => [item.id, item]));
  need(OOS.components.length === IS.components.length && OOS.components.every((item) => isById.has(item.id)), 'M2_ROUND_FILE_FIELD', 'segments.*.components 两段的分量不一致');
  const components = OOS.components.map((oos) => {
    const words = spec.components[oos.id];
    need(isObject(words), 'M2_ROUND_COMPONENT_NOT_REGISTERED', oos.id);
    const is = isById.get(oos.id);
    const rule = enteredBy.get(oos.id);
    if (rule) {
      // 入选分量的研究选项就是规则开关（例：upPhaseShortBlock）
      const flag = rule.spec_flag.replace(/^research\./, '');
      need(isObject(oos.research_options) && oos.research_options[flag] === true, 'M2_ROUND_SELECTION_MISMATCH', `${oos.id}.research_options.${flag}`);
    }
    const cell = (part, key) => deltaCell({
      g: part.summary ? part.summary.g : undefined, endCapital: part.summary && part.summary.end_capital, dg: part.delta_g, ci: part.delta_g_ci,
      suffix: c17HaltSuffix(profile, part, `segments.${key}.${oos.id}`),
    }, `segments.${key}.${oos.id}`);
    need(isObject(oos.summary) && isObject(is.summary), 'M2_ROUND_FILE_FIELD', `${oos.id}.summary`);
    return {
      id: oos.id, label_zh: words.label_zh, entered: Boolean(rule),
      oos_zh: cell(oos, 'OOS'), mde_zh: num(oos.mde80_delta_g, `segments.OOS.${oos.id}.mde80_delta_g`).toFixed(2), is_zh: cell(is, 'IS'),
      treatment_zh: rule ? `入选（${rule.id}）` : (words.treatment_zh || '未入选'),
      dg: { OOS: oos.summary.g === null ? null : oos.delta_g, IS: is.summary.g === null ? null : is.delta_g },
    };
  });
  for (const rule of enteredBy.values()) need(components.some((item) => item.id === rule.component), 'M2_ROUND_SELECTION_MISMATCH', `${rule.id}:${rule.component}`);

  const flat = (s, key) => {
    const f = s.exposure && s.exposure.FLAT;
    need(isObject(f), 'M2_ROUND_FILE_FIELD', `segments.${key}.exposure.FLAT`);
    return { share: num(f.share_of_hours, `${key}.FLAT.share_of_hours`), btc: num(f.btc_log_return_per_year, `${key}.FLAT.btc`), ci: ciOf(f.ci, `${key}.FLAT.ci`) };
  };
  const fo = flat(OOS, 'OOS'); const fi = flat(IS, 'IS');
  const exposureNote = `不在场（描述，不进候选）：${w.OOS} ${pct1(fo.share)} 的小时空仓，这些小时里 BTC 年化对数收益 ${signed(fo.btc)} ${ciText(fo.ci)}；${w.IS} ${pct1(fi.share)}，${signed(fi.btc)} ${ciText(fi.ci)}。`;

  // 候选已见数据（§4.2）：窗口与档案登记的行一致，全账本窗口必须是补充、不进结论
  const floor = profile.floor.value.toLocaleString('en-US');
  const sourceOf = (row) => {
    if (row.segment === 'FULL_BOOK') {
      const full = cand.full_book;
      need(isObject(full) && full.status === 'SUPPLEMENTARY_NOT_IN_CONCLUSION', 'M2_ROUND_FILE_FIELD', 'full_book.status');
      return { where: 'full_book', s: full, base: full.baseline_full_book };
    }
    const s = cand.segments && cand.segments[row.segment];
    need(isObject(s), 'M2_ROUND_FILE_FIELD', `segments.${row.segment}`);
    return { where: `segments.${row.segment}`, s, base: s.baseline_v2 };
  };
  const candRows = spec.candidate.rows.map((row) => {
    const { where, s, base } = sourceOf(row);
    if (row.window) need(isObject(s.window) && s.window.start === row.window[0] && s.window.end === row.window[1], 'M2_ROUND_WORDS_CONTRADICT_FILE', `${where}.window`);
    const c = s.candidate;
    need(isObject(c) && isObject(base) && isObject(s.path), 'M2_ROUND_FILE_FIELD', where);
    const dg = num(s.delta_g_vs_baseline, `${where}.delta_g_vs_baseline`);
    const ci = ciOf(s.delta_g_vs_baseline_ci, `${where}.delta_g_vs_baseline_ci`);
    const mde = num(s.mde80_delta_g_vs_baseline, `${where}.mde80_delta_g_vs_baseline`);
    return {
      cells: [row.label_zh, `${whole(c.end_capital)} / ${whole(base.end_capital)}`, `${pct1(c.max_drawdown)} / ${pct1(base.max_drawdown)}`,
        `${whole(c.max_loss_usdt)} / ${whole(base.max_loss_usdt)}`, `${signed(dg)} ${ciText(ci)}`, mde.toFixed(2),
        prob(num(s.path.p_below_1800, `${where}.path.p_below_1800`)), prob(num(s.path.p_c17_alone_reaches_a19_line_1400, `${where}.path.p_c17_alone_reaches_a19_line_1400`))],
      checks: [{ ci, point: dg, mde }],
    };
  });

  // 固定句核对（§4.3）
  const history = candRows.every((row) => row.checks.every((item) => straddles(item.ci) && Math.abs(item.point) < item.mde));
  const btc = straddles(atPath(cand, 'segments.OOS.g_vs_btc_ci')) && straddles(gapRows.OOS.ci);

  return {
    gap_zh: gapLine(profile, spec, gapRows),
    components, component_note_zh: exposureNote, rules_zh: null, selection_note_zh: '',
    candidate: {
      columns_zh: ['口径', '期末 候选 / 当前 D', '最大回撤', `最大亏损 ${profile.currency}`, 'Δg [95%]', '检出下限', `P(权益曾 < ${floor})`, spec.candidate.a19_label_zh],
      rows: candRows.map((row) => row.cells), footnote_zh: null,
    },
    words_ok: { history, btc },
    cost_numbers: costNumbers(profile, spec, components),
    forward_extra_zh: [],
    cost_result: spec.cost.kind === 'OWN' ? phaseH(docs.COST_RESULT, spec, docs, baselineLock) : null,
  };
}

function readQs(profile, spec, docs, baselineLock) {
  const doc = docs.RESULT;
  need(doc && isObject(doc.identity) && doc.identity.schema === 'QS_V3_M2_R1_RESULT_V1' && doc.identity.smoke === false, 'M2_ROUND_FILE_KIND', 'RESULT');
  need(doc.identity.strategy_ref === profile.strategy_ref, 'M2_ROUND_FILE_FIELD', 'identity.strategy_ref');
  need(doc.identity.baseline_lock === spec.baseline_result_id && baselineLock && doc.identity.baseline_sha256 === baselineLock.file_sha256,
    'M2_ROUND_BASELINE_MISMATCH', `${doc.identity.baseline_lock}/${String(doc.identity.baseline_sha256).slice(0, 12)}…`);
  const w = segWords(profile);
  const base = doc.baseline;
  need(isObject(base) && isObject(base.OOS) && isObject(base.IS) && Array.isArray(doc.components) && isObject(doc.selection), 'M2_ROUND_FILE_FIELD', 'baseline/components/selection');
  const gapRows = Object.fromEntries(['OOS', 'IS'].map((key) => [key, {
    value: num(base[key].gap_to_btc, `baseline.${key}.gap_to_btc`), ci: ciOf(base[key].gap_to_btc_ci, `baseline.${key}.gap_to_btc_ci`), mde: num(base[key].gap_to_btc_mde80, `baseline.${key}.gap_to_btc_mde80`),
  }]));

  // 入选：档案候选的分量 = selection.entered = candidate.components，且只有它们 selection.enters = true（§3.3）
  const listed = spec.candidate.rules.map((rule) => rule.component);
  const same = (list) => Array.isArray(list) && list.length === listed.length && list.every((id) => listed.includes(id));
  need(same(doc.selection.entered) && same(doc.candidate && doc.candidate.components)
    && same(doc.components.filter((item) => item.selection && item.selection.enters === true).map((item) => item.id)), 'M2_ROUND_SELECTION_MISMATCH', String(doc.selection.entered));

  const RULES = [['R1_rule_lever', 'R1'], ['R2_d_mean_R_pos', 'R2'], ['R3_dg_not_below_tolerance', 'R3'], ['R4_risk', 'R4']];
  const LEVER = { EXECUTION: '执行方式', SIZING: '定仓' };
  const components = doc.components.map((item) => {
    need(typeof item.label_zh === 'string' && item.label_zh && isObject(item.OOS) && isObject(item.IS) && isObject(item.selection), 'M2_ROUND_FILE_FIELD', `components.${item.id}`);
    const halts = (part) => (Number.isInteger(part.new_halts) && part.new_halts > 0 ? `（新增停止 ${part.new_halts} 次）` : '');
    const cell = (part, key) => deltaCell({ g: part.g, endCapital: part.end_capital, dg: part.dg, ci: part.dg_ci, suffix: halts(part) }, `components.${item.id}.${key}`);
    const failed = RULES.filter(([key]) => item.selection[key] !== true)
      .map(([key, short]) => (key === 'R1_rule_lever' && LEVER[item.lever] ? `${short}（${LEVER[item.lever]}）` : short));
    return {
      id: item.id, label_zh: item.label_zh, entered: item.selection.enters === true,
      oos_zh: cell(item.OOS, 'OOS'), mde_zh: num(item.OOS.dg_mde80, `components.${item.id}.OOS.dg_mde80`).toFixed(2), is_zh: cell(item.IS, 'IS'),
      treatment_zh: item.selection.enters === true ? '入选' : `未通过 ${failed.join('、')}`,
      dg: { OOS: item.OOS.g === null ? null : item.OOS.dg, IS: item.IS.g === null ? null : item.IS.dg },
    };
  });

  const cs = doc.candidate.segments;
  need(isObject(cs) && isObject(cs.IS) && isObject(cs.OOS), 'M2_ROUND_FILE_FIELD', 'candidate.segments');
  const candRows = spec.candidate.rows.map((row) => {
    const s = cs[row.segment]; const b = base[row.segment];
    need(isObject(s) && isObject(b), 'M2_ROUND_FILE_FIELD', `candidate.segments.${row.segment}`);
    const where = `candidate.segments.${row.segment}`;
    const dg = num(s.dg, `${where}.dg`); const dgCi = ciOf(s.dg_ci, `${where}.dg_ci`); const dgMde = num(s.dg_mde80, `${where}.dg_mde80`);
    const dr = num(s.d_mean_R, `${where}.d_mean_R`); const drCi = ciOf(s.d_mean_R_ci, `${where}.d_mean_R_ci`); const drMde = num(s.d_mean_R_mde80, `${where}.d_mean_R_mde80`);
    return {
      cells: [row.label_zh, `${whole(s.end_capital)} / ${whole(b.end_capital)}`, `${pct1(s.max_drawdown)} / ${pct1(b.max_drawdown)}`,
        `${whole(s.max_loss_usd)} / ${whole(b.max_loss_usd)}`, `${signed(dg)} ${ciText(dgCi)}`, `${signed(dr)} ${ciText(drCi)}`, `${dgMde.toFixed(2)} / ${drMde.toFixed(2)}`],
      checks: [{ ci: dgCi, point: dg, mde: dgMde }, { ci: drCi, point: dr, mde: drMde }],
    };
  });
  const year = atPath(cs.OOS, 'by_entry_year.2026');
  need(isObject(year) && Number.isInteger(year.n), 'M2_ROUND_FILE_FIELD', 'candidate.segments.OOS.by_entry_year.2026');
  const candGap = ciOf(cs.OOS.gap_to_btc_ci, 'candidate.segments.OOS.gap_to_btc_ci');
  const footnote = `没有修好的：2026 年空单 ${year.n} 笔，每笔 ${signed(num(year.mean_R, '2026.mean_R'))} R；候选对 ${marketLabel(profile)}的 g 差 ${signed(num(cs.OOS.gap_to_btc, 'candidate.segments.OOS.gap_to_btc'))} ${ciText(candGap)}，没有可信地跑赢。`;
  need(!candGap.every((value) => value > 0), 'M2_ROUND_WORDS_CONTRADICT_FILE', 'candidate.segments.OOS.gap_to_btc_ci');

  const rates = doc.candidate.rates;
  need(isObject(rates), 'M2_ROUND_FILE_FIELD', 'candidate.rates');
  const rateLine = `速度（只报）：候选${w.OOS}每月 ${num(rates.oos_trades_per_month, 'rates.oos').toFixed(1)} 笔，2026 年每月 ${num(rates.y2026_trades_per_month, 'rates.2026').toFixed(1)} 笔；${spec.forward.rate_note_zh}`;
  const entered = components.filter((item) => item.entered);

  return {
    gap_zh: gapLine(profile, spec, gapRows),
    components, component_note_zh: null,
    rules_zh: Array.isArray(doc.selection.rule_zh) ? doc.selection.rule_zh.filter((line) => typeof line === 'string') : null,
    selection_note_zh: entered.length === 1 ? `（${components.length} 项里只有它通过 R1–R4）` : '',
    candidate: {
      columns_zh: ['口径', '期末 候选 / 当前 D', '最大回撤', `最大亏损 ${profile.currency}`, 'Δg [95%]', 'Δ每笔 R [95%]', '检出下限（g / R）'],
      rows: candRows.map((row) => row.cells), footnote_zh: footnote,
    },
    words_ok: {
      history: candRows.every((row) => row.checks.every((item) => straddles(item.ci) && Math.abs(item.point) < item.mde)),
      btc: straddles(candGap) && straddles(gapRows.OOS.ci),
    },
    cost_numbers: costNumbers(profile, spec, components),
    forward_extra_zh: [rateLine],
    cost_result: null,
  };
}

/** 成本分量那一行的样本外 / 开发期 Δg（只取文件已报的数）。 */
function costNumbers(profile, spec, components) {
  const row = components.find((item) => item.id === spec.cost.component);
  need(row && row.dg.OOS !== null && row.dg.IS !== null, 'M2_ROUND_COMPONENT_NOT_REGISTERED', `cost.component:${spec.cost.component}`);
  return { OOS: signed(row.dg.OOS), IS: signed(row.dg.IS) };
}

/** C17 执行成本 Phase H（只报不判）：决定数、60 秒挂单成交率的下界 / 上界、相对立即吃单每个决定省的 bp。 */
function phaseH(doc, spec, docs, baselineLock) {
  need(isObject(doc) && doc.schema === 'C17_V2_M2_Q2_EXECUTION_COST_V1.PHASE_H.v1', 'M2_ROUND_FILE_KIND', 'COST_RESULT');
  const costK2 = spec.files.find((file) => file.role === 'COST_K2');
  need(costK2 && isObject(doc.k2) && costK2.sha256.startsWith(doc.k2.sha256_prefix || '-'), 'M2_ROUND_FILE_FIELD', 'COST_RESULT.k2.sha256_prefix');
  need(baselineLock && doc.inputs && doc.inputs.q0_v2_sha256 === baselineLock.file_sha256, 'M2_ROUND_BASELINE_MISMATCH', 'COST_RESULT.inputs.q0_v2_sha256');
  const all = doc.summary && doc.summary.ALL;
  need(isObject(all) && isObject(all.APPROX_1M_TRADE_THROUGH) && isObject(all.APPROX_1M_TOUCH), 'M2_ROUND_FILE_FIELD', 'COST_RESULT.summary.ALL');
  const tt = all.APPROX_1M_TRADE_THROUGH; const touch = all.APPROX_1M_TOUCH;
  return {
    decisions: Number(num(doc.decisions && doc.decisions.total, 'decisions.total')).toLocaleString('en-US'),
    fill_low: num(tt.fill_rate, 'TT.fill_rate').toFixed(3), fill_high: num(touch.fill_rate, 'TOUCH.fill_rate').toFixed(3),
    save_low: signed(num(tt.delta_vs_t0_bp && tt.delta_vs_t0_bp.mean, 'TT.delta_vs_t0_bp.mean'), 2), save_high: signed(num(touch.delta_vs_t0_bp && touch.delta_vs_t0_bp.mean, 'TOUCH.delta_vs_t0_bp.mean'), 2),
  };
}

const READINGS = Object.freeze({ C17_GAP_V1: readC17, QS_RESULT_V1: readQs });

// ── 前向登记（D6 ★）─────────────────────────────────────────────────────────────

/** 档案 forward.observation_id 在前向登记里的状态：RUNNING / NOT_REGISTERED / IMPORT_REF_INVALID。 */
function forwardOf(profile, id, options = {}) {
  const view = hkForward.forStrategy(profile.strategy_ref, options.hk || {});
  const item = id ? view.items.find((entry) => entry.id === id) : null;
  if (!item) return { state: 'NOT_REGISTERED', text_zh: '前向影子尚未登记运行', started_on: null };
  if (item.import_state === 'IMPORT_REF_INVALID') return { state: 'IMPORT_REF_INVALID', text_zh: '前向登记的导入引用无效', started_on: item.started_on };
  return { state: 'RUNNING', text_zh: '前向影子运行中', started_on: item.started_on, verified_at: item.verified_at || view.verified_at };
}

// ── 校验整轮（导入与页面共用）──────────────────────────────────────────────────

function validateRound(profile, spec, docs, baselineLock) {
  const reading = READINGS[spec.reading];
  need(reading, 'M2_ROUND_READING_UNKNOWN', spec.reading);
  const out = reading(profile, spec, docs, baselineLock);
  // §4.3：档案的固定句与文件数字矛盾就拒绝
  need(out.words_ok.history, 'M2_ROUND_WORDS_CONTRADICT_FILE', 'candidate.history_note_zh');
  need(out.words_ok.btc, 'M2_ROUND_WORDS_CONTRADICT_FILE', 'candidate.btc_note_zh');
  // 计划文字里的查看时点与档案常数一致（查看日期与笔数）
  const plan = spec.forward.plan_zh.join('');
  need(plan.includes(spec.forward.look_not_before) && plan.includes(`${spec.forward.min_closed} 笔`), 'M2_ROUND_WORDS_CONTRADICT_FILE', 'forward.plan_zh');
  return out;
}

function currentBaseline(profile) {
  const chain = baselineEvaluation.locks(profile.case_ref);
  return chain.length ? chain[chain.length - 1] : null;
}

/**
 * 导入并锁定一轮（命令行，完成权威）。同一组文件重复导入是幂等重放；这一轮已有另一把锁时拒绝，
 * 改锁须 `supersedes` 指向当前锁并给出 `defectRef` 与 `reason`（旧锁保留）。
 */
function importRound({ strategyRef, round, dir = null, registeredBy, supersedes = null, defectRef = null, reason = null, allowNonActual = false, lockedAt = null } = {}) {
  authority(registeredBy);
  const profile = profiles.mustGet(strategyRef);
  const spec = specOf(profile, Number(round));
  need(spec, 'M2_ROUND_NOT_REGISTERED', `${strategyRef}:${round}`);
  const base = path.resolve(dir || path.join(ROOT, spec.evidence_dir));
  const baselineLock = currentBaseline(profile);
  need(baselineLock && baselineLock.result_id === spec.baseline_result_id, 'M2_ROUND_BASELINE_NOT_CURRENT', `${spec.baseline_result_id}≠${baselineLock ? baselineLock.result_id : '无 Q0 锁'}`);
  const { files, docs } = readFiles(spec, (expected) => path.join(base, expected.name), { allowNonActual });
  validateRound(profile, spec, docs, baselineLock);
  const idFile = files.find((file) => ID_ROLES.includes(file.role));
  const resultId = `R${spec.round}-${idFile.sha256.slice(0, 16)}`;
  const k2 = files.find((file) => file.role === 'CANDIDATE_K2');
  const fileRows = files.map((file) => ({ role: file.role, name: file.name, path: file.path, sha256: file.sha256, size: file.size }));
  const head = headLock(profile.strategy_ref, spec.round);
  if (head && head.result_id === resultId && canonical(head.files.map((f) => [f.role, f.sha256])) === canonical(fileRows.map((f) => [f.role, f.sha256]))) return { ...head, replayHit: true };
  if (head) {
    need(supersedes === head.result_id, 'M2_ROUND_ALREADY_LOCKED', head.result_id);
    need(defectRef && reason, 'M2_ROUND_SUPERSEDE_REQUIRES_DEFECT_AND_REASON');
  } else need(!supersedes, 'M2_ROUND_SUPERSEDE_TARGET_NOT_FOUND', supersedes);
  const body = {
    schema: LOCK_SCHEMA, result_id: resultId, case_ref: profile.case_ref, strategy_ref: profile.strategy_ref, round: spec.round,
    baseline_result_id: spec.baseline_result_id, files: fileRows, k2_sha256: k2.sha256, import_profile_id: IMPORT_PROFILE_ID,
    supersedes_ref: supersedes, defect_ref: defectRef, supersede_reason: reason, production_effect: 'NONE', locked_by: registeredBy,
    locked_at: lockedAt || now(),
  };
  body.lock_hash = sha256(canonical(body));
  return append(LEDGER(), body);
}

// ── 页面投影 ────────────────────────────────────────────────────────────────────

function candidateName(spec) { return spec.candidate.name_zh; }
function lookText(spec) { return `最早 ${spec.forward.look_not_before} 查看`; }

/** 一句话（总览、轮次卡结论、研究页答句共用）。 */
function sentenceOf(spec, forward) {
  return `M2 第 ${spec.round} 轮：组合候选「${candidateName(spec)}」已冻结，${forward.text_zh}，${lookText(spec)}后按 做 / 不做 决定`;
}

function costText(profile, spec, out, costForward) {
  const w = segWords(profile);
  const numbers = `${w.OOS} ${out.cost_numbers.OOS}，${w.IS} ${out.cost_numbers.IS}`;
  if (spec.cost.kind === 'MERGED') return `成本（${numbers}）${spec.cost.merged_zh}`;
  const h = out.cost_result;
  return `${spec.cost.title_zh}：${spec.cost.frozen_zh}。${spec.cost.why_zh}（${numbers}）。`
    + `历史近似（Phase H，只用 1m 存档，只报不判）：${h.decisions} 个决定，60 秒挂单成交率 ${h.fill_low}–${h.fill_high}，相对立即吃单平均每个决定省 ${h.save_low} 到 ${h.save_high} bp。`
    + `前向记录：${costForward.state === 'RUNNING' ? '运行中' : '尚未登记运行'}。${spec.cost.adoption_zh}`;
}

/** 待研究里的成本题（D7 ★）：C17 自己的题用阶段词 RUNNING；QS 并入 C17 的题。 */
function costOpenOf(spec) {
  return spec.cost.kind === 'MERGED'
    ? { question_ref: null, title_zh: spec.cost.open_title_zh, phase: 'MERGED', waiting_on: [], note_zh: spec.cost.open_note_zh }
    : { question_ref: null, title_zh: spec.cost.open_title_zh, phase: 'RUNNING', waiting_on: [] };
}

function buildCard(profile, spec, out, lock, files, forward, costForward, baselineCurrent) {
  const w = segWords(profile);
  const sentence = sentenceOf(spec, forward);
  const forwardState = forward.state === 'RUNNING'
    ? `运行状态：${forward.text_zh}（登记起始 ${forward.started_on}，HK 只读核对 ${forward.verified_at}；见前向观察）`
    : `运行状态：${forward.text_zh}`;
  const blocks = [
    { key: 'conclusion', title_zh: '结论', open: true, lines_zh: [`${sentence}。${spec.candidate.history_note_zh}`] },
    {
      key: 'decomposition', title_zh: '缺口分解', open: false, lead_zh: out.gap_zh,
      columns_zh: ['分量', `${w.OOS} Δg [95%]`, `检出下限（${w.OOS}）`, `${w.IS} Δg [95%]`, '处理'],
      rows: out.components.map((item) => [item.label_zh, item.oos_zh, item.mde_zh, item.is_zh, item.treatment_zh]),
      note_zh: out.component_note_zh, folded_zh: out.rules_zh ? { title_zh: '选择规则 R1–R4（原文）', lines_zh: out.rules_zh } : null,
    },
    {
      key: 'candidate', title_zh: '组合候选', open: false,
      lead_zh: `组合候选「${candidateName(spec)}」（${spec.candidate.scope_zh}）`,
      rules_zh: spec.candidate.rules.map((rule) => `${rule.id} ${rule.label_zh}：${rule.text_zh}`),
      lines_zh: [spec.candidate.unchanged_zh, spec.candidate.owner_note_zh].filter(Boolean),
      table_title_zh: '已见数据（探索性；oos_reuse = true；只报不判，不作采用条件）',
      columns_zh: out.candidate.columns_zh, rows: out.candidate.rows,
      notes_zh: [out.candidate.footnote_zh, spec.candidate.history_note_zh, spec.candidate.btc_note_zh].filter(Boolean),
    },
    {
      key: 'forward', title_zh: '前向计划', open: true,
      lines_zh: spec.forward.plan_zh, do_title_zh: spec.forward.do_title_zh, do_zh: spec.forward.do_zh,
      after_zh: [spec.forward.dont_zh, ...spec.forward.extra_zh, ...out.forward_extra_zh, ADOPTION_RULE_ZH], state_zh: forwardState,
    },
    { key: 'cost', title_zh: '成本题', open: false, lines_zh: [costText(profile, spec, out, costForward)] },
  ];
  return {
    state: 'LOCKED_VERIFIED', round: spec.round, card_ref: `R${spec.round}`, result_id: lock.result_id,
    title_zh: `M2 第 ${spec.round} 轮：缺口分解 + 组合候选`,
    line_zh: `M2 第 ${spec.round} 轮 · 组合候选「${candidateName(spec)}」· ${forward.text_zh} · ${lookText(spec)}（做 / 不做）`,
    sentence_zh: sentence, candidate_name_zh: candidateName(spec), frozen_on: spec.frozen_on, component_count: out.components.length,
    selection_note_zh: out.selection_note_zh, look_not_before: spec.forward.look_not_before, min_closed: spec.forward.min_closed,
    forward: { state: forward.state, text_zh: forward.text_zh, started_on: forward.started_on },
    cost_open: costOpenOf(spec), baseline_current: baselineCurrent,
    blocks,
    source: {
      result_id: lock.result_id, baseline_result_id: lock.baseline_result_id, locked_at: lock.locked_at, import_profile_id: lock.import_profile_id,
      k2: `${(spec.files.find((file) => file.role === 'CANDIDATE_K2') || {}).template || ''} ${lock.k2_sha256}`.trim(),
      files: files.map((file) => ({ role: file.role, name: file.name, sha256: file.sha256 })),
    },
  };
}

const CACHE = new Map();
const statKey = (file) => { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch (error) { return `ERR:${error.code}`; } };

/**
 * 一条策略已登记各轮的页面投影（只含已导入的轮；没有锁的轮不出现）。每次读都现场复验文件 sha256；
 * 任一文件缺失或不符 → 这一轮 INVALID / MISSING，页面写「第 N 轮封存结果校验未通过」，不写「已冻结」「运行中」。
 */
function readProjections(profile, options = {}) {
  if (!profile) return [];
  const out = [];
  for (const spec of roundsOf(profile)) {
    const lock = headLock(profile.strategy_ref, spec.round);
    if (!lock) continue;
    const forward = forwardOf(profile, spec.forward.observation_id, options);
    const costForward = spec.cost.kind === 'OWN' ? forwardOf(profile, spec.cost.observation_id, options) : null;
    const baselineLock = currentBaseline(profile);
    const baselineCurrent = Boolean(baselineLock && baselineLock.result_id === lock.baseline_result_id);
    const key = `${profile.strategy_ref}|${spec.round}`;
    const stamp = [lock.lock_hash, ...lock.files.map((file) => statKey(file.path)), forward.state, forward.started_on, costForward && costForward.state, baselineCurrent].join('|');
    const hit = CACHE.get(key);
    if (hit && hit.stamp === stamp) { out.push(hit.result); continue; }
    let result;
    try {
      need(canonical(lock.files.map((f) => [f.role, f.name, f.sha256])) === canonical(spec.files.map((f) => [f.role, f.name, f.sha256])), 'M2_ROUND_FILE_SHA_MISMATCH', '锁与档案登记的文件不一致');
      const byName = new Map(lock.files.map((file) => [`${file.role}|${file.name}`, file.path]));
      const { files, docs } = readFiles(spec, (expected) => byName.get(`${expected.role}|${expected.name}`), { allowNonActual: true });
      const baseline = baselineEvaluation.locks(profile.case_ref).find((row) => row.result_id === lock.baseline_result_id) || null;
      const reading = validateRound(profile, spec, docs, baseline);
      result = buildCard(profile, spec, reading, lock, files, forward, costForward || { state: 'NOT_REGISTERED' }, baselineCurrent);
    } catch (error) {
      const missing = error instanceof M2RoundError && /MISSING/.test(error.code);
      result = {
        state: missing ? 'MISSING' : 'INVALID', round: spec.round, card_ref: `R${spec.round}`, result_id: lock.result_id,
        title_zh: `M2 第 ${spec.round} 轮：缺口分解 + 组合候选`, line_zh: `M2 第 ${spec.round} 轮 · 封存结果校验未通过`,
        sentence_zh: `M2 第 ${spec.round} 轮封存结果校验未通过`, reason: error.message, reason_code: error.code || 'UNKNOWN', blocks: [],
      };
    }
    CACHE.set(key, { stamp, result });
    out.push(result);
  }
  return out;
}

/** 研究进度（stage.js）用的那一轮：已导入的最后一轮；没有就是 null。 */
function latestOf(profile, options = {}) {
  const list = readProjections(profile, options);
  return list.length ? list[list.length - 1] : null;
}

const clearCache = () => CACHE.clear();

module.exports = {
  LOCK_SCHEMA, IMPORT_PROFILE_ID, LEDGER, ADOPTION_RULE_ZH, M2RoundError, roundsOf, specOf, idFileOf, locks, headLock,
  importRound, readProjections, latestOf, clearCache, internals: { signed, ciText, whole, pct1, prob, readRoleFile, READINGS },
};
