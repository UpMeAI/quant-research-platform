# US_V5_M2_Q0_RESULT_V1 · QRP 导入规格 · 冻结说明 1

状态：**FROZEN**（2026-10-25，协调会话）
冻结对象：`docs/contracts/US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE.md`，sha256 `23689c99a532f341f56cfe7bc8fd9147e835d62533ae45c90f03d151f35413eb`（随 PR #4 合并，文件原样不改；其首行「提议」状态由本说明替代为冻结）
上游：M2 计划 V1、修订 1（M1.4 / M1.5）、修订 2（M2.1 / M2.4）；UX 修订 3。

导入规格按原文冻结，另加以下三点；与原文冲突时以本说明为准。

## F1. 缺场景的压力行（修订 2 M2.4）

- `stress.rows` 允许一行带 `missing: true` 和 `missing_reason`（字符串）。此时 `max_loss_usd`、`longest_underwater_sessions`、`recovered`、`end_capital` 都是 `null`，`simulated: false`。
- 页面在该行写「缺场景：<missing_reason>」。这一行不进入「最大损失」主数字，也不计为已执行的压力。
- 2008 极端熊市一行按此填写，`missing_reason` 写「2007–2009 行业 ETF 日线在 Mac 与 HK 均无，按 Owner 规则不重新拉取」。
- 补充的规则边界情景（只含 SPY / QQQ 合成载体）单独占一行，`simulated: true`，`label` 用修订 2 M2.4 的原文；它也不进入「最大损失」主数字。
- 页面「最大损失」主数字取 `simulated: false` 且非 `missing` 的行里，`max_loss_usd` 最大的一行，并写明是哪个场景。

## F2. 长历史不适用的规则（修订 2 M2.1）

`gates.rules` 中只影响 A0 窗口的规则（例如 `A17_PREDECESSOR_SHARED_LIMITS`、`A17_T_ANCHOR`），在长历史结果里记 `status: 'NOT_APPLICABLE'`，附 `code_ref` 和 `reason`；它们在 A0 窗口的差异继续留在 `gates.A0.rows`。导入器第 3 节第 5、6 条的「规则清单无 NOT_IMPLEMENTED」按这一读法执行。

## F3. 主数字

页面主数字 = `stats.rows` 中 `segment='OOS'`、`cost_bps=5`、`phase='PRODUCTION'` 的 `mean_R` 与 `mean_R_ci`，按原文执行，确认冻结。
