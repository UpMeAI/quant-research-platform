'use strict';

/**
 * W21 acceptance: a factor idea may cite only registered readings that belong
 * to the market's frozen MINING_SPACE_V1. The same check protects drafts and
 * persisted FACTOR_IDEA_V1 records; the validator itself receives the host-side
 * registry view and never reads files.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./_rq_agent_fixture');
const V = require('../services/research-queue-agent');

const codes = (r) => r.errors.map((e) => e.code);

test('W21: registered CN readings inside the frozen mining space pass', () => {
  assert.deepEqual(V.validateIdeaDraft(F.goodIdea(), F.ctx()).errors, []);
});

test('W21: a registered reading outside the frozen mining space is refused with its id and space sha', () => {
  const spaceSha = F.sha('fixture-mining-space');
  const idea = F.goodIdea({ readings: ['RS60', 'CN_A.MOM.RS60_MARKET_PCT'] });
  assert.deepEqual(V.validateIdeaDraft(idea, F.ctx()).errors, [{
    code: 'FACTOR_IDEA_READING_NOT_IN_MINING_SPACE',
    detail: `CN_A.MOM.RS60_MARKET_PCT@${spaceSha}`,
  }]);
});

for (const market of ['US_EQUITY', 'CRYPTO']) {
  test(`W21: ${market} without a frozen mining space fails closed`, () => {
    const registry = F.makeRegistry({
      market,
      mining_space: null,
      readings: {
        R1: { pit_available_at: 'T close', origin: 'FACTOR_LIBRARY' },
        R2: { pit_available_at: 'T close', origin: 'FACTOR_LIBRARY' },
      },
      holding_periods: [5],
    });
    const idea = F.goodIdea({ readings: ['R1', 'R2'], holding_periods: [5] });
    assert.deepEqual(codes(V.validateIdeaDraft(idea, F.ctx({ market, registry }))), ['FACTOR_IDEA_NO_FROZEN_SPACE']);
  });
}

test('W21: a persisted record tampered to cite an outside reading is refused', () => {
  const ctx = F.ctx();
  const rec = V.buildIdeaRecords(F.makeCard(), ctx, {
    card_sha256: F.sha('card'), prompt_admission_sha256: F.sha('admission'), model: 'deepseek-flash',
  })[0];
  rec.readings[1] = {
    id: 'CN_A.MOM.RS60_MARKET_PCT',
    pit_available_at: ctx.registry.readings['CN_A.MOM.RS60_MARKET_PCT'].pit_available_at,
  };
  assert.deepEqual(V.validateIdeaRecord(rec, ctx).errors, [{
    code: 'FACTOR_IDEA_READING_NOT_IN_MINING_SPACE',
    detail: `CN_A.MOM.RS60_MARKET_PCT@${ctx.registry.mining_space.sha256}`,
  }]);
});
