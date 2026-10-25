# Cycle × Research × Desk V8.1：导入规格冻结说明 1 的 F1（缺场景压力行）实施回执（2026-10-25）

依据：`docs/contracts/US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE_FREEZE_1.md` F1；M2 计划修订 2 M2.4。冻结文件未改动。
实施者：Claude（QRP 工程）；合并闸由协调者做。Production effect：`NONE`。

## 做了什么

- `stress.rows` 允许一行 `missing: true` + `missing_reason`，`max_loss_usd`、`longest_underwater_sessions`、`recovered`、`end_capital` 全为 `null`，`simulated: false`。
  导入器不因缺场景行拒绝文件；原来「名称里带熊市就必须标 `simulated: true`」的整文件检查只管非缺场景行，所以 2008 极端熊市这一行（`simulated: false`）不会被拒。
- 缺场景行自身不自洽时只让压力块写「尚未回测：原因」，其他块照常：缺 `missing_reason`、带了数字（不能用 0 或估计值补位）、`simulated` 不是 `false`。
- 压力块新增「最大损失」主数字：取既非模拟、也非缺场景的行里 `max_loss_usd` 最大的一行，写明场景（并列取文件里靠前的一行）；没有这样的行写「最大损失：尚无」。
  规则边界情景（SPY / QQQ 合成载体，`simulated: true`）也不进主数字。
- 页面：缺场景行写「缺场景：<原因>」，不显示数字和恢复状态；表下一行写「已执行 N 个，模拟 M 个，缺场景 K 个；缺场景不计为已执行的压力」。

## 验证

- QRP 全量（工作树，设 `QRP_DESK_ROOT`）：105 项，104 过，0 失败，1 跳过（本机无 Ashare-V5 检出，不算通过）；页面脚本语法和 `git diff --check` 通过。
- 导入器测试：主数字取已执行的最大行、模拟行再大也不进；只剩模拟与缺场景时为「尚无」；缺原因／带数字／`simulated` 为真时只该块无效；非缺场景的熊市行没标模拟仍整文件拒绝。
  页面测试：缺场景行文字、主数字与场景名、计数行、缺场景行里没有任何数字。夹具里的数字仍是合成的，只在测试里。
- 浏览器窗格看过带合成结果的账本副本：缺场景行的原因折行完整显示（一开始被 `nowrap` 截断，已改）。

## 一处需要你决定的观察（没有实现）

V8.1 §11 AC8：「缺场景为不足」。M2.4 也写「压力结论按缺场景处理」。现在导入器只保证「`SUPPORTED` 不越过 L/U/n/引擎证据」，
并不阻止「有缺场景行却标 `SUPPORTED`」的文件进来。如果要把 AC8 做成机械检查（有缺场景行时 `verdict.state` 不得为 `SUPPORTED`），
那是对冻结导入规格第 3 节的补充，需要你来定；我没有加。
