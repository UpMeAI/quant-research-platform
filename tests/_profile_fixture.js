'use strict';
/**
 * 测试专用的策略档案：在测试进程里把生产注册表加上几条测试档案（修订 4：只有登记了档案的策略才能记产品阶段）。
 * 只换进程内的注册表，不写 config/strategy_profiles.v1.json。
 */
const fs = require('node:fs');
const path = require('node:path');
const profiles = require('../services/strategy-profiles');

const PRODUCTION = JSON.parse(fs.readFileSync(profiles.FILE, 'utf8'));

function testProfile(strategyRef, caseRef, overrides = {}) {
  return {
    strategy_ref: strategyRef, case_ref: caseRef, market: 'TEST_MARKET', currency: 'USDT', display_name: `TEST_${strategyRef}`,
    comparators: [{ key: 'TEST_MARKET_BUY_HOLD', label_zh: '测试基准买入持有', role: 'MARKET' }, { key: 'CASH', label_zh: '现金', role: 'CASH' }],
    floor: { value: 100, currency: 'USDT', rule_label_zh: '测试底线 100 USDT' },
    baseline_result_schema: `TEST_${strategyRef}_Q0_RESULT_V1`, import_profile_id: `tests/TEST_${strategyRef}_Q0_IMPORT_PROFILE`,
    comparison_import_profile_ids: [], phase_words: { PRODUCTION: '测试相位' }, segment_words: { OOS: '测试样本外' },
    cost_model_id: `TEST_${strategyRef}_COST_V1`,
    m1_evidence: { manifest_ref: `tests/TEST_${strategyRef}_M1_MANIFEST.json`, manifest_sha256: '0'.repeat(64), diagnostic_schema: `TEST_${strategyRef}_M1_DIAGNOSTIC_V1` },
    forward_observation_source_key: strategyRef,
    research_program: { plan_ref: `tests/TEST_${strategyRef}_PROGRAM`, amendment_ref: `tests/TEST_${strategyRef}_PROGRAM_AMENDMENT`, default_question: null, queue: {} },
    ...overrides,
  };
}

/** 生产注册表 + 给定的测试档案；返回原来的注册表，测试结束时可以换回。 */
const installProfiles = (...extra) => profiles.use(profiles.validate({ ...PRODUCTION, profiles: [...PRODUCTION.profiles, ...extra] }));

module.exports = { PRODUCTION, testProfile, installProfiles, path };
