'use strict';

/**
 * 队列状态的夹具：某题 K2 冻结之前的题组。档案里去掉这一题的导入规格（登记项因此不在），
 * 其余照真实档案，队列状态仍由 registry.queueState 按计划推出（排队，等谁／待立题）。
 * `withProgram` 只在回调期间让 registry.forStrategy 对这条策略返回夹具题组，结束后还原。
 */
const profiles = require('../services/strategy-profiles');
const registry = require('../services/candidate-comparison/registry');

function programBeforeK2(question, profile = profiles.defaultProfile()) {
  const entry = registry.ENTRIES.find((item) => item.question_ref === question && profile.comparison_import_profile_ids.includes(item.profile_ref));
  if (!entry) throw new Error(`QUEUE_FIXTURE_QUESTION_NOT_REGISTERED:${question}`);
  return registry.programOf({ ...profile, comparison_import_profile_ids: profile.comparison_import_profile_ids.filter((id) => id !== entry.profile_ref) });
}

async function withProgram(program, fn) {
  const original = registry.forStrategy;
  registry.forStrategy = (strategyRef) => (strategyRef === program.strategy_ref ? program : original(strategyRef));
  try {
    return await fn();
  } finally {
    registry.forStrategy = original;
  }
}

module.exports = { programBeforeK2, withProgram };
