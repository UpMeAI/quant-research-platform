# RF1116 · G-MINE ★e 门槛 · FREEZE_1 · DRAFT（待协调会话签发）

状态：**DRAFT。** 由协调会话签发：去掉 `.draft`，填冻结时刻，算 sha256，把 path 与 sha256 写进 QRP `config/mining_gate_thresholds.v1.json` 的 `frozen_ref`（门槛冻结 PR）。与 `MINING_SPACE_V1` DRAFT_4、锁定留出段日期同时冻结（协调会话 04:32）。
- 起草：2026-11-17 04:3x CST（读钟），AQuA 会话。

## 1. 冻结的是什么

- **决定：** ★E1 (a)，签字建议值原样冻结（协调会话 2026-11-17 03:2x，依签字页 39f8c17c 的 ★e「第一轮前由协调会话冻结」）。
- **出处：** 签字文本 `RESEARCH_FRAMEWORK_AMENDMENT_20261116_FACTOR_LIBRARY_AI_MINING.signed.fd22876f.md` §3.6；签字页 `RESEARCH_FRAMEWORK_AMENDMENT_20261116_SIGNATURE_1.md`（sha256 `39f8c17c…`）§4 ★e；理由见冻结准备稿修订 4（`RF1116_MINING_FREEZE_PREP_V1.draft.md`，sha256 `2fe8f606…`）§1。
- **六个数（G-MINE 第 3、4、5、7 项）：**

| 键 | 值 | 项 |
|---|---|---|
| `ic_mean_min` | 0.02 | 3：留出段平均 rank IC（中性化之后） |
| `icir_min` | 0.3 | 3：ICIR，按不重叠持有期 |
| `monotonicity_min` | 0.9 | 4：五分组 Spearman（最多一对相邻组颠倒） |
| `decay_ratio_min` | 0.5 | 5：持有期加倍时 IC 不低于原 IC 的一半 |
| `marginal_intercept_t_min` | 2 | 7：对库内 `LIVE_IN_RULE` 因子收益回归的截距 t |
| `marginal_ir_delta_min` | 0 | 7：加入后组合 IR 不降 |

- **不在本页：** DSR ≥ 0.95（N 取本族累计）与 PBO ≤ 0.5 沿用 11-10 修订；第 6 项扣成本净值按附录 1；第 8、9 项按签字文本。

## 2. 功效说明（随冻结一起生效）

- 留出段只有几十个交易日（按 ★H2 (a) 约 54 个，(b) 约 21 个）。按 5 日持有期，日度 IC 的标准差通常在 0.1 左右，十几个信号日的平均 IC 标准误约 0.025：**IC ≥ 0.02 在留出段上分不出真假**；ICIR 用的不重叠期约 10 个（(a)）或 3–4 个（(b)）。
- 所以第 3、4、5 项在留出段上是「筛」，不是「证据」（签字文本 §3.4「留出段只是一道筛，判定主要靠 ④」）。多重比较靠第 1 项 DSR 与第 2 项 PBO，不靠收紧单项门槛。

## 3. 冻结之后

- QRP 门槛冻结 PR 合并后，G-MINE 与逐候选记录（`MINING_GATE_RECORD_V1`）按这六个数判；在那之前一律 `pass: false`（`MINE_THRESHOLDS_UNFROZEN`）。
- 改任何一个数都要新的冻结页（FREEZE_2）和新的 PR；已写的 G-MINE 记录不改（记录里有门槛文件的 sha256 与用到的数）。
- 挖掘仍要等三样都冻结：本页、`MINING_SPACE_V1`（DRAFT_4，0d3556fa）、留出段起止（★H1、★H2，Owner），以及 P2 的生成方式与 ★K。
