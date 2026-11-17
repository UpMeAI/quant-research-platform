'use strict';

/**
 * 生成方的入口（RF1116 §3.1；P2 规格 §0.2「GP 先、DeepSeek 后」；★R (a)：一轮只用一种生成方式，清单写明）。
 *   - AI_MINED_GP → ../gp 的 createGp（种子取轮次清单的 generator.gp_seed）；
 *   - AI_MINED_LLM → MINE_LLM_NOT_ENABLED：研究专用密钥（★K (b)）还没放到车道上，大模型这一步不开（不读密钥、不连网络、不开轮）；
 *   - 别的 → MINE_GENERATOR_UNKNOWN。
 * 执行器在开轮之前就调 assertGeneratorEnabled，所以不会有用大模型开出来的轮。
 */
const gp = require('../gp');

class GeneratorError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const ENABLED = Object.freeze({ AI_MINED_GP: true, AI_MINED_LLM: false });

function assertGeneratorEnabled(generator) {
  const mode = generator && typeof generator === 'object' ? generator.mode : undefined;
  if (!Object.prototype.hasOwnProperty.call(ENABLED, mode)) throw new GeneratorError('MINE_GENERATOR_UNKNOWN', String(mode));
  if (ENABLED[mode] !== true) {
    throw new GeneratorError(mode === 'AI_MINED_LLM' ? 'MINE_LLM_NOT_ENABLED' : 'MINE_GENERATOR_NOT_ENABLED', `${mode}: research key not placed (RF1116 P2, ★K (b)); GP only`);
  }
  return mode;
}

/** 按轮次清单的 generator 建生成方。space = 冻结空间的 DSL 部分；holdingPeriod = 本轮的持有期。 */
function generatorFor(generator, { space, holdingPeriod } = {}) {
  assertGeneratorEnabled(generator);
  return gp.createGp({ seed: generator.gp_seed, space, holdingPeriod });
}

module.exports = { ENABLED, GeneratorError, assertGeneratorEnabled, generatorFor };
