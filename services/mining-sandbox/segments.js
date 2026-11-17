'use strict';

/**
 * 三段切分（RF1116 §3.4；A 股第一轮的锁定留出段冻结页 FREEZE_1，sha256 0fefcd24…，2026-11-17T10:57:06+08:00 协调会话签发，仓库副本在 docs/freeze/）。
 * 挖掘段在前、前推验证折在中间、锁定留出段整段在两种现行 DeepSeek 版本的发布日之后；三段不重叠，以后不能挪（tests/mining_data_adapter.test.js 对着冻结页核）。
 * 段按「决策日」（开盘执行的那一天）划分；标签（前推收益）也必须落在同一段里，所以每段的信号日只取到终点前 H 个交易日。
 */
const SEGMENTS = Object.freeze({
  MINING: Object.freeze({ from: '2020-06-01', to: '2023-12-29' }),
  VALIDATION: Object.freeze({ from: '2024-01-02', to: '2026-10-16' }),
  HOLDOUT: Object.freeze({ from: '2026-10-19', to: '2026-12-31' }),
});
const FREEZE_PAGE = Object.freeze({ path: 'docs/freeze/RF1116_HOLDOUT_CN_A_R1_FREEZE_1.md', sha256: '0fefcd244e85d68504fbb20b761043c1f001965f005c29106740250e2e24a14b' });

/** 决策日落在哪一段（都不在 → null）。 */
const segmentOf = (date) => Object.keys(SEGMENTS).find((k) => date >= SEGMENTS[k].from && date <= SEGMENTS[k].to) || null;

module.exports = { SEGMENTS, FREEZE_PAGE, segmentOf };
