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
]);

const locks = (strategyRef = null) => overseas.locks(strategyRef, STORE);
const stageEvidence = ({ ashareV6Root, artifactsRoot, out, entries = ENTRIES }) => overseas.stageEvidence({ artifactsRoot, out, entries, roots: { 'ashare-v6': ashareV6Root }, importProfileId: IMPORT_PROFILE_ID, manifestKind: 'ASHARE_SEALED_VERDICTS_STAGE_V1' });
const importVerdicts = (evidenceDir, { entries = ENTRIES, ...options } = {}) => overseas.importVerdicts(evidenceDir, { ...options, entries, store: STORE });

module.exports = { ENTRIES, IMPORT_PROFILE_ID, LEDGER, STORE, locks, stageEvidence, importVerdicts };
