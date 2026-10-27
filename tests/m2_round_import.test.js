'use strict';
/**
 * CRYPTO_Q0_RESULT_V1 导入规格增补 2（加密 M2 轮次，冻结裁定 LOOP_AND_IMPORT_DRAFTS_20261027_FREEZE_1 R2，D1–D8 全部 ★）的确定性测试 T1–T11。
 *   - 导入与拒绝（T1、T2、T5、T6）、逐字表格与句子（T4、T7）：读仓库里的真实封存文件 var/evidence/*-m2-r1-2026-10-27（D8 ★ 进 git），
 *     基线锁是直接写进临时账本的一行（只用 result_id 与 file_sha256），不需要本机的 Q0 文件；
 *   - 研究进度（T3、T8）：stageOf / countsSentence 是纯函数，直接喂事实；
 *   - 真实页面与 J5.1（T3、T9、T10）：要本机的真实 Q0 文件（research-data/qrp_crypto_v1）与 Desk 目录（QRP_DESK_ROOT）；不在时跳过，跳过不算通过。
 * 账本在临时目录（tests/_env），不碰 var/ledger。
 */
require('./_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const AUTHORITY = 'M2_ROUND_TEST_AUTHORITY';
process.env.QRP_PRODUCT_MILESTONE_AUTHORITY = AUTHORITY;

const profiles = require('../services/strategy-profiles');
const k3 = require('../services/baseline-evaluation');
const m2 = require('../services/m2-rounds');
const stage = require('../services/research-workspace/stage');
const workspace = require('../services/research-workspace');
const { validateRecord } = require('../schemas');

const C17 = profiles.mustGet('C17_V2_4000USDT');
const QS = profiles.mustGet('QUICK_SHOT_V3_1000USDT');
const PRODUCTION = JSON.parse(fs.readFileSync(profiles.FILE, 'utf8'));
const C17_DIR = path.join(ROOT, 'var', 'evidence', 'c17-v2-m2-r1-2026-10-27');
const QS_DIR = path.join(ROOT, 'var', 'evidence', 'qs-v3-m2-r1-2026-10-27');
const C17_Q0_FILE_SHA = 'e80c42523b30f7681aaede3e4f11b39475ed8fc9d724335400a7a8ba0db009fa';
const QS_Q0_FILE_SHA = 'bd83dd6ec1754dbc0b3338aefd826f29aa4f885afc05dced80ae4c826bdbfd45';

const REAL_C17_V1 = path.join(process.env.QRP_C17_Q0_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/q0-c17', 'C17_V2_M2_Q0_RESULT_V1.json');
const REAL_C17_V2 = path.join(process.env.QRP_C17_Q0_V2_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/m2-c17', 'C17_V2_M2_Q0_RESULT_V2.json');
const REAL_QS = path.join(process.env.QRP_QS_Q0_REAL_DIR || '/Users/kaylame/KaylaProject/research-data/qrp_crypto_v1/q0-qs', 'QS_V3_M2_Q0_RESULT_V1.json');
const HAVE_DESK = Boolean(process.env.QRP_DESK_ROOT) && fs.existsSync(path.join(process.env.QRP_DESK_ROOT || '', 'src', 'operation-review.js'));
const SKIP_PAGE = [REAL_C17_V1, REAL_C17_V2, REAL_QS].every((file) => fs.existsSync(file)) && HAVE_DESK ? false
  : '真实 C17 / QS Q0 文件或 Desk 目录（QRP_DESK_ROOT）不在本机；页面断言跳过不算通过';
const CHROME = [process.env.QRP_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((file) => fs.existsSync(file));
const SKIP_BROWSER = SKIP_PAGE || (CHROME ? false : '本机没有 Chrome（可用 QRP_TEST_CHROME 指定）；浏览器布局未验证，跳过不算通过');

const rejects = (code, detail) => (error) => { assert.equal(error.code, code, error.message); if (detail) assert.match(error.detail || '', detail); return true; };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const reset = () => { fs.rmSync(k3.LEDGER(), { force: true }); fs.rmSync(m2.LEDGER(), { force: true }); m2.clearCache(); k3.clearCache(); };
/** 基线锁：只写一行（导入器只看当前 Q0 锁的 result_id 与 file_sha256）。 */
function seedBaseline(profile, resultId, fileSha) {
  fs.mkdirSync(path.dirname(k3.LEDGER()), { recursive: true });
  fs.appendFileSync(k3.LEDGER(), `${JSON.stringify({ schema: 'BASELINE_EVALUATION_LOCK_V1', result_id: resultId, case_ref: profile.case_ref, strategy_ref: profile.strategy_ref, file_sha256: fileSha })}\n`);
}
const seedBoth = () => { seedBaseline(C17, 'Q0-e80c42523b30f768', C17_Q0_FILE_SHA); seedBaseline(QS, 'Q0-bd83dd6ec1754dbc', QS_Q0_FILE_SHA); };
const importC17 = (extra = {}) => m2.importRound({ strategyRef: C17.strategy_ref, round: 1, dir: C17_DIR, registeredBy: AUTHORITY, ...extra });
const importQs = (extra = {}) => m2.importRound({ strategyRef: QS.strategy_ref, round: 1, dir: QS_DIR, registeredBy: AUTHORITY, ...extra });
/** 生产注册表加一处改动（只在这个测试里生效）。 */
function withProfiles(mutate, fn) {
  const doc = JSON.parse(JSON.stringify(PRODUCTION));
  mutate(doc);
  const previous = profiles.use(profiles.validate(doc));
  try { return fn(); } finally { profiles.use(previous); m2.clearCache(); }
}
const roundOf = (doc, ref) => doc.profiles.find((item) => item.strategy_ref === ref).m2_rounds[0];
/** 把一轮的证据复制到临时目录（目录名不含 fixture 一类的词，readRoleFile 默认拒绝那类路径）。 */
function copyDir(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-m2r-copy-'));
  for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dir, name));
  return dir;
}

// ── 冻结文本里的逐字行（增补 2 §3.2、§4.2、§6、§7.1）────────────────────────────────

const C17_ROWS = [
  ['成本：费用 / 滑点 / 资金费全为 0', '+0.207 [+0.134, +0.274]', '0.10', '+0.199 [+0.085, +0.330]', '不进候选；另立执行题（maker 成交需要真实成交证据）'],
  ['去风险关', '+0.097 [−0.009, +0.212]', '0.16', '账户跌穿 0（期末 −526），g 无定义（Rule 1 停止 2021-03-28）', '排除：样本内毁灭'],
  ['权益乘数关（m = 1）', '−0.119 [−0.256, −0.009]', '0.18', '+0.041 [−0.049, +0.135]', '排除：符号相反，样本外显著为负'],
  ['固定 150.75（两者都关）', '−0.035 [−0.170, +0.068]', '0.17', '−0.639 [−1.198, −0.129]（Rule 1 停止 2021-05-23）', '排除'],
  ['只做多', '−0.119 [−0.287, +0.033]', '0.23', '+0.216 [−0.227, +0.676]', '排除：样本外为负且量大'],
  ['只做空', '−0.428 [−0.984, −0.029]', '0.70', '−0.153 [−0.682, +0.262]（Rule 2 停止 2021-05-30、2021-06-20、2022-04-17）', '未入选'],
  ['上涨阶段不做空（BTC 日线 > SMA200 不开空）', '−0.026 [−0.152, +0.092]', '0.17', '+0.104 [−0.140, +0.426]', '入选（CAND-D）'],
];
const QS_ROWS = [
  ['费用 / 滑点 / 资金费全为 0', '+0.056 [+0.040, +0.072]', '0.02', '+0.026 [+0.018, +0.036]', '未通过 R1（执行方式）'],
  ['每笔风险 = 开仓时已实现权益 × 0.72%（复利；现行为固定 7.2 USDT）', '−0.076 [−0.282, +0.162]（新增停止 2 次）', '0.32', '−0.005 [−0.016, +0.005]', '未通过 R1（定仓）、R2、R3、R4'],
  ['只做多（D0 空单分支不开仓）', '−0.267 [−0.714, +0.070]（新增停止 1 次）', '0.57', '−0.060 [−0.155, +0.036]', '未通过 R2、R3、R4'],
  ['只做空（D0 多单分支不开仓）', '+0.007 [−0.269, +0.215]', '0.35', '+0.013 [−0.028, +0.054]', '入选'],
  ['只交易信号时 24 h 成交额 ≥ 3 亿 USDT（生产滑点分档线）', '−0.235 [−0.666, +0.100]', '0.55', '−0.039 [−0.148, +0.075]', '未通过 R2、R3'],
  ['只交易信号时 24 h 成交额 < 3 亿 USDT', '−0.015 [−0.074, +0.032]', '0.08', '−0.004 [−0.028, +0.018]', '未通过 R2、R3'],
  ['晚一小时成交（h+2 开盘）', '−0.035 [−0.244, +0.179]（新增停止 2 次）', '0.30', '−0.018 [−0.099, +0.063]', '未通过 R1（执行方式）、R2、R3、R4'],
  ['BTC 上一根日线收盘 > SMA200 时不开空（C17 CAND-D 定义）', '−0.213 [−0.641, +0.094]（新增停止 1 次）', '0.53', '−0.033 [−0.119, +0.058]', '未通过 R2、R3、R4'],
  ['同一收盘小时全名单 ≥ 2 个 V3 信号才开仓', '+0.148 [+0.063, +0.233]', '0.12', '−0.050 [−0.143, +0.040]', '未通过 R2、R3'],
  ['同一收盘小时只有这 1 个 V3 信号才开仓', '账户跌穿 0（期末 −78），g 无定义（新增停止 6 次）', '0.98', '+0.005 [−0.044, +0.058]', '未通过 R2、R3、R4'],
  ['只开 trendConfirmed（1h 收盘对 MA100 同向；V3 已记录、不用）', '−0.071 [−0.390, +0.150]', '0.39', '−0.034 [−0.119, +0.048]', '未通过 R3'],
  ['持有上限 24 h（调优网格值；止损 3% / 止盈 8% 不变）', '−0.023 [−0.163, +0.080]', '0.18', '−0.081 [−0.151, −0.023]（新增停止 1 次）', '未通过 R2、R3、R4'],
];
const C17_GAP = '缺口：样本外 g(当前 D) − g(BTC 买入持有) = −0.028 [−0.569, +0.544]，检出下限 0.80；开发期 −0.230 [−1.125, +0.645]，检出下限 1.27。缺口接近 0，各分量只列 Δg 与区间，不算份额。';
const QS_GAP = '缺口：样本外 g(当前 D) − g(BTC 买入持有) = +0.034 [−0.708, +0.789]，检出下限 1.07；开发期 −0.399 [−1.068, +0.269]，检出下限 0.96。各分量只列 Δg 与区间，不算份额。';
const C17_EXPOSURE = '不在场（描述，不进候选）：样本外 67.6% 的小时空仓，这些小时里 BTC 年化对数收益 +0.159 [−0.198, +0.514]；开发期 69.4%，−0.039 [−0.719, +0.591]。';
const C17_CAND = [
  ['开发期 2020–2022', '4,727 / 3,463', '48.0% / 55.5%', '4,302 / 4,249', '+0.104 [−0.141, +0.427]', '0.41', '38.9%', '18.6%'],
  ['样本外 2023 → 2026-10-24', '11,974 / 13,199', '27.0% / 25.1%', '3,076 / 3,192', '−0.026 [−0.152, +0.092]', '0.17', '5.65%', '0.77%'],
  ['全账本窗口 2024-10-04 → 2026-09-30（补充，代理标的池，不进结论）', '6,682 / 2,737', '34.8% / 43.6%', '2,488 / 1,967', '+0.448 [−0.009, +0.920]', '0.67', '2.29%', '0.09%'],
];
const QS_CAND = [
  ['开发期 2020–2023', '1,256 / 1,191', '16.8% / 19.6%', '224 / 247', '+0.013 [−0.028, +0.054]', '+0.070 [−0.025, +0.212]', '0.06 / 0.17'],
  ['样本外 2024 → 2026-10-24', '2,142 / 2,102', '14.8% / 22.1%', '371 / 596', '+0.007 [−0.269, +0.215]', '+0.106 [−0.146, +0.287]', '0.35 / 0.31'],
];
const QS_FOOT = '没有修好的：2026 年空单 79 笔，每笔 −0.346 R；候选对 BTC 买入持有的 g 差 +0.041 [−0.708, +0.835]，没有可信地跑赢。';
const C17_COST = '执行成本题（EXEC-1：非保护性订单先挂单 60 秒再吃单；CAL：主流入场腿按前向成交记账）：K2 已冻结（2026-10-27，冻结裁定 1 Q2）。为什么立这题：成本是分解里最大、样本内外最一致的一项（样本外 +0.207，开发期 +0.199）。历史近似（Phase H，只用 1m 存档，只报不判）：1,224 个决定，60 秒挂单成交率 0.903–0.980，相对立即吃单平均每个决定省 +1.15 到 +1.77 bp。前向记录：尚未登记运行。采用是交易规则修订，须 Owner 签字。';
const QS_COST = '成本（样本外 +0.056，开发期 +0.026）是执行方式，按 K2 D5 (a) 并入 C17 执行成本题：QS 作为第二个账本，只报不判；C17 的判据只对 BTC / ETH。';
const C17_HEAD = 'Q0 证据不足（A0 未通过）；第 1 轮已做：缺口分解 + 组合候选已冻结，前向影子运行中，最早 2027-04-30 查看，2 题待研究';
const QS_HEAD = 'Q0 证据不足；第 1 轮已做：缺口分解 + 组合候选已冻结，前向影子运行中，最早 2027-04-30 查看，2 题待研究';
const block = (round, key) => round.blocks.find((item) => item.key === key);

// ── T1 / T2：导入、重放、拒绝 ──────────────────────────────────────────────────────

test('T1 C17 真实文件导入 → R1-229940c24a2246bc；同一组文件重导是幂等重放；锁符合 M2_ROUND_LOCK_V1；没有完成权威、没有登记的轮次、基线不是当前锁都拒绝', () => {
  reset(); seedBoth();
  assert.throws(() => importC17({ registeredBy: 'SOMEONE' }), rejects('M2_ROUND_REGISTERED_BY_NOT_AUTHORIZED'));
  assert.throws(() => m2.importRound({ strategyRef: C17.strategy_ref, round: 2, dir: C17_DIR, registeredBy: AUTHORITY }), rejects('M2_ROUND_NOT_REGISTERED'));
  assert.throws(() => m2.importRound({ strategyRef: 'US_V5_ETF_3000USD', round: 1, dir: C17_DIR, registeredBy: AUTHORITY }), rejects('M2_ROUND_NOT_REGISTERED'));
  const lock = importC17();
  assert.equal(lock.result_id, 'R1-229940c24a2246bc');
  assert.equal(lock.baseline_result_id, 'Q0-e80c42523b30f768');
  assert.equal(lock.k2_sha256, '443bdfccab9cbe0e3dab2dd4453cbbc14505501a23c0ed1c4fbb24453d52e206');
  assert.equal(lock.files.length, 10);
  assert.equal(lock.production_effect, 'NONE');
  assert.ok(validateRecord(lock, 'M2_ROUND_LOCK_V1').ok);
  const again = importC17();
  assert.equal(again.replayHit, true);
  assert.equal(m2.locks(C17.strategy_ref).length, 1);
  // 新的 Q0 锁成了当前锁：这一轮的基线不再是当前的，导入拒绝
  reset(); seedBaseline(C17, 'Q0-e80c42523b30f768', C17_Q0_FILE_SHA); seedBaseline(C17, 'Q0-ffffffffffffffff', 'f'.repeat(64));
  assert.throws(() => importC17(), rejects('M2_ROUND_BASELINE_NOT_CURRENT'));
  reset();
});

test('T2 QS 真实文件导入 → R1-c679d4c92c2d67a1；文件 identity.baseline_sha256 与当前 Q0 锁不符拒绝（M2_ROUND_BASELINE_MISMATCH）；C17 的 Phase H 也核对 Q0 V2 的 sha', () => {
  reset(); seedBoth();
  const lock = importQs();
  assert.equal(lock.result_id, 'R1-c679d4c92c2d67a1');
  assert.equal(lock.files.length, 4);
  reset();
  seedBaseline(QS, 'Q0-bd83dd6ec1754dbc', '0'.repeat(64));
  assert.throws(() => importQs(), rejects('M2_ROUND_BASELINE_MISMATCH'));
  reset();
  seedBaseline(C17, 'Q0-e80c42523b30f768', '0'.repeat(64));
  assert.throws(() => importC17(), rejects('M2_ROUND_BASELINE_MISMATCH', /q0_v2_sha256/));
  reset();
});

test('T1 封存文件：改一个字节、缺一个文件、旁证 .sha256 不符都拒绝；导入之后文件被改，页面读到的这一轮是 INVALID，写「封存结果校验未通过」', () => {
  reset(); seedBoth();
  const dir = copyDir(C17_DIR);
  try {
    const target = path.join(dir, 'C17_V2_M2_R1_GAP_DECOMPOSITION_V1.json');
    const original = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from(' ')]));
    assert.throws(() => importC17({ dir }), rejects('M2_ROUND_FILE_SHA_MISMATCH', /DECOMPOSITION/));
    fs.writeFileSync(target, original);
    fs.writeFileSync(`${target}.sha256`, `${'0'.repeat(64)}  C17_V2_M2_R1_GAP_DECOMPOSITION_V1.json\n`);
    assert.throws(() => importC17({ dir }), rejects('M2_ROUND_FILE_SHA_MISMATCH', /\.sha256/));
    fs.copyFileSync(path.join(C17_DIR, 'C17_V2_M2_R1_GAP_DECOMPOSITION_V1.json.sha256'), `${target}.sha256`);
    fs.renameSync(path.join(dir, 'CRYPTO_QRP_ONBOARDING_FREEZE_4.md'), path.join(dir, 'moved.md'));
    assert.throws(() => importC17({ dir }), rejects('M2_ROUND_FILE_MISSING', /FREEZE_4/));
    fs.renameSync(path.join(dir, 'moved.md'), path.join(dir, 'CRYPTO_QRP_ONBOARDING_FREEZE_4.md'));
    importC17({ dir });
    assert.equal(m2.readProjections(C17)[0].state, 'LOCKED_VERIFIED');
    fs.appendFileSync(path.join(dir, 'C17_V2_M2_R1_COMBINED_CANDIDATE_K2_DRAFT_V1.md'), '\n');
    const broken = m2.readProjections(C17)[0];
    assert.equal(broken.state, 'INVALID');
    assert.equal(broken.sentence_zh, 'M2 第 1 轮封存结果校验未通过');
    assert.equal(broken.reason_code, 'M2_ROUND_FILE_SHA_MISMATCH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); reset(); }
});

// ── T5 / T6：选择核对与固定句核对 ─────────────────────────────────────────────────

test('T5 选择核对：档案入选的分量与文件不一致就拒绝（QS selection.entered；C17 候选回放的 spec 开关，少登记一条也拒绝）', () => {
  reset(); seedBoth();
  withProfiles((doc) => { roundOf(doc, QS.strategy_ref).candidate.rules[0].component = 'LONG_ONLY'; }, () => {
    assert.throws(() => importQs(), rejects('M2_ROUND_SELECTION_MISMATCH'));
  });
  withProfiles((doc) => { roundOf(doc, C17.strategy_ref).candidate.rules.pop(); }, () => {
    assert.throws(() => importC17(), rejects('M2_ROUND_SELECTION_MISMATCH', /upPhaseShortBlock/));
  });
  withProfiles((doc) => { roundOf(doc, C17.strategy_ref).candidate.rules[1].component = 'LONG_ONLY'; }, () => {
    assert.throws(() => importC17(), rejects('M2_ROUND_SELECTION_MISMATCH', /LONG_ONLY/));
  });
  reset();
});

test('T6 固定句核对：候选区间不跨 0 的文件、计划文字与查看常数不一致、候选窗口与登记不符，都拒绝（M2_ROUND_WORDS_CONTRADICT_FILE）', () => {
  reset(); seedBoth();
  const dir = copyDir(QS_DIR);
  try {
    const file = path.join(dir, 'QS_V3_M2_R1_RESULT_V1.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.candidate.segments.OOS.dg_ci = [0.01, 0.2];
    const bytes = Buffer.from(JSON.stringify(doc));
    fs.writeFileSync(file, bytes); fs.rmSync(`${file}.sha256`);
    withProfiles((reg) => { roundOf(reg, QS.strategy_ref).files[0].sha256 = sha256(bytes); }, () => {
      assert.throws(() => importQs({ dir }), rejects('M2_ROUND_WORDS_CONTRADICT_FILE', /history_note_zh/));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  withProfiles((reg) => { roundOf(reg, QS.strategy_ref).forward.look_not_before = '2027-05-31'; }, () => {
    assert.throws(() => importQs(), rejects('M2_ROUND_WORDS_CONTRADICT_FILE', /forward\.plan_zh/));
  });
  withProfiles((reg) => { roundOf(reg, C17.strategy_ref).candidate.rows[1].window = ['2023-01-01', '2026-10-25']; }, () => {
    assert.throws(() => importC17(), rejects('M2_ROUND_WORDS_CONTRADICT_FILE', /segments\.OOS\.window/));
  });
  reset();
});

test('档案校验：m2_rounds 的形状错了，注册表加载失败（读法未知、缺 CANDIDATE_K2、查看日期格式、成本种类）', () => {
  const bad = [
    (spec) => { spec.reading = 'OTHER'; },
    (spec) => { spec.files = spec.files.filter((file) => file.role !== 'CANDIDATE_K2'); },
    (spec) => { spec.forward.look_not_before = '2027/04/30'; },
    (spec) => { spec.cost.kind = 'SHARED'; },
    (spec) => { spec.files[0].sha256 = 'abc'; },
  ];
  for (const mutate of bad) {
    const doc = JSON.parse(JSON.stringify(PRODUCTION));
    mutate(roundOf(doc, C17.strategy_ref));
    assert.throws(() => profiles.validate(doc), (error) => error.code === 'STRATEGY_PROFILE_FIELD_TYPE' || error.code === 'STRATEGY_PROFILE_FIELD_MISSING');
  }
  const legacy = JSON.parse(JSON.stringify(PRODUCTION));
  legacy.profiles.find((item) => item.strategy_ref === 'US_V5_ETF_3000USD').m2_rounds = [roundOf(legacy, C17.strategy_ref)];
  assert.throws(() => profiles.validate(legacy), /m2_rounds:not allowed with LEGACY_V1/);
});

// ── T4 / T7：逐字行 ────────────────────────────────────────────────────────────

test('T7 C17 轮次卡逐字：缺口句、7 行分解、不在场描述、候选三行、固定句、前向计划、成本句；T4 g 无定义的格不显示文件里的 −0.048', () => {
  reset(); seedBoth(); importC17();
  const [round] = m2.readProjections(C17);
  assert.equal(round.state, 'LOCKED_VERIFIED');
  assert.equal(round.line_zh, 'M2 第 1 轮 · 组合候选「只主流 + 上涨阶段不做空」· 前向影子运行中 · 最早 2027-04-30 查看（做 / 不做）');
  assert.deepEqual(round.blocks.map((item) => item.key), ['conclusion', 'decomposition', 'candidate', 'forward', 'cost']);
  const d = block(round, 'decomposition');
  assert.equal(d.lead_zh, C17_GAP);
  assert.deepEqual(d.columns_zh, ['分量', '样本外 Δg [95%]', '检出下限（样本外）', '开发期 Δg [95%]', '处理']);
  assert.deepEqual(d.rows, C17_ROWS);
  assert.equal(d.note_zh, C17_EXPOSURE);
  const c = block(round, 'candidate');
  assert.deepEqual(c.columns_zh, ['口径', '期末 候选 / 当前 D', '最大回撤', '最大亏损 USDT', 'Δg [95%]', '检出下限', 'P(权益曾 < 1,800)', 'C17 单独触到 A19 线 1,400']);
  assert.deepEqual(c.rows, C17_CAND);
  assert.deepEqual(c.notes_zh, ['历史三处区间都跨 0，都在检出下限以内：历史不能确认这个候选，采用只看前向。', '候选与当前 D 都没有可信地跑赢 BTC 买入持有。']);
  assert.equal(c.rules_zh[1], 'CAND-D 上涨阶段不做空：开 SHORT 前检查 BTC 日线：上一根已收盘日线 close > SMA200（200 根已收盘日线收盘的简单均值）→ 不开空；不足 200 根时不拦。');
  const f = block(round, 'forward');
  assert.equal(f.lines_zh[2], '查看：2027-04-30 与影子账本平仓满 60 笔，取后到者，一次查看。');
  assert.equal(f.do_zh.length, 3);
  assert.ok(f.after_zh.includes('只有做 / 不做，没有「证据不足」中间态；任何采用都须 Owner 签字。'));
  assert.equal(f.state_zh, '运行状态：前向影子运行中（登记起始 2026-10-27T09:27:03.038Z，HK 只读核对 2026-10-27；见前向观察）');
  assert.deepEqual(block(round, 'cost').lines_zh, [C17_COST]);
  assert.equal(block(round, 'conclusion').lines_zh[0], 'M2 第 1 轮：组合候选「只主流 + 上涨阶段不做空」已冻结，前向影子运行中，最早 2027-04-30 查看后按 做 / 不做 决定。历史三处区间都跨 0，都在检出下限以内：历史不能确认这个候选，采用只看前向。');
  const all = JSON.stringify(round);
  assert.ok(!all.includes('−0.048') && !all.includes('-0.048'), '开发期「去风险关」的假数不得出现（冻结裁定 3 F3）');
  // 这一轮没有三态：一行摘要、一句话、结论块都不用「证据不足」形容它（前向计划里那句「没有『证据不足』中间态」是冻结原文）
  for (const text of [round.line_zh, round.sentence_zh, ...block(round, 'conclusion').lines_zh]) assert.ok(!text.includes('证据不足'), text);
  reset();
});

test('T7 QS 轮次卡逐字：缺口句、12 行分解（R1–R4 结果）、候选两行、没有修好的一句、速度行、成本并入句；T4 单发的 g 无定义', () => {
  reset(); seedBoth(); importQs();
  const [round] = m2.readProjections(QS);
  assert.equal(round.line_zh, 'M2 第 1 轮 · 组合候选「只做空」· 前向影子运行中 · 最早 2027-04-30 查看（做 / 不做）');
  const d = block(round, 'decomposition');
  assert.equal(d.lead_zh, QS_GAP);
  assert.deepEqual(d.rows, QS_ROWS);
  assert.equal(d.note_zh, null);
  assert.equal(d.folded_zh.lines_zh.length, 5);
  const c = block(round, 'candidate');
  assert.deepEqual(c.columns_zh, ['口径', '期末 候选 / 当前 D', '最大回撤', '最大亏损 USDT', 'Δg [95%]', 'Δ每笔 R [95%]', '检出下限（g / R）']);
  assert.deepEqual(c.rows, QS_CAND);
  assert.equal(c.notes_zh[0], QS_FOOT);
  const f = block(round, 'forward');
  assert.ok(f.after_zh.includes('速度（只报）：候选样本外每月 16.4 笔，2026 年每月 8.6 笔；按后者，60 笔约在 2027-05 下旬（K2 §6）。'));
  assert.equal(f.do_zh.length, 4);
  assert.deepEqual(block(round, 'cost').lines_zh, [QS_COST]);
  assert.equal(round.selection_note_zh, '（12 项里只有它通过 R1–R4）');
  assert.deepEqual(round.cost_open, { question_ref: null, title_zh: '执行成本：并入 C17 的执行成本题', phase: 'MERGED', waiting_on: [], note_zh: 'QS 作为第二个账本，只报不判' });
  reset();
});

test('D6 「运行中」只来自前向登记：登记文件里没有这一条 → 「前向影子尚未登记运行」，导入引用无效 → 「前向登记的导入引用无效」', () => {
  reset(); seedBoth(); importC17();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-m2r-hk-'));
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'hk_forward_observations.v1.json'), 'utf8'));
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, JSON.stringify({ ...config, strategies: { US_V5_ETF_3000USD: config.strategies.US_V5_ETF_3000USD } }));
    const off = m2.readProjections(C17, { hk: { file: empty } })[0];
    assert.equal(off.forward.state, 'NOT_REGISTERED');
    assert.equal(off.line_zh, 'M2 第 1 轮 · 组合候选「只主流 + 上涨阶段不做空」· 前向影子尚未登记运行 · 最早 2027-04-30 查看（做 / 不做）');
    assert.equal(block(off, 'forward').state_zh, '运行状态：前向影子尚未登记运行');
    const invalid = path.join(dir, 'invalid.json');
    const broken = JSON.parse(JSON.stringify(config));
    broken.strategies.C17_V2_4000USDT.items[0].qrp_shadow_ref = 'SHADOW-NOT-IN-QRP';
    fs.writeFileSync(invalid, JSON.stringify(broken));
    assert.equal(m2.readProjections(C17, { hk: { file: invalid } })[0].forward.text_zh, '前向登记的导入引用无效');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); reset(); }
});

