# Cycle × Research × Desk V8.1：导入器按研究会话实际封存的 Q0 文件调整读法（2026-10-25）

文件：`/Users/kaylame/KaylaProject/research-data/us_v5_m2_q0_a1/result/US_V5_M2_Q0_RESULT_V1.json`，sha256 `591c2d485f5b0ab9b738c2029d82315f4624fc3c67940fe35dc91bed6e6d998b`（旁证文件与之相符）。
依据：研究会话的请求（压力行形状）；冻结导入规格 F1 的读法被**放宽**，冻结文件本身未改动。实施者：Claude（QRP 工程）；合并闸由协调者做。Production effect：`NONE`。

## 结论

- 用 PR #4 的代码读这份真实文件：整文件校验通过，周期、账户、胜率、半凯利、判定五块可读，压力块因「缺 stress.max_loss_usd」整块变空。
- 改完后，六块全部可读，问题清单 14 条可读；页面读法：结论「证据不足」，主数字样本外每笔净 R 均值 +0.26 R（区间 −0.06 至 +0.60），最大损失 US$1,084（扫描相位 ±60 分钟）。
- 我没有导入真实账本：只在 `/private/tmp` 的账本副本里导入过一次，用来验证 CLI 与页面；`var/ledger` 没有被改动。真实导入由协调者做。

## 改了什么（`services/baseline-evaluation`、页面压力块与胜率块）

| 研究会话文件里的形状 | 导入器现在的读法 |
|---|---|
| 压力行 `status: 'MISSING_SCENARIO'`（2008 极端熊市），数字为 null，`simulated: true` | 缺场景。没有序列的行，`simulated` 写什么都不算模拟序列；数字必须是 null（不能用 0 补位）；原因取 `reason_zh`（若有）、`reason`、`missing_reason`。页面写「缺场景：<原因>」 |
| 压力行 `status: 'INVALID_INPUT'`（2020 年窗口：没有载体通过流动性底线） | 无效输入。同样不计为已执行的压力。页面写「无效输入：<原因>」 |
| 压力行 `status: 'SUPPLEMENTARY_NOT_IN_CONCLUSION'`（SPY/QQQ 合成补充行），`simulated: true`、`in_headline: false` | 补充行：必须同时 `simulated: true` 且 `in_headline: false`，永不进「最大损失」；数字照常显示并标「模拟序列，不是可交易历史」 |
| `in_headline: false` | 显式排除出最大损失 |
| `stress.conclusion`（英文，说明压力评价不完整） | 页面写固定的中文句子「压力评价不完整：缺场景 K 个、无效输入 L 个；缺场景按「不足」处理（AC8）…」，研究会话的原文放在折叠的「研究会话的原文」里 |
| 未知 `status` 值 | 只让压力块无效（失败关闭），不静默当作已执行 |
| `stats.rows` 只有 `PLUS_60MIN`，没有 `MINUS_60MIN` | 120 分钟扫描下 −60 与 +60 是同一组时刻：只有 +60 时合并显示为「相位 ±60 分钟」并加一句说明；两行都在时照常分开 |
| `verdict.label`（中文的近似引擎说明）；`engine_approximation.missing` 是英文代码 | 结论的「最大的限制」和周期块直接用文件自带的中文说明；没有时才退回代码拼接 |
| `reason_codes` 里的 `CI_G_STRADDLES_ZERO`、`STRESS_SCENARIO_MISSING` | 加了中文说明 |

整文件失败关闭的条件不变，只有一处随之调整：「名称带熊市就必须标 `simulated: true`」的检查不再对没有序列的行（缺场景、无效输入）生效。

「最大损失」仍按 F1：只取已执行、非模拟、非缺场景、非无效输入、且未被 `in_headline: false` 排除的行里最大的一行。真实文件里是 `SCAN_PHASE_PLUS_60MIN`，US$1,083.56（计数：已执行 8、模拟或补充 1、缺场景 1、无效输入 1；
已执行里包含基线参照行和三条风控维度行，这与 F1 的字面读法一致，不影响本次的最大值）。

## 验证

- QRP 全量（工作树，设 `QRP_DESK_ROOT`）：111 项，110 过，0 失败，1 跳过（本机无 Ashare-V5 检出，不算通过）；页面脚本语法、`git diff --check` 通过。
- 新测试：研究会话形状的压力行、状态不自洽、中文原因优先、±60 合并说明、文件自带中文引擎说明、页面压力块（缺场景／无效输入各一行、补充行标模拟、压力结论与原文可见、最大损失不含它们）；
  一条读取真实文件的只读回归测试（本机有该文件时才跑，不导入）。F1 的两条旧断言随放宽更新（缺场景行 `simulated` 为真不再算错；计数多了「无效输入」）。
- 浏览器窗格：真实文件导入到 `/private/tmp` 的账本副本后，结论区块、账户、胜率、压力块读起来正常；压力表里的原因目前是研究会话写的**英文**原文。

## 给协调者

1. 本 PR 叠在 F1 的 PR #7 之上（基准分支 `claude/v8-1-q0-f1`），#7 合并后自动改基到 `main`。
2. 压力行和缺场景原因是英文，页面会原样显示。要中文的话请研究会话在这些行里加 `reason_zh`（导入器已优先读它），不用改别的。
3. 仍未做：AC8 的机械检查（有缺场景行时 `verdict.state` 不得为 `SUPPORTED`）。这份真实文件的 `state` 是 `INSUFFICIENT`，不受影响。
