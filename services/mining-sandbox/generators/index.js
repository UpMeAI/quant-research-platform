'use strict';

/**
 * 生成方的入口（RF1116 §3.1；P2 规格 §0.2「GP 先、DeepSeek 后」；★R (a)：一轮只用一种生成方式，清单写明）。
 *   - AI_MINED_GP → ../gp 的 createGp（种子取轮次清单的 generator.gp_seed）；
 *   - AI_MINED_LLM → ../llm 的纯函数部分（配置、提示词、请求体、应答解析）。连网与计量不在这里：网络只在 services/mining-llm-step（唯一连网的容器），
 *     交换目录与台账计量由执行器（round-runner）做。没有 options.llm（配置与机制）→ MINE_LLM_GENERATOR_OPTIONS_MISSING；
 *   - 别的 → MINE_GENERATOR_UNKNOWN。
 */
const gp = require('../gp');
const llm = require('../llm');

class GeneratorError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const ENABLED = Object.freeze({ AI_MINED_GP: true, AI_MINED_LLM: true });

function assertGeneratorEnabled(generator) {
  const mode = generator && typeof generator === 'object' ? generator.mode : undefined;
  if (!Object.prototype.hasOwnProperty.call(ENABLED, mode)) throw new GeneratorError('MINE_GENERATOR_UNKNOWN', String(mode));
  if (ENABLED[mode] !== true) throw new GeneratorError('MINE_GENERATOR_NOT_ENABLED', mode);
  return mode;
}

/** 按轮次清单的 generator 建生成方。space = 冻结空间的 DSL 部分；holdingPeriod = 本轮的持有期。 */
function generatorFor(generator, { space, holdingPeriod, llm: llmOptions } = {}) {
  assertGeneratorEnabled(generator);
  if (generator.mode === 'AI_MINED_LLM') {
    if (!llmOptions || !llmOptions.config || !Array.isArray(llmOptions.mechanisms)) throw new GeneratorError('MINE_LLM_GENERATOR_OPTIONS_MISSING', 'config and mechanisms');
    return llm.createGenerator({ config: llmOptions.config, mechanisms: llmOptions.mechanisms, space, holdingPeriod });
  }
  return gp.createGp({ seed: generator.gp_seed, space, holdingPeriod });
}

module.exports = { ENABLED, GeneratorError, assertGeneratorEnabled, generatorFor };