// ── T3 / T8：研究进度（纯函数）──────────────────────────────────────────────────

const roundFact = (over = {}) => ({
  state: 'LOCKED_VERIFIED', round: 1, result_id: 'R1-229940c24a2246bc', frozen_on: '2026-10-27', component_count: 7, selection_note_zh: '',
  candidate_name_zh: '只主流 + 上涨阶段不做空', look_not_before: '2027-04-30', min_closed: 60,
  forward: { state: 'RUNNING', text_zh: '前向影子运行中', started_on: '2026-10-27T09:27:03.038Z' }, ...over,
});
const c17Facts = (round) => ({
  profile: true, m4: null, current_case: false, baseline_of_case: false, m1: { state: 'NO_PRODUCER' },
  q0: { state: 'LOCKED_VERIFIED', result_id: 'Q0-e80c42523b30f768', verdict_label: '证据不足', a0: { state: 'FAILED' }, superseded_result_ids: ['Q0-26691b6c3a2c4227'] },
  comparisons: [], rounds: null,
  open: [
    { question_ref: 'Q4', title_zh: '风控维度：熔断与日停、去风险系数、总持仓、30 h 冷却', phase: 'READY_FOR_K2', waiting_on: [] },
    ...(round && round.state === 'LOCKED_VERIFIED' ? [{ question_ref: null, title_zh: '执行成本：EXEC-1 + CAL', phase: 'RUNNING', waiting_on: [] }] : []),
  ],
  ...(round ? { m2_round: round } : {}),
});

