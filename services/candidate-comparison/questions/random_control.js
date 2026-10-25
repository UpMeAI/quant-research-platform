'use strict';

/**
 * 随机选择对照块 `random_control`（Q3 K2 裁定 1–3、6）：类别 `RANDOM_SELECTION_CONTROL_V1`，两部分——
 *   Q3a  同一扫描候选的处理顺序随机化（`random_control`）；
 *   Q3a2 当前 D 每次真要开仓时，改为随机挑一个当时可交易的同方向标的（`random_control.random_instrument`）。
 * 每部分：种子（seed_i = 20261025 + i）、统计量（基线账户 g 胜过的种子比例，相等算一半）、分布分位数、
 * 选择点普查（G1：OOS ≥ 30，先判）、结论（≥ 0.75 SUPPORTED，≤ 0.50 NOT_PASSED，其余 INSUFFICIENT）；
 * 每笔净 R 的位置照报、不判。
 *
 * 这是它自己的结论，和 Q3b（行业 RS 排序层）的 `verdict` 分开：校验时互不引用，页面上是单独一张卡。
 * 只拒绝「标签比证据强」：G1 不成立时只能是证据不足且写 G1_NOT_MET；SUPPORTED／NOT_PASSED 需要比例过线且种子数是冻结的 1,000。
 * 不重算：比例、分位数、g 都是文件里已报的数字。
 */
const {
  need, finite, isObject, preferZh, E, fmtPct, baseline, reasonText, REASON_WORDS,
} = require('../common');

const STATES = baseline.STATES;
const STATE_LABELS = Object.freeze({ SUPPORTED: '有支持证据', NOT_PASSED: '未通过', INSUFFICIENT: '证据不足' });
const STATE_TONES = Object.freeze({ SUPPORTED: 'VALID', NOT_PASSED: 'INVALID', INSUFFICIENT: 'DEGRADED' });
const WORDS = Object.freeze({
  G1_NOT_MET: '选择点太少（G1 不成立）',
  SAMPLE_LT_30: '选择点少于 30 个',
  DESCRIPTIVE_ONLY: '种子运行只作描述，不判',
});

const partOf = (spec, doc) => spec.get(doc);

/** 把分位数表读成 [{q, value}]：认对象（键 → 数）和数组（{q|p|quantile, value}）。读不出来返回空数组。 */
function quantileRows(raw) {
  const label = (key) => {
    const text = String(key);
    const match = /^[pq]?0*(\d+(?:\.\d+)?)$/i.exec(text);
    if (match) return `${Number(match[1])}%`;
    return ({ min: '最小值', max: '最大值', median: '中位数', mean: '平均' })[text.toLowerCase()] || text;
  };
  if (Array.isArray(raw)) {
    return raw.filter(isObject).map((row) => ({ q: label(row.q !== undefined ? row.q : (row.p !== undefined ? row.p : row.quantile)), value: [row.value, row.g, row.v].find(finite) }))
      .filter((row) => finite(row.value));
  }
  if (isObject(raw)) return Object.entries(raw).filter(([, value]) => finite(value)).map(([key, value]) => ({ q: label(key), value }));
  return [];
}

function validatePart(entry, cfg, spec, part) {
  need(isObject(part), E(entry, 'RANDOM_CONTROL_PART_MISSING'), spec.key);
  const verdict = part.verdict;
  need(isObject(verdict) && verdict.class === cfg.class, E(entry, 'RANDOM_CONTROL_CLASS_UNSUPPORTED'), `${spec.key}:${verdict && verdict.class}`);
  need(STATES.includes(verdict.state), E(entry, 'RANDOM_CONTROL_STATE_UNSUPPORTED'), `${spec.key}:${verdict.state}`);
  const codes = Array.isArray(verdict.reason_codes) ? verdict.reason_codes : [];

  const seeds = part.seeds;
  need(isObject(seeds) && Number.isInteger(seeds.n) && seeds.n >= 1 && seeds.first === cfg.seed_first && seeds.last === seeds.first + seeds.n - 1,
    E(entry, 'RANDOM_CONTROL_SEEDS_CHANGED'), `${spec.key}: n=${seeds && seeds.n} first=${seeds && seeds.first} last=${seeds && seeds.last}`);

  const points = part.choice_points;
  need(isObject(points) && Number.isInteger(points.oos) && points.oos >= 0 && Number.isInteger(points.is) && points.is >= 0,
    E(entry, 'RANDOM_CONTROL_CHOICE_POINTS_INVALID'), spec.key);
  const g1 = points.oos >= cfg.min_choice_points;
  if (points.g1_met !== undefined) need(points.g1_met === g1, E(entry, 'RANDOM_CONTROL_G1_DISAGREES'), `${spec.key}: oos=${points.oos}`);

  const base = part.baseline;
  need(isObject(base) && finite(base.share_beaten_g) && base.share_beaten_g >= 0 && base.share_beaten_g <= 1, E(entry, 'RANDOM_CONTROL_STATISTIC_INVALID'), `${spec.key}:share_beaten_g`);
  need(isObject(part.distribution) && part.distribution.g !== undefined && part.distribution.g !== null, E(entry, 'RANDOM_CONTROL_DISTRIBUTION_MISSING'), spec.key);

  // G1 先判：选择点不够，只能是证据不足，并且必须自己写明 G1_NOT_MET（页面据此说清楚）
  if (!g1) {
    need(verdict.state === 'INSUFFICIENT', E(entry, 'RANDOM_CONTROL_VERDICT_WITHOUT_G1'), `${spec.key}: OOS 选择点 ${points.oos} < ${cfg.min_choice_points}`);
    need(codes.includes('G1_NOT_MET'), E(entry, 'RANDOM_CONTROL_G1_NOT_DECLARED'), spec.key);
  }
  if (verdict.state === 'SUPPORTED') {
    need(g1 && base.share_beaten_g >= cfg.support_at, E(entry, 'RANDOM_CONTROL_VERDICT_SUPPORTED_WITHOUT_EVIDENCE'), `${spec.key}: share=${base.share_beaten_g}`);
    need(seeds.n === cfg.full_seeds, E(entry, 'RANDOM_CONTROL_SEEDS_INSUFFICIENT'), `${spec.key}: n=${seeds.n}`);
  }
  if (verdict.state === 'NOT_PASSED') {
    need(g1 && base.share_beaten_g <= cfg.fail_at, E(entry, 'RANDOM_CONTROL_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE'), `${spec.key}: share=${base.share_beaten_g}`);
    need(seeds.n === cfg.full_seeds, E(entry, 'RANDOM_CONTROL_SEEDS_INSUFFICIENT'), `${spec.key}: n=${seeds.n}`);
  }
}

