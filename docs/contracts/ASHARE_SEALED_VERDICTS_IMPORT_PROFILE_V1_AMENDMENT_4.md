# A 股研究封存结论 · 导入规格 V1 · 修订 4（R8 A 股部分：K 线否决与缠论扣留，个股簿）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。V1 正文与修订 1–3 一字不改，本修订只往登记表加一题。Production effect：`NONE`。

依据：
- K2 `R8_X04_KLINE_CHAN_ASHARE_K2_V1.draft.md`（`299473b0…`，只读）；
- 冻结页 `R8_X04_KLINE_CHAN_ASHARE_K2_V1_FREEZE_1.md`（`4d30527e…`，2026-11-11 22:28:56 CST 冻结，★1–★7 全部 (a)，正文不改）；
- 协调会话 2026-11-15 18:58 封存裁定；2026-11-16 的导入裁定：`k2_frozen_at` = 冻结时刻，`G-CAUSAL N/A: PRE_EFFECTIVE_K2`。

## 1. 加入登记表的一题

| entry_id | 簿（族） | 封存文件 | K2 / 冻结页 | k2_frozen_at | 期望 |
|---|---|---|---|---|---|
| CN-R8 | ASHARE_V6_PAPER | 协调会话目录 `R8_X04_KLINE_CHAN_ASHARE_RESULT_V1.json` `cfa6c0cb…` | `299473b0…` / `4d30527e…` | 2026-11-11T22:28:56+08:00 | 不做 |

**封存文件的来源：**
- 结果在 Linux 研究车道上算出，两遍逐字节相同（G-AB），封存在 `/srv/research-lane/v6q0/scratch/r8-sealed-20261115/`：目录 555，SHA256SUMS `8e92a3a5…`，SEAL_MANIFEST `33ed445d…`。
- SanDisk 镜像 `research-data/r8_ashare_v1/verdict-20261115/`：`sha256sum -c` 12/12 通过（2026-11-16 03:50 CST）。
- A 股导入命令只从 Ashare-V6 与协调会话目录取证据，所以封存的 `R8_RESULT.json` 按原字节放进协调会话目录，改名为 `R8_X04_KLINE_CHAN_ASHARE_RESULT_V1.json`，与 K2 同名前缀。导入时按 sha256 复验。

**读法：**
- 结论读封存 JSON 的 `judged.verdict_zh`（`不做`），原因码读 `judged.reason_code`（`U_G_AT_OR_BELOW_ZERO`）。
- 判定对是 T_KC_K 对 C_RS，两阶段合并：g −2.47 %/年，95 % [−4.29 %, −0.65 %]，G1 满足（355 / 397）。
- 上限条件 T_KC_PROD 对 A_TOUCH 是 −1.05 %/年 [−2.58 %, +0.41 %]。
- 读数不是 `不做`，就读不出期望值，导入拒绝（`VERDICT_NOT_AS_REGISTERED`）。
- 用途：规则不变，保留现行 K 线入场否决、出场保护与缠论扣留，不开前向影子。
- 指数簿升档闸（FREEZE_1 ★6）记「未跑（缺引擎）」，只写在说明里，不另登记。

**K2 与冻结页：**
- `k2` 绑冻结的草稿本身，因为台账 7 行的 `k2_sha256` 都是草稿 sha `299473b0…`。
- `freeze` 绑冻结页 `4d30527e…`。

**Q0：** A_NOKLINE 只是 G-CF 的对照（对封存 A，两阶段 873 + 664 个会话，PASS `3121d9cb`）。登记表不登记任何 Q0 账户的结论，V1 的「A 股没有 Q0 账户」照旧成立。

## 2. 试验台账门（G-TRIAL-PRE / G-TRIAL-SEAL）

K2 在过拟合控制修订（2026-11-11 00:00 CST）之后冻结，`gates.applies` 给 `FROZEN_AFTER_AMENDMENT`，两道门都过。不带门的裁定。

