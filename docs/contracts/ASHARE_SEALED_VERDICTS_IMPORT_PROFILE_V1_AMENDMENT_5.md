# A 股研究封存结论 · 导入规格 V1 · 修订 5（R21：时机分缺 25% 权重，个股簿，两条判定）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。V1 正文与修订 1–4 一字不改，本修订只往登记表加两题。Production effect：`NONE`。

依据：
- 冻结页 `R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_K2_V1_FREEZE_1.md`（`ca036b24…`，冻结记录 2026-11-14 01:56:13 CST；★R21-1–6 全部 (a)）。台账行的 k2_sha256 就是这一页，所以 K2 绑它，不另绑冻结页。
- 协调会话 2026-11-16 22:4x 的封存裁定：封存批准；★R21-S1 = (a)，附条件；PBO 不适用的裁定原文。
- 门的裁定页 `R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_K2_V1_TRIAL_GATES_RULING_20261116.md`（`8cc181db…`，协调会话冻结）。
- `k2_frozen_at` = 冻结时刻；`G-CAUSAL N/A: PRE_EFFECTIVE_K2`。

## 1. 加入登记表的两题

| entry_id | 判定 | 封存文件 | K2 | k2_frozen_at | 期望 → 结论 |
|---|---|---|---|---|---|
| `CN-R21-RN` | J_RN = g(T_RN_K − B_K) | `R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_RESULT_V1.json`（`9db6f7e8…`） | 冻结页 `ca036b24…` | `2026-11-14T01:56:13+08:00` | `INSUFFICIENT` → 做（前向影子） |
| `CN-R21-RP` | J_RP = g(T_RP_K − B_K) | 同上 | 同上 | 同上 | `INSUFFICIENT` → 做（前向影子） |

- **结果文件：** Linux 封存 `scratch/r21-sealed-20261116`（SHA256SUMS `dbb72dbe…`，SEAL_MANIFEST `9c2b2dc5…`）里 `R21_RESULT.json` 的逐字节副本，放在协调会话目录，按 sha256 绑定。
- **读法：** `read.decision` 读 `judged.J_RN.state` / `judged.J_RP.state`。`strength` 读 `reason_code`（`G1_NOT_MET`），`text` 读 `verdict_zh`（「做 = 前向影子」）。`resolve.INSUFFICIENT` 给出「做」，`use_zh` 引用封存里冻结的前向影子规则 `R21_FORWARD_SHADOW_RULE_V1.md`（`dd55ec46…`）。
- **读数：**
  - J_RN g −0.0023 %/年，95 % [−0.0754 %, +0.0773 %]，改变的入场 7 笔；
  - J_RP g −0.0909 %/年，95 % [−0.2592 %, +0.0461 %]，改变的入场 15 笔。
  - 1537 个会话、76 个月。两条的成熟交易都 ≥ 30、改变的入场都 < 30，所以都是 G1 不满足 → INSUFFICIENT。
- **运行日志：** `R21_ASHARE_TIMING_SCORE_MISSING_WEIGHT_RESEARCH_RUN_LOG_V1.json`（`1ebfe73c…`），放在协调会话目录。3 个 run，每行一个预登记配置，各带台账登记的 rule_config_hash；`first_run_at` 2026-11-13T18:03:43Z，附证据。

## 2. 试验台账门（G-TRIAL-PRE / G-TRIAL-SEAL）

- **PRE：DEVIATION_ACCEPTED，原因码 `PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN`。**
  - K2 点名的 3 行（B_K、T_RN_K、T_RP_K）都是 PREREGISTERED，k2_sha256 = `ca036b24…`。
  - 登记于 2026-11-13T17:59:32.399Z，比冻结（17:56:13Z）晚 3 分 19 秒，早于首次计算：步 1 只读导出 startedAt 2026-11-14 02:03:43 CST = 18:03:43Z。
  - 门的裁定页把 `preregistered_at`、`first_run_at` 两个时刻写死，与台账、运行日志逐一核对。实质与 FREEZE_2_WITHDRAWN（`4d2b5ef4…`）的 PASS 判断相同。
- **SEAL：**
  - 3 行 RESULT（2026-11-16T14:44:11Z，V8_1_COORDINATOR）；运行日志 3 个 run，rule_config_hash 都已登记。
  - 披露 J_RN、J_RP 各一行：DSR 照算法算出（RN 0.0061、RP 1.9e-6）。PBO 由 overfit.js 自己记为 `NOT_APPLICABLE`（`CONFIGS_LT_4`），裁定原文：「PBO NOT_APPLICABLE: CONFIGS_LT_4 — 3 configurations (C_RS, T_RN_K, T_RP_K); CSCV needs ≥ 4; verdict 做 = 前向影子 (INSUFFICIENT) is unaffected; DSR reported (RN 0.0061, RP 1.9e-6)」。
  - `checkSeal` 只有 DSR 不适用时才要披露不适用的裁定，所以这里不写 `disclosure_not_applicable`。

## 3. RF1112 与成本门

- K2 冻结早于 RF1112 生效（2026-11-15T22:47:42+08:00），G-MECH、G-CAUSAL 都返回 `FROZEN_BEFORE_AMENDMENT`。**G-CAUSAL N/A: PRE_EFFECTIVE_K2**：范围说明，不是 §3.2 的码；不改冻结的 K2，不绑因果证据，锁行不加 `mechanism_gate` / `causality_gate` 字段。
- 成本门 G-COST 与 A1（QRP #92 / #93，EFFECTIVE_FROM 2026-11-17T00:00:00+08:00）：`k2_frozen_at` 照写，冻结早于生效 → 不适用。不写 `verdict_metric_kind`、`cost_model_ref` 或 bps 字段。
- 指数簿未跑（缺 Q0 引擎，K2 §6）：缺口，不是证据不足，封存里照实披露。

## 4. 真导入

合并之后再做，先备份台账：
1. 在 QRP 工作区 `stage --ashare-v6-root … --artifacts-root … --out <证据目录>`；
2. `QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR import --evidence <证据目录> --registered-by V8_1_COORDINATOR`。

预期：登记表 13 → 15 题；新增两把锁 `ASV-CN-R21-RN-9db6f7e8d31c`、`ASV-CN-R21-RP-9db6f7e8d31c`，每把都是 做、trial_gates pre DEVIATION_ACCEPTED / seal PASS，没有 mechanism_gate 或 causality_gate 字段。原有 13 把锁逐字节不变。
