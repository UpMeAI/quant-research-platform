'use strict';

/**
 * 海外研究封存结论 `OVERSEAS_SEALED_VERDICT_V1` —— 导入规格 docs/contracts/OVERSEAS_SEALED_VERDICTS_IMPORT_PROFILE_V1.md。
 *
 * 2026-11-03 起海外研究会话封存的结论（C17_V2、QUICK_SHOT_V3、US_V5、US_CORE），一题一条锁，挂在各自策略的详情页上。
 * 导入的是封存文件原样：结论、证据强度、允许用途都从锁定的文件里读，不重算、不重新评价。
 *   - 登记表 ENTRIES 按 sha256 钉住每题的绑定文件（结果文件；草稿题是 K2 草稿；前向影子题是冻结的影子规格）、K2、冻结裁定；
 *   - stage：从钉版 smartflow 提交（git show）与协调会话目录取出这些字节，sha256 不符即停，写进证据目录并带 .sha256 旁注；
 *   - import：整批先校验（文件 sha256、旁注、结论与登记的期望值一致），全部通过才追加锁；同一文件重复导入是幂等重放；
 *     同一题已有另一份锁时拒绝，除非 supersedes 指向当前锁并给出缺陷引用与理由（旧锁保留）；
 *   - 页面投影每次读都现场复验 sha256，文件漂移或缺失就显示原因，不显示结论。
 * 没有 HTTP 写入口，不下单，不改生产参数（production_effect: NONE）。做 ≠ 生产采用。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { dataDir, now, append, read } = require('../../packages/ledger');
const baseline = require('../baseline-evaluation');
const profiles = require('../strategy-profiles');

const { K3Error, need, sha256, canonical, authority } = baseline.internals;

const LOCK_SCHEMA = 'OVERSEAS_SEALED_VERDICT_LOCK_V1';
const RECORD_TYPE = 'OVERSEAS_SEALED_VERDICT_V1';
const IMPORT_PROFILE_ID = 'docs/contracts/OVERSEAS_SEALED_VERDICTS_IMPORT_PROFILE_V1.md';
const LEDGER = () => path.join(dataDir('research'), 'overseas_sealed_verdicts.jsonl');
const E = (code) => `OVERSEAS_VERDICT_${code}`;
const fail = (code, detail) => { throw new K3Error(code, detail); };
const SHA64 = /^[0-9a-f]{64}$/;

// ── 登记表 ──────────────────────────────────────────────────────────────────────

const sf = (commit, file, sha) => Object.freeze({ source: 'smartflow', commit, path: `trading-system-v2/${file}`, sha256: sha,
  ref: `smartflow@${commit.slice(0, 8)}:trading-system-v2/${file}` });
const coord = (file, sha) => Object.freeze({ source: 'coordinator', path: file, sha256: sha,
  ref: `artifacts/coordinator/${file}（不在 git 里，按 sha256 绑定）` });

const COMMIT = Object.freeze({
  Q4: '91d9d7deac64b173701dbed3d2ebf5ab6470e7c8', N2: '4ee1ef3d6460aa5467ca6f4dee27de00e8ed890c', N4: '51aac8ff2a0c9bfb36ce47fa5382be9bad754fa8',
  N4_SHADOW: 'e7cde51ed410b654f385631c8d1d07bd080b11fa', N6: 'ae5b11734657a1f6185dcf85b860b95d69637834', N7: 'ad1aa384b2890236e099c98412f9d22a2c9c3c43',
  X06: '215b2bab4a6b8123d6174429c115a42e972abf72', N3: '5104c3b9cb8251bff1519882f22b5e2fd99f55ff', N5: '2a6dbfefee17a9c14f5e9bb111c8668255dad8a2',
  Q6_SHADOW: '86864cc4c78254e9e22328386eea992c6415a489', N1: '833737dba793d38f97ca6101ed05436db67f181b',
  US_CORE_TOUCH: '352fa66fbe8fd45a0221eaae5c051fb873dbe492', X08: '312faa9656df27bb5c729dfc6dadf9067dcc890e',
  N8: 'f38045671afd5c31434f36a6ab580dfd3842d34a', N7_RUN: 'a7e74f15c5b526bfe0af61d549a73ce1c43ebcfb',
  N8_RUN: 'b971b05cb95546eb3cc83fe2d86f7dd0166f04a7',
  R_US_ETF_1: 'e41c43c44fd03462040f6e1b039a53729eed1ee3', R_US_ETF_1_RUN: '3a635a49538f84e9b4582393d18e76ef1262d521',
});

const Q4_RESULT = sf(COMMIT.Q4, 'docs/evidence/crypto-risk-q4/CRYPTO_C17_QS_RISK_Q4_RESULT_V1_E1.json', 'baa60ba86c44059fecd1b6a815d4302281ad6f478ae77b294522474a8b156730');
const Q4_K2 = sf(COMMIT.Q4, 'docs/CRYPTO_C17_QS_RISK_Q4_K2_DRAFT_V1.md', '56a976593f4f582706215b22d444dc1fda563469f365db0edd8d4f7053c5e808');
const Q4_FREEZE = coord('CRYPTO_C17_QS_RISK_Q4_K2_FREEZE_1.md', '759e35fb5f0f52d5a55ac98efba0ebf4df9efd8c0ba33f689ed1ff315aca9e1a');
const N7_K2 = sf(COMMIT.N7, 'docs/CRYPTO_N7_TRADE_FREQUENCY_K2_DRAFT_V1.md', 'fa6032d2fd67767c01ef9c1e51c745392da098b2e47b0d9a0f942c2da00e385b');
const N7_FREEZE = coord('CRYPTO_N7_TRADE_FREQUENCY_K2_FREEZE_1.md', '0c10d255779369e1e592615f8a391a56350736287cf6d0e96a9a85a26073e258');
const N7_RESULT = sf(COMMIT.N7_RUN, 'docs/evidence/crypto-n7-v1/CRYPTO_N7_TRADE_FREQUENCY_RESULT_V1.json', '469a0d86e441b75dd617f8e0f9882ff4aac2d7780e4b2c74bdbabac1c48c5c97');
const n7Read = (book) => Object.freeze({ decision: `verdict.${book}.decision`, strength: `verdict.${book}.evidence_strength`,
  use: `verdict.${book}.allowed_use`, text: 'answer_first_r_n7_2.text_zh' });
const N8_K2 = sf(COMMIT.N8, 'docs/C17_N8_NON_MAIN_K2_DRAFT_V1.md', '404cd2695324b7d545aacc4ab4fb021374fa9453c2cb0979e808ffe4305a46f2');
const N8_RESULT = sf(COMMIT.N8_RUN, 'docs/evidence/c17-n8-v1/C17_N8_NON_MAIN_RESULT_V1.json', '7aacf521398d2fc1f0aa3ed3a2b4daf4c81eacad497e1f2269e9673cb946b3fb');
const N8_FREEZE = coord('C17_N8_NON_MAIN_K2_FREEZE_1.md', 'f3b1477c78ea4c1f1a32f8fc779fb497c119208f734e381c11d9719f40c799cc');
const RUE1_K2 = sf(COMMIT.R_US_ETF_1, 'docs/R_US_ETF_1_MEAN_REVERSION_K2_DRAFT_V1.md', '1db0b65f188f7a02d827c7d765e486dbfd07ca0ec1892ba41a004177c32561b5');
const RUE1_RESULT = sf(COMMIT.R_US_ETF_1_RUN, 'docs/evidence/us-etf-r1-v1/R_US_ETF_1_RESULT_V1.json', '406a061b1c181331252cb4683c02cb9c653ab77d5b3f1b21aed3d41c980625af');
// 冻结记录含勘误 1（V5-SPY、V5-QQQ 不适用）；勘误前 301d26b8…
const RUE1_FREEZE = coord('R_US_ETF_1_K2_V1_FREEZE_RECORD.md', '95b0408fe062e775f572c2f97305d2cd15a1ceb3fe7c737f206303bd3f9a7b6e');
// 结果文件 verdict_detail 的顺序：0 UC-SPY、1 UC-QQQ、2 V5-SPY、3 V5-QQQ、4 V5-VOO、5 V5-SPMO
const rue1Read = (i) => Object.freeze({ decision: `verdict_detail.${i}.decision`, strength: `verdict_detail.${i}.evidence_strength_zh`,
  use: `verdict_detail.${i}.allowed_use_zh`, text: 'first_paragraph_zh' });
const rue1 = (id, label, strategy_ref, i, expect, note_zh) => Object.freeze({ id, label_zh: label, strategy_ref, kind: 'RESULT', sealed_on: '2026-11-05',
  title_zh: `宽基 ETF 均值回归波段（R-US-ETF-1，${label}）`, file: RUE1_RESULT, k2: RUE1_K2, freeze: RUE1_FREEZE, read: rue1Read(i), expect, note_zh });
const US_CORE_K2 = sf(COMMIT.US_CORE_TOUCH, 'docs/US_CORE_TOUCH_EXIT_Q0_K2_DRAFT_V1.md', 'ab4302b7e492727ae4c6c0b45d4f72f2c6ca50e63bf7bd3d33fd33f1eda4e83a');

const C17 = 'C17_V2_4000USDT';
const QS = 'QUICK_SHOT_V3_1000USDT';
const US5 = 'US_V5_ETF_3000USD';
const UC = 'US_CORE_9000USD_3X_GATEOBS';

const verdictPaths = (prefix = 'verdict', { strength = 'evidence_strength', use = 'allowed_use', text = 'text_zh' } = {}) => Object.freeze({
  decision: `${prefix}.decision`, strength: strength && `${prefix}.${strength}`, use: use && `${prefix}.${use}`, text: text && `${prefix}.${text}` });

/**
 * kind：RESULT（封存结论，读文件里的结论）、DRAFT（K2 草稿，未冻结）、STATUS（已冻结或前向影子：冻结文本 + 运行状态，不出结论）、
 * READING（只报读数，不改规则，不出结论；修订 1）。RESULT 的统计态 INSUFFICIENT 按 resolve 写成做 / 不做（Owner 10-06），统计态留在证据强度栏。
 * rev：登记修订号（修订 1）。同一文件换了读法时 rev 加一，result_id 随之改变，只能按 supersede 取代旧锁。
 * expect：导入时文件里读出的结论必须等于它（失败即关）。note_zh 只写来源说明与日期，不写数字以外的结论。
 */
