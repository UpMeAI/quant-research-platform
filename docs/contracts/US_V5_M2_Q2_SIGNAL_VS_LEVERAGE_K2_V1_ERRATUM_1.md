# US_V5 M2 Q2 研究规格 K2 V1 · 勘误 1

状态：**FROZEN**（2026-10-25，协调会话；Q2 运行封存之前）
对象：`docs/contracts/US_V5_M2_Q2_SIGNAL_VS_LEVERAGE_K2_V1.md`，sha256 `660237c8823a5961…`（原文不改）

## 勘误内容

裁定 4 把判定规则写成「L_g > 0 → SUPPORTED；U_g ≤ 0 → NOT_PASSED；其余 → INSUFFICIENT」，漏写了正文「判据」中的 G1（两臂 OOS 成熟交易各 ≥ 30；被改换载体的入场 ≥ 30）。这一漏写使裁定 4 可能被读成取消 G1。更正如下：

1. **先判 G1。** G1 不成立时，结论一律为 `INSUFFICIENT`（原因码 `G1_NOT_MET`），无论 L_g、U_g 是多少。依据：V8.1 §6.7「覆盖／数据／推断条件不足」→ 证据不足，以及已签 T3 验收「FAIL 须数据充分」的同一原则。
2. **G1 成立时**：L_g（95%）> 0 → `SUPPORTED`；U_g（95%）≤ 0 → `NOT_PASSED`（F3 式否决）；其余 → `INSUFFICIENT`。
3. G1 不成立而 U_g ≤ 0 时，照报 U_g 并加原因码 `G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT`，作为待验证事实进诊断清单，不作经济反证。
4. 裁定 4 的其余内容（次指标不参与判定、披露敞口、「有支持证据」的措辞）不变。

本勘误不改变 δ、比较对象、期限与任何已运行的结果。
