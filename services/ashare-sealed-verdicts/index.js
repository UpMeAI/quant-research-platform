'use strict';

/**
 * A 股研究封存结论 `ASHARE_SEALED_VERDICT_V1` —— 导入规格 docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1.md（复盘闭环修订 8 §5）。
 *
 * 校验、取证据、幂等重放、supersede 与海外结论同一套（../overseas-sealed-verdicts，错误码也沿用它的前缀）；台账和锁模式独立。
 * 结论只从封存文件读，不重算、不重新评价；A 股 Q0 账户不在登记表里，也不读。production_effect: NONE。「做」≠ 生产采用。
 */
const path = require('path');
const { dataDir } = require('../../packages/ledger');
const overseas = require('../overseas-sealed-verdicts');

const IMPORT_PROFILE_ID = 'docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1.md';
const LEDGER = () => path.join(dataDir('research'), 'ashare_sealed_verdicts.jsonl');
const STORE = Object.freeze({
  ledger: LEDGER, lockSchema: 'ASHARE_SEALED_VERDICT_LOCK_V1', recordType: 'ASHARE_SEALED_VERDICT_V1', importProfileId: IMPORT_PROFILE_ID, idPrefix: 'ASV',
  commitSource: 'ashare-v6', commitField: 'ashare_v6_commit', identityOf: (entry) => ({ strategy_ref: entry.strategy_ref, case_ref: null }),
});

const v6 = (commit, file, sha) => Object.freeze({ source: 'ashare-v6', commit, path: file, sha256: sha, ref: `Ashare-V6@${commit.slice(0, 8)}:${file}` });
const coord = (file, sha) => Object.freeze({ source: 'coordinator', path: file, sha256: sha, ref: `artifacts/coordinator/${file}（不在 git 里，按 sha256 绑定）` });

const INDEX = 'INDEX_BOOK';
const R_ETF_2 = v6('d62dde221298c67a3ec079529209b635c490d5d7', 'research/index-grid/r-etf-2/result-r-etf-2.json', 'd45595910e4235b3f2075daccc82aa11f71699e09dd8feff6bf542e39fb17518');
const R_ETF_2_K2 = v6('f19520304755445eb529dc8d5708a09aae644b6a', 'docs/contracts/drafts/ASHARE_V6_ETF_SWING_R_ETF_2_K2_V1.draft.md', 'dace890cce5126e8201d2a51ddbc6429a448d558996f6ded891807dcb2b96ba1');
const rEtf2 = (code, suffix, name) => Object.freeze({ id: `CN-R-ETF-2-${code}`, label_zh: `R-ETF-2 ${name}`, strategy_ref: INDEX, kind: 'RESULT', sealed_on: '2026-11-10',
  title_zh: `宽基 ETF 均值回归波段（R-ETF-2，${code}.${suffix}）`, file: R_ETF_2, k2: R_ETF_2_K2, freeze: null, expect: '不做',
  read: Object.freeze({ decision: ['decisions', `${code}.${suffix}`, 'decision'], state: ['decisions', `${code}.${suffix}`, 'reasons'], strength: null, use: 'consequence', text: null }) });

// 修订 1（docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1_AMENDMENT_1.md）：PVS-2、PVS-4 第 1 阶段，一份结果文档两题，结论从 §0 表里各自那一行读。
// 两份 K2 都在过拟合控制修订（2026-11-11）之前冻结，k2_frozen_at 取冻结页写的分钟段起点（「13:2x」→ 13:20，「09:3x」→ 09:30），G-TRIAL 门不适用。
const PVS24_RESULT = coord('PVS_2_4_RESULT_V1.md', '1cbfe175f3eccc76810ed2006e2396c981d7db18bea759ffeafba423807af4be');
const PVS24_NOTE = '判定读法：协调会话 PVS_2_4_RESULT_V1_RULINGS_20261113.md（b2438e63…）裁定 1 (a)，BLOCKED(G1_COUNTER_UNREADABLE) 按 G1_NOT_MET 读；第 1 阶段 2024-01-02 → 2026-09-28；k2_frozen_at 取冻结页分钟段起点。';
const pvs24Read = (q) => Object.freeze({ pattern: `^\\| \\*\\*PVS-${q}\\*\\* [^|]*\\| [^|]*\\| \\*\\*(做|不做) = `, strength_pattern: `^\\| \\*\\*PVS-${q}\\*\\* [^|]*\\| ([^|]+?) \\|` });

// 修订 2（docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1_AMENDMENT_2.md）：行业 ETF 左侧埋伏。K2 在 2026-11-12 07:58:23 冻结（过拟合控制修订之后），
// 两道试验台账门都过：7 个预登记行、运行日志（研究分支上，按 sha256 绑定）、披露行。结论从封存 JSON 的 verdict.state 读，INSUFFICIENT 而在前向影子 = 做。
const SEL1_COMMIT = '933d47ff8b4c81eff83bc7558f6799b8020c33e1';
const SEL1_RUN_LOG_COMMIT = '0a6ebc730b4a590323105a539692839a228eab6f';

// 修订 3（docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1_AMENDMENT_3.md）：X07a A 股凯利（个股簿）。K2 在 2026-11-14 13:25:47 冻结（过拟合控制修订之后），
// 13 个台账 id 在冻结后、首次计算前登记 → PRE 按门的裁定记 DEVIATION_ACCEPTED；披露行的 DSR、PBO 不适用，引用同一页裁定。
// 结果与运行日志在协调会话目录（按 sha256 绑定）：结果同 smartflow research/x07a-ashare-kelly 0f4fc855 的证据文件逐字节相同。
// K2 绑的就是冻结页（台账行的 k2_sha256 = 冻结页 sha；正文 = 草稿修订 2 db45a25e）；NOTE_1（种子、步 0b 的两道门）与 NOTE_2（运行代码 74d4ae6d）一并绑定。
const X07A_K2 = coord('X07A_ASHARE_KELLY_K2_V1_FREEZE_1.md', 'c3533cd9af966a8fb7fd7a9d759bf61e06aad202c451ed0b5f8ab60bda0aac87');
const X07A_RULING = Object.freeze({
  spec: coord('X07A_ASHARE_KELLY_K2_V1_TRIAL_GATES_RULING_20261114.md', 'aed3659512cf58e4b4f0b0de02872b5315fb4accd32d3c27420c9bf488800b74'),
  pre: Object.freeze({ status: 'DEVIATION_ACCEPTED', codes: Object.freeze(['PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN']),
    preregistered_at: '2026-11-14T05:28:02.950Z', first_run_at: '2026-11-14T05:41:36Z' }),
  disclosure_not_applicable: Object.freeze(['dsr', 'pbo']),
});

