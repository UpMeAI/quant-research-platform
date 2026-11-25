'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
require('./_env');

const returns = require('../services/desk-review-routing/return');
const ai = require('../services/desk-review-routing/ai-return');
const canon = require('../services/research-queue-agent/canon');
const ideas = require('../services/research-queue-agent/factor-idea');
const F = require('./_rq_agent_fixture');
const schema = require('./_json_schema');
const RETURN_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'desk-schemas', 'qrp-research-return.v1.schema.json')));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const put = (file, value) => { const b = Buffer.from(`${JSON.stringify(value)}\n`); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, b); return sha(b); };

function fixture({ inlineRegistry = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q141-return-'));
  const host = path.join(root, 'linux'); fs.mkdirSync(host);
  const pack = F.makePack();
  const registry = F.makeRegistry();
  const packFile = path.join(root, 'pack.json');
  const registryFile = path.join(root, 'registry.json');
  const packSha = put(packFile, pack); put(registryFile, registry);
  const body = F.makeCard();
  const card = { schema: 'REVIEW_AI_CARD_V1', task_id: 'RQT-LINUX-20261125-q1410001', ...body,
    prompt_admission_sha256: 'a'.repeat(64), model: 'deepseek-flash' };
  const cardSha = canon.sha256(canon.canonicalJson(card));
  const records = ideas.buildIdeaRecords(card, F.ctx({ pack, registry }), {
    card_sha256: cardSha, prompt_admission_sha256: card.prompt_admission_sha256, model: card.model,
  });
  const bundleBody = {
    schema: 'RQ_VALIDATED_RETURN_V1', task_id: card.task_id, attempt_no: 1, host: 'LINUX',
    template_id: 'T-CARD', template_sha256: 'b'.repeat(64), kind: 'AI_REVIEW_CARD', market: 'CN_A',
    validator: { name: 'rq-consumer-revalidate', version: 'Q3C_V1' }, card, ideas: records,
    card_sha256: cardSha, ideas_sha256: canon.sha256(canon.canonicalJson(records)),
    fact_pack: { ref: packFile, sha256: packSha },
    registry: inlineRegistry
      ? { ref: 'in/bundle.json#/registry', sha256: canon.sha256(canon.canonicalJson(registry)) }
      : { ref: registryFile, sha256: canon.sha256(canon.canonicalJson(registry)) },
    result_sha256: 'c'.repeat(64), output_sha256: 'd'.repeat(64),
  };
  const bundle = { ...bundleBody, bundle_sha256: canon.sha256(canon.canonicalJson(bundleBody)) };
  put(path.join(host, `validated-return-${card.task_id}-a1.json`), bundle);
  return { root, pack, registry, card, records };
}

test('switch defaults off and off return bytes stay identical', () => {
  delete process.env.QRP_RETURN_AI_BLOCKS;
  assert.equal(returns.aiEnabled(), false);
  const a = returns.buildReturn({ generatedAt: '2026-11-25T08:00:00.000Z', aiBlocks: false });
  const b = returns.buildReturn({ generatedAt: '2026-11-25T08:00:00.000Z' });
  assert.deepEqual(a, b);
  assert.equal(Object.hasOwn(a, 'aiReviewCards'), false);
  assert.equal(Object.hasOwn(a, 'factorIdeas'), false);
});

for (const inlineRegistry of [false, true]) test(`validated producer bundle projects card and idea (${inlineRegistry ? 'bundle registry ref' : 'file registry ref'})`, () => {
  const fx = fixture({ inlineRegistry });
  const result = ai.load({ root: fx.root, registryFor: () => fx.registry });
  assert.equal(result.state, 'VERIFIED');
  assert.deepEqual(result.unverified, []);
  assert.equal(result.cards.length, 1);
  assert.equal(result.ideas.length, 1);
  assert.equal(result.cards[0].modelAlias, 'deepseek-flash');
  assert.deepEqual(result.cards[0].ideaIds, [fx.records[0].idea_id]);
  assert.equal(result.ideas[0].recordHash, canon.sha256(canon.canonicalJson(fx.records[0])));
  const generatedAt = '2026-11-25T08:00:00.000Z';
  const off = returns.buildReturn({ generatedAt, aiBlocks: false });
  const on = returns.buildReturn({ generatedAt, aiBlocks: true, aiReturnRoot: fx.root, aiOptions: { registryFor: () => fx.registry } });
  assert.deepEqual(schema.validate(RETURN_SCHEMA, on), []);
  const { aiReviewCards: _cards, factorIdeas: _ideas, hash: _onHash, ...onBase } = on;
  const { hash: _offHash, ...offBase } = off;
  assert.deepEqual(onBase, offBase);
});

test('missing directory is visible state, while a bad hash is UNVERIFIED and never projected', () => {
  const missing = ai.load({ root: path.join(os.tmpdir(), 'q141-no-such-return-root') });
  assert.equal(missing.state, 'NO_VALIDATED_AI_CARDS_YET');
  const fx = fixture();
  const file = fs.readdirSync(path.join(fx.root, 'linux')).map((n) => path.join(fx.root, 'linux', n))[0];
  const doc = JSON.parse(fs.readFileSync(file)); doc.card_sha256 = '0'.repeat(64);
  const body = { ...doc }; delete body.bundle_sha256; doc.bundle_sha256 = canon.sha256(canon.canonicalJson(body)); put(file, doc);
  const bad = ai.load({ root: fx.root, registryFor: () => fx.registry });
  assert.equal(bad.state, 'UNVERIFIED');
  assert.equal(bad.cards.length, 0);
  assert.match(bad.unverified[0].code, /CARD_SHA256/);
});
