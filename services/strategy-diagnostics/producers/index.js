'use strict';

/**
 * M1 诊断生产者按 id 选择（CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE §9.5）。策略档案的 `m1_evidence.producer` 指向这里的一项；
 * LEGACY_V1 档案（US_V5）不写，默认 US_V5_M1_PRODUCER_V1（改造前的 buildDiagnostic）。非 LEGACY 档案不写或写了未登记的 id，
 * 诊断失败关闭（DIAGNOSTIC_PRODUCER_NOT_REGISTERED），不借用别的策略的生产者。
 * 本文件没有顶层 require：策略档案校验器在加载时读这张表，生产者模块到调用时才加载。
 */
const LEGACY_DEFAULT = 'US_V5_M1_PRODUCER_V1';
const REGISTERED = Object.freeze({
  US_V5_M1_PRODUCER_V1: () => require('..').buildUsV5Diagnostic,
  QS_V3_M1_PRODUCER_V1: () => require('./QS_V3_M1_PRODUCER_V1').build,
  US_CORE_M1_PRODUCER_V1: () => require('./US_CORE_M1_PRODUCER_V1').build,
});

const isRegistered = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(REGISTERED, id);

/** `legacy`：档案是否为 LEGACY_V1。返回 { id, build }；没有可用的生产者时抛 DIAGNOSTIC_PRODUCER_NOT_REGISTERED。 */
function resolve(producerId, { legacy = false } = {}) {
  const id = producerId === undefined && legacy ? LEGACY_DEFAULT : producerId;
  if (!isRegistered(id)) {
    const error = new Error('DIAGNOSTIC_PRODUCER_NOT_REGISTERED');
    error.code = 'DIAGNOSTIC_PRODUCER_NOT_REGISTERED';
    error.producer = id || null;
    throw error;
  }
  return { id, build: REGISTERED[id]() };
}

module.exports = { LEGACY_DEFAULT, IDS: Object.freeze(Object.keys(REGISTERED)), isRegistered, resolve };
