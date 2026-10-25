# US_V5_M2 候选对比结果 · QRP 导入规格 V2 · 增补 1（Q3 登记项、随机选择对照块、参照臂）

状态：**提议，随 PR 合并；协调会话合并即冻结。** 实现者起草，2026-10-25；已按 UX 修订 4（`docs/contracts/CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_4.md`）与协调会话 10-25 的调整更新（Q3a2 只跑样本外、判定依据、去重、队列状态）。
上游：Q3 研究规格 `docs/contracts/US_V5_M2_Q3_SELECTION_K2_V1.md`（sha256 `56d16406d3c116e2dfc8e8c95ece1535697c00e2e02df4f90e651091c92cfa13`，裁定 1–6）；
Q2 K2 勘误 1（`…Q2_SIGNAL_VS_LEVERAGE_K2_V1_ERRATUM_1.md`，G1 先判）；
导入规格 V2 `docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2.md`（已冻结，本文不改动它，也不改 Q1、Q2 的任何行为）。
实现：`services/candidate-comparison/questions/q3.js`（登记项）、`paired_g.js`（Q2 与 Q3b 共用的判定与块）、`random_control.js`（随机对照）；
测试：`tests/comparison_q3.test.js`、`tests/comparison_q3_page.test.js`、`tests/_q3_fixture.js`（合成数字，只用于测试）。

## 1. 不变的部分

按题目登记、题目按 `identity.schema` 判断、封存与不重算、基线链、压力表、前向不并入、三行文字分写、一题一锁——都与 V2 相同。
**Q1 与 Q2 的登记项不变**：用仓库里封存的真实 Q1、Q2 文件在临时台账里重新导入，`result_id`（`Q1-52d8296ffb10626b`、`Q2-02796a4366aa0263`）、锁字段集合、页面投影（对照改造前导出的金标 `tests/golden/q1_real_projection.json`、`q2_real_projection.json`）、卡片 HTML 都与改造前逐项相同。Q2 与 Q3b 共用判定部件之后，Q2 的行为没有变。
唯一的文字变化：**给 Q2 勘误 1 的原因码 `G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT` 加了中文标签**（Q2 与 Q3 共用）；只在文件带这个码时才显示。

## 2. Q3 的登记项（Q3b：行业 RS 排序候选，主卡）

- **身份**：`identity.schema = US_V5_M2_Q3_RESULT_V1`，`result_kind = CHALLENGER_VS_BASELINE`，`identity.k2.sha256 = 56d16406…`，`baseline_result_id`（同 Q1、Q2：必须是当前的 Q0 锁，原版臂逐项等于 Q0 的 `arms.D`）。`result_id = Q3-<文件 sha256 前 16 位>`；锁里 `verdict_state` 是 Q3b 的结论，`t3_state` 为 `null`。
- **候选臂** `CANDIDATE_SECTOR_RS`（别名 `SECTOR_RS`）：`arms.CANDIDATE_SECTOR_RS` 与每个压力行的 `arms.CANDIDATE_SECTOR_RS`。
- **运行门**（九道，缺或不是 PASSED 都拒绝）：`ACCEPTANCE`、`INPUTS`、`BASELINE_REPRO`、`INERT_Q0F`、`INERT_Q1`、`INERT_Q2`、`RANDOM_IDENTITY`、`RS_TABLE_PARITY`、`PROBE`。
- **判定同 Q2 加勘误 1**（单变体，95% 区间，没有 Bonferroni）：
  - 冻结常数 `verdict.delta_g = 0`、`verdict.delta_R = 0.10`；区间两端 `verdict.L_g`、`verdict.U_g`（缺则取 `comparison.g_vs_baseline.ci_95`）；没有 `t3_state`；
  - **先判 G1**：`comparison.criteria.G1 = {met, baseline_oos_trades, candidate_oos_trades, changed_entries}`；G1 不成立时结论一律 INSUFFICIENT；
  - SUPPORTED 须：G1、P_G 成立，F3 未触发，`L_g > 0`，`U_g > 0`，`criteria.G1` 里三个样本数都写明且 ≥ 30（改变的入场 = 只在一臂出现的「序列 + 扫描时点」入场），引擎不是近似；
  - NOT_PASSED 须：G1 成立、`U_g ≤ 0`、F3 触发；
  - INSUFFICIENT 随时允许；G1 不成立而 `U_g ≤ 0` 时照报并加原因码 `G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT`（页面写中文标签：照报上沿，作待验证的事实，不是经济上的反证）；
  - 次指标（`comparison.secondary.{literal,paired}`）不参与判定，只报告并标出相对 +0.10 R 的位置；`comparison.routing` 不适用，不写（写了也不读）。