// 修订 4（docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1_AMENDMENT_4.md）：R8 的 A 股部分（K 线否决与缠论扣留，个股簿）。K2 在 2026-11-11 22:28:56 冻结（过拟合控制修订之后），
// K2 §14 的 7 行在冻结前预登记（14:27:51.030Z），两道试验台账门照常过、不带门的裁定；披露行 OVD-f62f0cc373e0122b 的 DSR 照算法记 UNKNOWN。
// 结果与运行日志在协调会话目录（按 sha256 绑定）：结果文件是 Linux 封存 scratch/r8-sealed-20261115 里 R8_RESULT.json 的逐字节副本（SanDisk 镜像同 sha）。
// K2 绑冻结的草稿本身（台账行的 k2_sha256 = 草稿 299473b0），冻结页 4d30527e 另绑。
// K2 冻结早于 RF1112 生效（2026-11-15T22:47:42+08:00）：G-MECH、G-CAUSAL 都不适用（G-CAUSAL N/A: PRE_EFFECTIVE_K2），不绑因果证据；
// 机制 id 在 QRP #87 回填里是 SEL.KLINE.ENTRY_VETO、SEL.KLINE.EXIT_PROTECT、SEL.CHAN.HOLDBACK（条目 R8-ASHARE，消融题，§4.3 不写结论块），门不读，这里不另写字段
const R8_RESULT = coord('R8_X04_KLINE_CHAN_ASHARE_RESULT_V1.json', 'cfa6c0cbe7bb95b1fe9a27816de9c6ee0aa13650bc44bed139061d242f0acca3');
const R8_RUN_LOG = coord('R8_X04_KLINE_CHAN_ASHARE_RESEARCH_RUN_LOG_V1.json', '60e2a6a94038d92661af569803c154f426eb92e54fa61ac5ede33ef51a8f4e16');
const R8_K2 = coord('R8_X04_KLINE_CHAN_ASHARE_K2_V1.draft.md', '299473b0bfc3ed15c6075459b96f57b257afdefbc69bf64a6b89c660fd8b4f1c');
const R8_FREEZE = coord('R8_X04_KLINE_CHAN_ASHARE_K2_V1_FREEZE_1.md', '4d30527ee89f94753a38501297e6f7b64b2486249f2b8a15d6b5b002aba2b153');

// 修订 5（docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1_AMENDMENT_5.md）：R21 的两条判定（时机分缺 25% 权重，个股簿；J_RN、J_RP 各自对 B_K = C_RS、各用 95%）。
// K2 = 冻结页本身（台账行的 k2_sha256 = 冻结页 ca036b24），冻结记录 2026-11-14 01:56:13（过拟合控制修订之后）；K2 §7 的 3 行在冻结后 3 分 19 秒、首次计算之前登记，PRE 带门的裁定。
// 两条都是 INSUFFICIENT（G1_NOT_MET）→ 做 = 前向影子；前向影子的规则在封存里冻结（R21_FORWARD_SHADOW_RULE_V1，dd55ec46）。
// 结果与运行日志在协调会话目录（按 sha256 绑定）：结果文件是 Linux 封存 scratch/r21-sealed-20261116 里 R21_RESULT.json 的逐字节副本。
// K2 冻结早于 RF1112 生效（2026-11-15T22:47:42+08:00）与成本门 A1（2026-11-17T00:00:00+08:00）：G-MECH、G-CAUSAL、G-COST 都不适用（G-CAUSAL N/A: PRE_EFFECTIVE_K2），k2_frozen_at 照写。
const R21_RESULT = coord('R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_RESULT_V1.json', '9db6f7e8d31c08d5d6e8e13c67875bfd86cb21b1b5e03443217757f6e51d74c0');
const R21_RUN_LOG = coord('R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_RESEARCH_RUN_LOG_V1.json', '1ebfe73c0aeb0f1e66264309c55a3846ae5140915efc28ba7e714c1c2cdd0461');
const R21_K2 = coord('R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_K2_V1_FREEZE_1.md', 'ca036b246ade25d498dd3695fb1ac20ae3df438a11b8b2df53df7817c574b6a6');
const R21_RULING = Object.freeze({
  spec: coord('R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_K2_V1_TRIAL_GATES_RULING_20261116.md', '128687eeb0a2438c65d5786874f1480b4e50a0be71ae3f9cb5653c0dc9d7b942'),
  pre: Object.freeze({ status: 'DEVIATION_ACCEPTED', codes: Object.freeze(['PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN']),
    preregistered_at: '2026-11-13T17:59:32.399Z', first_run_at: '2026-11-13T18:03:43Z' }),
});
const R21_USE = '前向影子：R21_FORWARD_SHADOW_RULE_V1（dd55ec46，封存里冻结）：T_start 2026-11-17，按日与生产并排记 ① 读数，另一本只读研究账（C_RS + 该路径）；'
  + '只有记录器实时记下、或可逐字节复现的时点重放（附惰性证明）的会话才计入，否则 PENDING，不手填；读数照 K2 §5.1，G1 满足或 2027-05-17 先到者首读；生产不改';
const r21Entry = (id, pair, label, titleZh, g, changed) => ({ id, label_zh: label, strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-16', title_zh: titleZh,
  file: R21_RESULT, k2: R21_K2, freeze: null, run_log: R21_RUN_LOG, k2_frozen_at: '2026-11-14T01:56:13+08:00', trial_gates_ruling: R21_RULING,
  read: Object.freeze({ decision: `judged.${pair}.state`, strength: `judged.${pair}.reason_code`, use: null, text: `judged.${pair}.verdict_zh` }), expect: 'INSUFFICIENT',
  resolve: Object.freeze({ INSUFFICIENT: Object.freeze({ decision: '做', use_zh: R21_USE }) }),
  note_zh: `INSUFFICIENT（G1_NOT_MET）→ 做 = 前向影子：${pair} 两阶段合并 g ${g}，1537 个会话、76 个月；改变的入场 ${changed} 笔 < 30（成熟交易 ≥ 30）。规则不改、生产不改。`
    + '只报：g(T_RP_K − T_RN_K) −0.0886 %/年 [−0.2450 %, +0.0286 %]；分阶段复测（已读）只报。指数簿未跑（缺引擎，K2 §6），是缺口，不是证据不足。'
    + '过拟合披露（J_RN、J_RP 各一行）：N 42（下界），DSR 照算法算出（RN 0.0061、RP 1.9e-6），PBO NOT_APPLICABLE: CONFIGS_LT_4 — 3 configurations (C_RS, T_RN_K, T_RP_K); CSCV needs ≥ 4（协调会话裁定原文）。'
    + 'G_REPRO 两阶段 BINDING PASS（V6.3），G_INERT 两半 PASS。来源：Linux 封存 scratch/r21-sealed-20261116（SHA256SUMS dbb72dbe，SEAL_MANIFEST 9c2b2dc5），研究分支 Ashare-V6 research/r21-timing-weight 1477f16d，封存 2026-11-16。' });