const ENTRIES = Object.freeze([
  { id: 'C17-Q4', label_zh: 'Q4（风控）', strategy_ref: C17, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: '熔断与日停按凯利后的风险单位重设', file: Q4_RESULT, k2: Q4_K2, freeze: Q4_FREEZE,
    read: verdictPaths('verdict', { text: 'wording_zh' }), expect: '做' },
  { id: 'C17-N2', label_zh: 'N2', strategy_ref: C17, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: '当前 D 对 BTC 买入持有的差距分解（诊断）',
    file: sf(COMMIT.N2, 'docs/evidence/c17-n2-v1/C17_N2_RESULT_V1.json', '3cc7a2cff18ba92319c55f41ed5057ab1089728398c6910fa4310aaa5d32c656'),
    k2: sf(COMMIT.N2, 'docs/C17_N2_GAP_DECOMPOSITION_K2_DRAFT_V1.md', '1849879db0f5854101ccaeb9a3c7f5b101beeecaa8f25bcfe512fdd8a9ffb38e'),
    freeze: coord('C17_N2_GAP_DECOMPOSITION_K2_FREEZE_1.md', '3a68e25a5d0557c56224260b1912d63faafcbc48a2e9e3f0af8aee1f2100d95b'),
    read: verdictPaths(), expect: '不做' },
  { id: 'C17-N4', label_zh: 'N4', strategy_ref: C17, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: '降手续费与滑点：入场挂单 + 止盈与决策出场挂单',
    file: sf(COMMIT.N4, 'docs/evidence/c17-n4-v1/C17_N4_FEE_SLIPPAGE_RESULT_V1.json', '83fda6e7d4d9405d3c600b0cf13f8d8c03f9a3225fa992d0ace0c6c9f59a9f8d'),
    k2: sf(COMMIT.N4, 'docs/C17_N4_FEE_SLIPPAGE_K2_DRAFT_V1.md', '008e416f9248525c52506eee9863b6eb1b73fd394a1914e1646a563cd1f324f2'),
    freeze: coord('C17_N4_FEE_SLIPPAGE_K2_FREEZE_1.md', 'ecca50d0a65d7ea24069d5ef38e4ddc769286b09e3094ac60060e1d93a823b99'),
    read: verdictPaths(), expect: '做' },
  { id: 'C17-N4-SHADOW', label_zh: 'N4 前向影子', strategy_ref: C17, kind: 'STATUS', sealed_on: '2026-11-04',
    title_zh: '挂单成交前向影子（R-N4-2）',
    file: sf(COMMIT.N4_SHADOW, 'docs/C17_N4_MAKER_FILL_SHADOW_V1.md', '56ccf0b8cfa3685dbe98403acd8b877178b083cac0f239b3b402ad5bd3f98c21'),
    k2: null, freeze: coord('C17_N4_MAKER_FILL_SHADOW_V1_FREEZE_1.md', 'd8c2f608e495295a1554e03fb5018c12d73127ec956bb8e97cd2c78df76b22e3'),
    status_zh: '前向影子运行中',
    note_zh: 'smartflow #91 已合（e7cde51e）；HK pm2 已登记 c17-n4-maker-fill-shadow（每小时一次，2026-11-05 只读核对）。只记成交率与逆向选择，不改生产下单；首次查看按影子规格。' },
  { id: 'C17-N6', label_zh: 'N6', strategy_ref: C17, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: '空仓缺口按闸门归因 + 唯一组合候选',
    file: sf(COMMIT.N6, 'docs/evidence/c17-n6-v1/C17_N6_OUT_OF_MARKET_RESULT_V1.json', '37d8c9d16b0af980c28ed51c48999d85b64ea66bf9a2636ad400b4227d2a422d'),
    k2: sf(COMMIT.N6, 'docs/C17_N6_OUT_OF_MARKET_K2_DRAFT_V1.md', 'fd7783507c2e4986ca618ae41339df26f91842f7376281d3089c0d21d70a218e'),
    freeze: coord('C17_N6_OUT_OF_MARKET_K2_FREEZE_1.md', '7dc84e563e815cf43b54134499694c38bf4fb8c12bb043e782b8c8f02a044cb5'),
    read: verdictPaths(), expect: '不做' },
  // 修订 1：草稿 fa6032d2 冻结后为 STATUS；11-05 封存（469a0d86），改为 RESULT，按 supersede 取代 STATUS 锁
  { id: 'C17-N7', label_zh: 'N7', strategy_ref: C17, kind: 'RESULT', sealed_on: '2026-11-05',
    title_zh: '降低交易频率：每月至多开仓一次', file: N7_RESULT, k2: N7_K2, freeze: N7_FREEZE,
    read: n7Read('C17_V2_4000USDT'), expect: '不做' },
  // 修订 1：N8 于 11-05 02:05 CST 冻结时为 STATUS；11-05 封存（7aacf521），改为 RESULT，按 supersede 取代 STATUS 锁
  { id: 'C17-N8', label_zh: 'N8', strategy_ref: C17, kind: 'RESULT', sealed_on: '2026-11-05',
    title_zh: '非主流合约：保留、收窄还是去掉', file: N8_RESULT, k2: N8_K2, freeze: N8_FREEZE,
    read: Object.freeze({ decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use', text: 'first_paragraph_zh' }),
    expect: '不做',
    note_zh: '历史判不出：测试段与开发期方向不一致。结果文件写的「功效约 92%」是按开发期效应推算的，测试段效应消失；K2 的先验是 6–11%。主要证据是前向影子（T_start 2026-11-04T18:05:00Z，查看工具须在第一次查看前上 main）。补记 1：签字的凯利上限 0.43 已含非主流；研究线工具只算 BTC/ETH，已记入诊断清单。生产规则不变。' },
  { id: 'QS-Q4', label_zh: 'Q4（风控）', strategy_ref: QS, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: '熔断与日停按凯利后的风险单位重设（QS 部分）', file: Q4_RESULT, k2: Q4_K2, freeze: Q4_FREEZE,
    read: verdictPaths('verdict.qs', { text: null }), expect: '不做' },
  // 修订 1：草稿 fa6032d2 冻结后为 STATUS；11-05 封存（469a0d86），改为 RESULT，按 supersede 取代 STATUS 锁
  { id: 'QS-N7', label_zh: 'N7', strategy_ref: QS, kind: 'RESULT', sealed_on: '2026-11-05',
    title_zh: '降低交易频率：每月至多开仓一次', file: N7_RESULT, k2: N7_K2, freeze: N7_FREEZE,
    read: n7Read('QUICK_SHOT_V3_1000USDT'), expect: '不做' },
  { id: 'US5-X06', label_zh: 'X06', strategy_ref: US5, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: '45 日回看：45 日读法与锚定读法取严',
    file: sf(COMMIT.X06, 'docs/evidence/kelly-us-drawdown-v1/us5-lookback/KELLY_US5_LOOKBACK_RESULT_V1.json', '97677edb65420a70a9f0047774df7250fea8f118ef53f801a5a15ddd32d1ad59'),
    k2: sf(COMMIT.X06, 'docs/US_V5_45D_LOOKBACK_RESEARCH_K2_DRAFT_V1.md', '9698d490575e1c80e2c1cde7db7bdea0233cf9751673a72419f94a6aeb839170'),
    freeze: sf(COMMIT.X06, 'docs/US_V5_ROUND2_ITEMS_1_4_K2_FREEZE_1.md', 'e4bcc0cc81144327bf983b0d50d47b19eaff997b807ce9beb3d95bb3ed2574e3'),
    read: Object.freeze({ decision: 'decision.verdict', strength: null, use: null, text: null }), expect: '做',
    note_zh: '修订已起草，待 Owner 签字（KELLY_CAP_ONLY_AMENDMENT_V1 修订 1）；签字前生产不变。' },
  { id: 'US5-N3', label_zh: 'N3', strategy_ref: US5, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: 'M-1 进海外桶的可行性（Rule 1b 桶线）',
    file: sf(COMMIT.N3, 'docs/evidence/bucket-n3-v1/OVERSEAS_BUCKET_N3_M1_FEASIBILITY_RESULT_V1.json', 'c9b473398ef683508cb003c0ab2cbd4fd505ff23af5617b6c2ad352bebefbefb'),
    k2: sf(COMMIT.N3, 'docs/OVERSEAS_BUCKET_N3_M1_FEASIBILITY_K2_DRAFT_V1.md', '309c400e1e5df30a00525ea3780dc419431af973491cbd6494b66b56c7c6aa65'),
    freeze: coord('OVERSEAS_BUCKET_N3_M1_FEASIBILITY_K2_FREEZE_1.md', '39758f3368230a96de6d7838fdf847819afb2c7e1162b511762e5c82790232ba'),
    read: Object.freeze({ decision: 'verdict.decision', strength: null, use: 'verdict.use_zh', text: 'verdict.text' }), expect: '不做' },
  { id: 'US5-N5', label_zh: 'N5', strategy_ref: US5, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: 'M-1 下 US_V5 的 m 上限前沿',
    file: sf(COMMIT.N5, 'docs/evidence/us-v5-n5-v1/US_V5_N5_MCAP_FRONTIER_RESULT_V1.json', '9416bc71c2b88613d3b6a23c7fd16b5387b960c49c302d50813832b5f729d205'),
    k2: sf(COMMIT.N5, 'docs/US_V5_N5_MCAP_FRONTIER_K2_DRAFT_V1.md', '6b834e8a2f8cb918c681cd05fd81ab1a993202d73d3be1f62811308271eb64be'),
    freeze: coord('US_V5_N5_MCAP_FRONTIER_K2_FREEZE_1.md', 'f53314982c3d718c3dc8ae5eddb308d886fdd92737190360bbfa10ec2c865a36'),
    read: Object.freeze({ decision: 'verdict.decision', strength: 'verdict.evidence_strength', use: 'verdict.allowed_use_zh', text: 'verdict.text' }), expect: '不做' },
  { id: 'US5-Q6-M1-SHADOW', label_zh: 'Q6 M-1 前向影子', strategy_ref: US5, kind: 'STATUS', sealed_on: '2026-11-04',
    title_zh: 'M-1（闲置现金停在 SPY）前向影子 US_V5_M1_SHADOW',
    file: sf(COMMIT.Q6_SHADOW, 'docs/US_V5_M1_SHADOW_FORWARD_V1.md', '56c60d9bb79eecec641437de27cdc3a17a6fd739107b400213e7704520dc2c10'),
    k2: null, freeze: null, cites: Object.freeze(['Q6-0510c7da07196bb2']),
    status_zh: '前向影子运行中',
    note_zh: 'Q6（封存 0510c7da，本页 Q6 卡）判「做」后的前向影子：smartflow #81 已合（86864cc4），HK pm2 已登记 us-v5-m1-shadow（每小时一次，2026-11-05 只读核对）。首次判定 2027-11-02（R-Q6F-1），2027-05-03 只描述；进生产要 Owner 签第 1 类修订。' },
  { id: 'UC-U08-Q0', label_zh: '当前 D 的 Q0（日线近似）', strategy_ref: UC, kind: 'RESULT', sealed_on: '2026-11-03',
    title_zh: '到价出场加凯利 0.42 之后的当前 D：Q0 日线近似',
    file: sf(COMMIT.US_CORE_TOUCH, 'docs/evidence/us-core-touch-q0-v1/US_CORE_CURRENT_D_Q0_DAILY_APPROX_RESULT_V1.json', '5f85fd8a34cd44b7e054f71c9e1d2071bb90eb024217dab02b5021ef8654ca84'),
    also: Object.freeze([sf(COMMIT.US_CORE_TOUCH, 'docs/evidence/us-core-touch-q0-v1/phase2/US_CORE_TOUCH_KELLY_LINES_V1.json', '6d75a0ce4e75b71f7517a8b648c50c26ef09f2a7ffbac8eb7c38cc46d3253842')]),
    k2: US_CORE_K2, freeze: coord('US_CORE_TOUCH_EXIT_Q0_K2_FREEZE_1.md', '72a54f6cd045d390c6b5d07ea10a4b5528e3832eb1283f464823b20d670e4206'),
    read: Object.freeze({ decision: 'verdict.state', strength: 'verdict.reason_codes', use: null, text: null }), expect: 'INSUFFICIENT',
    // 修订 1：页面结论只写做 / 不做（Owner 10-06）。当前 D 在 HK 纸面账本上运行（到价出场 10-29 起、凯利 0.42），INSUFFICIENT 而在纸面 = 做
    rev: 2, resolve: Object.freeze({ INSUFFICIENT: Object.freeze({ decision: '做', use_zh: '当前 D 继续在纸面账本上运行（Owner 10-06：INSUFFICIENT 而在纸面 = 做）；生产规则不变' }) }),
    note_zh: '日线近似最多到 INSUFFICIENT，不能认证盘中到价规则。R-REUSE 不做：封存 Q0 不代表当前 D（差别主要来自凯利 0.42）。生产不变。' },
  // 修订 1：只报读数，没有提出、也没有采用任何规则改动，所以不写做 / 不做
  { id: 'UC-U13-30M', label_zh: '30 分钟读数（附录 1）', strategy_ref: UC, kind: 'READING', rev: 2, sealed_on: '2026-11-04',
    title_zh: '凯利线的 30 分钟读数（1 分钟历史不存在）',
    file: sf(COMMIT.US_CORE_TOUCH, 'docs/evidence/us-core-touch-q0-v1/addendum-1/phase2/US_CORE_TOUCH_KELLY_LINES_30MIN_V1.json', '78a9b2aa53da00baa902f26d2711d6a5d8d019197977dd983297a701e9583203'),
    also: Object.freeze([sf(COMMIT.US_CORE_TOUCH, 'docs/evidence/us-core-touch-q0-v1/addendum-1/US_CORE_CURRENT_D_Q0_30MIN_RESULT_V1.json', '870a644ac07c17242cebf10648dcdb97fff7c695bad70985665da7d432db2937')]),
    k2: sf(COMMIT.US_CORE_TOUCH, 'docs/US_CORE_TOUCH_EXIT_Q0_K2_ADDENDUM_1_30MIN_DRAFT.md', '0ac538ea0b73a93f96f9b83f16090a7ee0d3bc0928d1dd555cd3237512ce983e'),
    freeze: coord('US_CORE_TOUCH_EXIT_Q0_K2_ADDENDUM_1_FREEZE_1.md', '05e72fa0aac0e8721ea6e1ab3561f9e527bb18c31f0f4516f3d82df3de9cc390'),
    read: Object.freeze({ decision: 'verdict.decision', strength: null, use: null, text: 'verdict.text' }), expect: '做',
    status_zh: '只报读数（不改规则）', note_zh: '只报不判；30 分钟近似，不是 1 分钟。不改 m，不触发修订（R-A1-4）。' },
  { id: 'UC-N1', label_zh: 'N1', strategy_ref: UC, kind: 'RESULT', sealed_on: '2026-11-04',
    title_zh: '当前 D 的差距分解 + 闲置现金组合候选',
    file: sf(COMMIT.N1, 'docs/evidence/us-core-n1-v1/US_CORE_N1_RESULT_V1.json', '0fe7c5976eceecc1d29da5ac3fef2cc93a6bc9b24b2e3eff7fbdca6f4569a6f4'),
    k2: sf(COMMIT.N1, 'docs/US_CORE_N1_IDLE_CASH_COMPLETE_CANDIDATE_K2_DRAFT_V1.md', '8be74d382f2bf95fbb7e3e6c2c9d202f8e224398d7ae2ad7851c0bdd30b4cdee'),
    freeze: coord('US_CORE_N1_IDLE_CASH_K2_FREEZE_1.md', 'c8ca974df19139c6284859aa64d381ad6f60dea437104a57d68a6b5611934dc0'),
    read: Object.freeze({ decision: 'verdict.decision', strength: 'verdict.strength', use: 'verdict.use', text: 'verdict.text' }), expect: '不做' },
  { id: 'UC-X08', label_zh: 'X08（状态）', strategy_ref: UC, kind: 'RESULT', sealed_on: '2026-10-06',
    title_zh: '长期核心对 3 倍择时（US_LONGTERM_VS_TIMING_V1）',
    file: sf(COMMIT.X08, 'research/us-longterm-vs-timing/result-v1.json', '14e8f567c623e9435f96aa1f1bf24dad2cb52078e9eb04073bfc58455c9f18da'),
    k2: sf(COMMIT.X08, 'docs/US_LONGTERM_CORE_VS_3X_TIMING_ACCEPTANCE_V1.md', '59ac9e5e931cd5eec26c9e40a3f0f5b5a6841ee9aef9af311755901d1a2feddc'),
    freeze: null, read: Object.freeze({ final: 'final' }), expect: 'V2_SPY:不做',
    note_zh: '10-06 签署后跑完（验收即 K2，Owner 签字 f7664c1b）。2026-11-04 盘点：V1、V2_SPMO 前向影子在 HK 运行（10-07 起，2026-11-05 只读核对 pm2）；V3 两条影子未启动，待协调会话裁定。' },
  rue1('UC-RUE1-SPY', 'R-US-ETF-1 SPY 袖', UC, 0, '不做',
    'MR-V1 只在 2.9% 的交易日持仓，差距几乎全在「现行在场、MR 空仓」一格，即少拿了趋势期的 3x 收益；IS、OOS 同号。该袖保留现行趋势规则，计划页照写趋势。生产不变。'),
  rue1('UC-RUE1-QQQ', 'R-US-ETF-1 QQQ 袖', UC, 1, '不做',
    'MR-V1 只在 2.0% 的交易日持仓，输在趋势期的 3x 收益；IS、OOS 同号。该袖保留现行趋势规则。生产不变。'),
  rue1('US5-RUE1-VOO', 'R-US-ETF-1 VOO', US5, 4, '做',
    '点估计 +0.0036，方向判对的概率只有 56%，接近抛硬币（K2 §9 预先写明）。「做」= 起草第 1 类修订交 Owner 签字；进修订前须补一次 US_V5 账本级的线检查。V5-SPY、V5-QQQ 按勘误 1 不适用（US_V5 不做多这两个序列，在 US_CORE 两袖判）。生产不变。'),
  rue1('US5-RUE1-SPMO', 'R-US-ETF-1 SPMO', US5, 5, '做',
    '弱：窗口内现行 US_V5 在 SPMO 上只成交 3 笔（全部止损），+0.0313 主要是 MR-V1 对近乎现金的差，不是胜过一条活跃的规则；买入持有对 MR-V1 高 0.169 /年。SPMO 按 smartflow #99 的 P-3 表算宽基，#99 合并前「待归类定稿」。「做」= 起草第 1 类修订交 Owner 签字，进修订前须补 US_V5 账本级线检查。生产不变。'),
]);

// ── 读文件 ──────────────────────────────────────────────────────────────────────

const at = (doc, dotted) => {
  if (!dotted) return null;
  let value = doc;
  for (const key of dotted.split('.')) { if (value === null || typeof value !== 'object' || !(key in value)) return null; value = value[key]; }
  return value;
};
const textOf = (value) => (value === null || value === undefined ? null : Array.isArray(value) ? value.join('、') : typeof value === 'object' ? null : String(value));
const FINAL_ZH = { UNDECIDED: '未判定（转前向）' };

/** 从封存文件读出结论（RESULT）；DRAFT / STATUS 不读结论。 */
function readVerdict(entry, doc) {
  if (entry.kind === 'DRAFT' || entry.kind === 'STATUS') return { decision: entry.status_zh, strength: null, use: null, text: null };
  if (entry.read.final) {
    const final = at(doc, entry.read.final);
    need(final && typeof final === 'object', E('VERDICT_FIELD_MISSING'), `${entry.id}:${entry.read.final}`);
    const lines = Object.entries(final).map(([line, row]) => `${line} ${FINAL_ZH[row.action] || row.action}`);
    return { decision: lines.join('；'), code: Object.entries(final).map(([line, row]) => `${line}:${row.action}`), strength: null, use: null,
      text: Object.entries(final).map(([line, row]) => `${line}：${row.verdict}${row.label ? `（${row.label}）` : ''}${row.next ? ` → ${row.next}` : ''}`).join('；') };
  }
  const raw = textOf(at(doc, entry.read.decision));
  need(raw, E('VERDICT_FIELD_MISSING'), `${entry.id}:${entry.read.decision}`);
  const strength = textOf(at(doc, entry.read.strength));
  const text = textOf(at(doc, entry.read.text));
  if (entry.kind === 'READING') return { decision: entry.status_zh, raw, code: [raw], strength, use: textOf(at(doc, entry.read.use)), text };
  const resolved = entry.resolve && entry.resolve[raw];
  if (resolved) return { decision: resolved.decision, raw, code: [raw], strength: `统计判定 ${raw}${strength ? `（${strength}）` : ''}`, use: resolved.use_zh, text };
  return { decision: raw, raw, code: [raw], strength, use: textOf(at(doc, entry.read.use)), text };
}
const readsFile = (entry) => entry.kind === 'RESULT' || entry.kind === 'READING';
const expectHolds = (entry, verdict) => (!readsFile(entry) ? true
  : entry.read.final ? verdict.code.includes(entry.expect) : verdict.raw === entry.expect);
/** 一题的锁编号：OSV-<题>-<绑定文件 sha256 前 12 位>，登记修订号 rev > 1 时加 -r<rev>（修订 1）。 */
const resultIdOf = (entry) => `OSV-${entry.id}-${entry.file.sha256.slice(0, 12)}${entry.rev > 1 ? `-r${entry.rev}` : ''}`;

const boundFiles = (entry) => [
  { role: 'FILE', spec: entry.file }, ...(entry.also || []).map((spec) => ({ role: 'ALSO', spec })),
  ...(entry.k2 && entry.k2 !== entry.file ? [{ role: 'K2', spec: entry.k2 }] : []), ...(entry.freeze && entry.freeze !== entry.file ? [{ role: 'FREEZE', spec: entry.freeze }] : []),
];
const evidencePath = (dir, spec) => (spec.source === 'smartflow' ? path.join(dir, 'smartflow', spec.commit.slice(0, 12), spec.path) : path.join(dir, 'coordinator', spec.path));

function readBound(file, expectSha) {
  if (!fs.existsSync(file)) fail(E('FILE_MISSING'), file);
  const bytes = fs.readFileSync(file);
  const actual = sha256(bytes);
  need(actual === expectSha, E('SHA256_MISMATCH'), `${path.basename(file)}:${actual.slice(0, 12)}…≠${expectSha.slice(0, 12)}…`);
  const side = `${file}.sha256`;
  if (!fs.existsSync(side)) fail(E('SIDECAR_MISSING'), side);
  need(fs.readFileSync(side, 'utf8').trim().split(/\s+/)[0] === expectSha, E('SIDECAR_MISMATCH'), side);
  return bytes;
}
const parseJson = (bytes, where) => { try { return JSON.parse(bytes.toString('utf8')); } catch (error) { return fail(E('RESULT_NOT_JSON'), where); } };

// ── 取证据（stage） ──────────────────────────────────────────────────────────────

/** 从钉版 smartflow 提交与协调会话目录取出所有绑定文件，sha256 不符即停；写进 out，带 .sha256 旁注。返回清单。 */
function stageEvidence({ smartflowRoot, artifactsRoot, out, entries = ENTRIES }) {
  need(smartflowRoot && artifactsRoot && out, E('STAGE_ARGUMENTS'), 'smartflowRoot, artifactsRoot, out');
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const { role, spec } of boundFiles(entry)) {
      const dest = evidencePath(out, spec);
      if (seen.has(dest)) continue;
      seen.add(dest);
      const bytes = spec.source === 'smartflow'
        ? execFileSync('git', ['-C', smartflowRoot, 'show', `${spec.commit}:${spec.path}`], { maxBuffer: 1 << 30 })
        : fs.readFileSync(path.join(artifactsRoot, spec.path));
      const actual = sha256(bytes);
      need(actual === spec.sha256, E('STAGE_SHA256_MISMATCH'), `${entry.id}:${role}:${spec.path}:${actual.slice(0, 12)}…≠${spec.sha256.slice(0, 12)}…`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      fs.writeFileSync(`${dest}.sha256`, `${actual}  ${path.basename(dest)}\n`);
      rows.push({ path: path.relative(out, dest), ref: spec.ref, sha256: actual, bytes: bytes.length });
    }
  }
  const manifest = { kind: 'OVERSEAS_SEALED_VERDICTS_STAGE_V1', import_profile_id: IMPORT_PROFILE_ID, entries: entries.map((e) => e.id), files: rows };
  fs.writeFileSync(path.join(out, 'STAGE.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

// ── 锁 ──────────────────────────────────────────────────────────────────────────

function locks(strategyRef = null) {
  return read(LEDGER()).filter((row) => row.schema === LOCK_SCHEMA && (!strategyRef || row.strategy_ref === strategyRef));
}
function headLock(entryId) {
  const rows = locks().filter((row) => row.entry_id === entryId);
  return rows.length ? rows[rows.length - 1] : null;
}

/** 校验一题（不写）：绑定文件全部在证据目录且 sha256 与旁注一致；RESULT 的结论等于登记的期望值。 */
function checkEntry(entry, evidenceDir) {
  const profile = profiles.mustGet(entry.strategy_ref);
  const refs = boundFiles(entry).map(({ role, spec }) => {
    const file = evidencePath(evidenceDir, spec);
    readBound(file, spec.sha256);
    return { role, ref: spec.ref, sha256: spec.sha256, file_ref: path.resolve(file) };
  });
  const bytes = fs.readFileSync(evidencePath(evidenceDir, entry.file));
  const verdict = readsFile(entry) ? readVerdict(entry, parseJson(bytes, entry.id)) : readVerdict(entry, null);
  need(expectHolds(entry, verdict), E('VERDICT_NOT_AS_REGISTERED'), `${entry.id}:${verdict.raw}≠${entry.expect}`);
  for (const cited of entry.cites || []) need(typeof cited === 'string' && cited, E('CITE_INVALID'), entry.id);
  return { profile, refs, verdict };
}

/**
 * 导入并锁定（命令行，完成权威）。整批先校验，全部通过才写；同一文件重复导入是幂等重放。
 * 某题已有另一份锁时拒绝，除非 supersedes 是那份锁的 result_id 并给出缺陷引用与理由（旧锁保留）。
 */
function importVerdicts(evidenceDir, { registeredBy, entries = ENTRIES, supersedes = {}, defectRef = null, reason = null, lockedAt = null } = {}) {
  authority(registeredBy);
  need(evidenceDir && fs.existsSync(evidenceDir), E('EVIDENCE_DIR_MISSING'), evidenceDir);
  const ids = new Set();
  const plan = entries.map((entry) => {
    need(!ids.has(entry.id), E('DUPLICATE_ENTRY'), entry.id);
    ids.add(entry.id);
    const checked = checkEntry(entry, evidenceDir);
    const resultId = resultIdOf(entry);
    const head = headLock(entry.id);
    if (head && head.result_id === resultId) return { replay: head };
    if (head) {
      need(supersedes[entry.id] === head.result_id, E('ALREADY_LOCKED'), `${entry.id}:${head.result_id}`);
      need(defectRef && reason, E('SUPERSEDE_REQUIRES_DEFECT_AND_REASON'), entry.id);
    } else need(!supersedes[entry.id], E('SUPERSEDE_TARGET_NOT_FOUND'), entry.id);
    return { entry, checked, resultId, supersedesRef: head ? head.result_id : null };
  });
  const stamp = lockedAt || now();
  return plan.map((step) => {
    if (step.replay) return { ...step.replay, replayHit: true };
    const { entry, checked, resultId, supersedesRef } = step;
    const body = {
      schema: LOCK_SCHEMA, record_type: RECORD_TYPE, result_id: resultId, entry_id: entry.id, kind: entry.kind,
      strategy_ref: checked.profile.strategy_ref, case_ref: checked.profile.case_ref, sealed_on: entry.sealed_on,
      decision: checked.verdict.decision, file_ref: checked.refs[0].file_ref, file_sha256: entry.file.sha256, refs: checked.refs,
      cites: [...(entry.cites || [])], smartflow_commit: entry.file.source === 'smartflow' ? entry.file.commit : null,
      import_profile_id: IMPORT_PROFILE_ID, supersedes_ref: supersedesRef, defect_ref: supersedesRef ? defectRef : null,
      supersede_reason: supersedesRef ? reason : null, production_effect: 'NONE', locked_by: registeredBy, locked_at: stamp,
    };
    body.lock_hash = sha256(canonical(body));
    return append(LEDGER(), body);
  });
}

// ── 页面投影 ────────────────────────────────────────────────────────────────────

const KIND_ZH = { RESULT: '已封存', DRAFT: '草稿（未冻结）', STATUS: '冻结 / 前向影子', READING: '只报读数' };
const FILE_LABEL_ZH = { RESULT: '封存结果文件', READING: '封存读数文件', DRAFT: 'K2 草稿', STATUS: '影子规格' };
const ROLE_LABEL_ZH = { ALSO: '同题另一封存文件', K2: '研究规格（K2）', FREEZE: '冻结裁定' };
const toneOf = (entry, decision) => (entry.kind !== 'RESULT' ? 'NEUTRAL' : decision === '做' ? 'DO' : decision === '不做' ? 'DONT' : 'OTHER');
const reasonText = (error) => (error instanceof K3Error ? `${error.code}${error.detail ? `（${error.detail}）` : ''}` : error.message);

function buildProjection(entry, lock) {
  const base = { entry_id: entry.id, label_zh: entry.label_zh, title_zh: entry.title_zh, kind: entry.kind, kind_zh: KIND_ZH[entry.kind],
    sealed_on: lock.sealed_on, result_id: lock.result_id, production_effect: 'NONE' };
  try {
    // 修订 1：登记改了读法（rev）或绑定文件，而台账里还是旧锁时，不按新读法显示旧锁，等协调会话按 supersede 重新导入
    if (lock.result_id !== resultIdOf(entry)) {
      return { ...base, state: 'REIMPORT_PENDING', reason: `登记已更新（${resultIdOf(entry)}），等待按 supersede 重新导入；旧锁 ${lock.result_id} 保留`, reason_code: E('REIMPORT_PENDING') };
    }
    for (const ref of lock.refs) readBound(ref.file_ref, ref.sha256);
    need(lock.file_sha256 === entry.file.sha256, E('LOCK_NOT_REGISTERED_FILE'), entry.id);
    const verdict = readsFile(entry) ? readVerdict(entry, parseJson(fs.readFileSync(lock.file_ref), entry.id)) : readVerdict(entry, null);
    need(expectHolds(entry, verdict), E('VERDICT_NOT_AS_REGISTERED'), entry.id);
    const ref = (role) => lock.refs.find((row) => row.role === role) || null;
    const k2 = entry.k2 === entry.file ? ref('FILE') : ref('K2');
    return {
      ...base, state: 'LOCKED_VERIFIED', reason: null,
      decision_zh: verdict.decision, tone: toneOf(entry, verdict.decision),
      strength_zh: verdict.strength, use_zh: verdict.use, text_zh: verdict.text, note_zh: entry.note_zh || null,
      k2_sha256: k2 ? k2.sha256 : null, result_sha256: readsFile(entry) ? lock.file_sha256 : null, cites: lock.cites,
      source: {
        result_id: lock.result_id, locked_at: lock.locked_at, locked_by: lock.locked_by, smartflow_commit: lock.smartflow_commit,
        supersedes_ref: lock.supersedes_ref || null,
        files: lock.refs.map((row) => ({ role: row.role, ref: row.ref, sha256: row.sha256,
          label_zh: row.role === 'FILE' ? entry.file_label_zh || FILE_LABEL_ZH[entry.kind] : ROLE_LABEL_ZH[row.role] || row.role })),
        import_profile_id: lock.import_profile_id,
      },
    };
  } catch (error) {
    const missing = error instanceof K3Error && /MISSING/.test(error.code);
    return { ...base, state: missing ? 'MISSING' : 'INVALID', reason: `封存文件校验未通过：${reasonText(error)}`, reason_code: error.code || 'UNKNOWN' };
  }
}

const CACHE = new Map();
const statKey = (file) => { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch (error) { return `ERR:${error.code}`; } };

/** 这条策略已导入的海外封存结论（登记表顺序，每题取当前锁）。每次读都现场复验 sha256。 */
function readProjections(strategyRef, { entries = ENTRIES } = {}) {
  const rows = locks(strategyRef);
  if (!rows.length) return [];
  const heads = new Map();
  for (const row of rows) heads.set(row.entry_id, row);
  return entries.filter((entry) => entry.strategy_ref === strategyRef && heads.has(entry.id)).map((entry) => {
    const lock = heads.get(entry.id);
    const stamp = [lock.lock_hash, ...lock.refs.flatMap((ref) => [statKey(ref.file_ref), statKey(`${ref.file_ref}.sha256`)])].join('|');
    const hit = CACHE.get(lock.result_id);
    if (hit && hit.stamp === stamp) return hit.result;
    const result = buildProjection(entry, lock);
    CACHE.set(lock.result_id, { stamp, result });
    return result;
  });
}

const clearCache = () => CACHE.clear();

module.exports = {
  LOCK_SCHEMA, RECORD_TYPE, IMPORT_PROFILE_ID, ENTRIES, LEDGER, stageEvidence, importVerdicts, locks, headLock, readProjections, clearCache,
  internals: { readVerdict, boundFiles, evidencePath, checkEntry, resultIdOf, SHA64 },
};