- **样本外**：顶层 `oos_reuse` 必须是 `false`；`verdict.reason_codes` **必须带 `OOS_PREVIOUSLY_EVALUATED_SAME_RULE`**（`Q3_OOS_PREVIOUS_EVALUATION_NOT_DECLARED`），**不得带 `OOS_REUSED_FOR_SELECTION`**（`Q3_OOS_REUSE_CONTRADICTS_CODE`）；`oos_reuse_detail` 必须写理由（须写明 RS-1 已在同一窗口评价过同一规则）。页面在问题块写「**同窗复测，不是新的样本外**」，结论不因此封顶。采用条件里没有「独立样本不足」（样本外没有被复用来选择）。
- **敞口披露（必填，两臂）**：同 Q2 的四个字段（`comparison.exposure.{BASELINE,CANDIDATE_SECTOR_RS}`），候选臂另加两个必填的非负整数：`sector_rs_refusals`（行业 RS 拒绝数，原因码 `SECTOR_RS_NOT_TOP_N`；页面写「行业 RS 拒绝数（不在前 4 的行业信号）」，不写原码）与 `reorder_instants`（名次重排的时点数）；原版臂没有排序层，写了就按整数读、没写页面显示「—」。
- **归因块**：不要求（Q3 没有 `attribution`）。
- **前向**：`forward` 为空并写原因（`forward.reason_zh` 或顶层 `forward_reason_zh`）；任何一行 `in_verdict` 不是 `false` 拒绝。
- **页面**：主卡八块——问题 → 账户结果（原版、候选和差值三行，加参照行；SPY 与现金只在回测结论卡，卡里写一句「基准见回测结论卡」——UX 修订 4 D3.2）→ 账户对数增长与每笔净 R → 敞口变化披露（含行业 RS 两行）→ 判据逐条（G1、P_G、F3）→ 压力 → 三态结论 → 前向。SUPPORTED 读作「完整账户的对数增长更好（不等于信号 alpha 更大）」，三行文字照旧分开写，并按 UX 修订 4 写「判定依据」（`basis.js`：SUPPORTED 写区间下沿高于门槛并注明 G1 成立；NOT_PASSED 写上沿不高于门槛；INSUFFICIENT 且 G1 不成立写改变的入场等笔数对门槛，g 区间并列）。导入规格里主内容不出现原样英文原因码：已登记的写中文，未登记的折叠，写「另有 N 个技术原因码（见技术详情）」。

## 3. 参照臂 `EQUAL_WEIGHT_1X_BUY_HOLD`（只报，不判）

- 位置：顶层 `reference_arms.EQUAL_WEIGHT_1X_BUY_HOLD`，也认 `arms.EQUAL_WEIGHT_1X_BUY_HOLD`（K2 正文把它列在 `arms` 里，裁定 6 写成 `reference_arms`）。**必须存在**（`Q3_REFERENCE_ARM_MISSING`）。
- 形状同其他臂：`summary:{end_capital, cagr, max_drawdown, longest_underwater_sessions, recovered}`，可带 `equity:{dates,values}`（带了，期末资本须等于序列末点）。读不出来只让页面那一行写「尚未完成：原因」，不让账户块整块失败。
- 页面：账户表里「候选 − 原版」一行之后，一行「等权买入持有（15 只 1× 多头）」，下面小字「**价格收益，不含分红**；只报，不判」。名字和说明用登记项的固定写法，不取文件里的标签；它不进差值、不进判定。

