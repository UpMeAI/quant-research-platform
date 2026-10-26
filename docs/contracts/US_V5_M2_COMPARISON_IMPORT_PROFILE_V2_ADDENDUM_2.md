# 候选对比导入规格 V2 · 附录 2：Q4 登记项与只报不判行

状态：**提议，随 PR 合并；协调会话合并即冻结。** 研究会话起草，2026-10-26。

上游：
- Q4 研究规格 `docs/contracts/US_V5_M2_Q4_COOLDOWN_K2_V1.md`（sha256 `262f4b9790532f647a569a049fb5ad79c66fea0a3006354d01d7123d11c3566c`），裁定 1–7。本附录不改动它。
- 导入规格 V2 `US_V5_M2_COMPARISON_IMPORT_PROFILE_V2.md` 与附录 1：封存、复现、基线链、压力行形状、三行分写、配对 g 判定。本附录全部沿用。
- Q2 K2 勘误 1：G1 先判。

实现：
- `services/candidate-comparison/questions/q4.js`（登记项）；
- `services/candidate-comparison/questions/report_only.js`（只报行的校验与卡片）；
- `paired_g.js` 的敞口附加行可带 `get(arm)` 读嵌套计数；不带时读法与之前相同，Q1–Q3 不变；
- `config/strategy_profiles.v1.json` 把本附录列进 US_V5 的 `comparison_import_profile_ids`；
- 页面 `renderExtraCard` 认出只报行的卡片。

## 1. 登记项

| 项 | 值 |
|---|---|
| 题目 | `Q4`，队列顺序 4，结果类别 `CANDIDATE_COMPARISON_V1` |
| schema | `US_V5_M2_Q4_RESULT_V1`；`result_kind` = `CHALLENGER_VS_BASELINE` |
| K2 | 上述路径与 sha256 |
| 候选臂键 | `CANDIDATE_COOLDOWN_ON_OPEN`（也认 `COOLDOWN_ON_OPEN`） |
| 运行门 | `ACCEPTANCE`、`INPUTS`、`BASELINE_REPRO`、`COOLDOWN_PARITY`、`INERT_Q0F`、`INERT_Q2`、`INERT_Q3`、`PROBE`，都必须 `PASSED` |
| 判据集与常数 | G1 / P_G / F3；δ_g = 0、δ_R = 0.10；95% 区间，没有 Bonferroni；G1 先判（同 Q2 与勘误 1） |
| 样本外 | `oos_reuse` 必须是 `true`，`verdict.reason_codes` 必须含 `OOS_REUSED_FOR_SELECTION`，`oos_reuse_detail` 必须有文字（裁定 3） |
| 采用条件一行 | 「采用条件：未满足（结论交给 Owner，由 Owner 按 A25 的 C6 决定保留、修改或撤回 A25［；必要压力缺失，§6.7］）」 |
| 归因 | 不要求 |
| 敞口 | 要求，见第 2 节 |
| 顶层字段 | 同 V2，另加 `report_only_dimensions` |

## 2. 敞口披露（`comparison.exposure`）

两臂照 V2 的必填字段：`avg_notional_usd`、`time_in_market_ratio`、`notional_cap_rejections`、`notional_cap_reductions`，可选 `avg_actual_risk_usd`。另加嵌套计数，形状坏了就拒绝（`Q4_EXPOSURE_DISCLOSURE_INVALID`）：

- 两臂：`cooldown_blocked_signals {open_scan, other}`，即冷却挡下的信号数；
- 候选臂：`arms_not_set {gate_refusal {open_scan, other}, other_no_open {open_scan, other}}`，即没有武装的冷却数（裁定 1）。

每个计数都是非负整数。`open_scan` 指每个交易日第一个扫描时点。页面在敞口表里加六行，原版臂没有 `arms_not_set` 时写「—」。

## 3. 只报不判行（`report_only_dimensions`）

一个数组，必须包含这四行（键名固定，裁定 2）：`NO_24H_COOLDOWN`、`MAX_POSITIONS_5`、`RISK_UNIT_90`、`GATE_REFUSAL_ONLY_UNARM`。

- **行的字段：** `{key, label_zh, end_capital, n, mean_R, max_drawdown, g_vs_baseline {value, ci_95}, changed_entries, in_verdict: false}`。
- **拒绝条件：** 少任何一行（`Q4_REPORT_ONLY_ROW_MISSING`），或任何一行的 `in_verdict` 不是 `false`（`Q4_REPORT_ONLY_IN_VERDICT`）。缺整个数组为 `Q4_REPORT_ONLY_MISSING`。
- **其余数字读不出来：** 只让这张卡写「尚未完成：<原因>」，不拒绝整份文件。
- **显示：** 页面在主卡之后单独一张卡，标「只报不判」，每行与原版比较。这四行不进三态结论，也不进采用条件。

## 4. 不做的事

- 不重算任何业务数字。敞口差值是文件里两臂数字的相减，不是新判定。
- 不写生产参数、账本或 HK。A25 的去留由 Owner 按 A25 的 C6 决定，不在 QRP。