test('T3 研究进度：轮次锁 → ROUND_FORWARD，标题句与四行逐字（§7.1）；前向未登记、轮次锁校验失败各有自己的句子；没有轮次时句子与计数对象不变', () => {
  const s = stage.stageOf(c17Facts(roundFact()));
  assert.equal(s.code, 'ROUND_FORWARD');
  assert.equal(s.headline_zh, C17_HEAD);
  assert.deepEqual(s.steps.map((step) => step.text_zh), [
    'M1 体检包已登记，QRP 尚无它的诊断生产者 · A0 未通过 · Q0 证据不足（替代过 1 份旧锁）',
    '第 1 轮已做（2026-10-27 冻结）：缺口分解 7 项，组合候选「只主流 + 上涨阶段不做空」',
    '前向查看后按 做 / 不做 决定：最早 2027-04-30，且影子平仓满 60 笔；任何采用须 Owner 签字',
    'Q4 风控维度：熔断与日停、去风险系数、总持仓、30 h 冷却（待立题，等 K2 冻结）；执行成本：EXEC-1 + CAL（进行中，K2 已冻结）',
  ]);
  assert.deepEqual(s.technical.at(-1), { label: '第 1 轮锁', value: 'R1-229940c24a2246bc' });
  assert.equal(s.counts.forward_running, true);
  const off = stage.stageOf(c17Facts(roundFact({ forward: { state: 'NOT_REGISTERED', text_zh: '前向影子尚未登记运行', started_on: null } })));
  assert.equal(off.headline_zh, 'Q0 证据不足（A0 未通过）；第 1 轮已做：缺口分解 + 组合候选已冻结，前向影子尚未登记运行，最早 2027-04-30 查看，2 题待研究');
  assert.equal(off.counts.forward_running, false);
  const bad = stage.stageOf(c17Facts({ state: 'INVALID', round: 1, result_id: 'R1-229940c24a2246bc' }));
  assert.equal(bad.code, 'ROUND_INVALID');
  assert.equal(bad.headline_zh, 'Q0 证据不足（A0 未通过）；第 1 轮封存结果校验未通过，1 题待研究');
  assert.equal(bad.steps[1].text_zh, '第 1 轮封存结果校验未通过');
  const none = stage.stageOf(c17Facts(null));
  assert.equal(none.code, 'Q0_LOCKED');
  assert.equal(none.headline_zh, 'Q0 证据不足（A0 未通过）；方案对比尚未开始，1 题待研究');
  assert.ok(!('m2_round' in none.counts) && !('forward_running' in none.counts));
});