// 修订 6（docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1_AMENDMENT_6.md）：R-XM-1 个股本闲置现金停放（M 货币 ETF 511880、B 短债 ETF 511010，对现金基线 C）。
// K2 = 草稿修订 3 本身（台账行的 k2_sha256 = 480ec87f），冻结页 FREEZE_1 另绑，2026-11-17 15:42:02 冻结——第一题在 RF1112（11-15 22:47:42）、附录 1（11-17 00:00）
// 与 G-PARITY（11-17 00:24）之后冻结的导入，五道门都过：G-COST、G-PARITY 照常 PASS；G-TRIAL PRE（冻结后、首次计算前登记）、G-MECH（先前结论表在冻结后按冻结前的数据生成，
// sha256 不在 K2 里；第 4 行「无。……」读作「无」）、G-CAUSAL（K2 没写范围，读作 N/A: RISK_K_OR_ACCOUNT_LAYER）都只出自同一页门的裁定，记 DEVIATION_ACCEPTED。
// 判定照 ★R1 (b)（裁定页 28bf76ca）：M = 做（有支持；过拟合门的族方差 V 不用本题自己的行，DSR = 1），B = 不做（T0 缺口）。指数本不出判定（K2 §6），不进登记表。
// 结果与运行日志在协调会话目录（按 sha256 绑定）：Linux 封存 rxm1/sealed-20261117（SEAL_MANIFEST 63de15fa）里 RXM1_RESULT.json、RUN_LOG.json 的逐字节副本。
const RXM1_RESULT = coord('R_XM_1_ASHARE_IDLE_CASH_RESULT_V1.json', '1b277f278a28b0ad10ff422cc75e7f1ff90691e5de9e8ef87317ecb4694e0bea');
const RXM1_RUN_LOG = coord('R_XM_1_ASHARE_IDLE_CASH_RESEARCH_RUN_LOG_V1.json', '5f253bb3de10ce25fea6bbfd915b9105647ceb9aaa3c09e8efc71ddadeae5bb9');
const RXM1_K2 = coord('R_XM_1_ASHARE_IDLE_CASH_K2_V1.draft.480ec87f.md', '480ec87fdc39880f1d44e7bd71642b56af1d4af56fb6179c18cf0fc845eb182e');
const RXM1_FREEZE = coord('R_XM_1_ASHARE_IDLE_CASH_K2_V1_FREEZE_1.md', '5794f7c3679fcffe21647d9b70e281b09d5b1fe129b5aab465c859151a61c320');
const RXM1_NOTES = Object.freeze([
  coord('R_XM_1_ASHARE_IDLE_CASH_K2_V1_FREEZE_1_NOTE_1.md', '4ecde74c33bff06ca39f87264eb42c2536d9ce56bdcf59414d0b94905608b3fb'),
  coord('R_XM_1_ASHARE_IDLE_CASH_K2_V1_FREEZE_1_NOTE_2.md', '900d38ccc103346f8e2cba3c164b926cc2eb5f15a94c12edbad372ba5fd91ac9'),
]);
const RXM1_ALSO = Object.freeze([
  coord('R_XM_1_ASHARE_IDLE_CASH_K2_V1_RESULT.md', 'c13e03fa930a26fe7d9571b2e8aece48c120be066488e3bec145e9271b17a4f3'),
  coord('R_XM_1_ASHARE_IDLE_CASH_K2_V1_RESULT_RULING_R1.md', '28bf76ca1c0b845ecb3a7b7008fcbf307369a4732f2fe741071fbb4c53c84e60'),
]);
const RXM1_PRIOR = coord('R_XM_1_MECHANISM_PRIOR_TABLE_V1.json', '04c4aec8358b7060813bdf379a4bd8dfcb6007964d57640a1478ba02e5f76c97');
// 门的裁定页：协调会话 2026-11-17T20:15:00+08:00 冻结（草稿 09ecea27 只读保留；冻结页只加 §3 说明与 §6 核对，机读记号不变）
const RXM1_GATES_RULING = coord('R_XM_1_IMPORT_GATES_RULING_1.md', '46861c5be29a6d95d3789f444bb2190b1e12f81334d0b73f726fd9544b6b74bf');
const RXM1_LINE4 = '无。只用封存回放与实盘账本里抽取的事实。';
const RXM1_SOURCE = '来源：Linux 封存 /srv/research-lane2/overseas/rxm1/sealed-20261117（SEAL_MANIFEST 63de15fa，15 个文件；Mac 副本逐个文件相符），运行代码 rxm1-run.js f516ae39（测试 7/7，两遍逐字节相同），封存 2026-11-17。'
  + '门的裁定页 R_XM_1_IMPORT_GATES_RULING_1：G-TRIAL PRE、G-MECH、G-CAUSAL 都记 DEVIATION_ACCEPTED；G-COST、G-PARITY 照常 PASS。'
  + '实盘 T0 检查按 NOTE_2（900d38cc）：c_{t−1} + 停放累计现金 + min(同一开盘本的卖出回笼, G_t) − G_t ≥ 0，回放里 M 三种读法缺口都是 0。';
const rxm1Entry = (id, row, code, expect, labelZh, titleZh, noteZh) => ({ id, label_zh: labelZh, strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-17', title_zh: titleZh,
  file: RXM1_RESULT, also: RXM1_ALSO, k2: RXM1_K2, freeze: RXM1_FREEZE, k2_notes: RXM1_NOTES, run_log: RXM1_RUN_LOG, k2_frozen_at: '2026-11-17T15:42:02+08:00',
  trial_gates_ruling: Object.freeze({ spec: RXM1_GATES_RULING, pre: Object.freeze({ status: 'DEVIATION_ACCEPTED', codes: Object.freeze(['PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN']),
    preregistered_at: '2026-11-17T07:48:36.403Z', first_run_at: '2026-11-17T07:54:06.728Z' }) }),
  mechanism_ids: Object.freeze(['ACCT.IDLE_CASH.TBILL_PARKING']), mechanism_prior_table: RXM1_PRIOR, ai_inputs: Object.freeze([]),
  mechanism_ruling: Object.freeze({ spec: RXM1_GATES_RULING, deviations: Object.freeze(['MECHANISM_PRIOR_TABLE_NOT_IN_K2', 'AI_ROLE_K2_LINE4_READ_AS_NONE']), line4_text: RXM1_LINE4 }),
  causality_ruling: Object.freeze({ spec: RXM1_GATES_RULING, scope_not_applicable: 'RISK_K_OR_ACCOUNT_LAYER' }),
  read: Object.freeze({ decision: `rows.${row}.verdict`, strength: null, use: null, text: null }), expect,
  note_zh: `${noteZh}${RXM1_SOURCE}` });

