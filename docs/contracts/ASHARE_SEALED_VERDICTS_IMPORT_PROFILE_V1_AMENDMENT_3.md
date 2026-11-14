# A 股研究封存结论 · 导入规格 V1 · 修订 3（X07a A 股凯利，个股簿）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。V1 正文与修订 1、2 一字不改，本修订只往登记表加一题。Production effect：`NONE`。

依据：
- K2 `X07A_ASHARE_KELLY_K2_V1_FREEZE_1.md`（`c3533cd9…`，2026-11-14 13:25:47 CST 冻结；正文 = 草稿修订 2 `db45a25e…`）；
- NOTE_1 `c86e1b16…`：★ 全部 (a)，前推各折种子按 §3，步 0b 加两道门；
- NOTE_2 `817ad4a1…`：运行代码 smartflow `74d4ae6d`；
- 门的裁定 `X07A_ASHARE_KELLY_K2_V1_TRIAL_GATES_RULING_20261114.md`（`aed36595…`）。

## 1. 加入登记表的一题

| entry_id | 簿（族） | 封存文件 | K2 | k2_frozen_at | 期望 |
|---|---|---|---|---|---|
| CN-X07A | ASHARE_V6_PAPER | 协调会话目录 `X07A_ASHARE_KELLY_RESULT_V1.json` `b2159735…` | `X07A_ASHARE_KELLY_K2_V1_FREEZE_1.md` `c3533cd9…` | 2026-11-14T13:25:47+08:00 | DO_INSUFFICIENT → 做 |

**封存文件的来源：** 结果在旧 MBP 上跑，两次独立进程逐字节相同（G-AB）。文件同时在 smartflow `research/x07a-ashare-kelly` `0f4fc855` 的 `docs/evidence/x07a/`，逐字节相同。A 股导入命令只从 Ashare-V6 与协调会话目录取证据，所以绑定的是协调会话目录里的那一份，按 sha256 复验。

**读法：** 封存 JSON 的 `verdict.code` 是机械判定（F1 → `DO_TIGHTEN`，F2 → `DO_INSUFFICIENT`，通过 → `DONT`）。
- `resolve` 把 `DO_INSUFFICIENT` 写成页面结论「做」，用途写明：
  - 没有收紧候选，个股簿 m = 1 不变；
  - 前向影子 `SHADOW_NOT_APPLICABLE_NO_CANDIDATE`（协调会话 11-14 裁定）。
- `part2.reading`（F2）进强度，`verdict.zh` 进正文。
- 读数不是 `DO_INSUFFICIENT`，就读不出期望值，导入拒绝（`VERDICT_NOT_AS_REGISTERED`）。

**K2 与冻结页：** `k2` 绑的是冻结页本身，因为台账行的 `k2_sha256` 就是冻结页的 sha，`freeze` 为空。NOTE_1、NOTE_2 作为 `also` 一并绑定。

**Q0：** 结果文件里 Q0 的基线账 A 只作只报行。登记表不登记任何 Q0 账户的结论，V1 的「A 股没有 Q0 账户」照旧成立。

## 2. 试验台账门（G-TRIAL-PRE / G-TRIAL-SEAL）

K2 在过拟合控制修订（2026-11-11 00:00 CST）之后冻结，`gates.applies` 给 `FROZEN_AFTER_AMENDMENT`，两道门都过。本题带门的裁定（导入规格修订 4 的形式）。

**PRE：`DEVIATION_ACCEPTED`，原因码 `PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN`。**
- K2 §7 写出 13 个 TRL id，13 行都是 PREREGISTERED，`k2_sha256` = 冻结页 sha。
- 登记于 2026-11-14T05:28:02.950Z（13:28:02 CST）：晚于冻结（13:25:47），早于首次计算（13:41:36 = 05:41:36Z）。
- 门核对登记时刻与裁定一致。

**SEAL：**
- 13 个预登记试验各有一条结果行（11-14 记，series_ref = 上述结果文件）。
- 运行日志 `X07A_ASHARE_KELLY_RESEARCH_RUN_LOG_V1.json`（`e8328ba9…`，协调会话目录，按 sha256 绑定）：
  - 每个预登记行一条运行；
  - `rule_config_hash` 都是已登记的；
  - `first_run_at` 与裁定一致。
- 本族本题的 `OVERFIT_DISCLOSURE_V1`：DSR、PBO `NOT_APPLICABLE`，引用同一页门的裁定（K2 §0 的原因：本题判的是拟合上限的样本外稳定性，不是收益对比）。

## 3. 真导入

照 V1 §3：
1. 先备份台账；
2. 在副本上（`QRP_DATA_DIR`）试导入，核对后再写真台账；
3. 现有 11 份锁逐字节重放，只多 1 份新锁。