test('T8 页头计数句：Q0 已锁的括号里加「N 个已做第 1 轮、前向影子运行中」（只数前向已登记的）；没有轮次时计数对象与句子逐字不变', () => {
  const us = stage.stageOf({ ...c17Facts(null), q0: { ...c17Facts(null).q0, a0: { state: 'PASSED' } } });
  const running = stage.stageOf(c17Facts(roundFact()));
  const off = stage.stageOf(c17Facts(roundFact({ forward: { state: 'NOT_REGISTERED', text_zh: '前向影子尚未登记运行', started_on: null } })));
  const plain = stage.countsOf([us]);
  assert.deepEqual(Object.keys(plain), ['with_record', 'q0_locked', 'q0_invalid', 'compared', 'decided', 'connected_without_q0', 'frozen_baseline', 'm4_pending']);
  assert.equal(stage.countsSentence(plain), '其中 1 个有研究记录：1 个已锁定 Q0 回测结论。');
  const counts = stage.countsOf([us, running, running, off]);
  assert.equal(counts.rounds_forward, 2);
  assert.equal(stage.countsSentence(counts), '其中 4 个有研究记录：4 个已锁定 Q0 回测结论（2 个已做第 1 轮、前向影子运行中）。');
  const compared = { ...counts, compared: 1, decided: 1 };
  assert.equal(stage.countsSentence(compared), '其中 4 个有研究记录：4 个已锁定 Q0 回测结论（1 个已有锁定的方案对比、1 个已有 Owner 采用决定、2 个已做第 1 轮、前向影子运行中）。');
});

