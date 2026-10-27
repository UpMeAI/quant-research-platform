'use strict';
/**
 * 测试用的 JSON Schema（2020-12）子集校验器，不引入依赖：type、const、enum、pattern、minLength、minimum、format date-time、
 * required、properties、additionalProperties: false、items、minItems、anyOf、$ref（#/$defs/…）。
 * 用来核对回程文件与研究队列夹具符合 desk 的两份 schema（tests/fixtures/desk-schemas/，取自 portfolio-desk ea31a3e，只有字段形状）。
 */
const TYPES = {
  string: (v) => typeof v === 'string', number: (v) => typeof v === 'number' && Number.isFinite(v), integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean', object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v), array: Array.isArray, null: (v) => v === null,
};
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validate(schema, value, root = schema, at = '$', errors = []) {
  if (schema.$ref) {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    if (!name || !root.$defs[name[1]]) { errors.push(`${at}: unknown $ref ${schema.$ref}`); return errors; }
    return validate(root.$defs[name[1]], value, root, at, errors);
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((option) => validate(option, value, root, at, []).length === 0)) errors.push(`${at}: no anyOf option matches`);
    return errors;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => item === value)) errors.push(`${at}: enum ${JSON.stringify(schema.enum)} got ${JSON.stringify(value)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => TYPES[type](value))) { errors.push(`${at}: type ${types.join('|')} got ${JSON.stringify(value)}`); return errors; }
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: pattern ${schema.pattern} got ${value}`);
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${at}: minLength`);
    if (schema.format === 'date-time' && !(DATE_TIME.test(value) && Number.isFinite(Date.parse(value)))) errors.push(`${at}: date-time got ${value}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: minimum ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: minItems ${schema.minItems}`);
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, root, `${at}[${i}]`, errors));
  }
  if (TYPES.object(value)) {
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${at}: missing ${key}`);
    const props = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (props[key]) validate(props[key], item, root, `${at}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown key ${key}`);
    }
  }
  return errors;
}

module.exports = { validate };
