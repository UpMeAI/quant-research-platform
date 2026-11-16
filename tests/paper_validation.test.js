'use strict';
/**
 * PAPER_VALIDATION_V1（RF1116 §5，签字 fd22876f / 39f8c17c）—— §5.3 的反例、§8.3 第 5 条、晋级门进 PROMOTION_CANDIDATE_V1、
 * 现有五个前向影子原样登记（逐字节对出处）、现有影子台账行为不变。全部是合成夹具。
 */
const { dataRoot } = require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { append } = require('../packages/ledger');
const { validateRecord } = require('../schemas');
const trials = require('../services/trial-ledger');
const raceV2 = require('../services/race-orchestrator/v2');
const pv = require('../services/shadow-control/paper-validation');
const shadow = require('../services/shadow-control');
const experiments = require('../services/experiment-orchestrator');
const controlPlane = require('../services/strategy-control-plane');
const { setupExperiment } = require('./_fixture');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };

/** 合成交易日历：2026-11-02 起的工作日。 */
const CAL = (() => {
  const out = []; const d = new Date(Date.UTC(2026, 10, 2));
  while (out.length < 400) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
})();
const CALENDAR = { ref: 'calendar:synthetic-weekdays', days: CAL };

let raceN = 0;
/** 合成一行已关闭的 RACE_V2（记录哈希照真实算法），C1 晋级（回测 MDD 0.10），C2 淘汰。 */
function closedRace({ market = 'CN_A', closedAt = '2026-11-20T08:00:00Z', status = 'CLOSED', tamper = false, mdd = 0.10 } = {}) {
  raceN += 1;
  const manifestSha = sha(`manifest-${raceN}`);
  const body = {
    schema: 'RACE_V2', race_id: `RACE2-${market}-SELECTION_TIMING-${manifestSha.slice(0, 12)}`, status, market, partition: 'SELECTION_TIMING',
    manifest_sha256: manifestSha, freeze: { path: 'synthetic', sha256: sha('freeze') }, manifest: { champion: { entrant_id: 'CHAMP', book_ref: 'ACCOUNT' } },
    signed: raceV2.SIGNED, entry: [], cost_model: { ref: 'synthetic' },
    outcome: status === 'CLOSED' ? { state: 'RANKED', champion: { entrant_id: 'CHAMP', mdd: 0.12 }, promoted: ['C1'],
      entrants: [{ entrant_id: 'C1', book_ref: 'ACCOUNT', mdd }, { entrant_id: 'C2', book_ref: 'ACCOUNT', mdd: 0.2 }] } : null,
    production_effect: 'NONE', opened_at: '2026-11-18T00:00:00Z', closed_at: status === 'CLOSED' ? closedAt : null,
  };
  body.record_hash = trials.recordHash(body);
  if (tamper) body.outcome.promoted = ['C1', 'C2'];
  append(raceV2.LEDGER(), body);
  return body;
}

const REG = { holding_period_trading_days: 1, discrete_trades: false, calendar: CALENDAR, registeredAt: '2026-11-21T02:00:00Z',
  mechanism: { ref: 'mechanism:synthetic', statement_zh: '合成机制' } };
function registered(extra = {}, raceOpts = {}) {
  const race = closedRace(raceOpts);
  return pv.registerNew({ race: { race_id: race.race_id, entrant_id: 'C1' }, shadow_ref: 'SHD-synthetic', ...REG, ...extra });
}

const START = '2026-11-23'; // 2026-11-20（周五）16:00 CST 关闭后的下一个交易日
const at = (i) => CAL[CAL.indexOf(START) + i];
/** 从起始日起第 from 个交易日开始的 n 个会话。 */
const sessions = (from, n, { chal = 0.001, champ = 0.0005, fills = 1 } = {}) =>
  Array.from({ length: n }, (_, k) => ({ date: at(from + k), challenger_logret: chal, champion_logret: champ, fills }));
const fwd = (o = {}) => ({ source: { ref: 'recorder:synthetic', sha256: 'a'.repeat(64) }, sessions: [], faults: [], mechanism_falsified: null,
  guardrail_breaches: [], run_health: { healthy: true, ref: 'health:synthetic' }, ...o });