// 修订 7（docs/contracts/ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1_AMENDMENT_7.md）：R-STK-1 D4（③ 排序净化加价值底线初筛，个股簿）与 X07b（按 k 分档的日 / 周亏损锁，个股簿）。
// 结论文件直接绑 Mac 封存副本里的那一份（协调会话目录 evidence/<封存目录>/，与 Linux 封存逐字节相同），封存目录的 SHA256SUMS 与结果页一并绑定。
// D4：K2 冻结页 2026-11-10 00:57:00 CST（早于 G-TRIAL 11-11 与之后的各道门）→ 五道门都不适用；之后冻结的附注不重新冻结 K2。判定只读 J2（全改动），J1 与排序效应写在 note_zh；
// 结果页附注 1（32fb2a41）的报表覆盖说明作为披露写在 note_zh，附注页按 sha256 绑定。
// X07b：K2 = 草稿终稿 3fae758b（台账行的 k2_sha256），冻结页 2026-11-14T23:39:05+08:00；3 行在冻结前 53 秒预登记，G-TRIAL 两道门照常过、不带门的裁定；
// 冻结早于 RF1112、附录 1 与 G-PARITY，其余四道门不适用。运行日志按封存事实写（build-x07b-seal-kit.js），结果行与披露由协调会话导入前写入台账（修订 7 §4）。
const D4_SEAL = 'evidence/rstkd4-sealed-20261118';
const D4_NOTES = Object.freeze([
  ['NOTE_1', '561362074691ddbcd94211ddd54ea8caffccc6afd95c536e62656a85b8f43dfa'], ['NOTE_2', '364e87b8c5ab98c8182da02819a3ef0a8aeca028f584635c6b706984531eec43'],
  ['NOTE_3', '70850b411f712dfd435fcb72f82f71f36bef725f2d7da904c7acec230317b032'], ['NOTE_4', 'dc7c2431cbe73ba127ff89dafd16bdd3dbd33c549716cf79855cc690d56cf472'],
  ['NOTE_5', '12bd9c3b943058783c030f5f9754a6f24159a9c063e054b63666554271d8a2e0'], ['NOTE_6', '68acf5cc94228078e52671a40e990bebd5bc5618e0f457529b3e51a6cc2754c8'],
  ['NOTE_7', '31c5ae5cfaac024e6c1040a24514667a212cabd28c2e894bbe2de457faf22184'], ['NOTE_8', 'bd9087041f662ec802d2bf77e087778d179484c2d7f4b7a98f683a1d03d77a32'],
  ['NOTE_8_CLARIFICATION_1', '4e04d69d181232659f259bd7d0f3d80d78fda577e76d5ffe74ee796be49e24eb'],
].map(([n, s]) => coord(`R_STK_D4_SCREEN_RANKING_K2_V1_FREEZE_1_${n}.md`, s)));
const D4_USE = '前向影子：候选 C_RS_FLOOR 记成现有 A 股个股前向记录器里的一个模块（Owner 11-09 不按策略开新账本），在 FWD 车道、★C3FWD_STATEMENT_SCOPE=B 之后跑；'
  + '验收草稿 R_STK_D4_FWD_SHADOW_ACCEPTANCE_V1（e0687b02）冻结之前不开；只记相对读数；盘中一半修好之前沿用收盘判定、次日开盘（K2 Q-7）；研究账本不进生产（修订 2 §2），生产规则 ③ 不变';
const D4_NOTE = 'INSUFFICIENT（CI_SPANS_ZERO）→ 做 = 前向影子，候选 C_RS_FLOOR（新排序加价值底线初筛，C_RS 基座）。判定基座 C_RS（R-STK-1 的 T_RS 对 C_RS 不是 SUPPORTED，机械规则；T_RS 基座只报）。'
  + '读数是年化配对 g（小数），照封存 JSON 原样，月块自助 10000 次、种子 20261025、95 %、δ_g = 0：'
  + 'J2（全改动，判定）g(C_RS_FLOOR − C_RS) 0.002984，[−0.010106, 0.015913]，第 2 阶段 −0.003903、第 1 阶段 0.012039，1537 个会话、76 个月；G1 满足（C_RS_FLOOR 成熟交易 152、C_RS 140，改变的入场 216）。'
  + 'J1（初筛增量，另写）g(C_RS_FLOOR − C_RS_RANK) −0.005054，[−0.015592, 0.005826]，第 2 阶段 −0.008976、第 1 阶段 0.000101，G1 满足（152、108、204），INSUFFICIENT（CI_SPANS_ZERO），'
  + '不是 NOT_PASSED，§6「初筛门槛交 Owner」一条不适用；J1 与 J2 方向相反，两阶段方向也相反。'
  + '只报：排序效应 g(C_RS_RANK − C_RS) 0.008039，[−0.002981, 0.018311]；T_RS 基座的 J1 −0.004613、J2 0.005917、排序效应 0.01053，都 INSUFFICIENT。'
  + '12 道运行门全 PASS（COMPLETE，blocked_by []），G_INERT（rstkd4c）INERTNESS_PASS，臂 4c2ecde5（14 个账本 × 阶段组合都是它）。'
  + '披露（结果页 §5）：各账本绝对收益都为负（第 1 阶段 A −3.80%、C_RS −6.67%），D4 只判相对差；oos_reuse: true（OOS_REUSED_FOR_SELECTION）；'
  + '普查之后改过门槛（pe_ttm 空值 95% → 90%，SCREEN_READ 的 Q 上限 10% → 45%，改时没读收益或账户）；pe_ttm 空值读作亏损（第 1 阶段 97.9%）；'
  + '结构状态 UNKNOWN 的名字跳过 Q 初筛（打分名字的 24–27%）；盘中一半是另一份规格，BLOCKED（LEVEL_READ:FAIL），不出结论。'
  + '结果页附注 1（32fb2a41）：P-15 计数 276 个名字、4,466 个持仓会话，21 个在除权日，复权因子缺 0。'
  + '报表覆盖说明：回放读到的报表比实盘 V6 多——实盘 V6 共 76,069 个报表单元，fina_indicator_vip 从 2026-08-26 起，income / balancesheet / cashflow 从 2026-09-13 起（实际只有 2024 年起的报告期有 fina）；'
  + 'D4 回放（2020-06-01 → 2026-09-28）读的是 Q0 回放底的完整历史 PIT（ann_date+1），这是 D4 冻结时的规则（KNOWNAT_EARLY_BASE_ORIGIN），封存照旧。报表只经 8 个 fina 特征字段进决策（Value V2 关）；'
  + 'C_RS_FLOOR 前向要在 FWD 车道、★C3FWD_STATEMENT_SCOPE=B 之后跑（11-18 F00 核对：79 个有成交的近期上市名字 8 季窗口不同）；'
  + '前向影子验收草稿 R_STK_D4_FWD_SHADOW_ACCEPTANCE_V1（e0687b02）在重盖 v3 与 F01 干净比对之后才冻结。'
  + '依据：C3-FWD 报表覆盖报告 v2（a5146af1）§8，生产只读导出 PROD_STMT_KEYS.tsv.gz（0cbc00c9）。'
  + '来源：Linux 封存 scratch/rstkd4-sealed-20261118（SHA256SUMS 36b8bb26；Mac 副本 evidence/rstkd4-sealed-20261118 逐字节相同），封存读取条目 38，封存 2026-11-18，结果页 722931c2。';
