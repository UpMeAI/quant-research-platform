# RACE_V2 · 赛马扩展（按市场的榜、按层的分区）

- 依据：研究框架修订 2026-11-16（RF1116）§4（③ 赛马，修订 4），Owner 2026-11-16 23:50 CST 签字。
  - 签字文本 `artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261116_FACTOR_LIBRARY_AI_MINING.signed.fd22876f.md`（sha256 `fd22876f…`）；
  - 签字页 `artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261116_SIGNATURE_1.md`（sha256 `39f8c17c…`），★g：三个市场各一张榜、按层分区；风控层用 BHY 校正，代替 DSR；每场最多 2 名进样本外模拟盘。
  - 实施项 R1（§8.1）；先红后绿的测试 §8.3 第 4 条。
- 代码：`services/race-orchestrator/v2.js`。两两配对的裁决器（`services/race-orchestrator` 的 `adjudicate`）原样复用；旧赛马（`RACE_RUN_V1`，台账 `races.jsonl`、`paired_samples.jsonl`）不动，逐字节不变。RACE_V2 写自己的台账 `races_v2.jsonl`。
- 性质：只是研究台账，不下单，不改生产，`production_effect: NONE`。门只拒绝或判负，不改写任何结论；失败即关，错误码 `RACE_*`（成本门沿用 `COST_MODEL_*`）。

## 1. 赛马清单 `RACE_MANIFEST_V1`

一场 = 一个市场、一个分区（层）。字段：`race_ref`、`market`（`CN_A` / `US` / `CRYPTO`）、`partition`（`SELECTION_TIMING` / `RISK`）、`periods_per_year`、`engine{id, version}`、`window{from, to}`、`cost_model{cost_model_ref, cost_breakdown?}`、`primary_metric`、`guardrails`、`pbo_max`、`promotion_slots`（1–2）、`champion`、`challengers[]`。

- 主指标随分区固定：`SELECTION_TIMING` → `ACCOUNT_PAIRED_G`；`RISK` → `RISK_TRIPLE_THEN_DAILY_CVAR5`。
- 护栏（§4.4 的建议值，★g「细则是默认值」；清单逐项写出，冻结时定）：选股择时层 `dsr_min 0.95`、`mdd_max_ratio 1.2`、`participation_cap 0.10`；风控层 `bhy_alpha 0.05`；`pbo_max 0.5`。
- 参赛者：`entrant_id`、`trial_id`、`market`、`layer`、`book_ref`；挑战者另写 `origin`（`FACTOR` + `factor_ref`，或 `HUMAN` + `k2{sha256, frozen_at}`）、`causality{state, evidence_sha256 | not_applicable_code}`；风控层的挑战者写 `return_loss_max`（K2 预登记的收益损失约束，与配对 g 同单位：年化对数）。
- **冻结**（做法同 K2）：清单按字节 sha256 绑定；冻结页（协调会话目录，按 sha256 绑定）原文必须写出清单 sha256、`RACE_MANIFEST_V1` 与 `FROZEN`。否则 `RACE_MANIFEST_NOT_FROZEN`。
- **台账**：每个参赛者在试验台账里有一行预登记（`PREREGISTERED`）：`k2_sha256` = 清单 sha256，阶段 `BOOK`，冠军角色 `BASELINE`、挑战者 `VERDICT_ARM`，`market` 归到本榜。否则 `RACE_LEDGER_ROW_MISSING` / `RACE_LEDGER_ROW_INVALID`。

## 2. 开赛（`openRace`）

依次核对，全部通过才写一行 `OPEN`：

1. 冻结（§1）。
2. 清单结构；名额超过 2 → `RACE_PROMOTION_SLOTS_INVALID`。
3. **一个市场一个榜**：任一参赛者的市场、台账行的市场、因子库里因子的市场不是本榜 → `RACE_CROSS_MARKET`。同一市场内跨账本允许（`book_ref` 可以不同），都和本市场冠军在账户层配对。
4. **一个分区一层**：参赛者的 `layer` 不是本分区 → `RACE_MIXED_LAYER`。
5. 台账行（§1）。
6. **入场线**（§4.4）：
   - `FACTOR`：因子库里该因子是 `RESEARCH`（过了 G-MINE）→ 否则 `RACE_ENTRY_FACTOR_NOT_RESEARCH`；
   - `HUMAN`：有冻结 K2（sha256 + 冻结时刻）→ 否则 `RACE_ENTRY_K2_NOT_FROZEN`；
   - 都声明 G-CAUSAL：`PASS` / `DEVIATION_ACCEPTED` 带证据 sha256，或 `NOT_APPLICABLE` 且码是 `RISK_K_OR_ACCOUNT_LAYER`（附录 1 §1 A1）→ 否则 `RACE_ENTRY_CAUSALITY`。