// ── 真实页面（T3、T9、T10）────────────────────────────────────────────────────────

const PAGE = fs.readFileSync(path.join(ROOT, 'apps', 'research-web', 'index.html'), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
async function renderPage(model, hash) {
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = { id, innerHTML: '', textContent: '', addEventListener() {}, querySelector() { return null; }, focus() {}, scrollIntoView() {} });
  const sandbox = {
    document: { getElementById: element, title: '' }, location: { hash }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(model)) }),
    requestAnimationFrame() {}, URLSearchParams, Intl, encodeURIComponent, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return elements.workspace.innerHTML;
}
const textOf = (html) => html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** 真实 Q0（C17 V1 → V2 替代、QS）导入临时账本；带不带轮次锁由 withRounds 决定。 */
function importRealBaselines() {
  reset();
  k3.importBaselineEvaluation(REAL_C17_V1, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref });
  k3.importBaselineEvaluation(REAL_C17_V2, { registeredBy: AUTHORITY, strategyRef: C17.strategy_ref, supersedes: 'Q0-26691b6c3a2c4227',
    defectRef: 'C17_V2_QRP_ONBOARDING_K2_ERRATUM_1_CADENCE', reason: 'K2 §5 扫描节奏勘误 1（协调冻结裁定 3 F1）：按生产 10 分钟网格' });
  k3.importBaselineEvaluation(REAL_QS, { registeredBy: AUTHORITY, strategyRef: QS.strategy_ref });
  k3.clearCache();
}

