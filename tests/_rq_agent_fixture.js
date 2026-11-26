'use strict';
/** AUTONOMOUS_RESEARCH_QUEUE_V1 Q2 的测试夹具：事实包、注册表视图、合格的卡与核对报告（全部是假数据）。 */
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SOURCE = (n) => ({ path: `runs/RQT-LINUX-20261122-aaaa1111/attempt-1/evidence/${n}.json`, sha256: sha(`src${n}`), pointer: `/rows/${n}` });
const fact = (n, value) => ({ id: `F-${String(n).padStart(3, '0')}`, source: SOURCE(n), at: '2026-11-20T18:00:00+08:00', value });

function makePack(over = {}) {
  return {
    schema: 'RQ_CHECK_FACT_PACK_V1', market: 'CN_A', week_id: '2026-W47', task_id: 'RQT-LINUX-20261122-aaaa1111',
    facts: [
      fact(1, { signals: 12, window_days: 60 }),
      fact(2, { hit_rate_pct: 41.5, n: 87 }),
      fact(3, { lag_days: 3 }),
      fact(4, { count: 3, key: 'LATE_ENTRY' }),
      fact(5, { missing: ['RS60'] }),
    ],
    evidence_matrix: [
      { req_id: 'R1', text: 'gate record present', gate_result: 'PASS', reason: null, fact_ids: ['F-001'] },
      { req_id: 'R2', text: 'sample size reported', gate_result: 'PASS', reason: null, fact_ids: ['F-002'] },
    ],
    code_counts: [{ key: 'LATE_ENTRY', count: 3, fact_id: 'F-004' }],
    author: null,
    ...over,
  };
}

function makeRegistry(over = {}) {
  const market = over.market || 'CN_A';
  const spaceMarket = market === 'US_EQUITY' ? 'US' : market;
  return {
    market,
    mining_space: {
      schema: 'MINING_SPACE_V1',
      space_ref: `MINING_SPACE_V1:${spaceMarket}:TEST`,
      market: spaceMarket,
      sha256: sha(spaceMarket === 'CN_A' ? 'fixture-mining-space' : `fixture-mining-space:${spaceMarket}`),
      freeze_sha256: sha(spaceMarket === 'CN_A' ? 'fixture-mining-space-freeze' : `fixture-mining-space-freeze:${spaceMarket}`),
    },
    mechanisms: [
      { mechanism_id: 'SEL.XSEC.REVERSAL', layer: 'SELECTION_TIMING', decision_point: 'SELECT' },
      { mechanism_id: 'SEL.XSEC.LOW_VOLATILITY', layer: 'SELECTION_TIMING', decision_point: 'SELECT' },
      { mechanism_id: 'SEL.TREND.LONG_MA_GATE', layer: 'SELECTION_TIMING', decision_point: 'ENTRY' },
      { mechanism_id: 'RISK.TOTAL.BUDGET', layer: 'RISK', decision_point: 'SIZING' },
    ],
    readings: {
      RS60: { pit_available_at: 'T 日收盘后', origin: 'SPACE' },
      VOL20: { pit_available_at: 'T 日收盘后', origin: 'SPACE' },
      'CN_A.MOM.RS60_MARKET_PCT': { pit_available_at: 'T 日收盘后（V6 特征）', origin: 'FACTOR_LIBRARY' },
      'CN_A.VOL.REALIZED_20': { pit_available_at: 'T 日收盘后（V6 特征）', origin: 'FACTOR_LIBRARY' },
    },
    holding_periods: [5, 10, 20],
    ...over,
  };
}

const goodIdea = (over = {}) => ({
  fact_ids: ['F-002', 'F-003'],
  mechanism: 'SEL.XSEC.REVERSAL',
  readings: ['RS60', 'VOL20'],
  holding_periods: [5, 10],
  question_zh: '近期弱势后的反弹是否在放量日之后更常见？',
  expected_failure_zh: '市场整体单边下行、所有读数同向时这个机制不应有效',
  ...over,
});

function makeCard(over = {}) {
  return {
    market: 'CN_A', week_id: '2026-W47',
    supporting: [{ text_zh: '本周共 12 次信号，窗口 60 日', fact_ids: ['F-001'] }],
    opposing: [{ text_zh: '命中率 41.5，样本 87', fact_ids: ['F-002'] }],
    unknowns: [{ text_zh: '读数 RS60 缺失，来源未给', fact_ids: ['F-005'] }],
    repeated_patterns: [{ pattern_key: 'LATE_ENTRY', note_zh: '入场偏晚重复出现', count: 3, fact_ids: ['F-004'] }],
    factor_ideas: [goodIdea()],
    no_idea_reason: null,
    question_proposals: [],
    ...over,
  };
}

function makeCheckReport(over = {}) {
  return {
    verdict: 'CONSISTENT',
    items: [
      { req_id: 'R1', status: 'COVERED', fact_ids: ['F-001'], note_zh: '有窗口 60 日的记录' },
      { req_id: 'R2', status: 'COVERED', fact_ids: ['F-002'], note_zh: '样本 87 已报告' },
    ],
    hold_reasons: [],
    unknowns: [],
    ...over,
  };
}

const ctx = (over = {}) => ({ pack: makePack(), registry: makeRegistry(), market: 'CN_A', week_id: '2026-W47', ...over });

module.exports = { sha, fact, makePack, makeRegistry, makeCard, makeCheckReport, goodIdea, ctx };
