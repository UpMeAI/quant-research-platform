'use strict';

/**
 * 独立验证器编排（W20，PLAN V1.1 修订 1 §2；合同 docs/contracts/INDEPENDENT_VERIFIER_V1.md）。
 *
 * 固定顺序 V-1…V-6，前一项不过就停，原因码写明停在哪一项（V<n>_<码>）。输入是一份 INDEPENDENT_VERIFIER_INPUT_V1（文件合同，引用的文件按 sha256 复验）。
 * 输出两份：
 *   internal   内部报告（含各项读数，只给 plan-coord 与台账，不给生成方）；
 *   generator  生成方只收到 { candidateId, verdict: pass|fail, reasonCodes }，没有任何指标。
 * 同输入逐字节相同（没有时钟、随机数）。验证器不改输入。V-6 只在输入包声明已过 S3（reachedS3）时运行，否则记 NOT_RUN。
 */
const crypto = require('crypto');
const { canonicalJson } = require('../trial-ledger');
const authority = require('./authority');
const { runners } = require('./stages');

const STAGES = Object.freeze(['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
const GENERATOR_KEYS = Object.freeze(['candidateId', 'reasonCodes', 'verdict']);
const INPUT_SCHEMA = 'INDEPENDENT_VERIFIER_INPUT_V1';
const REPORT_SCHEMA = 'INDEPENDENT_VERIFIER_REPORT_V1';
const CODE = /^[A-Z][A-Z0-9_]*$/;

/** 原因码 = 阶段 + 闸门的错误码；错误细节（含数值）丢掉，认不出的码记 STAGE_ERROR。 */
function reasonCode(stage, err) {
  const code = err && typeof err.code === 'string' && CODE.test(err.code) ? err.code : 'STAGE_ERROR';
  return `${stage}_${code}`;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * @param {object} bundle INDEPENDENT_VERIFIER_INPUT_V1
 * @param {{readBytes: (ref: {path: string, sha256: string}) => Buffer|null, gateOptions?: object, promotionEngine?: object, authority?: object}} ctx
 * @returns {{internal: object, generator: {candidateId: string, verdict: 'pass'|'fail', reasonCodes: string[]}}}
 */
function verify(bundle, ctx) {
  const cfg = authority.loadConfig(); // 配置钉的 sha256 不符 → 拒绝运行
  const stages = []; const stagesRun = [];
  let failed = null; let reasonCodes = [];
  const input = { ...bundle, cfg };
  for (const stage of STAGES) {
    if (failed) { stages.push({ stage, status: 'NOT_RUN', codes: [], detail: {} }); continue; }
    if (stage === 'V6' && bundle.reachedS3 !== true) { stages.push({ stage, status: 'NOT_RUN', codes: [], detail: { reason: 'S3_NOT_REACHED' } }); continue; }
    stagesRun.push(stage);
    let out;
    try {
      if (!bundle || bundle.schema !== INPUT_SCHEMA) throw Object.assign(new Error('BUNDLE_INVALID'), { code: 'BUNDLE_INVALID' });
      out = runners[stage](input, ctx, cfg);
      out = { codes: out.codes.map((c) => `${stage}_${c}`), detail: out.detail };
    } catch (e) { out = { codes: [reasonCode(stage, e)], detail: {} }; }
    const status = out.codes.length ? 'FAIL' : 'PASS';
    stages.push({ stage, status, codes: out.codes, detail: out.detail });
    if (status === 'FAIL') { failed = stage; reasonCodes = out.codes.filter((c) => CODE.test(c.replace(/^V[1-6]_/, '')) && /^V[1-6]_[A-Z0-9_]+$/.test(c)); if (!reasonCodes.length) reasonCodes = [`${stage}_STAGE_ERROR`]; }
  }
  const verdict = failed ? 'fail' : 'pass';
  const candidateId = bundle && typeof bundle.candidateId === 'string' ? bundle.candidateId : '';
  const internal = { schema: REPORT_SCHEMA, contract: cfg.contract, candidateId, bundleSha256: sha(canonicalJson(bundle)), verdict, failedStage: failed, reasonCodes, stagesRun, stages };
  return { internal, generator: { candidateId, verdict, reasonCodes: [...reasonCodes] } };
}

const serializeInternal = (report) => `${canonicalJson(report)}\n`;
/** 生成方输出只有 GENERATOR_KEYS 三个键（schema 测试核键集合）。 */
const serializeGenerator = (g) => `${canonicalJson(Object.fromEntries(GENERATOR_KEYS.map((k) => [k, g[k]])))}\n`;

module.exports = { STAGES, GENERATOR_KEYS, INPUT_SCHEMA, REPORT_SCHEMA, reasonCode, verify, serializeInternal, serializeGenerator, authority };