test('登记：起始日 = 赛马关闭后的下一个交易日；早于登记日、不是下一个交易日、赛马未关闭或参赛者未晋级 → 拒绝', () => {
  // §8.3 第 5 条：起始日早于登记日被拒（11-24 才登记，起始日 11-23 已过）
  assert.throws(() => registered({ registeredAt: '2026-11-24T02:00:00Z' }), code(/PAPER_VALIDATION_START_BEFORE_REGISTRATION:2026-11-23<2026-11-24/));
  assert.throws(() => registered({ start_date: '2026-11-24' }), code(/START_NOT_NEXT_TRADING_DAY_AFTER_RACE_CLOSE/));
  assert.throws(() => registered({ start_date: '2026-11-20' }), code(/START_NOT_NEXT_TRADING_DAY_AFTER_RACE_CLOSE/));
  assert.throws(() => registered({}, { status: 'OPEN' }), code(/RACE_NOT_CLOSED/));
  assert.throws(() => registered({}, { tamper: true }), code(/RACE_RECORD_HASH_MISMATCH/));
  const race = closedRace();
  assert.throws(() => pv.registerNew({ race: { race_id: race.race_id, entrant_id: 'C2' }, shadow_ref: 'S', ...REG }), code(/ENTRANT_NOT_PROMOTED/));
  assert.throws(() => pv.registerNew({ race: { race_id: race.race_id, entrant_id: 'C1' }, shadow_ref: 'S', ...REG, calendar: { ref: 'c', days: CAL.slice(0, 10) } }), code(/CALENDAR_INCOMPLETE/));
  assert.throws(() => pv.registerNew({ race: { race_id: race.race_id, entrant_id: 'C1' }, shadow_ref: 'S', ...REG, mechanism: undefined }), code(/MECHANISM_MISSING/));

  const r = registered();
  assert.equal(r.start.date, START);
  assert.equal(r.registered_on, '2026-11-21');
  assert.equal(r.expiry.date, '2027-11-23');
  assert.equal(r.withdrawal.economic.forward_mdd_limit, 1.5 * 0.10);
  assert.equal(r.champion.entrant_id, 'CHAMP');
  assert.deepEqual(r.promotion_gate.requires, ['NOT_CLAIM_ELIGIBLE', 'NAV_BELOW_CHAMPION', 'GUARDRAIL_BREACH', 'RUN_NOT_HEALTHY']);
  assert.ok(validateRecord(r, 'PAPER_VALIDATION_V1').ok);
  // 开跑之前冻结：同一参赛者不能再登记一次
  assert.throws(() => pv.registerNew({ race: r.race, shadow_ref: 'S', ...REG }), code(/ALREADY_REGISTERED/));
  // 美股按纽约日期：21:00 ET 周五关闭 → 下一个交易日周一
  const us = registered({ registeredAt: '2026-11-21T12:00:00Z' }, { market: 'US', closedAt: '2026-11-21T02:00:00Z' });
  assert.equal(us.race.closed_on, '2026-11-20');
  assert.equal(us.start.date, '2026-11-23');
});

test('最小样本 = max(60 交易日, 20 个持有期)，离散交易另要 ≥ 30 笔；不足量只能 DESCRIBE_ONLY', () => {
  assert.deepEqual([1, 3, 5].map((h) => pv.internals.minSampleOf(h, false).trading_days), [60, 60, 100]);
  assert.equal(pv.internals.minSampleOf(1, true).fills, 30);
  assert.equal(pv.internals.minSampleOf(1, false).fills, null);
  assert.throws(() => pv.internals.minSampleOf(0, false), code(/HOLDING_PERIOD_INVALID/));
  assert.throws(() => pv.internals.minSampleOf(1, undefined), code(/DISCRETE_TRADES_UNDECLARED/));

  const r = registered();
  const e59 = pv.evaluate(r, fwd({ sessions: sessions(0, 59) }), at(58));
  assert.equal(e59.state, 'RUNNING_DESCRIBE_ONLY');
  assert.equal(e59.claim_status, 'DESCRIBE_ONLY');
  assert.deepEqual(e59.promotion_gate.blockers, ['NOT_CLAIM_ELIGIBLE']);
  const e60 = pv.evaluate(r, fwd({ sessions: sessions(0, 60) }), at(59));
  assert.equal(e60.claim_status, 'CLAIM_ELIGIBLE');
  assert.equal(e60.promotion_gate.pass, true);
  // 起始日之前的会话不计（不追溯）
  const pre = [{ date: '2026-11-20', challenger_logret: 0.01, champion_logret: 0, fills: 1 }];
  const ePre = pv.evaluate(r, fwd({ sessions: [...pre, ...sessions(0, 59)] }), at(58));
  assert.equal(ePre.counted.sessions, 59);
  assert.equal(ePre.ignored_pre_start_sessions, 1);
  assert.equal(pv.evaluate(r, fwd(), '2026-11-21').state, 'PENDING_START');

  const h5 = registered({ holding_period_trading_days: 5 });
  assert.equal(pv.evaluate(h5, fwd({ sessions: sessions(0, 99) }), at(98)).claim_status, 'DESCRIBE_ONLY');
  assert.equal(pv.evaluate(h5, fwd({ sessions: sessions(0, 100) }), at(99)).claim_status, 'CLAIM_ELIGIBLE');

  const d = registered({ discrete_trades: true });
  const few = sessions(0, 60).map((s, i) => ({ ...s, fills: i < 29 ? 1 : 0 }));
  assert.equal(pv.evaluate(d, fwd({ sessions: few }), at(59)).claim_status, 'DESCRIBE_ONLY');
  assert.equal(pv.evaluate(d, fwd({ sessions: few.map((s, i) => ({ ...s, fills: i < 30 ? 1 : 0 })) }), at(59)).claim_status, 'CLAIM_ELIGIBLE');
  assert.throws(() => pv.evaluate(d, fwd({ sessions: [{ date: at(0), challenger_logret: 0, champion_logret: 0 }] }), at(0)), code(/FORWARD_SESSION_FILLS_MISSING/));
});

