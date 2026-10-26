'use strict';

/**
 * 成本模型按 id 选择（QRP_MULTI_STRATEGY_PROFILE_REGISTRY_ACCEPTANCE_V1 R2）。策略档案的 `cost_model_id` 指向这里的一项；
 * 每个成本模型是独立模块。没有登记的 id 失败关闭，诊断不会借用别的策略的成本模型。
 */
const MODELS = Object.freeze(Object.fromEntries([
  require('./US_V5_M1_RESEARCH_COST_V1'),
].map((model) => [model.MODEL_ID, model])));

function resolve(modelId) {
  const model = MODELS[modelId];
  if (!model) {
    const error = new Error('DIAGNOSTIC_COST_MODEL_NOT_REGISTERED');
    error.code = 'DIAGNOSTIC_COST_MODEL_NOT_REGISTERED';
    error.cost_model_id = modelId || null;
    throw error;
  }
  return model;
}

module.exports = { MODELS, resolve };
