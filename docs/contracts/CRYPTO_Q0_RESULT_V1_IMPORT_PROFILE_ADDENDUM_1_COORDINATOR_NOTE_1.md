# CRYPTO_Q0_RESULT_V1 导入规格 · 增补 1 · 协调会话冻结说明 1

状态：**FROZEN**（2026-10-26 23:3x CST，协调会话）
被说明：`docs/contracts/CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE_ADDENDUM_1.md`。该文件由 Owner 在 QRP 规格会话中冻结（「all ★, freeze it」，main `26d50b3`），原文不改。本说明只补两点，冲突时以增补 1 原文为准。

1. **V2 将替代 V1。** Owner 2026-10-26「同意，按这三步推进」：C17 会按生产 10 分钟节奏重建基线，出 `C17_V2_M2_Q0_RESULT_V2`，其 `supersedes` 指向 V1（`26691b6c…`）。
   - 实现要能按导入规格 §8 接受 V2：导入后 V1 只显示为 SUPERSEDED。
   - V2 若沿用同一结构，不需要新读法；字段若有不同，另出增补。
2. **海外桶 Rule 1b 是共享约束**（A5.6、A17 V3 桶）：US_V5、US_CORE、C17_V2、QS V3 合计 16,000；自起点峰值回撤 ≥ 40% 时全体停新开仓，只有 Owner 能解除。
   - C17 页面在共享约束处，与 A19 同样只写文字，加一行：「海外桶 Rule 1b：四本账合计 16,000，自起点峰值回撤 ≥ 40% 全体停新开仓，只有 Owner 解除（共享，未复算；研究题 R1B-1）」。
   - QS 与 US_V5 的页面本说明不改（保持逐字节不变）。各成员统一显示，待 R1B-1 冻结后另行处理。
   - 依据：Owner 2026-10-26「Rule 1b 那个研究题先立起来」；研究题文件 `OVERSEAS_BUCKET_RULE_1B_RESEARCH_QUESTION_V1.md`。
