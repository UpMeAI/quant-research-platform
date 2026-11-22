# RF1116 缺陷逃逸记录：评分的市值中性化（2026-11-18）

## 逃逸的缺陷

- **评分怎么中性化。** 挖掘沙箱给 IC 类读数做中性化（`evaluator.neutralizeForScoring` → `operators.csNeutralizeSize`）分两步：先减同一天同行业的均值，再对 `log(total_mv)` 做一元线性回归取残差。
- **漏在哪。** 公式值若是右偏的原始量级，这一步之后，残差按排名仍然带着很强的市值暴露。
- **核对。** -r4 尾段 2026-10-16 与 09-30 两天，READY、去掉北交所，没做减行业均值那一步。数字是残差与对数市值的秩相关：

| 公式值 | 秩相关 |
|---|---|
| 总市值 | −0.92 / −0.91 |
| 流通市值 | −0.89 / −0.88 |
| 后复权收盘价 | −0.70 / −0.71 |
| 成交额取负 | +0.59 / +0.58 |

- **证据。** 协调会话目录 `evidence/rf1116-round2-mechanisms-aqua-20261118/`，SHA256SUMS `3cd26241`。

## 当时为什么没拦住

- 挖掘空间冻结审阅和裁定 R1 只核了「两步都做了」，也就是戳 `neutralization { industry: APPLIED, size: APPLIED }`，G-MINE §3.6 核的也是这个戳。没有人核做完之后还剩多少暴露。
- 单元测试用的合成值是对数尺度或排名尺度，碰不到右偏的原始量级。

## 影响

- **第 1 轮** `MR-CN_A-2026-11-e1ab63a27b`：FAILED_EVALUATION，没被评估，不受影响。
- **第 2 轮** `MR-CN_A-2026-11-2a1d2c9c82`：选择记录 `cccd65af`，62 个幸存者。
  - 22 个是小市值的替身：A004 A006 A035 A041 A049 A065 A076 A111 A116 A127 A139 A142 A143 A164 A168 A170 A173 A174 A181 A191 A198 A199。
  - 1 个是大市值一侧：A194。
  - 协调会话 2026-11-18 12:07 在机制复审里把这 23 个全部定为 REJECTED。它们在验证段只做多上的正结果照实披露，写 `SIZE_LEAK_NOT_MECHANISM`。
- **没有发生的：** 留出段开启、打分、G-MINE 判定、因子入库、生产效应。

## 处理

- 第 2 轮的规则照冻结时的样子不动（裁定：frozen as run）。第 1、2 轮在代码里按名单固定为 `LINEAR_RAW_V1`。
- 修复：`artifacts/coordinator/RF1116_AMENDMENT_SIZE_NEUTRALIZATION_20261118.draft.md`，即 ★RF1116_SIZE_NEUTRALIZATION = (a)。
  - 第 3 轮起，中性化之前先换成排名高斯（`RANK_GAUSS_V2`）；
  - G-MINE 第 8 项加市值暴露检查，失败即关。
- 验收是 `tests/mining_size_neutralization_v2.test.js`，冻结之前是红测试。冻结并部署之前，第 3 轮不开。
- 原冻结文件、第 1、2 轮的台账与选择记录一概不改。