**PRE：PASS。**
- K2 §14 写出 7 个 TRL id：T_KC_K、T_K_K、T_C_K、T_KC_PROD、B_K、B_PROD、A_NOKLINE。
- 7 行都是 PREREGISTERED，family `ASHARE_V6_PAPER`，`k2_sha256` = 草稿 sha。
- 登记于 2026-11-11T14:27:51.030Z（22:27:51 CST），早于冻结 22:28:56 CST。

**SEAL：**
- 7 个预登记试验各有一条结果行（2026-11-15 18:59 CST 记，series_ref 指 Linux 封存路径，sha `cfa6c0cb…`）。
- 运行日志 `R8_X04_KLINE_CHAN_ASHARE_RESEARCH_RUN_LOG_V1.json`（`60e2a6a9…`，协调会话目录，按 sha256 绑定）。它从封存结果与运行证据导出：
  - 每个预登记行一条运行，`rule_config_hash` 都是已登记的；
  - 两阶段车道：第 2 阶段 `p2lx-r8b`，计划 `a28386e7…`，873 个会话；第 1 阶段 `p2lx-r8`，计划 `23f57a02…`，664 个会话；
  - 判定运行 2026-11-15 18:46:16 → 18:52:31 CST（`r8-verdict.log` `c4e712eb…`）。
  - `first_run_at` 不写：车道账本日志不带时间戳。车道在冻结之后开跑，见冻结页的车道一节，以及结果 `gates.G_INERT` 记的车道开跑前惰性核对（2026-11-11 23:10 CST）。7 行登记早于冻结，所以 PRE 不需要首次计算时刻。
- 本族本题的 `OVERFIT_DISCLOSURE_V1`：`OVD-f62f0cc373e0122b`（record_hash `22cd297e…`）。
  - N 42（下界），DSR `UNKNOWN`，PBO 0.045，回退为按族 N 的 Bonferroni。
  - DSR 是算法给出的「未知」，不是「不适用」，所以不需要门的裁定。

## 3. 研究框架修订 2026-11-12（RF1112）的两道门

- **G-MECH、G-CAUSAL 都不适用。** K2 冻结（2026-11-11T22:28:56+08:00）早于 `EFFECTIVE_FROM` 2026-11-15T22:47:42+08:00，两道门都给 `FROZEN_BEFORE_AMENDMENT`。
- **G-CAUSAL N/A: PRE_EFFECTIVE_K2。**
  - 这是范围说明，不是 §3.2 的不适用码。
  - 冻结的 K2 不改，不绑因果证据，锁行不加 `mechanism_gate` / `causality_gate` 字段。
- 去掉 `k2_frozen_at` 时三道门都拒绝（`K2_FROZEN_AT_MISSING`），因为封存日 2026-11-15 在两次修订的生效日之后。测试钉住了这一点。
- **K2 自己的 G-CF** 只作背景（A_NOKLINE = 封存 A，PASS `3121d9cb`，873 + 664），不作因果证据绑定。
- **机制：** QRP #87 回填把本题登记为 `R8-ASHARE`（CN_A，消融题），机制 id 为 `SEL.KLINE.ENTRY_VETO`、`SEL.KLINE.EXIT_PROTECT`、`SEL.CHAN.HOLDBACK`。
  - 按 §4.3，消融题不写结论块：本题的「不做」= 保留现行 K 线与缠论规则，方向与机制结论相反。
  - **协调会话裁定 ★R8IMP-1 → (a)（2026-11-16）：** 不写结论块，不写 `sealed_ref`，本修订不改机制登记表；本题的导入条目是 **CN-R8**，在本修订与 PR 正文里写明。
    - 不取 (b)：给本题写结论块会把读数反过来。D5#V1 不同，它检验的就是 STATE_K 本身，它的「不做」是对该机制的真结论。
    - 不取 (c)：消融题若以后也要交叉核对，另开登记表 PR，在 11-18 之后。

## 4. 真导入

照 V1 §3：
1. 先备份台账；
2. 在副本上（`QRP_DATA_DIR`）试导入，核对后再写真台账；
3. 现有 12 份锁逐字节重放，只多 1 份新锁。
