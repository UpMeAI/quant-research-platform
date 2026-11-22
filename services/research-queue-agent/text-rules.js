'use strict';
/** 三个验证器共用的文字规则：词表、密钥形状、数字必须在被引用的事实里。返回错误码，由调用方挂上各自的前缀。 */
const lexicon = require('./lexicon');
const { SECRET_SHAPED } = require('./canon');
const { numbersNotInFacts } = require('./facts');

/**
 * @param {string} text
 * @param {{prefix: string, lists: string[], cited?: string[], factsById?: Map, checkNumbers?: boolean}} o
 */
function textErrors(text, { prefix, lists = ['PREDICTION', 'VERDICT'], cited = [], factsById = null, checkNumbers = true }, path) {
  const out = [];
  const add = (code, detail) => out.push({ code: `${prefix}_${code}`, path, detail });
  const hits = lexicon.findWording(text, lists);
  for (const l of lists) { const h = hits.find((x) => x.list === l); if (h) add(`${l}_WORDING`, h.term); }
  if (SECRET_SHAPED.test(text)) add('SECRET_SHAPED');
  if (checkNumbers && factsById) {
    const bad = numbersNotInFacts(text, cited, factsById);
    if (bad.length) add('NUMBER_NOT_IN_FACT', bad.join(','));
  }
  return out;
}

module.exports = { textErrors };
