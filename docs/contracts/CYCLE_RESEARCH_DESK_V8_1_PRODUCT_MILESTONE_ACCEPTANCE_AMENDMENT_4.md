# Cycle × Research × Desk：V8.1 产品里程碑验收修订 4 —— M4 范围：增加策略

状态：FROZEN
冻结日期：2026-10-26（协调会话）
原验收：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_V1.md`，SHA-256 `32682ab08a03c168b1cb3648bd72133682785f573076b22ae026b1fabc1f717e`
修订 3：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_3.md`，SHA-256 `629c43babef597b7fde669b8ac82244d03e6a6d84b85a7af178136f752deb80b`
Production effect：`NONE`。不改任何交易规则、研究结果、锁、采用状态，也不授予生产写权限。

## 触发（Owner 原话）

- 2026-10-26 00:3x CST：「目前只有US_V5策略有research, 接下来Quick Shot和C17 都要接入research，再接下来是A股选股和美股核心轮动，最后是加密货币资金费率套利策略接入research」
- 2026-10-26：「同意以上策略接入research 三批的安排」

## A4.0 与上游规格的冲突（照实披露）

V8.1 规格 §12.2 和 T06 把 M4 放在 M3 之后；§747 写明第一版实施范围是 M0–M3。原验收 V1 因此把 M4/M5 记为 `OUT_OF_SCOPE`。

现在 US_V5 的 M3 还是 `NOT_VERIFIED`，而 Owner 要求现在就开始接入新策略。按指令优先级，Owner 的明确指令高于项目规格，本修订按 Owner 指令执行，同时保留规格的顺序语义：

1. 新策略的研究工作和各自的 M0–M2 阶段记录，可以现在开始，与 US_V5 并行。
2. 平台级的 **M4 PASS** 仍要求 US_V5 的 M3 先 PASS（见 A4.5）。
3. 新策略的任何进展都不推出 US_V5 的 M3，反过来也一样。

## A4.1 当期 M4 方向

当期只立「同一工作台增加策略 / 市场」这一个方向。「从 Cycle 线索进入 A/B 增量评价」这个方向仍不在范围内，页面显示「未立项」。M5 仍为 `OUT_OF_SCOPE`。

## A4.2 范围与顺序（Owner 指定）

| 批次 | 策略 | 策略身份 | 计价 |
|---|---|---|---|
| 1 | Quick Shot V3 | `QUICK_SHOT_V3_1000USDT` | USDT |
| 1 | C17_V2 | `C17_V2_4000USDT` | USDT |
| 2 | Ashare-V6 个股账本（五段链） | 在其 K2 冻结时确定 | CNY |
| 2 | 美股核心轮动 | `US_CORE`（账本身份在其 K2 冻结时确定） | USD |
| 3 | 资金费率套利 | `CARRY_V2_SHADOW_10000USDT` | USDT |

每条策略的研究 case id，随该策略的导入档案一起冻结。建议格式为 `RRC-<策略>-<资金>-V8-1-M0`。

## A4.3 每条策略单独走 M0→M3

1. 每条策略都绑定自己的 `RUNTIME_RESEARCH_CASE_V1`，按原验收 P2（共同证据）和 P3（分阶段准入）顺序记录。阶段不从 US_V5 或其他策略继承。
2. 共享约束只引用、不复算。例如 A19 亏损预算由 Quick Shot V3 与 C17_V2 共用。一条策略的数字不得进入另一条策略的账户等式或页面结论。
3. M1 必须是该策略自己的真实原生回放和对账。US_V5 的证据、测试档案和夹具都不能充当新策略的运行证据。

## A4.4 页面显示

1. 已接入的策略各显示自己的 M0–M3 状态。
2. 已列入 A4.2、但还没有导入档案的策略，显示「已列入 M4 范围，尚未接入」，不显示 `NOT_VERIFIED` 加零值。
3. 平台级 M4 一行显示 `NOT_VERIFIED`，直到 A4.5 的条件满足。M5 行显示 `OUT_OF_SCOPE`。

## A4.5 M4 PASS 条件

平台级 M4 PASS 要求同时满足：

1. US_V5 的 M3 已 PASS；
2. 至少一条 A4.2 策略用真实证据完成了自己的 M1–M3 PASS；
3. 复用证据成立：新策略和 US_V5 用的是同一套 QRP 注册表与页面，即 `QRP_MULTI_STRATEGY_PROFILE_REGISTRY_ACCEPTANCE_V1` 已验收通过。

之后每多一条策略完成，就单独记为一个 M4 范围项 PASS。只有 A4.2 的五条全部通过，才能宣称「支持全部五条」。

## A4.6 确定性验收（QRP 实现：在多策略注册表合并之后）

1. 正向测试：一个新 case 可以按 M0→M1→M2→M3 顺序记录；A4.5 三项都满足时，可以记平台级 M4 PASS。
2. 负向测试，以下情况都必须被拒绝：
   - US_V5 的 M3 未 PASS，却记平台级 M4 PASS；
   - 新 case 跳过前一阶段；
   - 用另一个 case 的证据给本 case 记阶段；
   - 未登记的策略记任何阶段；
   - 用夹具当真实运行证据。
3. 页面显示符合 A4.4，有测试断言。
4. QRP 全量测试、schema、Research Web 语法和 `git diff --check` 都是 0 失败。原验收 P6 的既有断言不回归。