const X07B_SEAL = 'evidence/x07b-sealed-20261118';
const X07B_NOTE = '不做（NOT_PASSED，U_G_AT_OR_BELOW_ZERO；FREEZE_1 ★X7B-4 (a)、读法裁定第 1 条，机械）：J = g(X7B_KLINES_K − X7B_BASE_K)，X7B_BASE_K = C_RS（NOTE_2）。'
  + '读数是年化配对 g（252 × 日对数收益差均值，小数），照封存 JSON 原样，月块自助 10000 次、种子 20261025、95 %、δ_g = 0：两阶段合并（判定）−0.000195，[−0.000578, −5e-06]，1537 个会话、76 个月；'
  + '第 2 阶段 0，[0, 0]（873 个会话，复测（已读），只报）；第 1 阶段 −0.000451，[−0.001338, −1.2e-05]（664 个会话，只报）。'
  + 'G1（锁的计数）不满足：锁仓会话 1、被挡下或放出的新开仓 2（各要 ≥ 30；按股数的改变入场 1，读法裁定第 3 条），候选成熟交易 139；Q4 表第一行不带 G1 条件，U_g ≤ 0 → 不做，不是证据不足。'
  + '§5.2 风险否决 CLEAR：mdd_deeper_pp 0.001066（结果页：深 0.11 个百分点，否决线 1 个百分点），S16（15%）两本两阶段都没有触及。'
  + '只报：NOLOCK = g(X7B_NOLOCK_K − C_RS) 0，[0, 0]，两阶段都与 C_RS 逐日相同（C_RS 已按 k 定仓，D1），J 的差全部来自锁。'
  + '锁在 1537 个会话里只触发 1 次（第 1 阶段，k = 0.3 档，DAILY），挡下 2 笔新开仓，第 2 阶段没有锁；C_RS 平均敞口 1.4–1.6%、约 43% 的会话持仓，K2 范围内的日 / 周亏损线（0.03 / 0.06 × k_t）很少触到；'
  + '本题不回答线对敞口更大的账本有没有用（那是新 K2）。各账本绝对收益为负（第 2 阶段 C_RS −3.68%、第 1 阶段 −6.67%），只判相对差；oos_reuse（与 R-STK-1、D4 同一决策样本）；'
  + '后处理直接读 Linux 运行目录（读法裁定第 7 条，是对执行简报 27e4ae87 的偏离，不是对 K2）；G_STACK 带不上的缺口照写：Q0 锁 475bdc64 早于 MAINLINE_RANKING v6 与 KLINE_LIVE_TIMING v3。'
  + '过拟合列不适用（只加在「做（有支持证据）」上）；披露 J 一行，PBO 由 overfit.js 记 NOT_APPLICABLE（CONFIGS_LT_4，3 个配置）。'
  + '运行门 14 道 PASS、INDEX_READ / BARS_READ 不适用（COMPLETE，blocked_by []）；G-REPRO 两阶段 BINDING PASS（873/873、664/664），G_INERT 两半 PASS。'
  + '来源：Linux 封存 scratch/x07b-sealed-20261118（SHA256SUMS dccfdb24，17 个文件；Mac 副本 shasum -c 0 不符），运行代码 x07b-verdict.sh 52bc87a7，臂 3e356eda，封存读取条目 41，封存 2026-11-18，结果页 ee39f38e；'
  + 'ACCEPTANCE 另核 R-STK-1 FREEZE_1（6eefdcbb）与附录 1 FREEZE_1（dfe264b6）。生产不变：X07b 的线从未上线，不开前向影子。';

