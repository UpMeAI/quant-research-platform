# Cycle × Research × Desk V8.1：Q3 登记项（Q3b 主卡、随机选择对照卡、参照臂）的实施回执（2026-10-25）

依据：协调会话 10-25 的任务；Q3 K2（QRP `main` 681ce53，`docs/contracts/US_V5_M2_Q3_SELECTION_K2_V1.md`，sha256 `56d16406d3c116e2dfc8e8c95ece1535697c00e2e02df4f90e651091c92cfa13`，裁定 1–6）与 Q2 K2 勘误 1。导入规格增补 `docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_1.md` 随本 PR 提交，**合并即冻结**（V2 本身已冻结，不改）。实施者：Claude（QRP 工程）；合并闸和部署由协调者做。Production effect：`NONE`。

**字段名按 K2 和夹具先搭好；研究会话（正在跑 Q3，约 3.5 小时）回执里的试导入拒绝码到手后，我再按真实字段名调整。**

## 做了什么

1. **Q3 登记项**（`questions/q3.js`，已在 `registry.js` 登记，队列 Q1、Q2、Q3）：
   - Q3b：候选臂 `CANDIDATE_SECTOR_RS`，判据 G1／P_G／F3，`delta_g 0`、`delta_R 0.10`，判定同 Q2 加勘误 1（G1 先判；SUPPORTED 要三个样本数 ≥ 30；NOT_PASSED 要 G1 成立）；九道运行门（含 `INERT_Q2`、`RANDOM_IDENTITY`、`RS_TABLE_PARITY`）；没有 `attribution`；`exposure` 必填，候选臂另加 `sector_rs_refusals` 与 `reorder_instants`（非负整数）。
   - `oos_reuse: false`，**必须带** `OOS_PREVIOUSLY_EVALUATED_SAME_RULE`、**不得带** `OOS_REUSED_FOR_SELECTION`，并要写 `oos_reuse_detail`；页面写「同窗复测，不是新的样本外」，采用条件里没有「独立样本不足」，结论不因此封顶。
2. **`random_control` 块**（`questions/random_control.js`）：类别 `RANDOM_SELECTION_CONTROL_V1`，Q3a（`random_control`）与 Q3a2（`random_control.random_instrument`）两部分都必填。每部分：种子（起点必须是 20261025，`last = first + n − 1`）、统计量（基线账户 g 胜过的种子比例，相等算一半）、分布分位数、选择点普查（G1：OOS ≥ 30，先判）、结论。**结论只能不比证据强**：G1 不成立 → 只能证据不足并写 `G1_NOT_MET`；SUPPORTED 要比例 ≥ 0.75，NOT_PASSED 要 ≤ 0.50，且种子数是冻结的 1,000；INSUFFICIENT 随时允许；每笔净 R 的位置只报不判。它与 Q3b 的 `verdict` 互不引用。
3. **页面**：Q3 主卡八块（问题 → 账户结果含参照行 → 效应 → 敞口含行业 RS 两行 → 判据 → 压力 → 结论 → 前向），紧跟着一张**独立的随机选择对照卡**，两部分各有自己的三态结论。Q3a 预期 INSUFFICIENT（7 个选择点），页面明说：「G1 不成立：OOS 选择点只有 7 个，要求 ≥ 30 个，所以结论是证据不足；200 个种子的运行只作描述，不判」，状态标「证据不足（G1 不成立）」。随机对照卡里没有 Q3b 的三行文字，Q3b 主卡里也没有随机对照的结论。
4. **参照臂 `EQUAL_WEIGHT_1X_BUY_HOLD`**：顶层 `reference_arms.EQUAL_WEIGHT_1X_BUY_HOLD`（也认 `arms` 下；必须存在）。账户表在「候选 − 原版」之后多一行「等权买入持有（15 只 1× 多头）」，小字「**价格收益，不含分红**；只报，不判」；名字和说明用登记项的固定写法；它不进差值、不进判定。读不出来只让这一行写原因，账户块不失败。
5. **原因码中文标签**：`G_UPPER_AT_OR_BELOW_ZERO_SAMPLE_INSUFFICIENT`（Q2 K2 勘误 1）加了中文——「G1 不成立，而账户年化对数增长差的上沿不高于 0：照报上沿，作待验证的事实，不是经济上的反证（Q2 K2 勘误 1）」；Q2 与 Q3 共用，只在文件带这个码时才显示。
6. **共用部件**：Q2 与 Q3b 的判定、敞口、效应／判据／结论块抽到 `questions/paired_g.js`（与题目有关的文字由登记项的 `texts` 给出）；Q2 自己只留归因块。引擎加了登记项的 `extra_cards`（Q3 的随机对照卡）、`oos_reuse.required_code`、`reference_arms`；`--question` 与文件不符时先报 schema 不符。