test('T3 / T9 真实页面：总览卡片两句逐字、页头计数句、详情一句话与下一步研究、研究页轮次卡（card=R1 展开）；US_V5、US_CORE 的详情投影与没有轮次时逐字节相同', { skip: SKIP_PAGE }, async () => {
  importRealBaselines();
  const before = {};
  for (const ref of ['US_V5_ETF_3000USD', 'US_CORE_9000USD_3X_GATEOBS']) before[ref] = JSON.stringify((await workspace.readModel({ strategyRef: ref })).views['strategy-detail']);
  importC17(); importQs();
  for (const ref of Object.keys(before)) {
    assert.equal(JSON.stringify((await workspace.readModel({ strategyRef: ref })).views['strategy-detail']), before[ref], `${ref} 的详情投影变了`);
  }
  const model = await workspace.readModel({ strategyRef: C17.strategy_ref });
  const card = (ref) => model.strategy_directory.strategies.find((item) => item.strategy_ref === ref).research_stage;
  assert.equal(card(C17.strategy_ref).headline_zh, C17_HEAD);
  assert.equal(card(QS.strategy_ref).headline_zh, QS_HEAD);
  assert.equal(card(QS.strategy_ref).steps[1].text_zh, '第 1 轮已做（2026-10-27 冻结）：缺口分解 12 项，组合候选「只做空」（12 项里只有它通过 R1–R4）');
  const overview = textOf(await renderPage(model, '#strategies'));
  assert.ok(overview.includes('2 个已做第 1 轮、前向影子运行中'), '页头计数句缺轮次');
  assert.ok(overview.includes(`Research：${C17_HEAD}`) && overview.includes(`Research：${QS_HEAD}`));
  assert.ok(!overview.includes('方案对比尚未开始，1 题待研究'), '加密卡片不再写「方案对比尚未开始」');
  const view = model.views['strategy-detail'];
  assert.ok(view.summary.sentence_zh.endsWith('；M2 第 1 轮：组合候选「只主流 + 上涨阶段不做空」已冻结，前向影子运行中，最早 2027-04-30 查看后按 做 / 不做 决定'));
  assert.deepEqual(view.summary.rules.next.map((item) => `${item.title_zh}：${item.text_zh}`), ['第 1 轮组合候选：前向查看，最早 2027-04-30（且影子平仓满 60 笔）', '执行成本：EXEC-1 + CAL：进行中，K2 已冻结']);
  assert.ok(textOf(await renderPage(model, `#strategy-detail?strategy=${C17.strategy_ref}`)).includes('第 1 轮组合候选：前向查看，最早 2027-04-30（且影子平仓满 60 笔）'));
  const folded = await renderPage(model, `#strategy-detail?strategy=${C17.strategy_ref}&section=research`);
  assert.match(folded, /data-card="R1" id="card-R1" data-fold="closed"/);
  assert.ok(textOf(folded).includes('M2 第 1 轮 · 组合候选「只主流 + 上涨阶段不做空」· 前向影子运行中 · 最早 2027-04-30 查看（做 / 不做）'));
  assert.ok(!textOf(folded).includes('暂无真实研究问题'));
  const opened = await renderPage(model, `#strategy-detail?strategy=${C17.strategy_ref}&card=R1`);
  assert.match(opened, /data-card="R1" id="card-R1" data-fold="open"/);
  const text = textOf(opened);
  for (const line of [C17_GAP, C17_EXPOSURE, C17_COST, ...C17_ROWS.flat(), ...C17_CAND.flat()]) assert.ok(text.includes(line), `轮次卡缺：${line}`);
  assert.match(opened, /data-round-block="conclusion" data-fold="open"/);
  assert.match(opened, /data-round-block="forward" data-fold="open"/);
  assert.match(opened, /data-round-block="decomposition" data-fold="closed"/);
  const forward = textOf(await renderPage(model, `#strategy-detail?strategy=${C17.strategy_ref}&section=forward`));
  assert.ok(forward.includes('Q0 结果文件里带有前向记录 15 笔（只报不判）；HK 上已在跑 1 条前向影子（1 条尚未导入）。'));
  assert.ok(forward.includes('C17_V2 第 1 轮组合候选影子账本（只主流 + 上涨阶段不做空）'));
  const qs = await workspace.readModel({ strategyRef: QS.strategy_ref });
  const qsText = textOf(await renderPage(qs, `#strategy-detail?strategy=${QS.strategy_ref}&card=R1`));
  for (const line of [QS_GAP, QS_FOOT, QS_COST, ...QS_ROWS.flat(), ...QS_CAND.flat()]) assert.ok(qsText.includes(line), `QS 轮次卡缺：${line}`);
  assert.ok(!qsText.includes('2026-10-27T09:27:03'), 'QS 页不得出现 C17 影子的起始时刻');
  reset();
});