test('运行故障：暂停，修复日起重计，之前的样本作废', () => {
  const r = registered();
  const all = sessions(0, 110);
  const fault = { kind: 'LOOKAHEAD', detected_on: at(40), fixed_on: null, ref: 'fault:synthetic' };
  // 修好之前：暂停，只能描述，运行不健康
  const open = pv.evaluate(r, fwd({ sessions: all.slice(0, 43), faults: [fault] }), at(42));
  assert.equal(open.state, 'PAUSED_RUN_FAULT');
  assert.equal(open.claim_status, 'DESCRIBE_ONLY');
  assert.equal(open.voided_sessions, 40);
  assert.equal(open.paused_sessions, 3);
  assert.ok(open.promotion_gate.blockers.includes('RUN_NOT_HEALTHY'));
  // 第 44 个会话那天修好：从修复日起重计，60 个才够
  const fixed = { ...fault, fixed_on: at(44) };
  const e103 = pv.evaluate(r, fwd({ sessions: all.slice(0, 103), faults: [fixed] }), at(102));
  assert.equal(e103.counted.from, at(44));
  assert.equal(e103.counted.sessions, 59);
  assert.equal(e103.voided_sessions, 40);
  assert.equal(e103.paused_sessions, 4);
  assert.equal(e103.claim_status, 'DESCRIBE_ONLY');
  assert.equal(pv.evaluate(r, fwd({ sessions: all.slice(0, 104), faults: [fixed] }), at(103)).claim_status, 'CLAIM_ELIGIBLE');
  // 已足量之后出故障：样本作废，回到不足量
  const late = { kind: 'DATA_CONTAMINATION', detected_on: at(70), fixed_on: at(70), ref: 'fault:late' };
  const eLate = pv.evaluate(r, fwd({ sessions: all.slice(0, 80) , faults: [late] }), at(79));
  assert.equal(eLate.voided_sessions, 70);
  assert.equal(eLate.counted.sessions, 10);
  assert.equal(eLate.claim_status, 'DESCRIBE_ONLY');
  assert.throws(() => pv.evaluate(r, fwd({ faults: [{ ...fault, kind: 'OTHER' }] }), at(1)), code(/FAULT_INVALID/));
  assert.throws(() => pv.evaluate(r, fwd({ faults: [{ ...fault, fixed_on: at(39) }] }), at(1)), code(/FAULT_FIX_DATE_INVALID/));
});

test('经济证伪：前向最大回撤 > 1.5 × 回测最大回撤，或机制被证伪 → 停止，记负结果；终态之后不再记', () => {
  const r = registered(); // 回测 MDD 0.10 → 上限 0.15
  const drop = (dd) => [...sessions(0, 5), { date: at(5), challenger_logret: Math.log(1 - dd), champion_logret: 0, fills: 1 }, ...sessions(6, 60)];
  const under = pv.evaluate(r, fwd({ sessions: drop(0.149) }), at(65));
  assert.notEqual(under.state, 'STOPPED_NEGATIVE');
  assert.ok(Math.abs(under.forward_mdd - 0.149) < 1e-12);
  const over = pv.evaluate(r, fwd({ sessions: drop(0.151) }), at(65));
  assert.equal(over.state, 'STOPPED_NEGATIVE');
  assert.deepEqual(over.reasons, ['FORWARD_MDD_OVER_1_5X_BACKTEST']);
  assert.equal(over.terminal_on, at(5));
  // 运行故障作废的样本不拿来算回撤（之前的样本作废）
  const voided = pv.evaluate(r, fwd({ sessions: drop(0.151), faults: [{ kind: 'RUN_ERROR', detected_on: at(5), fixed_on: at(6), ref: 'f' }] }), at(65));
  assert.notEqual(voided.state, 'STOPPED_NEGATIVE');
  const mech = pv.evaluate(r, fwd({ sessions: sessions(0, 70), mechanism_falsified: { on: at(10), ref: 'mechanism:refuted' } }), at(69));
  assert.equal(mech.state, 'STOPPED_NEGATIVE');
  assert.deepEqual(mech.reasons, ['MECHANISM_FALSIFIED']);

  const rec = pv.recordEvaluation(r.validation_id, fwd({ sessions: drop(0.151) }), { asOf: at(10) });
  assert.equal(rec.state, 'STOPPED_NEGATIVE');
  assert.ok(validateRecord(rec, 'PAPER_VALIDATION_EVALUATION_V1').ok);
  assert.throws(() => pv.recordEvaluation(r.validation_id, fwd({ sessions: sessions(0, 70) }), { asOf: at(69) }), code(/PAPER_VALIDATION_TERMINAL/));
});