## Q1 与 Q2 不变——已核对

- **改动前后各导出一份真实封存文件的投影**（真实 Q0 + 真实 Q1／Q2，临时台账）：`Q1-52d8296ffb10626b`、`Q2-02796a4366aa0263` 的 `result_id`、锁字段集合、整份页面投影，前后**逐字段相同**；Q1、Q2 的卡片 HTML 前后**逐字节相同**（用页面脚本渲染同一份投影各存一份对比）。
- 金标进了仓库：`tests/golden/q1_real_projection.json`（改造前代码生成，上一个 PR）、`tests/golden/q2_real_projection.json`（本 PR 动手前用上一版代码生成）；新增测试 `真实的 Q2 封存文件…` 对着它核对。
- 原有测试（Q1 导入器 28、Q1 页面 9、登记项 22、Q2 页面 8）全部一字未改通过；登记项测试只改了题目数量的断言（2 → 3）。

## 请你决定／核对的点

1. **K2 没有固定、由我在增补里定的字段名**（研究会话产出文件时最可能不同）：`random_control.{seeds,choice_points,distribution,baseline,verdict}` 里各字段的名字与类型（`choice_points.oos／is` 为整数；`distribution.g／net_R` 认「键 → 数」或 `[{q,value}]`；`baseline.share_beaten_g` 0–1）、`criteria.G1` 的三个样本数、敞口两个计数的键名、`reference_arms` 的位置。页面读法对分位数表、净 R、百分位都是宽松的（缺了不拒绝）。
2. **比 K2 字面更严的几处**：种子起点必须是 20261025，SUPPORTED／NOT_PASSED 要求恰好 1,000 个种子（K2 说同一组 1,000 个种子，同一门槛）；G1 不成立时必须自己写 `G1_NOT_MET`；参照臂和两部分随机对照都必须存在；候选臂的两个行业 RS 计数必填。
3. K2 把参照臂同时写在 `arms` 和 `reference_arms` 下，增补里两处都认；若研究会话只用一处，另一处可以删。

## 验证

- 新增测试：`tests/comparison_q3.test.js` 17 项（登记项自洽并核对 K2 实际 sha256、Q3b 判定与样本外与敞口、参照臂、随机对照卡与各条拒绝、分位数读法、校验失败、读模型）、`tests/comparison_q3_page.test.js` 6 项（四张卡的顺序与块、Q3 主卡主内容、随机对照卡与 Q3b 互不影响、清单、失败隔离）、登记项测试里 1 项真实 Q2 对金标；`tests/mobile_layout.test.js` 加入 Q3 主卡与随机对照卡（长代码，360／390 px 无整页横向滚动，且断言四张卡都渲染）。夹具 `tests/_q3_fixture.js`（合成数字，路径带 fixture，默认被拒）。
- 全量（临时工作树，设 `QRP_DESK_ROOT`，`npm test`）：208 项，207 过，0 失败，1 跳过（本机无 Ashare-V5 检出，不算通过；比上一个 PR 的 184 项多出的 24 项就是本 PR 新增的）。
- 浏览器窗格：临时端口 + 真实台账拷贝（真实 Q0、Q1、Q2 已锁定）+ 一份在真实 Q0 之上造的合成 Q3：四张卡（Q1、Q2、Q3 主卡、随机对照卡）都渲染，随机对照卡里 Q3a 明说 G1 不成立，Q3 账户表有参照行；360 px 下七条路由无整页横向滚动。验证后已杀服务并删除拷贝与种子脚本；运行中的服务和 `var/ledger` 没动。

## 没有做的

- 没有导入任何真实 Q3 文件（还没有）；没有动 smartflow、HK、Desk；没有 HTTP 写入口。
- Q4 的登记项（等它的 K2）。
