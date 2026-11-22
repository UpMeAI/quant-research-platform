'use strict';

/**
 * 轮次的打分中性化版本（RF1116 修订「评分的市值中性化 V2」FREEZE_1 1aaf43e0 / 正文 f67701e9，N2）。
 * 版本跟着轮走，不设默认：
 *   - 第 1、2 轮在修订之前开的，按冻结时的 LINEAR_RAW_V1 打分（名单 LEGACY_LINEAR_RAW_V1_ROUNDS，冻结、不扩）；
 *   - 新开的轮，轮次清单写 scoring_neutralization: 'RANK_GAUSS_V2'（openRound 写）；
 *   - 其余（不在名单、清单里也没写，或写的不认识）→ MINE_RUNNER_NEUTRALIZATION_UNKNOWN；名单里的轮清单却写了别的版本 → MINE_RUNNER_NEUTRALIZATION_LEGACY_CONFLICT。
 * 版本串的权威定义在 services/mining-sandbox/evaluator 的 NEUTRALIZATIONS；这里只管「哪一轮用哪一个」。
 */
const LEGACY_LINEAR_RAW_V1_ROUNDS = Object.freeze(['MR-CN_A-2026-11-e1ab63a27b', 'MR-CN_A-2026-11-2a1d2c9c82']);
const NEW_ROUND_NEUTRALIZATION = 'RANK_GAUSS_V2';

class NeutralizationError extends Error {
  constructor(code, detail) { super(detail === undefined ? code : `${code}:${detail}`); this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new NeutralizationError(`MINE_RUNNER_${code}`, detail); };

function neutralizationOf(head) {
  const versions = require('../mining-sandbox/evaluator').NEUTRALIZATION_VERSIONS;
  if (!head || typeof head.round_id !== 'string') fail('NEUTRALIZATION_UNKNOWN', 'no round head');
  const written = head.scoring_neutralization;
  if (LEGACY_LINEAR_RAW_V1_ROUNDS.includes(head.round_id)) {
    if (written !== undefined && written !== null && written !== 'LINEAR_RAW_V1') fail('NEUTRALIZATION_LEGACY_CONFLICT', `${head.round_id}:${written}`);
    return 'LINEAR_RAW_V1';
  }
  if (typeof written === 'string' && versions.includes(written)) return written;
  return fail('NEUTRALIZATION_UNKNOWN', `${head.round_id}:${written === undefined ? 'unset' : String(written)}`);
}

module.exports = { LEGACY_LINEAR_RAW_V1_ROUNDS, NEW_ROUND_NEUTRALIZATION, NeutralizationError, neutralizationOf };