test('到期：起始日后 12 个月仍不足量 → 关闭「证据不足」，不续跑；到期后补来的会话救不回', () => {
  const r = registered();
  const expiry = r.expiry.date;
  assert.equal(expiry, '2027-11-23');
  const thin = sessions(0, 300).filter((_, i) => i % 5 === 0); // 一年里只有 ~50 个会话
  const atExpiry = pv.evaluate(r, fwd({ sessions: thin.filter((s) => s.date <= expiry) }), expiry);
  assert.equal(atExpiry.state, 'CLOSED_INSUFFICIENT');
  assert.equal(atExpiry.terminal_on, expiry);
  assert.deepEqual(atExpiry.reasons, ['EXPIRED_SAMPLE_NOT_MET']);
  assert.equal(r.expiry.verdict_zh, '证据不足');
  const dayBefore = pv.evaluate(r, fwd({ sessions: thin.filter((s) => s.date < expiry) }), CAL[CAL.indexOf(expiry) - 1]);
  assert.equal(dayBefore.state, 'RUNNING_DESCRIBE_ONLY');
  const after = [...thin.filter((s) => s.date <= expiry), ...Array.from({ length: 20 }, (_, k) => ({ date: CAL[CAL.indexOf(expiry) + 1 + k], challenger_logret: 0, champion_logret: 0, fills: 1 }))];
  const late = pv.evaluate(r, fwd({ sessions: after }), CAL[CAL.indexOf(expiry) + 25]);
  assert.equal(late.state, 'CLOSED_INSUFFICIENT');
  assert.equal(late.terminal_on, expiry);
  // 到期前已足量 → 不关闭
  assert.equal(pv.evaluate(r, fwd({ sessions: sessions(0, 60) }), CAL[CAL.indexOf(expiry) + 5]).state, 'CLAIM_ELIGIBLE');
  const rec = pv.recordEvaluation(r.validation_id, fwd({ sessions: after }), { asOf: CAL[CAL.indexOf(expiry) + 25] });
  assert.equal(rec.state, 'CLOSED_INSUFFICIENT');
  assert.throws(() => pv.recordEvaluation(r.validation_id, fwd({ sessions: sessions(0, 60) }), { asOf: CAL[CAL.indexOf(expiry) + 30] }), code(/TERMINAL/));
});

/** 夹具：实验锁定 CHALLENGER_WINS + QRP 影子足量（同 promotion_pipeline）。 */
async function promotable() {
  const fx = await setupExperiment({ min_forward_evidence: 2 });
  await experiments.runBacktest(fx.exp.experiment_id);
  experiments.recordResult(fx.exp.experiment_id, { verdict: 'CHALLENGER_WINS' });
  const run = shadow.openShadowRun({ champion_ref: fx.champRef, challenger_ref: fx.chalRef, race_ref: 'RACE-T', experiment_ref: fx.exp.experiment_id });
  shadow.recordObservation(run.shadow_id, { key: 'd1', business_date: 'd1', champion_output: [], challenger_output: [] });
  shadow.recordObservation(run.shadow_id, { key: 'd2', business_date: 'd2', champion_output: [], challenger_output: ['600001.SH'] });
  return { ...fx, shadowId: run.shadow_id };
}

test('晋级门进 PROMOTION_CANDIDATE_V1（带赛马清单引用）：不足量、净值低于冠军、护栏违约、运行不健康 → 拒绝；全过才写', async () => {
  const fx = await promotable();
  const base = { release_candidate_ref: fx.chalRef, market: 'CN_A', experiment_ref: fx.exp.experiment_id,
    research_evidence_refs: ['ev1'], shadow_forward_refs: [fx.shadowId], rollback_ref: fx.champRef };
  const route = (forward, asOf) => {
    const reg = registered({ shadow_ref: fx.shadowId });
    if (forward) pv.recordEvaluation(reg.validation_id, forward, { asOf });
    const race = raceV2.raceHead(reg.race.race_id);
    return { reg, c: { ...base, candidate_id: `PC-${reg.validation_id}`, race_manifest_ref: { race_id: race.race_id, manifest_sha256: race.manifest_sha256 }, paper_validation_refs: [reg.validation_id] } };
  };
  const fails = async (forward, asOf, re) => { const { c } = route(forward, asOf); await assert.rejects(controlPlane.createPromotionCandidate(c), code(re)); };

  await fails(fwd({ sessions: sessions(0, 59) }), at(58), /PROMOTION_PAPER_VALIDATION_GATE_FAILED:.*:NOT_CLAIM_ELIGIBLE$/);
  await fails(fwd({ sessions: sessions(0, 60, { chal: 0.0004, champ: 0.0005 }) }), at(59), /GATE_FAILED:.*:NAV_BELOW_CHAMPION$/);
  await fails(fwd({ sessions: sessions(0, 60), guardrail_breaches: [{ date: at(3), guardrail: 'PARTICIPATION_CAP', ref: 'g' }] }), at(59), /GATE_FAILED:.*:GUARDRAIL_BREACH$/);
  await fails(fwd({ sessions: sessions(0, 60), run_health: { healthy: false, ref: 'h' } }), at(59), /GATE_FAILED:.*:RUN_NOT_HEALTHY$/);
  await fails(null, null, /PROMOTION_PAPER_VALIDATION_NOT_EVALUATED/);

  const ok = route(fwd({ sessions: sessions(0, 60) }), at(59));
  await assert.rejects(controlPlane.createPromotionCandidate({ ...ok.c, race_manifest_ref: undefined }), code(/PROMOTION_RACE_MANIFEST_REF_REQUIRED/));
  await assert.rejects(controlPlane.createPromotionCandidate({ ...ok.c, paper_validation_refs: [] }), code(/PROMOTION_PAPER_VALIDATION_REFS_REQUIRED/));
  await assert.rejects(controlPlane.createPromotionCandidate({ ...ok.c, race_manifest_ref: { ...ok.c.race_manifest_ref, manifest_sha256: 'b'.repeat(64) } }), code(/PROMOTION_RACE_MANIFEST_MISMATCH/));
  await assert.rejects(controlPlane.createPromotionCandidate({ ...ok.c, market: 'US' }), code(/PROMOTION_RACE_MARKET_MISMATCH/));
  const other = registered({ shadow_ref: 'SHD-elsewhere' });
  pv.recordEvaluation(other.validation_id, fwd({ sessions: sessions(0, 60) }), { asOf: at(59) });
  await assert.rejects(controlPlane.createPromotionCandidate({ ...ok.c, paper_validation_refs: [other.validation_id] }), code(/PROMOTION_PAPER_VALIDATION_RACE_MISMATCH/));

  const cand = await controlPlane.createPromotionCandidate(ok.c);
  assert.deepEqual(cand.race_manifest_ref, ok.c.race_manifest_ref);
  assert.deepEqual(cand.paper_validation_refs, [ok.reg.validation_id]);
  assert.equal(cand.paper_validation_gate[ok.reg.validation_id].pass, true);
  assert.ok(validateRecord(cand, 'PROMOTION_CANDIDATE_V1').ok);
  // 旧路径（不带赛马引用）：行形不变，没有新字段
  const legacy = await controlPlane.createPromotionCandidate({ ...base, candidate_id: 'PC-legacy' });
  for (const k of ['race_manifest_ref', 'paper_validation_refs', 'paper_validation_gate']) assert.equal(k in legacy, false);
});

