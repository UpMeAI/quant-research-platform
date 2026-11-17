# MINING_SPACE_V1 · A 股第一轮搜索空间 · FREEZE_1 · FROZEN

- **状态：** FROZEN。冻结时刻 2026-11-17T10:57:06+08:00（读钟），协调会话签发。
- **依据：** Owner 2026-11-17 10:5x 在协调窗口签「挖掘按推荐」（★M (a)、★H1 (a)、★H2 (a)、★K (b)）；RF1116 签字文本 `RESEARCH_FRAMEWORK_AMENDMENT_20261116_FACTOR_LIBRARY_AI_MINING.signed.fd22876f.md`；冻结准备 rev 4 `RF1116_MINING_FREEZE_PREP_V1.draft.2fe8f606.md`（sha256 2fe8f606a192a978552f1e4db28d30bc8e8595a3a8f5d810bdb3fba8f05af750）。
- **冻结的空间：** schema MINING_SPACE_V1，文件 `MINING_SPACE_V1_CN_A_R1.0d3556fa.json`（与 DRAFT_4 `MINING_SPACE_V1_CN_A_R1.draft.0d3556fa.json` 逐字节相同）。
- **sha256：** 0d3556fa97f17d3a67b350e7f74c12fb521ca1fb60c293121601f7eb95f96637
- **校验：** QRP main 0bbfe7f5 起的 `parseSpace` 通过（读数都是已登记数据集，有历史时钟的数据集按历史时钟声明：后复权价 series [daily, adj_factor] 为 CLOSE_DATED_NEXT_OPEN_USABLE，ret_1d / amount 为 BAR_CLOSE，daily_basic 为 CLOSE_DATED_NEXT_OPEN_USABLE；只用次日开盘可用的数据）。
- **同时冻结：** `RF1116_GMINE_THRESHOLDS_FREEZE_1.md`（★e 六个门槛）与 `RF1116_HOLDOUT_CN_A_R1_FREEZE_1.md`（留出段）。
- **冻结之后：** 轮中改空间即为新的一轮；任何改动要 FREEZE_2 加 PR，已有记录不重写。
