'use strict';

/**
 * Revocation (RF1118 section 3, AQ-41). A revocation is a separate page, `<ID>_K2_V1_FREEZE_PROGRAM_1_REVOCATION_1.md`, written by the coordinator's tool.
 * It never touches the freeze page, the frozen text, the report, their sidecars or the queue line. Runs already done are read as REVOKED_AFTER_RUN and
 * do not enter a verdict; the trial rows stay in N (nothing here touches the ledger).
 */
const fs = require('fs');
const path = require('path');
const { fail, need, isText, isCstStamp } = require('./common');

const nameOf = (draftId) => `${draftId}_K2_V1_FREEZE_PROGRAM_1_REVOCATION_1.md`;

function write(dir, { draftId, revokedBy, reason, now }) {
  need(isText(draftId) && isText(revokedBy) && isText(reason), 'REVOCATION_INVALID');
  need(isCstStamp(now), 'REVOCATION_INVALID', 'now');
  need(fs.existsSync(path.join(dir, `${draftId}_K2_V1_FREEZE_PROGRAM_1.md`)), 'REVOCATION_NO_FREEZE', draftId);
  const file = path.join(dir, nameOf(draftId));
  if (fs.existsSync(file)) fail('REVOCATION_EXISTS', draftId);
  const body = `# ${draftId} · FREEZE_PROGRAM_1 · REVOCATION_1\n\n- 撤回人：${revokedBy}\n- 时刻：${now}\n- 理由：${reason}\n\n冻结页、冻结文本、验证报告与 queue 行一字节不改；已跑的结果标 REVOKED_AFTER_RUN，不进判定；试验行留在 N 里。\n`;
  fs.writeFileSync(file, body, { mode: 0o444, flag: 'wx' });
  fs.chmodSync(file, 0o444);
  return { name: nameOf(draftId), file };
}

const read = (dir, draftId) => ({ revoked: fs.existsSync(path.join(dir, nameOf(draftId))) });

function statusOfRuns(dir, draftId, { runsDone }) {
  if (!read(dir, draftId).revoked) return runsDone ? 'NOT_REVOKED_RUNS_STAND' : 'NOT_REVOKED';
  return runsDone ? 'REVOKED_AFTER_RUN' : 'REVOKED_NO_RUN';
}

module.exports = { nameOf, write, read, statusOfRuns };
