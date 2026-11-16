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
  spec: coord('R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_K2_V1_TRIAL_GATES_RULING_20261116.md', '8cc181db5d75a1737dd2541e569cb6f11734daec311190d293c4033c6d922686'),
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
]);

const locks = (strategyRef = null) => overseas.locks(strategyRef, STORE);
const stageEvidence = ({ ashareV6Root, artifactsRoot, out, entries = ENTRIES }) => overseas.stageEvidence({ artifactsRoot, out, entries, roots: { 'ashare-v6': ashareV6Root }, importProfileId: IMPORT_PROFILE_ID, manifestKind: 'ASHARE_SEALED_VERDICTS_STAGE_V1' });
const importVerdicts = (evidenceDir, { entries = ENTRIES, ...options } = {}) => overseas.importVerdicts(evidenceDir, { ...options, entries, store: STORE });

module.exports = { ENTRIES, IMPORT_PROFILE_ID, LEDGER, STORE, locks, stageEvidence, importVerdicts };
