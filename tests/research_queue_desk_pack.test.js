'use strict';
/**
 * AQ <-> desk: REVIEW_AI_FACT_PACK_V1 packs in the REAL shape the desk producer writes (ops/review-loop/ai-review-facts.cjs, desk PR #131) through the AQ JS consumers.
 * The packs are tests/fixtures/desk-fact-packs/: the desk producer's own output for two SYNTHETIC week files (made-up ids, texts, dates; plan-coord ruling 11-23 13:35: no real desk
 * content in this public repo); MANIFEST.json holds their sha256 and how they were made. The desk writes `contract` (not `schema`), `weekId` (not `week`), no `code_counts` (the counts
 * are COUNT facts) and no per-fact `window`. The QRP fixtures used to be written by QRP itself, which hid all of that.
 *   what must hold: the pack check, the fact map, the card validator (repeated patterns from the COUNT facts), the agent's prompt and run, the lab card step, the week reader.
 * Python side (relay, producer intake, one card per market and week): tests/research_queue/test_desk_pack_shape.py.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const F = require('./_rq_agent_fixture');
const V = require('../services/research-queue-agent');
const facts = require('../services/research-queue-agent/facts');
const { packSha } = require('../services/research-queue-agent/factor-idea');
const steps = require('../services/research-lab-e2e/steps');
const accessLog = require('../services/independent-verifier/access-log');

const DIR = path.join(__dirname, 'fixtures', 'desk-fact-packs');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'MANIFEST.json'), 'utf8'));
const PACKS = Object.keys(MANIFEST.packs).sort().map((rel) => {
  const bytes = fs.readFileSync(path.join(DIR, rel));
  return { rel, name: path.basename(rel), bytes, pack: JSON.parse(bytes.toString('utf8')) };
});
const byName = (n) => PACKS.find((p) => p.name === n).pack;
const CN_R1 = () => byName('REVIEW_AI_FACT_PACK_CN_A_2031-W07_R1.json');

const hostOf = (market) => (market === 'CN_A' ? 'LINUX' : 'HK');
const taskOf = (market) => ({ task_id: 'RQT-LINUX-20261124-aaaa1111', host: hostOf(market), agent_host: hostOf(market), kind: 'AI_REVIEW_CARD', market, template_id: 'AI_REVIEW_CARD_V1', template_sha256: F.sha('tpl'), attempt_no: 1 });
const okResp = (obj) => ({ ok: true, status: 200, data: { model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }], usage: {} } });
/** The last scripted answer repeats, so a rejected card shows up as a status and validator codes (not as an exhausted script). */
const mockClient = (script) => { const calls = []; return { calls, async chat(req) { calls.push(JSON.parse(JSON.stringify(req))); return script.length > 1 ? script.shift() : script[0]; } }; };
const codes = (v) => v.errors.map((e) => e.code);
/** The first repeated pattern a desk pack offers, read straight off its first COUNT fact (the test's own oracle, not the production helper): key "<subject>:<first code>". */
function firstPattern(pack) {
  const c = pack.facts.find((x) => x.kind === 'COUNT');
  const code = Object.keys(c.value.counts).sort()[0];
  return { pattern_key: `${c.value.subject}:${code}`, note_zh: '这个模式重复出现', count: c.value.counts[code], fact_ids: [c.id] };
}

/** A card for a real pack: every cited id is a real fact id; no repeated pattern unless asked (`over`); no digits in any sentence. */
function cardFor(pack, over = {}) {
  const f = pack.facts;
  const period = f.find((x) => x.kind === 'PERIOD');
  const findings = f.filter((x) => x.kind === 'FINDING');
  return F.makeCard({
    market: pack.market, week_id: pack.weekId,
    supporting: [{ text_zh: '本周有发现被记录', fact_ids: [period.id] }],
    opposing: [{ text_zh: '另有发现没有候选', fact_ids: [findings[0].id] }],
    unknowns: [{ text_zh: '原因没有给出', fact_ids: [period.id] }],
    repeated_patterns: [],
    factor_ideas: [F.goodIdea({ fact_ids: [findings[0].id, findings[1].id] })],
    ...over,
  });
}
const vctx = (pack) => ({ pack, registry: F.makeRegistry({ market: pack.market }), market: pack.market, week_id: pack.weekId, existing_idea_count: 0 });