const ORDER = ['C3-FWD', 'SECTOR-ETF-LEFT-1', 'C17-NMSEL', 'U11(B)', 'R21'];
const UNWRITTEN_EXPECTED = {
  'C3-FWD': ['promotion_gate', 'withdrawal', 'holding_period'],
  'SECTOR-ETF-LEFT-1': ['min_sample', 'promotion_gate', 'withdrawal'],
  'C17-NMSEL': ['min_sample', 'promotion_gate', 'withdrawal', 'expiry', 'champion', 'pairing', 'holding_period'],
  'U11(B)': ['promotion_gate', 'expiry', 'holding_period'],
  R21: ['promotion_gate', 'withdrawal', 'expiry', 'holding_period'],
};

test('现有五个前向影子：只登记，规则字段与配置原样一致，没写的记「未写」，不补 §5.3 默认值；§5.3 判定不作用在它们上', () => {
  const cfg = pv.loadExisting();
  const recs = pv.existingRecords(cfg);
  assert.deepEqual(recs.map((r) => r.shadow_key), ORDER);
  for (const [i, r] of recs.entries()) {
    const sh = cfg.shadows[i];
    assert.ok(validateRecord(r, 'PAPER_VALIDATION_V1').ok, r.shadow_key);
    assert.equal(r.kind, 'EXISTING');
    assert.equal(r.race, null);
    for (const f of pv.RULE_FIELDS) {
      const want = sh.fields[f] === pv.UNWRITTEN ? pv.UNWRITTEN : sh.fields[f].map((q) => ({ source: q.source, quote: q.quote }));
      assert.equal(JSON.stringify(r[f].as_written), JSON.stringify(want), `${r.shadow_key}.${f}`);
      assert.deepEqual(Object.keys(r[f]), ['as_written']);
    }
    assert.deepEqual(pv.RULE_FIELDS.filter((f) => r[f].as_written === pv.UNWRITTEN), UNWRITTEN_EXPECTED[r.shadow_key], r.shadow_key);
    const text = JSON.stringify(r);
    for (const leak of ['MAX_60_TRADING_DAYS', 'forward_mdd_multiple_max', 'NEXT_TRADING_DAY_AFTER_RACE_CLOSE', 'CLOSE_INSUFFICIENT_NO_EXTENSION']) assert.equal(text.includes(leak), false, `${r.shadow_key}:${leak}`);
    assert.throws(() => pv.evaluate(r, fwd(), '2026-12-01'), code(/EXISTING_SHADOW_RULES_ARE_ITS_OWN/));
  }
  assert.deepEqual(recs.filter((r) => r.unverified.length).map((r) => r.shadow_key), ['U11(B)']); // V1 后续：R21 规则进了协调目录；C17 T_start 与 U11 的 C / D 有了出处
  // 幂等；冻结后改了原有内容 → 拒绝，旧行不改（只追加的改动走取代行，见末尾一条）
  const first = pv.registerExisting(cfg);
  assert.equal(first.length, 5);
  assert.ok(pv.registerExisting(cfg).every((r) => r.idempotent_skip));
  const patched = JSON.parse(JSON.stringify(cfg));
  patched.shadows[0].fields.start = [{ source: 'C3_FREEZE_1', quote: '★4 | (a)：T_start 照裁定 1 保持 2026-09-30。' }]; // 改原有摘句（不是追加）
  assert.throws(() => pv.registerExisting(patched), code(/EXISTING_REGISTRATION_CHANGED:PV-EXISTING-C3-FWD/));
  const bad = JSON.parse(JSON.stringify(cfg));
  bad.shadows[1].fields.start = '';
  assert.throws(() => pv.existingRecords(bad), code(/EXISTING_FIELD_INVALID/));
});