const ENTRIES = Object.freeze([
  { id: 'CN-R-ETF-1', label_zh: 'R-ETF-1', strategy_ref: INDEX, kind: 'RESULT', sealed_on: '2026-11-05', title_zh: '宽基 ETF 波动率网格 VG 对现行档位规则 C',
    file: v6('84adf8b97268d59318dda22be5363953e7939b6a', 'research/index-grid/r-etf-1/result-r-etf-1.json', '6eda510cd7dd3aea7ae2f27b83d9e9fb2595aa93c0b69b782473d065f652d3b0'),
    k2: v6('82900c7ec512acb1c99682d70e3a162bc7468939', 'docs/contracts/drafts/ASHARE_V6_ETF_GRID_R_ETF_1_K2_V1.draft.md', '700f8454a76eac367096aefbfc4eaf50241c5091f418c9dbf1cf4bec8aaeb98c'), freeze: null,
    read: Object.freeze({ decision: 'verdict.decision', state: 'verdict.verdict', strength: null, use: 'verdict.consequence', text: null }), expect: '做' },
  { id: 'CN-R-ETF-1-A1', label_zh: 'R-ETF-1 附录 1', strategy_ref: INDEX, kind: 'RESULT', sealed_on: '2026-11-05', title_zh: '510880 刹车改看 ETF 全收益（R-ETF-1 附录 1）',
    file: v6('abe9a3fe08b39fe3e6ad94b5fccbf20b31f3e2ec', 'research/index-grid/r-etf-1/result-a1.json', '3759a1835c065ba27e980a594dcbd959c4429451a4ed7f1626e8fe21fe020a89'),
    k2: v6('2b289f48c66c6cff0a7b35d711da41c7ca44caaa', 'docs/contracts/drafts/ASHARE_V6_ETF_GRID_R_ETF_1_K2_ADDENDUM_1.draft.md', '911394d5004eb11d9b098d18a29044f1398c41ca01acdcda802238a6fe86e4f9'), freeze: null,
    read: Object.freeze({ decision: 'decision.decision', state: 'decision.rule', strength: null, use: null, text: null }), expect: '做' },
  rEtf2('510300', 'SH', '沪深 300'), rEtf2('510500', 'SH', '中证 500'), rEtf2('588000', 'SH', '科创 50'), rEtf2('159967', 'SZ', '创成长'), rEtf2('510880', 'SH', '红利'),
  { id: 'CN-PVS-0', label_zh: 'PVS-0', strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-10-30', title_zh: '结构分类 PVS0_SWING_ATR_V1 的 2024 年后稳定性',
    file: coord('PVS_0_CONCLUSION_1.md', 'ddeb4ed7f03c5d2015c73f30ce1f7ab8c7309a604d5321780704882c0a61e5ee'),
    k2: coord('PVS_0_K2_V1.draft.md', '738d06827be7baf28550429cf7a672980de3293e960aa0ad29be733077daaf20'), freeze: coord('PVS_0_FREEZE_1.md', 'aa5321e47a0fe8cce313fa6c53391cd8e05136fa3a48af0d185c43aef23f7251'),
    read: Object.freeze({ pattern: '^\\*\\*(做|不做)。\\*\\*', strength_pattern: '按冻结页要求必须写的一句：(.+?)\\*\\*' }), expect: '做' },
  { id: 'CN-PVS-2', label_zh: 'PVS-2', strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-13', title_zh: '量能增量（A_PVS2_VOLUME_ON_A 对 A，第 1 阶段）',
    file: PVS24_RESULT, k2: coord('PVS_2_K2_V1.draft.md', '47802cb56e63528d7465a5006b5b6d7126ab1e6ecbd1ebbf7e1bcd818fd53f51'),
    freeze: coord('PVS_1_2_3_K2_FREEZE_1.md', '3e9cfd2c7bda7989bb5e099a5546d9eae0638ca0485277e1eecfbd413b7bd85c'), k2_frozen_at: '2026-10-30T13:20:00+08:00',
    read: pvs24Read(2), expect: '做',
    note_zh: `${PVS24_NOTE}惰性诊断（结果文档 §3.3）：评估过、从未在能起作用的地方成立 = 真惰性；前向一年仍 0 个改变的决策 → 转「不做（惰性）」。` },
  { id: 'CN-PVS-4', label_zh: 'PVS-4', strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-13', title_zh: '价位成交分布，用途 (b) 突破质量（A_PVS4_BREAKOUT_QUALITY_ON_A 对 A，第 1 阶段）',
    file: PVS24_RESULT, k2: coord('PVS_4_K2_V1.draft.md', '1a78c5322d578fd96331c44369ec78c955c9b0d7e69a236ce8d601a41c7373e0'),
    freeze: coord('PVS_4_5_K2_FREEZE_1.md', '2370748b9d5ec472340312a6625dc6545c6021cd935dfbdb13b005ff373a2884'), k2_frozen_at: '2026-10-31T09:30:00+08:00',
    read: pvs24Read(4), expect: '做',
    note_zh: `${PVS24_NOTE}没有事先的 TRL 登记：回补登记依据协调会话 2026-11-11 21:5x 裁定 (a)（按冻结页原样跑，BASE_ARM = A），结果文档 §5.4 披露。` },
  { id: 'CN-SECTOR-ETF-LEFT-1', label_zh: '行业 ETF 左侧埋伏', strategy_ref: INDEX, kind: 'RESULT', sealed_on: '2026-11-13',
    title_zh: '行业 ETF 左侧埋伏：错位初筛加价格低位，到价分批入场（SECTOR_ETF_LEFT_1，L 对 CASH）',
    file: v6(SEL1_COMMIT, 'research/sector-etf-left-1/result-sector-etf-left-1.json', '77067969408f5f7ee626083188856ee20e8653776beee4884798f2b0c3e3c720'),
    k2: coord('SECTOR_ETF_LEFT_1_K2_V1.draft.md', '34864588774647c909d59baae185748915c708cf235b2f8eebc1ca5bcd4e8aa5'),
    freeze: coord('SECTOR_ETF_LEFT_1_K2_V1_FREEZE_1.md', '68bd7e9f8d9b4dde0cd6817ef0e7410cbe790e3fd75e123a292aedd389b4baee'),
    run_log: v6(SEL1_RUN_LOG_COMMIT, 'research/sector-etf-left-1/RESEARCH_RUN_LOG_V1.json', '42d3ceee9adf6046956a6f926060b5382a9739505457e1d8da42c0e8df61bbfa'),
    k2_frozen_at: '2026-11-12T07:58:23+08:00',
    read: Object.freeze({ decision: 'verdict.state', strength: 'verdict.reason', use: null, text: 'verdict.conclusion' }), expect: 'INSUFFICIENT',
    resolve: Object.freeze({ INSUFFICIENT: Object.freeze({ decision: '做', use_zh: '前向影子：研究账本，同 PV_CN_STOCK_BOOK_TREND_V1 形状，不新开生产账本（Owner 11-09）；指数簿行业袖不变' }) }),
    note_zh: 'g(L − CASH) +2.02 %/年，95 % [+0.31 %, +4.34 %]，但只有 12 个已平仓回合，不到 G1 = 30 → INSUFFICIENT（G1_NOT_MET）→ 做 = 前向影子，冻结页预期如此。'
      + '只报：200 次随机入场 L 在第 98.5 百分位；主线入场 T −0.42 %/年。过拟合披露：DSR 未知（已知 ŜR 4 个 < 5），按族 N = 39 的 Bonferroni 回退不过；PBO 0.031（4 个计入配置）；证据不足，校正列不适用。'
      + '月度序列是封存之后从未改动的封存命令导出的（Ashare-V6 469445ce，7fb3e802…，结果逐字节同封存文件）。'
      + '来源：Ashare-V6 research/sector-etf-left-1 的结果文件（77067969），结果文档 SECTOR_ETF_LEFT_1_RESULT_V1.md（bd853a6a），封存 2026-11-13。' },
  { id: 'CN-X07A', label_zh: 'X07a A 股凯利', strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-14',
    title_zh: 'A 股个股簿凯利上限：C_RS 对 S16 自峰值 15% 回撤线的锚定扩展窗前推（现行 m = 1，只降不升）',
    file: coord('X07A_ASHARE_KELLY_RESULT_V1.json', 'b2159735024bfd5cdbba84cd2302a5c517957a11bb142a976c03d6d4dae6cc80'),
    also: Object.freeze([coord('X07A_ASHARE_KELLY_K2_V1_FREEZE_1_NOTE_1.md', 'c86e1b16b69fe2a7dda104d21e6329f7cacac57b1069b4372e47fa5a1a61e129'),
      coord('X07A_ASHARE_KELLY_K2_V1_FREEZE_1_NOTE_2.md', '817ad4a11c8a982456c99dc95eb9549e883f10494e3864b1dfbc09453b88b4f8')]),
    k2: X07A_K2, freeze: null,
    run_log: coord('X07A_ASHARE_KELLY_RESEARCH_RUN_LOG_V1.json', 'e8328ba960b23419ed10013f29d437017841037ca54ab08ada5463357de7b82b'),
    k2_frozen_at: '2026-11-14T13:25:47+08:00', trial_gates_ruling: X07A_RULING,
    read: Object.freeze({ decision: 'verdict.code', strength: 'part2.reading', use: null, text: 'verdict.zh' }), expect: 'DO_INSUFFICIENT',
    resolve: Object.freeze({ DO_INSUFFICIENT: Object.freeze({ decision: '做',
      use_zh: '证据不足（参数不稳），没有收紧候选：A 股个股簿 m = 1 不变，不提上限；前向影子 SHADOW_NOT_APPLICABLE_NO_CANDIDATE（生产个股簿即前向记录，Owner 11-09 不另开账本），下次凯利复盘或 D4 / R8 改变个股簿时再看' }) }),
    note_zh: 'F2 只因后一半折（第 4–6 折）m_f 的极差 0.23 > 0.2：2、2、1.77，全部高于现行 m = 1，中位数 2 不低于 1，只降不升 → 候选为空；'
      + '前推（m = min(m_f, 1) = 1，2023-06-01 → 2026-09-28）不触 L-S16，最大回撤 7.22%，无 F1。全段拟合只报（复测（已读））：C_RS 判定行 T = 3 年 P(m = 1) = 0，容差 5% 内最大 m 1.77；'
      + 'A_TOUCH、A 为 2（网格顶）；L-X40 不触。只报的不利事实：三本账全段日收益优势不为正（年化 Sharpe C_RS −1.31、A_TOUCH −1.61、A −1.25，k* = 0，c_0 无定义），凯利本身给不出正的下注比例；'
      + '15% 线远只因波动小。读数里的 A（Q0 基线）只报，不登记 Q0 账户的结论。过拟合披露：DSR、PBO 不适用（K2 §0，门的裁定同页）。'
      + '来源：协调会话目录的结果文件（b2159735，旧 MBP 两次独立进程逐字节相同，运行代码 smartflow 74d4ae6d），结论页 X07A_VERDICT_20261114，封存 2026-11-14。' },
  { id: 'CN-R8', label_zh: 'R8 A 股 K 线与缠论', strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-15',
    title_zh: '个股簿：同时关 K 线入场否决与出场保护、去掉缠论扣留（T_KC_K）对现行规则 C_RS，两阶段合并（2020-06-01 → 2026-09-28）',
    file: R8_RESULT, k2: R8_K2, freeze: R8_FREEZE, run_log: R8_RUN_LOG, k2_frozen_at: '2026-11-11T22:28:56+08:00',
    read: Object.freeze({ decision: 'judged.verdict_zh', state: 'judged.reason_code', strength: null, use: null, text: null }), expect: '不做',
    note_zh: '不做（U_G_AT_OR_BELOW_ZERO）：T_KC_K 对 C_RS 两阶段合并 g −2.47 %/年，95 % [−4.29 %, −0.65 %]，1537 个会话、76 个月；G1 满足（成熟交易 355、改变的入场 397）。'
      + '上限条件 T_KC_PROD 对 A_TOUCH −1.05 %/年 [−2.58 %, +0.41 %]，点估计为负。只报：T_C_K（只去缠论扣留）−1.35 %/年 [−2.34 %, −0.39 %]；分阶段复测（已读）只报。'
      + '规则不变：保留现行 K 线入场否决、出场保护与缠论扣留，不开前向影子。指数簿升档闸未跑（缺引擎，FREEZE_1 ★6），是缺口，不是证据不足，进 2027-02 季度消融。'
      + 'G-CF（A_NOKLINE 对封存 A，两阶段 873 + 664 个会话）PASS，只作对照；Q0 基线账 A 只在这一道门里比对，登记表不登记任何 Q0 账户的结论。'
      + '过拟合披露 OVD-f62f0cc373e0122b：N 42（下界），DSR 未知，PBO 0.045，按族 N 的 Bonferroni 回退；§3.5 的校正条件只加在「有支持证据」上，本题不适用。'
      + '来源：Linux 封存 scratch/r8-sealed-20261115（SHA256SUMS 8e92a3a5，SEAL_MANIFEST 33ed445d；SanDisk research-data/r8_ashare_v1/verdict-20261115 同 sha），研究分支 Ashare-V6 research/r8-ashare-kline-chan 0069dd8e（NEVER MERGE），封存 2026-11-15。' },
  r21Entry('CN-R21-RN', 'J_RN', 'R21 A 股时机分缺权重（RN）', '个股簿：时机分缺 25% 权重按当天投票的维度重分（T_RN_K）对现行规则 C_RS，两阶段合并（2020-06-01 → 2026-09-28）',
    '−0.0023 %/年，95 % [−0.0754 %, +0.0773 %]', 7),
  r21Entry('CN-R21-RP', 'J_RP', 'R21 A 股时机分缺权重（RP）', '个股簿：时机分缺 25% 权重用两融余额与宽基 ETF 份额替换（T_RP_K）对现行规则 C_RS，两阶段合并（2020-06-01 → 2026-09-28）',
    '−0.0909 %/年，95 % [−0.2592 %, +0.0461 %]', 15),
  rxm1Entry('CN-RXM1-M', 'RXM1_M', '511880.SH', '做', 'R-XM-1 闲置现金停放（货币 ETF）', '个股本闲置现金按 Q_t = max(0, c_{t−1} − G_t) 停放 511880.SH 银华日利（M），开盘成交，对现金基线 C（2020-06-01 → 2026-09-28）',
    '做（有支持，★R1 (b)，裁定页 28bf76ca）：配对 g +1.47 %/年，95 % [+1.35 %, +1.59 %]，MDE80 0.18 %；ΔMDD −4.46 个百分点（3.02 % 对 7.49 %）；T0 缺口 0，T1 压力 3 次 6,675 元（只报）；'
    + '29 笔、成本 467 元、分配 9,326 元；1537 个会话、76 个月，75 个月为正。过拟合披露 OVD-95fd157215597f79 的机械读数 DSR 0.033（族方差 V 含本题 3 行）原样保留；'
    + '★R1 (b) 的读法：族方差 V 不用本题自己的行（RXM1_M、RXM1_M_LOWCOST、RXM1_B），只用 R8_X04 三行与 R21 两行，V 0.0165、N 50、T 76、DSR 1，证据门不降级。'
    + '上线前提：V6 先放行 511880、采日线、个股本停放放在默认关闭的开关后（R_XM_1_V6_PARKING_PREREQUISITES 272c8939），生产另走变更；「做」≠ 生产采用。'),
  rxm1Entry('CN-RXM1-B', 'RXM1_B', '511010.SH', '不做', 'R-XM-1 闲置现金停放（短债 ETF）', '个股本闲置现金按同一规则停放 511010.SH 上证 5 年期国债 ETF（B），开盘成交，对现金基线 C（2020-06-01 → 2026-09-28）',
    '不做：配对 g +2.24 %/年，95 % [+1.00 %, +3.37 %]，但 T0 缺口 34 次 53,415 元（2020-08-27 → 2021-02-08 债市下跌期，2 次落在本的买入日），「T0 缺口为 0」是 K2 §5.5 的必要条件；'
    + 'NOTE_2 的封顶读法下仍是 34 次，最宽读法下也有 31 次。过拟合披露 OVD-02f289abe66f0225 原样保留（证据门对「不做」不起作用；★R1 (b) 读法下 DSR 0.785）。裁定页 28bf76ca。'),
  { id: 'CN-R-STK-1-D4', label_zh: 'R-STK-1 D4 初筛与排序', strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-18',
    title_zh: '个股簿 ③ 排序净化加价值底线初筛：C_RS_FLOOR（新排序加初筛）对现行 C_RS，两阶段合并（2020-06-01 → 2026-09-28）',
    file: coord(`${D4_SEAL}/RSTKD4_VERDICT.json`, '63e91f82312ce61ebe990edb503185c8bff8e9430c1a49ac63dc39340e5a4446'),
    also: Object.freeze([coord('R_STK_D4_SCREEN_RANKING_K2_V1_RESULT_1.md', '722931c223629aa103ecb25cf5b404abc06a8153cdc2dd7a9214cc5e60531df3'),
      coord('R_STK_D4_SCREEN_RANKING_K2_V1_RESULT_1_NOTE_1.md', '32fb2a41894e3f3add3b46b3c86ed60baec1747bb51cb61fa0405114713146b3'),
      coord(`${D4_SEAL}/SHA256SUMS`, '36b8bb2655ec748c45e2d485b7af06500aa0cb989dcaaf654f24de9e9128cf09')]),
    k2: coord('R_STK_D4_SCREEN_RANKING_K2_V1_FREEZE_1.md', '571806b6e914a36c626ab8b24d767485cff8c4c79eb8d74e8d2c8a47a176c49c'), freeze: null, k2_notes: D4_NOTES,
    k2_frozen_at: '2026-11-10T00:57:00+08:00',
    read: Object.freeze({ decision: 'd4.pairs.C_RS.J2.state', strength: 'd4.pairs.C_RS.J2.reason_code', use: null, text: 'd4.pairs.C_RS.J2.verdict_zh' }), expect: 'INSUFFICIENT',
    resolve: Object.freeze({ INSUFFICIENT: Object.freeze({ decision: '做', use_zh: D4_USE }) }),
    note_zh: D4_NOTE },
  { id: 'CN-X07B', label_zh: 'X07b A 股风控线', strategy_ref: 'ASHARE_V6_PAPER', kind: 'RESULT', sealed_on: '2026-11-18',
    title_zh: '个股簿按 k 分档的日 / 周亏损锁（日线 3% × k_t、周线 6% × k_t，只锁新开仓）：X7B_KLINES_K 对 C_RS，两阶段合并（2020-06-01 → 2026-09-28）',
    file: coord(`${X07B_SEAL}/X07B_RESULT.json`, '4c84761fc7f9909909172a3800dff32ca93c41b4ba711ee28e8a3f8adca72f74'),
    also: Object.freeze([coord('X07B_ASHARE_RISK_LINES_K2_V1_RESULT_1.md', 'ee39f38e1b8123b2d5e4dc7dcaea3798d38e2f406ac27398f7b2aef12e66ce89'),
      coord(`${X07B_SEAL}/SHA256SUMS`, 'dccfdb24f3209efcb9f7fd13aafff83f72d6a2ea4baf2f2e1a0b98c82be8b3d3')]),
    k2: coord('X07B_ASHARE_RISK_LINES_K2_V1.draft.md', '3fae758b7c724c3c2c36b3b1ccd6a7a7e1bcb12296373ca5931a0ad3d9d35558'),
    freeze: coord('X07B_ASHARE_RISK_LINES_K2_V1_FREEZE_1.md', 'c82975b3ea3e69b65c7bb4ee9bbce855cd7950c23490fc978b0c217b504a8349'),
    k2_notes: Object.freeze([coord('X07B_ASHARE_RISK_LINES_K2_V1_FREEZE_1_NOTE_1.md', 'f829092e0976466748e432640bb263f861b8ae1dc769752cbb51b2a4493aa716'),
      coord('X07B_ASHARE_RISK_LINES_K2_V1_FREEZE_1_NOTE_2.md', 'f90872a1174f7bd546a31e777f1b353fbe18888a3ef31368e0f4a30fcd023a83'),
      coord('X07B_ASHARE_RISK_LINES_K2_V1_FREEZE_1_NOTE_2_RECEIPT_1.md', '2a24fc2b9e6a49fe6b65225079725fecaa41bcb03b77e98bad8c173dccf44a0e'),
      coord('X07B_ASHARE_RISK_LINES_K2_V1_FREEZE_1_NOTE_3.md', '2d3012ccc826f3f30e54a425a747c102bf26174fea3c0e683765dce58bf1f1cf')]),
    run_log: coord('X07B_ASHARE_RISK_LINES_RESEARCH_RUN_LOG_V1.json', 'd7ba7f8935c6bd389a2801740bd8753054d354d2f525ee4248b12e04274b9edf'),
    k2_frozen_at: '2026-11-14T23:39:05+08:00',
    read: Object.freeze({ decision: 'judged.verdict_zh', state: 'judged.state', strength: 'judged.reason_code', use: null, text: null }), expect: '不做',
    note_zh: X07B_NOTE },
]);

const locks = (strategyRef = null) => overseas.locks(strategyRef, STORE);
const stageEvidence = ({ ashareV6Root, artifactsRoot, out, entries = ENTRIES }) => overseas.stageEvidence({ artifactsRoot, out, entries, roots: { 'ashare-v6': ashareV6Root }, importProfileId: IMPORT_PROFILE_ID, manifestKind: 'ASHARE_SEALED_VERDICTS_STAGE_V1' });
const importVerdicts = (evidenceDir, { entries = ENTRIES, ...options } = {}) => overseas.importVerdicts(evidenceDir, { ...options, entries, store: STORE });

module.exports = { ENTRIES, IMPORT_PROFILE_ID, LEDGER, STORE, locks, stageEvidence, importVerdicts };