/**
 * Where the lab card step also writes the pack's SEEN mark (the W05 branch: steps.card calls review_pack_seen.markPack) it needs the ledger authority and a ledger directory in the environment.
 * This test sets both itself (the authority name and a temp dir, restored afterwards) so it passes on plain main (the variables are unused there) and on main + W05.
 */
function withSeenLedger(fn) {
  const keys = ['QRP_PRODUCT_MILESTONE_AUTHORITY', 'QRP_DATA_DIR'];
  const keep = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-pack-ledger-'));
  process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = 'V8_1_COORDINATOR';
  process.env.QRP_DATA_DIR = ledgerDir;
  try { return fn(); } finally {
    for (const k of keys) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- the fixtures are the desk producer's bytes for synthetic weeks */
test('fixtures: six desk-shaped packs (3 markets x base/revision), byte for byte the manifest sha256, made from synthetic weeks; the desk header (contract, weekId, no schema/week/code_counts)', () => {
  assert.equal(PACKS.length, 6);
  for (const [rel, sha] of Object.entries(MANIFEST.week_files)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, rel))).digest('hex'), sha, rel);
  for (const p of PACKS) {
    assert.match(p.pack.sourceWeek.file, /^REVIEW_LOOP_WEEK_2031-W07(_R1)?\.json$/, `${p.name}: a synthetic week (2031), nothing real`);
    assert.ok(p.pack.facts.filter((x) => x.kind === 'FINDING').every((x) => /^SYN-/.test(x.value.findingId) && x.value.evidence.every((e) => /^synthetic\//.test(e.file))), `${p.name}: made-up findings only`);
    assert.equal(crypto.createHash('sha256').update(p.bytes).digest('hex'), MANIFEST.packs[p.rel], p.name);
    assert.equal(p.pack.contract, 'REVIEW_AI_FACT_PACK_V1', p.name);
    assert.equal(p.pack.producer, 'DESK_REVIEW_LOOP', p.name);
    for (const k of ['schema', 'week', 'week_id', 'code_counts']) assert.equal(k in p.pack, false, `${p.name} has no ${k}`);
    assert.match(p.pack.weekId, /^\d{4}-W\d{2}$/);
    assert.ok(p.pack.facts.every((x) => /^F-\d{3}$/.test(x.id) && x.source && x.source.sha256 === p.pack.sourceWeek.sha256 && /^\d{4}-\d{2}-\d{2}$/.test(x.at) && !('window' in x)), p.name);
  }
  assert.deepEqual(PACKS.map((p) => p.pack.market).sort(), ['CN_A', 'CN_A', 'CRYPTO', 'CRYPTO', 'US_EQUITY', 'US_EQUITY']);
  assert.deepEqual(PACKS.map((p) => p.pack.revision).sort(), [0, 0, 0, 1, 1, 1]);
});

/* ---------------------------------------------------------------- consumers that already accept the real shape (kept green) */
test('checkPack (card path and generator view) accepts every real pack; factsMap holds every fact; the size is far below the call limit', () => {
  for (const p of PACKS) {
    assert.deepEqual(facts.checkPack(p.pack, { purpose: 'CARD' }).errors, [], p.name);
    assert.deepEqual(facts.checkPack(p.pack, { purpose: 'GENERATOR_VIEW', maxTokens: Infinity }).errors, [], p.name);
    assert.equal(facts.factsMap(p.pack).size, p.pack.facts.length, p.name);
    assert.ok(facts.estimateTokens(p.pack) < facts.MAX_CALL_TOKENS / 4, `${p.name} ${facts.estimateTokens(p.pack)}`);
  }
});

test('lab card step (steps.card): a DONE card over a real pack passes with the review read range the agent logs (the date of the facts)', async () => {
  const pack = CN_R1();
  const client = mockClient([okResp(cardFor(pack))]);
  const task = taskOf(pack.market);
  const bundle = { schema: 'RQ_AGENT_BUNDLE_V1', market: pack.market, week_id: pack.weekId, pack, registry: F.makeRegistry({ market: pack.market }) };
  const result = await V.runAgentTask(task, bundle, { client, env: {}, host: 'LINUX', triage: () => ({ route: 'NORMAL_NO_PRIOR', cite_seal_sha256: [] }), now: () => '2026-11-24T10:00:00+08:00' });
  assert.equal(result.status, 'DONE', JSON.stringify(result));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-pack-lab-'));
  const days = pack.facts.map((x) => x.at.slice(0, 10)).sort();
  const logFile = path.join(dir, 'access_log.jsonl');
  accessLog.writer(logFile).record({ principal: 'review-agent', op: 'READ', dataset: 'REVIEW_FACT_PACK_V1', from: days[0], to: days[days.length - 1] });
  const resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(resultFile, JSON.stringify(result));
  const S = { job: { files: { card_result: resultFile, review_agent_access_log: logFile }, card_id: task.task_id, market: pack.market }, services: { bundle: () => bundle }, data: {}, asOf: '2026-11-24T18:00:00+08:00' };
  const r = withSeenLedger(() => steps.card(S));
  assert.equal(r.reason, undefined, r.reason);
  assert.deepEqual(Object.keys(r.files).sort(), ['card_result.json', 'review_agent_access_log.jsonl']);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- the week of a pack */
test('packWeek: the desk weekId, the QRP week / week_id; aliases that disagree, empty or non-string values are no week', () => {
  for (const p of PACKS) assert.equal(facts.packWeek(p.pack), p.pack.weekId, p.name);
  assert.equal(facts.packWeek({ week: '2026-W47' }), '2026-W47');
  assert.equal(facts.packWeek({ week_id: '2026-W47' }), '2026-W47');
  assert.equal(facts.packWeek({ week: '2026-W47', week_id: '2026-W47', weekId: '2026-W47' }), '2026-W47');
  assert.equal(facts.packWeek({ week: '2026-W47', weekId: '2026-W48' }), null);
  for (const bad of [{}, { weekId: '' }, { weekId: 46 }, { week: null }, null, 'x', []]) assert.equal(facts.packWeek(bad), null);
});

/* ---------------------------------------------------------------- repeated patterns: code counts from the COUNT facts */
test('codeCounts: the desk packs carry the counts as COUNT facts; they become [{key: "<subject>:<code>", count, fact_id}] in fact order, codes sorted', () => {
  assert.deepEqual(facts.codeCounts(CN_R1()), [
    { key: 'FINDINGS_BY_TRIGGER:SYN01', count: 2, fact_id: 'F-007' },
    { key: 'FINDINGS_BY_TRIGGER:SYN02', count: 1, fact_id: 'F-007' },
    { key: 'FINDINGS_BY_TRIGGER:SYN03', count: 1, fact_id: 'F-007' },
    { key: 'FINDINGS_BY_DISPOSITION:ATTACHED', count: 2, fact_id: 'F-008' },
    { key: 'FINDINGS_BY_DISPOSITION:NO_CANDIDATE', count: 2, fact_id: 'F-008' },
    { key: 'CANDIDATES_BY_TYPE:SYN_TYPE_A', count: 1, fact_id: 'F-009' },
  ]);
  for (const p of PACKS) {
    const got = facts.codeCounts(p.pack);
    assert.equal(new Set(got.map((x) => x.key)).size, got.length, `${p.name}: keys are unique`);
    for (const c of p.pack.facts.filter((x) => x.kind === 'COUNT')) {
      const mine = got.filter((x) => x.fact_id === c.id);
      assert.deepEqual(Object.fromEntries(mine.map((x) => [x.key.slice(c.value.subject.length + 1), x.count])), c.value.counts, `${p.name} ${c.id}`);
      assert.equal(mine.reduce((s, x) => s + x.count, 0), c.value.total, `${p.name} ${c.id} total`);
      assert.ok(mine.every((x) => x.key.startsWith(`${c.value.subject}:`)));
    }
  }
});

test('codeCounts: a pack with a code_counts array (the QRP shape) keeps it; no COUNT fact and no array is an empty list; malformed COUNT facts are skipped', () => {
  const native = [{ key: 'LATE_ENTRY', count: 3, fact_id: 'F-004' }];
  assert.deepEqual(facts.codeCounts(F.makePack()), native);
  assert.deepEqual(facts.codeCounts({ facts: [{ id: 'F-001', kind: 'PERIOD', value: {} }] }), []);
  assert.deepEqual(facts.codeCounts(null), []);
  const bad = { facts: [{ id: 'F-001', kind: 'COUNT', value: { subject: 'S', counts: { A: 1.5, B: 'x', C: 2 } } }, { id: 'F-002', kind: 'COUNT', value: { counts: { A: 1 } } }, { id: 'F-003', kind: 'COUNT', value: null }] };
  assert.deepEqual(facts.codeCounts(bad), [{ key: 'S:C', count: 2, fact_id: 'F-001' }]);
});

test('validateCard on a real pack: a repeated pattern with a derived key and its count passes; another count, or the bare code without the subject, is refused', () => {
  const pack = CN_R1();
  assert.deepEqual(codes(V.validateCard(cardFor(pack), vctx(pack))), []);
  const key = 'FINDINGS_BY_TRIGGER:SYN01';
  const pat = (over) => cardFor(pack, { repeated_patterns: [{ pattern_key: key, note_zh: '这个模式重复出现', count: 2, fact_ids: ['F-007'], ...over }] });
  assert.deepEqual(codes(V.validateCard(pat({}), vctx(pack))), []);
  assert.deepEqual(codes(V.validateCard(pat({ count: 3 }), vctx(pack))), ['CARD_PATTERN_COUNT_MISMATCH']);
  assert.deepEqual(codes(V.validateCard(pat({ pattern_key: 'SYN01' }), vctx(pack))), ['CARD_PATTERN_UNKNOWN']);
  assert.deepEqual(codes(V.validateCard(pat({ pattern_key: 'FINDINGS_BY_TRIGGER:SYN99' }), vctx(pack))), ['CARD_PATTERN_UNKNOWN']);
});

test('agent run on every real pack: the prompt carries the derived counts as repeated_pattern_counts, the card passes, the idea record is bound to the pack sha', async () => {
  for (const p of PACKS) {
    const pack = p.pack;
    const client = mockClient([okResp(cardFor(pack, { repeated_patterns: [firstPattern(pack)] }))]);
    const bundle = { schema: 'RQ_AGENT_BUNDLE_V1', market: pack.market, week_id: pack.weekId, pack, registry: F.makeRegistry({ market: pack.market }) };
    const r = await V.runAgentTask(taskOf(pack.market), bundle, { client, env: {}, host: hostOf(pack.market), triage: () => ({ route: 'NORMAL_NO_PRIOR', cite_seal_sha256: [] }), now: () => '2026-11-24T10:00:00+08:00' });
    assert.equal(r.status, 'DONE', `${p.name} ${JSON.stringify(r.calls)}`);
    assert.equal(client.calls.length, 1, `${p.name}: one call, no revision`);
    const user = JSON.parse(client.calls[0].body.messages[1].content);
    assert.deepEqual(user.repeated_pattern_counts, facts.codeCounts(pack), p.name);
    assert.ok(user.repeated_pattern_counts.length > 0, p.name);
    assert.equal(user.week_id, pack.weekId);
    assert.equal(r.outputs.factor_ideas[0].fact_pack_sha256, packSha(pack), p.name);
    assert.equal(r.outputs.factor_ideas[0].week_id, pack.weekId);
  }
});