test('出处核对器：sha 对、摘句逐字节在原文 → FOUND；改一个字节、换一个文件、读不到 → 分别报出来（合成文件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-src-'));
  const text = Buffer.from('# 冻结页\n\n- **T_start：** 2026-12-01。\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'PAGE.md'), text);
  const cfg = JSON.parse(JSON.stringify(pv.loadExisting()));
  cfg.sources = { PAGE: { repo: 'coordinator', path: 'artifacts/coordinator/PAGE.md', sha256: sha(text) }, GONE: { repo: 'coordinator', path: 'artifacts/coordinator/GONE.md', sha256: 'c'.repeat(64) } };
  cfg.shadows = [{ ...cfg.shadows[0], listed_as: { source: 'PAGE', quote: '冻结页' }, book_zh: '冻结页', run_by: '冻结页', consulted: [],
    fields: Object.fromEntries(pv.RULE_FIELDS.map((f) => [f, pv.UNWRITTEN])) }];
  cfg.shadows[0].fields.start = [{ source: 'PAGE', quote: '- **T_start：** 2026-12-01。' }];
  cfg.shadows[0].fields.reading = [{ source: 'PAGE', quote: '- **T_start：** 2026-12-02。' }];
  cfg.shadows[0].fields.expiry = [{ source: 'GONE', quote: 'x' }];
  const v = pv.verifySources(cfg, { coordinatorDir: dir, smartflowRepo: dir });
  assert.deepEqual(v.sources, { PAGE: 'MATCH', GONE: 'ABSENT' });
  assert.deepEqual(v.quotes.map((q) => `${q.field}:${q.state}`), ['listed_as:FOUND', 'start:FOUND', 'expiry:ABSENT', 'reading:QUOTE_NOT_IN_SOURCE']);
  fs.writeFileSync(path.join(dir, 'PAGE.md'), Buffer.concat([text, Buffer.from(' ')]));
  assert.equal(pv.verifySources(cfg, { coordinatorDir: dir }).sources.PAGE, 'SHA_MISMATCH');
});

test('现有五个影子的规则字段与封存 / 冻结页逐字节一致（读得到的出处全部核对；读不到的列出来）', (t) => {
  const v = pv.verifySources();
  const states = Object.values(v.sources);
  if (states.every((s) => s === 'ABSENT')) { t.skip('SOURCES_ABSENT: 协调目录与 smartflow 仓库都读不到（CI）'); return; }
  const absent = Object.entries(v.sources).filter(([, s]) => s === 'ABSENT').map(([k]) => k);
  if (absent.length) t.diagnostic(`ABSENT: ${absent.join(', ')}`);
  assert.deepEqual(Object.entries(v.sources).filter(([, s]) => s === 'SHA_MISMATCH'), []);
  const bad = v.quotes.filter((q) => !['FOUND', 'ABSENT'].includes(q.state));
  assert.deepEqual(bad, []);
  assert.ok(v.quotes.filter((q) => q.state === 'FOUND').length > 0);
  assert.deepEqual(v.freeze_records.filter((f) => !['FOUND', 'ABSENT'].includes(f.section) || !['FOUND', 'ABSENT'].includes(f.queue_line)), []);
  if (!absent.length) {
    assert.equal(states.length, 23);
    assert.ok(states.every((s) => s === 'MATCH'));
    assert.ok(v.quotes.every((q) => q.state === 'FOUND'));
    assert.deepEqual(v.freeze_records, [{ source: 'U11B_FREEZE_1_NOTE_1', section: 'FOUND', queue_line: 'FOUND' }]);
  }
});