function validateRandomControl(entry, doc) {
  const cfg = entry.random_control;
  need(isObject(doc.random_control), E(entry, 'RANDOM_CONTROL_MISSING'));
  for (const spec of cfg.parts) validatePart(entry, cfg, spec, partOf(spec, doc));
}

/** 每一部分各自构造，一部分读不出来只让这一部分写原因。 */
function buildPart(entry, cfg, spec, doc) {
  const head = { key: spec.key, title_zh: spec.title_zh, question_zh: spec.question_zh };
  try {
    const part = partOf(spec, doc);
    need(isObject(part), 'MISSING', `random_control.${spec.key}`);
    const { verdict, seeds, choice_points: points, baseline: base, distribution } = part;
    const g1 = points.oos >= cfg.min_choice_points;
    const share = base.share_beaten_g;
    const rule = preferZh(verdict, 'rule');
    const plain = g1
      ? `基线账户 g 胜过 ${fmtPct(share, 1)} 的随机种子（相等算一半）。≥ ${fmtPct(cfg.support_at, 0)} 有支持证据，≤ ${fmtPct(cfg.fail_at, 0)} 未通过，其余证据不足。`
      : `G1 不成立：OOS 选择点只有 ${points.oos} 个，要求 ≥ ${cfg.min_choice_points} 个，所以结论是证据不足；${seeds.n} 个种子的运行只作描述，不判。`;
    return {
      ...head, state: 'AVAILABLE', reason: null, verdict_state: verdict.state,
      state_label: g1 || verdict.state !== 'INSUFFICIENT' ? STATE_LABELS[verdict.state] : '证据不足（G1 不成立）', tone: STATE_TONES[verdict.state],
      plain_zh: plain, rule_zh: typeof rule === 'string' && rule.trim() ? rule.trim() : null,
      g1: {
        met: g1, oos: points.oos, is: points.is, required: cfg.min_choice_points,
        definition_zh: typeof preferZh(points, 'definition') === 'string' ? preferZh(points, 'definition') : null,
      },
      seeds: { n: seeds.n, first: seeds.first, last: seeds.last, rule_zh: typeof preferZh(seeds, 'rule') === 'string' ? preferZh(seeds, 'rule') : null },
      statistic: {
        share_beaten_g: share, percentile_g: finite(base.percentile_g) ? base.percentile_g : null, support_at: cfg.support_at, fail_at: cfg.fail_at,
      },
      baseline: { g: finite(base.g) ? base.g : null, net_R: finite(base.net_R) ? base.net_R : null },
      net_R_position: {
        share_beaten_net_R: finite(base.share_beaten_net_R) ? base.share_beaten_net_R : null, note_zh: '每笔净 R 的位置只报告，不参与判定',
      },
      distribution: { g: quantileRows(distribution.g), net_R: quantileRows(distribution.net_R) },
      reasons: (Array.isArray(verdict.reason_codes) ? verdict.reason_codes : [])
        .map((code) => ({ code, text: WORDS[code] || REASON_WORDS[code] || `原因码 ${code}` })),
    };
  } catch (error) {
    return { ...head, state: 'NOT_COMPLETED', reason: reasonText(error) };
  }
}

/** 随机对照那张卡的数据：两部分，各自一个三态结论，和 Q3b 的 verdict 无关。 */
function card(entry, doc) {
  const cfg = entry.random_control;
  return {
    class: cfg.class,
    parts: cfg.parts.map((spec) => buildPart(entry, cfg, spec, doc)),
    note_zh: '随机对照是它自己的结论，与上面行业 RS 排序层（Q3b）的结论分开，互不影响；两者都不做多重比较校正（问题不同）。',
  };
}

module.exports = { validateRandomControl, card, quantileRows, STATE_LABELS };