// J5.1（真浏览器、真实锁）
const PROBE = (routes) => `<!doctype html><meta charset="utf-8"><title>probe</title><pre id="out">PENDING</pre><script>
const routes = ${JSON.stringify(routes)};
(async () => {
  const results = [];
  for (const [route, width] of routes) {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;left:0;top:0;border:0;height:800px;width:' + width + 'px';
    frame.src = '/' + route;
    document.body.appendChild(frame);
    await new Promise((resolve) => frame.addEventListener('load', resolve));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const doc = frame.contentDocument; const root = doc.documentElement;
    results.push({ route, width, height: root.scrollHeight, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, sections: doc.querySelectorAll('#workspace .detail-section').length, text: doc.getElementById('workspace').innerText.length });
    frame.remove();
  }
  document.getElementById('out').textContent = JSON.stringify(results);
})();
</script>`;

async function probe(models, routes) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__probe')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PROBE(routes)); return; }
    if (req.url.startsWith('/api/workspace')) {
      const ref = new URL(req.url, 'http://x').searchParams.get('strategy_ref');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(models[ref] || models.default)); return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-m2r-chrome-'));
  try {
    const stdout = await new Promise((resolve) => {
      const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        `--user-data-dir=${profile}`, '--virtual-time-budget=90000', '--dump-dom', `http://127.0.0.1:${server.address().port}/__probe`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; child.stdout.on('data', (chunk) => { out += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
      child.on('close', () => { clearTimeout(timer); resolve(out); });
    });
    const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout);
    assert.ok(match && match[1] !== 'PENDING', '探针页没有跑完');
    return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
}

test('T10 J5.1 在 C17 与 QS 页上（真实锁）：1280 × 800 下总览 ≤ 1,600 px、「研究与对比」全部折叠 ≤ 3,000 px；390 px 宽下总览、研究、前向、全部展开都没有整页横向滚动', { skip: SKIP_BROWSER, timeout: 300000 }, async () => {
  importRealBaselines(); importC17(); importQs();
  const models = {
    [C17.strategy_ref]: await workspace.readModel({ strategyRef: C17.strategy_ref }),
    [QS.strategy_ref]: await workspace.readModel({ strategyRef: QS.strategy_ref }),
  };
  models.default = models[C17.strategy_ref];
  const routes = [];
  for (const ref of [C17.strategy_ref, QS.strategy_ref]) {
    const base = `#strategy-detail?strategy=${ref}`;
    routes.push([base, 1280], [`${base}&section=research`, 1280], ...['', '&section=research', '&section=forward', '&section=all', '&card=R1'].map((extra) => [`${base}${extra}`, 390]));
  }
  const rows = await probe(models, routes);
  assert.equal(rows.length, routes.length);
  for (const row of rows) assert.ok(row.sections >= 1 && row.text > 80, `${row.route} @${row.width} 没有渲染出页面（${row.text} 字）`);
  for (const ref of [C17.strategy_ref, QS.strategy_ref]) {
    const overview = rows.find((row) => row.width === 1280 && row.route === `#strategy-detail?strategy=${ref}`);
    const research = rows.find((row) => row.width === 1280 && row.route.endsWith('&section=research') && row.route.includes(ref));
    assert.ok(overview.height <= 1600, `${ref} 总览 @1280：${overview.height} px > 1,600`);
    assert.ok(research.height <= 3000, `${ref} 研究与对比（全部折叠）@1280：${research.height} px > 3,000`);
  }
  for (const row of rows.filter((item) => item.width === 390)) assert.ok(row.scrollWidth <= row.clientWidth, `${row.route} @390：整页横向宽度 ${row.scrollWidth} > ${row.clientWidth}`);
  console.log(`M2 round J5.1: ${rows.map((row) => `${row.route.replace('#strategy-detail?strategy=', '')}@${row.width} h=${row.height} w=${row.scrollWidth}/${row.clientWidth}`).join('; ')}`);
  reset();
});
