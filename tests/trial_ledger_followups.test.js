'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const followups = require('../services/trial-ledger/followups');
const ledger = require('../services/trial-ledger');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('FORWARD_RESERVED：只转换 STARTED，日期按市场时区落日，开放终点由调用方显式给出', () => {
  const registry = {
    schema: 'FORWARD_SHADOW_TSTART_REGISTRY_V1',
    rows: [
      { masterTableRow: 'C02', market: '加密', status: 'STARTED', T_start: '2026-10-27T23:30:00Z', T_start_precision: 'INSTANT', to: '2027-04-30', shadow_ref: 'QS-C02', sources: [{ file: 'freeze', sha256: 'a'.repeat(64) }] },
      { masterTableRow: 'U09', market: '美股', status: 'STARTED', T_start: '2026-11-04T01:30:00Z', T_start_precision: 'INSTANT', to: null, shadow_ref: 'UC-U09', sources: [{ file: 'lock', sha256: 'b'.repeat(64) }] },
      { masterTableRow: 'A19', market: 'A股', status: 'STARTED', T_start: '2026-10-29', T_start_precision: 'DATE', to: null, shadow_ref: 'CN-A19', sources: [] },
      { masterTableRow: 'X03a', market: '跨市场', status: 'STARTED', T_start: '2026-10-28', T_start_precision: 'DATE', to: null, shadow_ref: 'ALL-X03a', sources: [] },
      { masterTableRow: 'U11', market: '美股', status: 'NOT_STARTED', T_start: 'NOT_STARTED', T_start_precision: null, to: null, shadow_ref: 'US-U11', sources: [] },
    ],
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-forward-')), 'registry.json');
  fs.writeFileSync(file, JSON.stringify(registry));
  const marks = followups.forwardReservedFromRegistry({
    file,
    sha256: sha(fs.readFileSync(file)),
    familyMap: {
      C02: ['QUICK_SHOT_V3_1000USDT'], U09: ['US_CORE_9000USD_3X_GATEOBS'], A19: ['ASHARE_V6_PAPER'], U11: ['US_V5_ETF_3000USD'],
      X03a: [
        { family_id: 'US_V5_ETF_3000USD', market: 'US_EQUITY' },
        { family_id: 'C17_V2_4000USDT', market: 'CRYPTO_USDM_PERP' },
        { family_id: 'CARRY_V2_SHADOW_10000USDT', market: 'CRYPTO' },
      ],
    },
    openEndedTo: '9999-12-31',
  });
  assert.deepEqual(marks.map((m) => [m.family_id, m.from, m.to]), [
    ['QUICK_SHOT_V3_1000USDT', '2026-10-27', '2027-04-30'],
    ['US_CORE_9000USD_3X_GATEOBS', '2026-11-03', '9999-12-31'],
    ['ASHARE_V6_PAPER', '2026-10-29', '9999-12-31'],
    ['US_V5_ETF_3000USD', '2026-10-28', '9999-12-31'],
    ['C17_V2_4000USDT', '2026-10-28', '9999-12-31'],
    ['CARRY_V2_SHADOW_10000USDT', '2026-10-28', '9999-12-31'],
  ]);
  assert.deepEqual(marks.slice(-3).map((m) => m.market), ['US_EQUITY', 'CRYPTO_USDM_PERP', 'CRYPTO']);
  assert.ok(marks.every((m) => m.label === 'FORWARD_RESERVED' && m.source_refs[0].registry_sha256 === sha(fs.readFileSync(file))));
  assert.throws(() => followups.forwardReservedFromRegistry({ file, sha256: '0'.repeat(64), familyMap: {}, openEndedTo: '9999-12-31' }), (e) => e.code === 'TRIAL_LEDGER_FOLLOWUP_SOURCE_SHA256_MISMATCH');
});

test('UNCOUNTED_HISTORY：冻结下限逐族生成，角色、来源与下限通过既有台账校验', () => {
  const specs = followups.uncountedHistorySpecs([
    { family_id: 'US_CORE_9000USD_3X_GATEOBS', market: 'US_EQUITY', study_ref: 'HIST:BOLLINGER', lower_bound: 2, source_refs: [{ ref: 'BOLLINGER §3.1' }] },
    { family_id: 'C17_V2_4000USDT', market: 'CRYPTO_USDM_PERP', study_ref: 'HIST:BB_VOLUME', lower_bound: 4, source_refs: [{ ref: 'BB V0-V3' }] },
  ]);
  assert.deepEqual(specs.map((s) => [s.family_id, s.role, s.uncounted_lower_bound]), [
    ['US_CORE_9000USD_3X_GATEOBS', 'UNCOUNTED_HISTORY', 2],
    ['C17_V2_4000USDT', 'UNCOUNTED_HISTORY', 4],
  ]);
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'TEST_FOLLOWUP_AUTHORITY';
  const rows = ledger.register(specs, { registeredBy: 'TEST_FOLLOWUP_AUTHORITY', mode: 'BACK_REGISTERED', dryRun: true, registeredAt: '2026-11-10T10:00:00Z' });
  assert.equal(rows.length, 2);
  assert.throws(() => followups.uncountedHistorySpecs([{ family_id: 'X', market: 'Y', study_ref: 'H', lower_bound: 0, source_refs: [] }]), (e) => e.code === 'TRIAL_LEDGER_FOLLOWUP_UNCOUNTED_INVALID');
});