test('现有影子台账行为不变（SHD-…）：paper-validation 不写 shadow_runs / observations / virtual_ledger，读出来的状态一模一样', async () => {
  const fx = await setupExperiment({ min_forward_evidence: 2 });
  const run = shadow.openShadowRun({ champion_ref: fx.champRef, challenger_ref: fx.chalRef, race_ref: 'RACE-LEGACY', experiment_ref: fx.exp.experiment_id });
  shadow.recordObservation(run.shadow_id, { key: 'k1', business_date: '2026-11-10', champion_output: ['A'], challenger_output: ['B'], data_quality: 'OK' });
  // 一行旧形状的 SHADOW_RUN_V1（合成，形如台账里那条 CN_A RUNNING 的影子）
  const legacyId = 'SHD-1f624ff6-synthetic';
  append(shadow.SHADOW_LEDGER(), { ...shadow.shadowHead(run.shadow_id), shadow_id: legacyId, virtual_ledger_ref: `VL-${legacyId}` });
  const files = [shadow.SHADOW_LEDGER(), shadow.DISAGREEMENT_LEDGER(), shadow.VIRTUAL_LEDGER()];
  const snap = async () => ({
    bytes: files.map((f) => sha(fs.readFileSync(f))),
    runs: shadow.listShadowRuns(),
    per: await Promise.all([run.shadow_id, legacyId].map(async (id) => ({
      head: shadow.shadowHead(id), suff: await shadow.sufficiency(id), health: shadow.operationalHealth(id), fwd: shadow.forwardMetrics(id) }))),
  });
  const before = await snap();

  pv.registerExisting();
  const reg = registered({ shadow_ref: run.shadow_id });
  pv.recordEvaluation(reg.validation_id, fwd({ sessions: sessions(0, 61) }), { asOf: at(60) });
  pv.evaluate(reg, fwd({ sessions: sessions(0, 10), faults: [{ kind: 'RUN_ERROR', detected_on: at(2), fixed_on: null, ref: 'f' }] }), at(9));

  assert.deepEqual(await snap(), before);
  assert.ok(fs.existsSync(pv.LEDGER()) && fs.existsSync(pv.EVAL_LEDGER()));
  assert.ok(pv.LEDGER().startsWith(dataRoot) && !files.includes(pv.LEDGER()) && !files.includes(pv.EVAL_LEDGER()));
  const src = fs.readFileSync(require.resolve('../services/shadow-control/paper-validation'), 'utf8');
  for (const s of ['SHADOW_LEDGER', 'DISAGREEMENT_LEDGER', 'VIRTUAL_LEDGER', 'shadow_runs.jsonl', 'virtual_ledger.jsonl', 'shadow_observations.jsonl', "require('./index')", "require('../shadow-control')"]) {
    assert.equal(src.includes(s), false, s);
  }
});

// ── V1 后续（协调会话 2026-11-17 02:2x）：「预登记」按字面读、回测回撤为 0 拒绝、R21 出处可核后追加一行取代 ─────

test('当天登记：起始会话开盘之前登记 → 起始日不变；开盘时或之后 → 顺延一个交易日并记原因与原起始日；晚于原起始日登记 → 仍拒绝', () => {
  // A 股：09:30 +08（2026-11-23 周一，赛马 11-20 周五关闭）
  const before = registered({ registeredAt: '2026-11-23T01:29:59Z' });
  assert.deepEqual([before.start.date, before.start.shift], [START, undefined]);
  for (const t of ['2026-11-23T01:30:00Z', '2026-11-23T01:31:00Z']) {
    const r = registered({ registeredAt: t });
    assert.equal(r.start.date, '2026-11-24', t);
    assert.deepEqual(r.start.shift, { reason: 'START_SHIFTED_REGISTERED_AFTER_OPEN', original_date: START, open_at: '2026-11-23T01:30:00.000Z' }, t);
    assert.equal(r.registered_on, START);
    assert.equal(r.expiry.date, '2027-11-24'); // 到期从实际起始日算
    assert.ok(validateRecord(r, 'PAPER_VALIDATION_V1').ok);
  }
  assert.throws(() => registered({ registeredAt: '2026-11-24T00:00:00Z' }), code(/PAPER_VALIDATION_START_BEFORE_REGISTRATION:2026-11-23<2026-11-24/));
  // 美股：09:30 America/New_York（11-23 是冬令时，= 14:30Z）
  const us = (t) => registered({ registeredAt: t }, { market: 'US', closedAt: '2026-11-21T02:00:00Z' });
  assert.equal(us('2026-11-23T14:29:00Z').start.date, '2026-11-23');
  assert.deepEqual([us('2026-11-23T14:30:00Z').start.date, us('2026-11-23T14:30:00Z').start.shift.open_at], ['2026-11-24', '2026-11-23T14:30:00.000Z']);
  assert.equal(pv.internals.marketOpenAt('2026-07-01', 'US'), '2026-07-01T13:30:00.000Z'); // 夏令时
  // 加密：00:00 UTC，日历是每一天
  const days = Array.from({ length: 400 }, (_, i) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10));
  const cr = (t) => registered({ registeredAt: t, calendar: { ref: 'calendar:every-day', days } }, { market: 'CRYPTO', closedAt: '2026-11-20T08:00:00Z' });
  assert.equal(cr('2026-11-20T23:59:59Z').start.date, '2026-11-21');
  assert.deepEqual([cr('2026-11-21T00:00:00Z').start.date, cr('2026-11-21T00:00:00Z').start.shift.reason], ['2026-11-22', 'START_SHIFTED_REGISTERED_AFTER_OPEN']);
});

test('回测最大回撤为 0 → 登记拒绝 BACKTEST_DRAWDOWN_ZERO；大于 0 照旧', () => {
  assert.throws(() => registered({}, { mdd: 0 }), code(/PAPER_VALIDATION_BACKTEST_DRAWDOWN_ZERO/));
  const r = registered({}, { mdd: 0.0001 });
  assert.equal(r.withdrawal.economic.backtest_mdd, 0.0001);
});