7. **G-COST**：分区的成本模型过 `services/cost-gate` 的 `assessCostModel`（目录内计成本的模型，或不低于本市场下限的自报单边 bps）；不计成本、低于下限、没有下限 → `COST_MODEL_*`。

## 3. 收赛（`closeRace`）

- 结果：冠军与每个挑战者的 `engine`、`window`、`cost_model_ref` 必须等于清单（`RACE_ENGINE_MISMATCH` / `RACE_WINDOW_MISMATCH` / `RACE_COST_MODEL_MISMATCH`）；账户层日序列 `daily[{date, logret}]` 在窗口内、日期升序；每个挑战者与冠军逐日一致，缺边 → `RACE_PAIRED_SAMPLE_MISSING`。
- **PBO**：CSCV（`overfit.pbo`），在本分区的全部参赛者（冠军加挑战者）的日对数收益上算。`> pbo_max` 或算不出 → 分区 `INCONCLUSIVE`，谁都不晋级；配置 < 4 → 不适用（由 DSR / BHY 承担）。
- **选股择时层**，每个挑战者：
  - 配对 g = 日对数收益差的均值 × `periods_per_year`；裁决器 `adjudicate`（主指标 `paired_g`，护栏 `MDD_MAX_RATIO`：最大回撤不超过冠军的 `mdd_max_ratio` 倍）；
  - DSR = `overfit.deflatedSharpe`：`d` = 月度配对差（`overfit.monthlyPairedDiff`），N = 本市场累计 N（`trial-ledger.countMarket`，计入 N 的角色、不同配置数加未计数历史的下限，从不跨市场），V 取本市场账本级已知 ŜR（`trial-ledger.marketSharpes`）加本分区挑战者的 ŜR；
  - 淘汰（任一条，记负结果）：`NOT_BEATING_CHAMPION`、`MDD_OVER_RATIO`、`DSR_BELOW_MIN`、`DSR_UNKNOWN`、`EXCESS_NOT_POSITIVE`（窗口内扣成本后的对数超额 ≤ 0）、`PARTICIPATION_OVER_CAP`（结果的 `participation_max` > `participation_cap`）；
  - 另报：最大回撤、最差月份、日 CVaR 5%（尾部亏损）。
- **风控层**，每个挑战者：
  - 最大回撤、最差月份、日 CVaR 5% 任一项劣于冠军 → `WORSE_MDD` / `WORSE_WORST_MONTH` / `WORSE_CVAR5`；
  - 收益损失（= −配对 g）> `return_loss_max` → `RETURN_LOSS_OVER_CONSTRAINT`；
  - BHY（`overfit.bhy`，11-10 修订 §3.4）：本分区挑战者的单边 p 与本市场已关闭的风控分区的 p 一起校正，从不跨市场；校正后 > `bhy_alpha` → `BHY_NOT_SIGNIFICANT`。不算 DSR。
  - p 值由结果给出（`p_one_sided` 与 `p_method_ref`，按各自冻结 K2 的检验）。
- **晋级**：淘汰线以上的按主指标排名（选股择时层：配对 g；风控层：日 CVaR 5% 的改善），取前 `min(promotion_slots, 2)` 名。
- 写一行 `CLOSED`：`outcome{state, primary_metric, pbo, champion, entrants[], ranking[], promoted[], negative_results[]}`；负结果也入台账。

## 4. 指标的写法

- 最大回撤：净值 = exp(累计日对数收益)，取 1 − 净值 / 此前最高净值的最大值（正数）。
- 最差月份：月内日对数收益之和取 exp − 1 的最小值。
- 日 CVaR 5%：日简单收益最差的 ⌈5% · 天数⌉ 天的均值。
- DSR、PBO、BHY、月度配对差的公式都取自 `services/trial-ledger/overfit.js`，不另写。

## 5. 范围之外与已知限制

- 挖掘的尝试数：P1 才有 `MINED_CANDIDATE` 角色。现在本市场 N = 台账里计入 N 的行，P1 合并后挖掘的尝试自动计入同一个计数。
- G-CAUSAL 只核声明（证据 sha256 与状态），由协调会话冻结清单时核对，不在赛马里重跑因果门。
- 风控层的 p 值不在赛马里计算：§4 没定检验方法，取各挑战者冻结 K2 的单边 p，赛马只做 BHY。
- PBO 在风控分区也按日对数收益排名（CSCV 的写法），不是按风控层的主指标。
- DSR 算不出（月数 < 24 或已知 ŜR < 5 个）时记 `DSR_UNKNOWN` 并淘汰，没有接 11-10 修订 ★5 的 Bonferroni 回退。
