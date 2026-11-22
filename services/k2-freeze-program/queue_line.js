'use strict';

/**
 * The one queue line per freeze: `K2_PROGRAM_FROZEN <ID> <k2 sha> <page sha> <market> <host>` (RF1118 V13). The program only builds the line;
 * the Mac relay appends it (with its own timestamp prefix) and `ensureLine` makes that append idempotent by k2 sha.
 */
const LINE = /(?:^|\s)K2_PROGRAM_FROZEN (\S+) ([0-9a-f]{64}) ([0-9a-f]{64}) (\S+) (\S+)\s*$/;

const lineFor = ({ draftId, k2Sha, pageSha, market, host }) => `K2_PROGRAM_FROZEN ${draftId} ${k2Sha} ${pageSha} ${market} ${host}`;

function parse(logText) {
  return String(logText || '').split('\n').map((l) => LINE.exec(l)).filter(Boolean)
    .map((m) => ({ draft_id: m[1], k2_sha256: m[2], page_sha256: m[3], market: m[4], host: m[5] }));
}
const count = (logText, k2Sha) => parse(logText).filter((l) => l.k2_sha256 === k2Sha).length;

function ensureLine(logText, line) {
  const m = LINE.exec(line);
  if (!m) throw new Error('QUEUE_LINE_INVALID');
  if (count(logText, m[2]) >= 1) return { text: logText, appended: false };
  const base = logText && !logText.endsWith('\n') ? `${logText}\n` : logText || '';
  return { text: `${base}${line}\n`, appended: true };
}

module.exports = { LINE, lineFor, parse, count, ensureLine };