## 4. 随机选择对照块 `random_control`（它自己的结论，单独一张卡）

- **位置与类别**：顶层 `random_control`（必填，否则 `Q3_RANDOM_CONTROL_MISSING`）是 Q3a；它下面的 `random_instrument` 是 Q3a2（必填，否则 `Q3_RANDOM_CONTROL_PART_MISSING`）。每部分：
  `{seeds:{rule, n, first, last}, choice_points:{definition_zh, oos, is, is_reason_zh?, rows}, distribution:{g, net_R}, baseline:{g, net_R, share_beaten_g, share_beaten_net_R, percentile_g}, verdict:{class:'RANDOM_SELECTION_CONTROL_V1', state, rule, reason_codes}}`。
- **开发期选择点 `choice_points.is`**：非负整数。**Q3a2 只跑样本外**（Q3 K2 裁定 1，协调会话 10-25 确认），此时 `is` 为 `null`，且必须带非空的 `is_reason_zh`（或 `is_reason`）；`null` 不带原因、Q3a 的 `null`、非整数都拒绝（`…_CHOICE_POINTS_INVALID`）。G1 只数 OOS 选择点，所以 `is` 是什么都不影响 G1。页面写「开发期 不跑（原因）」。
- **与 Q3b 互不影响**：校验时两者互不引用；锁里的结论是 Q3b 的；页面上随机对照是紧跟在 Q3b 主卡后面的单独一张卡，两部分各有各的三态结论，不并入、不覆盖 Q3b 的 verdict。
- **统计量**：`baseline.share_beaten_g` = 基线账户 g 胜过的种子比例（相等算一半），0–1；分位数在 `distribution.g`（必填）与 `distribution.net_R`（可选），认「键 → 数」对象或 `[{q|p|quantile, value}]` 数组；每笔净 R 的位置（`share_beaten_net_R`）只报告，不判。
- **种子**：`seeds.first` 必须是 20261025（seed_i = 20261025 + i），`seeds.last = first + n − 1`（`Q3_RANDOM_CONTROL_SEEDS_CHANGED`）。SUPPORTED／NOT_PASSED 要求 `n = 1000`（`Q3_RANDOM_CONTROL_SEEDS_INSUFFICIENT`）；Q3a 在 G1 不成立时只跑 200 个种子作描述，只能是证据不足。
- **G1 先判**：`choice_points.oos ≥ 30`（可另写布尔 `g1_met`，与 `oos` 不符拒绝：`…_G1_DISAGREES`）。G1 不成立时结论只能是 INSUFFICIENT（`…_VERDICT_WITHOUT_G1`）且 `reason_codes` 必须含 `G1_NOT_MET`（`…_G1_NOT_DECLARED`）。Q3a 预期就是这样（OOS 选择点 7 个），页面写一句结果「选择点太少：OOS 7 个，N 个种子的运行只作描述，不判」，判定依据写「G1 不成立：OOS 选择点 7 个，低于门槛 30 个」，状态标「证据不足（G1 不成立）」。
- **三态**：G1 成立且 `share_beaten_g ≥ 0.75` 才可 SUPPORTED；G1 成立且 `≤ 0.50` 才可 NOT_PASSED；其余 INSUFFICIENT（`…_VERDICT_SUPPORTED_WITHOUT_EVIDENCE`、`…_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE`）。INSUFFICIENT 随时允许（保守方向）。
- 类别 `verdict.class` 必须是 `RANDOM_SELECTION_CONTROL_V1`（`…_CLASS_UNSUPPORTED`）；缺 `choice_points`、`baseline.share_beaten_g`、`distribution.g` 拒绝。

## 5. 不做的事

- 不重算：比例、分位数、g、选择点数都是文件里已报的数字；页面上的差只是已报数字的并排或相减。
- 不改 Q1、Q2 的任何行为；不写生产参数、账本、HK；没有 HTTP 写入口。
- 采用任何改动都走 `US_CRYPTO_PAPER_FULL_RUN` 修订加 Owner 签字；排序层的上线已由 A23 签署为前向验证，开关仍关，本题不改动它。
