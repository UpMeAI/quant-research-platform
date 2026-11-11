# ASHARE_Q0_ACCOUNT_RESULT_V1

状态：QRP #49 新增的只读格式适配合同。它把 Ashare-V6 Q0 未封存账户的
`ASHARE_V6_Q0_ACCOUNT_DAY_V1` JSONL 转成研究平台可校验的结果与信号登记；不替换 V6
引擎，不连接数据库，不修改 V6，也不产生生产动作。

## 1. 输入边界

- 一次只接受一个 `accountId + role + phase.id`，日期必须严格递增。
- `sealed: true` 一律拒绝，防止读取封存比较臂和 R-STK-1 盲线。
- 输入文件必须由调用方给出预期 SHA-256；不一致失败关闭。
- 权威字段仅来自账户日记录：账户身份、`point.events` / `point.executions`、权益字段以及
  `reasonCodes`、`klineDecisions`、`marketGate`、`q0Events`、`armPoints`、`ranking`、
  `shortlistState`。适配器不重算规则命中或业务数值。

## 2. 结果

`ASHARE_Q0_ACCOUNT_RESULT_V1` 包含：

- `account`：账户、角色、阶段；
- `executions`：事件名以 `FILLED_` 开头的原始事件及其账户日定位；
- `equityCurve`：逐日直接映射的权益、现金、持仓市值、净值和峰值。旧 Q0 导出只提供
  `navCny/cashCny/grossExposureCny/peakNavCny` 时，`nav` 保持 `null`，不会自行除法补值；
- `ruleEvidence`：逐日原样规则证据；
- `summary`：账户日数、成交事件数、源文件最后一日的权益和日期；
- `signalRegistryHash`：同批信号登记内容哈希；
- `productionEffect: NONE`。

结果 `hash` 是去掉顶层 `hash` 后，对完整规范 JSON 的 SHA-256；嵌套来源哈希仍参与计算。

## 3. 信号登记

`ASHARE_Q0_SIGNAL_REGISTRY_V1` 与结果同批生成。一行等于开仓成交（`FILLED_BUY` 或
`FILLED_OPEN`）上的一组 `decision.reasonCodes`，不从普通阻断原因、排序或 K 线判断猜测
入场信号。源文件没有开仓成交时：

```text
rows = []
rowsState = NOT_APPLICABLE:NO_ENTRY_FILLS_IN_SOURCE
```

这与“信号为零”不同，也不会用占位信号冒充记录。缺少成交决策码的真实开仓登记为
`UNKNOWN:ENTRY_SIGNAL_NOT_RECORDED`。

`merge_signal_registries.js` 把这份登记与美股、加密的 `SIGNAL_REGISTRY_V1` 合并成
`SIGNAL_REGISTRY_V2`。V2 是同一张三市场表；既有 V1 行的窗口绩效原样保留，A 股没有
记分牌窗口时 `performanceState` 明确为不适用，不能把三市场不可比的统计量拼成同一分数。

## 4. 验证

- 结果、登记和登记行分别通过 `schemas/index.js` 的合同校验；
- CLI 已存在任一输出时拒绝覆盖；
- 验收对账直接比较源文件成交事件数与结果 `fillCount`、源文件末行权益与结果
  `endingEquity`，不设容差。
- 统一登记逐份复算来源登记的内容哈希，必须且只能包含 `CN_A / CRYPTO / US` 三个市场。

