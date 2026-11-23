'use strict';
// Writes the SYNTHETIC weekly compile files in weeks/ (weekId 2031-W07, revision 0 and 1): every id, text, date and hash in them is made up (no real desk or Owner data).
// Run from a portfolio-desk checkout (it needs the desk's src/canonical.js for the week hash), in a directory that has a weeks/ folder:
//   node make_synthetic_weeks.cjs    then    node ops/review-loop/ai-review-facts.cjs --week-file weeks/REVIEW_LOOP_WEEK_2031-W07[_R1].json --outbox <dir>
// The packs in linux/ and hk/ are the desk producer's own output for these two files (see MANIFEST.json).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { contentHash } = require('./src/canonical');
const h = (s) => crypto.createHash('sha256').update(`synthetic:${s}`).digest('hex');
const ev = (n, file) => ({ contract: 'SYNTHETIC_EVIDENCE_V1', file: `synthetic/evidence/${file}`, hash: h(file), path: `$.rows[${n}]` });
const WEEK = '2031-W07';

function build(rev) {
  const F = (n, market, trigger, ledger, fact, disposition, candidateId, evidence, reasonCode = 'SYN_REASON') => ({
    findingId: `SYN-2031W07-${n}`, triggerId: trigger, market, ledgerId: ledger, fact, evidence, disposition, reasonCode, route: 'SYN_ROUTE_A', candidateId });
  const C = (id, market, type, ledger, firstWeek, weeksSeen, findingIds) => ({
    candidateId: id, market, type, ledgerId: ledger, state: 'SYN_OPEN', ruleRef: [], effect: { state: 'NOT_MEASURED', reasonCode: 'SYN_NOT_MEASURED', unit: 'SYN_UNIT', value: null },
    sample: { n: weeksSeen, unit: 'EVENTS', floor: 1, state: 'AT_OR_ABOVE_FLOOR' }, recurrence: { firstWeek, weeksSeen }, findings: findingIds.map((findingId) => ({ findingId })) });
  const findings = [
    F(1, 'CN', 'SYN01', 'SYN_LEDGER_ALPHA', 'Synthetic finding one (made-up text for tests): item alpha repeated on several days.', 'ATTACHED', 'SYN-CN-2031W05-1', [ev(0, 'cn_a.json'), ev(1, 'cn_a.json')]),
    F(2, 'CN', 'SYN01', 'SYN_LEDGER_ALPHA', 'Synthetic finding two (made-up text for tests): item beta repeated on several days.', 'ATTACHED', 'SYN-CN-2031W05-1', [ev(2, 'cn_a.json')]),
    F(3, 'CN', 'SYN02', 'SYN_LEDGER_ALPHA', '合成示例：这是测试用的虚构文本，与任何真实数据无关。', 'NO_CANDIDATE', null, [ev(3, 'cn_b.json')]),
    F(4, 'CN', 'SYN03', 'SYN_LEDGER_BETA', rev ? 'Synthetic finding four, revised (made-up text for tests).' : 'Synthetic finding four (made-up text for tests).', 'NO_CANDIDATE', null, [ev(4, 'cn_c.json')]),
    F(5, 'US', 'SYN01', 'SYN_LEDGER_GAMMA', 'Synthetic finding five (made-up text for tests): item gamma.', 'ATTACHED', 'SYN-US-2031W06-1', [ev(0, 'us_a.json')]),
    F(6, 'US', 'SYN02', 'SYN_LEDGER_GAMMA', 'Synthetic finding six (made-up text for tests): item delta.', 'ATTACHED', 'SYN-US-2031W06-2', [ev(1, 'us_a.json')]),
    F(7, 'US', 'SYN04', 'SYN_LEDGER_GAMMA', 'Synthetic finding seven (made-up text for tests): item epsilon.', 'NO_CANDIDATE', null, [ev(2, 'us_b.json')]),
    F(8, 'US', 'SYN05', 'SYN_LEDGER_GAMMA', 'Synthetic finding eight (made-up text for tests): its evidence is a mining out file, so the desk firewall refuses it.', 'NO_CANDIDATE', null,
      [{ contract: 'SYNTHETIC_EVIDENCE_V1', file: 'synthetic/mining/out/SYN_SELECTION.json', hash: h('mining'), path: '$.rows[0]' }]),
    F(9, 'CRYPTO', 'SYN01', 'SYN_LEDGER_DELTA', 'Synthetic finding nine (made-up text for tests): item zeta.', 'ATTACHED', 'SYN-CRYPTO-2031W06-1', [ev(0, 'crypto_a.json')]),
    F(10, 'CRYPTO', 'SYN06', 'SYN_LEDGER_DELTA', 'Synthetic finding ten (made-up text for tests): item eta.', 'NO_CANDIDATE', null, [ev(1, 'crypto_b.json')]),
    F(11, 'CRYPTO', 'SYN06', 'SYN_LEDGER_DELTA', 'Synthetic finding eleven (made-up text for tests): item theta.', 'NO_CANDIDATE', null, [ev(2, 'crypto_b.json')]),
  ];
  const candidates = [
    C('SYN-CN-2031W05-1', 'CN', 'SYN_TYPE_A', 'SYN_LEDGER_ALPHA', '2031-W05', 3, ['SYN-2031W07-1', 'SYN-2031W07-2']),
    C('SYN-CN-2031W03-2', 'CN', 'SYN_TYPE_B', 'SYN_LEDGER_BETA', '2031-W03', 4, []),
    C('SYN-US-2031W06-1', 'US', 'SYN_TYPE_A', 'SYN_LEDGER_GAMMA', '2031-W06', 2, ['SYN-2031W07-5']),
    C('SYN-US-2031W06-2', 'US', 'SYN_TYPE_C', 'SYN_LEDGER_GAMMA', '2031-W06', 2, ['SYN-2031W07-6']),
    C('SYN-CRYPTO-2031W06-1', 'CRYPTO', 'SYN_TYPE_A', 'SYN_LEDGER_DELTA', '2031-W06', 2, ['SYN-2031W07-9']),
  ];
  const overdue = rev ? [] : [{ candidateId: 'SYN-CN-2031W03-2', step: 'SYN_STEP_REVIEW', since: '2031-01-27', days: 21, limitDays: 14 }];
  const week = {
    contract: 'REVIEW_LOOP_WEEK_V1', schemaVersion: 1, producer: 'SYNTHETIC_TEST_FIXTURE', weekId: WEEK, revision: rev, generatedAt: '2031-02-17T04:00:00.000Z', routes: 'SYN_ROUTES@v1',
    periods: { CN: { from: '2031-02-10', to: '2031-02-14', clock: 'SSE_SESSIONS' }, US: { from: '2031-02-10', to: '2031-02-14', clock: 'NYSE_SESSIONS' }, CRYPTO: { from: '2031-02-10', to: '2031-02-16', clock: 'UTC_DAYS' } },
    findings, candidates, overdue, ownerDecisions: [], register: [], researchReturns: [], triageDecisions: [], interpretation: 'SYNTHETIC_TEST_FIXTURE_NOT_REAL_DATA', realOrder: 0, brokerWrite: false,
  };
  return { ...week, hash: contentHash(week) };
}

for (const rev of [0, 1]) fs.writeFileSync(path.join('weeks', `REVIEW_LOOP_WEEK_${WEEK}${rev ? `_R${rev}` : ''}.json`), `${JSON.stringify(build(rev), null, 2)}\n`);
