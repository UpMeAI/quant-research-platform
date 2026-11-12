# A 股研究封存结论 · 导入规格 V1 · 修订 1（PVS-2、PVS-4 第 1 阶段）

状态：随 QRP PR 交协调会话审阅；协调会话合并即采用。V1 正文一字不改，本修订只往登记表加两题。Production effect：`NONE`。
依据：协调会话 2026-11-13 的指示（PVS-2/4 封存已接受，结果行走现有 A 股导入路径）；判定裁定 `PVS_2_4_RESULT_V1_RULINGS_20261113.md`（sha256 `b2438e634aa09eb396772d38ac904f5820695367247eca7a5d761dd551705e24`）。

## 1. 加入登记表的两题

两题出自同一份封存结果文档，协调会话目录，按 sha256 绑定：`PVS_2_4_RESULT_V1.md`，`1cbfe175f3eccc76810ed2006e2396c981d7db18bea759ffeafba423807af4be`。

| entry_id | 簿 | K2（sha256 前 12 位） | 冻结页 | k2_frozen_at | 期望结论 |
|---|---|---|---|---|---|
| CN-PVS-2 | ASHARE_V6_PAPER | `PVS_2_K2_V1.draft.md` `47802cb56e63` | `PVS_1_2_3_K2_FREEZE_1.md` `3e9cfd2c7bda` | 2026-10-30T13:20:00+08:00 | 做 |
| CN-PVS-4 | ASHARE_V6_PAPER | `PVS_4_K2_V1.draft.md` `1a78c5322d57` | `PVS_4_5_K2_FREEZE_1.md` `2370748b9d5e` | 2026-10-31T09:30:00+08:00 | 做 |

- K2 与冻结页就是判定 paired（`ASHARE_V6_Q0_ARMS_PAIRED_EVALUATION_V1.json` `23c788ee…`）的 ACCEPTANCE 逐一核对过的那几份。
- **读法**：同 CN-PVS-0 读封存文字（`read.pattern`）。结论从结果文档 §0 表里该题自己那一行的「结论」列读（`**做 = …`），状态从「判定」列读（两行都写 `G1_NOT_MET → INSUFFICIENT`）。去掉自己那一行就读不出结论，不会读到另一题（测试）。
- **只读结论文档**：V1 §0 的「不导入 A 股 Q0 账户（不读）」不变。这两题的研究臂是 Q0 账户，但导入器只读封存的结果文档，不读任何账户文件。

## 2. 试验台账门（G-TRIAL-PRE / G-TRIAL-SEAL）

两份 K2 都在过拟合控制修订（2026-11-11 00:00 CST 起生效）之前冻结，`gates.applies` 给 `FROZEN_BEFORE_AMENDMENT`：两题照原样导入，锁行不带门字段，也不得带 `trial_gates_ruling`（带了就是 `RULING_ON_UNGATED_ENTRY`）。

- `k2_frozen_at`：冻结页只写到分钟段（「13:2x」「09:3x」），取段的起点。门的判断只看是否早于 2026-11-11，取段内任何一分钟结果都一样。
- **PVS-4 没有事先的 TRL 登记**：协调会话 2026-11-11 21:5x 裁定 (a)（PVS-4 按冻结页原样跑，用途 (b)、参数 R4-3，BASE_ARM = A；不新冻结、不事先登记，封存时回补登记并披露）。因为门不适用，这条依据记在锁的 `note_zh` 和结果文档 §5.4，不作为门的 DEVIATION 裁定挂上去。

## 3. 真导入

照 V1 §3：先备份台账，在副本上（`QRP_DATA_DIR`）试导入，核对后再写真台账。