test('新出处之后：R21、C17-NMSEL 去掉 UNVERIFIED，U11(B) 只留 T_START_PENDING_FIRST_WRITE；台账里已有旧行时追加一行取代（旧行逐字节不动），改了原有摘句或出处仍拒绝', () => {
  const cfg = pv.loadExisting();
  const by = (c, k) => c.shadows.find((x) => x.shadow_key === k);
  assert.deepEqual([by(cfg, 'R21').unverified, by(cfg, 'C17-NMSEL').unverified], [[], []]);
  assert.deepEqual(by(cfg, 'U11(B)').unverified.map((u) => u.split(':')[0]), ['T_START_PENDING_FIRST_WRITE']);
  assert.deepEqual(by(cfg, 'C17-NMSEL').fields.start.at(-1), { source: 'C17NM_RULING_3', quote: 'Forward shadow T_start = 2026-11-13T00:00:00Z.' });
  assert.deepEqual(by(cfg, 'U11(B)').fields.champion.map((q) => q.source), ['U11B_FREEZE_1', 'U11B_FREEZE_1_NOTE_1', 'U11B_FREEZE_1_NOTE_1']);
  assert.ok(cfg.sources.U11B_FREEZE_1_NOTE_1.freeze_record.queue_log.line_quote.includes('CD_NOTE_FROZEN'));
  // 改动之前已经登记过的样子（#103 合并时的内容）：三条 UNVERIFIED、没有两份新出处与它们的摘句
  const old = JSON.parse(JSON.stringify(cfg));
  delete old.sources.C17NM_RULING_3; delete old.sources.U11B_FREEZE_1_NOTE_1;
  Object.assign(by(old, 'C17-NMSEL'), { unverified: ['T_START_DATE_NOT_ON_A_SEAL_OR_FREEZE_PAGE: (former note)'] });
  by(old, 'C17-NMSEL').fields.start = by(old, 'C17-NMSEL').fields.start.slice(0, 2);
  const u = by(old, 'U11(B)');
  Object.assign(u.fields, { champion: u.fields.champion.slice(0, 1), pairing: pv.UNWRITTEN, reading: u.fields.reading.slice(0, 2) });
  u.unverified = [...u.unverified, 'CHAMPION_ARMS_UNDEFINED_ON_PAGE: (former note)'];
  by(old, 'R21').unverified = ['RULE_SOURCE_NOT_IN_COORDINATOR_DIR: (former note)'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-supersede-'));
  const prev = process.env.QRP_DATA_DIR;
  process.env.QRP_DATA_DIR = dir;
  try {
    const first = pv.registerExisting(old);
    const before = fs.readFileSync(pv.LEDGER());
    const second = pv.registerExisting(cfg);
    const row = (k) => second.find((x) => x.shadow_key === k);
    assert.ok(row('C3-FWD').idempotent_skip && row('SECTOR-ETF-LEFT-1').idempotent_skip);
    assert.deepEqual(row('C17-NMSEL').supersede_changes, ['start', 'sources', 'unverified']);
    assert.deepEqual(row('U11(B)').supersede_changes, ['champion', 'pairing', 'reading', 'sources', 'unverified']);
    assert.deepEqual(row('R21').supersede_changes, ['unverified']);
    for (const k of ['C17-NMSEL', 'U11(B)', 'R21']) {
      assert.equal(row(k).supersedes, first.find((x) => x.shadow_key === k).record_hash, k);
      assert.equal(row(k).supersede_reason, 'ADDITIVE_UPDATE');
      assert.equal(pv.registration(row(k).validation_id).record_hash, row(k).record_hash, k); // 头行是新的
      assert.ok(validateRecord(row(k), 'PAPER_VALIDATION_V1').ok, k);
    }
    const after = fs.readFileSync(pv.LEDGER());
    assert.deepEqual(after.subarray(0, before.length), before); // 旧行逐字节不动，只在后面追加
    assert.ok(pv.registerExisting(cfg).every((x) => x.idempotent_skip));
    const refused = (mutate, re = /EXISTING_REGISTRATION_CHANGED/) => { const c = JSON.parse(JSON.stringify(cfg)); mutate(c); assert.throws(() => pv.registerExisting(c), code(re)); };
    refused((c) => { by(c, 'C3-FWD').fields.start[0].quote = '★4 | (a)：T_start 照裁定 1 保持 2026-09-30。'; });
    refused((c) => { by(c, 'U11(B)').fields.reading.pop(); });
    refused((c) => { by(c, 'U11(B)').fields.pairing = pv.UNWRITTEN; });
    refused((c) => { c.sources.U11B_FREEZE_1.sha256 = 'f'.repeat(64); });
    refused((c) => { by(c, 'R21').run_by = 'smartflow'; by(c, 'R21').listed_as.quote = `${by(c, 'R21').listed_as.quote} smartflow`; });
  } finally {
    if (prev === undefined) delete process.env.QRP_DATA_DIR; else process.env.QRP_DATA_DIR = prev;
  }
});
