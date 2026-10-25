# Cycle × Research × Desk V8.1：Q3 登记项（Q3b 主卡、随机选择对照卡、参照臂）的实施回执（2026-10-25）

依据：协调会话 10-25 的任务；Q3 K2（QRP `main` 681ce53，`docs/contracts/US_V5_M2_Q3_SELECTION_K2_V1.md`，sha256 `56d16406d3c116e2dfc8e8c95ece1535697c00e2e02df4f90e651091c92cfa13`，裁定 1–6）与 Q2 K2 勘误 1。导入规格增补 `docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2_ADDENDUM_1.md` 随本 PR 提交，**合并即冻结**（V2 本身已冻结，不改）。实施者：Claude（QRP 工程）；合并闸和部署由协调者做。Production effect：`NONE`。

**本回执已按 UX 修订 4（PR #24，main 0b74a84）与协调会话 10-25 的调整更新；分支已 rebase 到 0b74a84。**

### 修订 4 之后多做的（rebase 后）

1. **Q3a2 只跑样本外**：`random_instrument.choice_points.is` 为 `null` 且带非空 `is_reason_zh`（或 `is_reason`）时接受；G1 只数 OOS 选择点。`null` 不带原因、Q3a 的 `null`、非整数、负数仍拒绝（`Q3_RANDOM_CONTROL_CHOICE_POINTS_INVALID`）；整数照旧接受。页面写「开发期 不跑（原因）」。夹具里的 Q3a2 就按这个形状。
2. **修订 4 的规则用到 Q3 的卡上**：Q3b 与 Q2 共用 `paired_g.js`，所以 Q3b 的「判定依据」（`basis.js`，G1 笔数用登记项的「改变的入场」）、未登记原因码折叠、对比卡账户表（原版、候选、差值、等权买入持有参照行，SPY／现金不在表里，下写「基准见回测结论卡」）、前向人话行都是同一套；随机对照卡每个部分各有「判定依据」（G1 不成立写 OOS 选择点对门槛；成立写比例对 75%／50% 线），原因码已登记的写中文、未登记的折叠，一句结果不再复述规则，比例不再单列一行。
3. **主内容里的英文原因码**：敞口表那一行原来写「行业 RS 拒绝数（SECTOR_RS_NOT_TOP_N）」，改为「行业 RS 拒绝数（不在前 4 的行业信号）」；原码只留在中文原因说明所对应的内部登记里。
4. **队列状态从锁和计划推出**（协调会话要求）：诊断清单里 Q3 原来写固定的「排队：Q1 之后」。现在 `registry.queueState` 用锁、登记项（K2 已冻结）和计划里的先后关系（`PLAN`：Q2 可与 Q1 并行，Q3 在 Q1 之后，Q4 排在 Q3 封存之后）推出：有封存结果→已完成／校验失败／文件缺失；K2 已冻结但没有结果→「进行中：K2 已冻结，等研究会话交付封存的对比结果」；K2 未冻结→「排队：Q3 锁定之后开始」，前置都已锁定则「待立题：前置题已锁定，等 K2 冻结后开始」。同一份状态也生成页头与研究区开头的句子，所以现在是「研究问题：Q1、Q2 已锁定；Q3 进行中；Q4 排队，等 Q3 锁定（来源：Q0 诊断，协调会话立题）；尚未回到 Desk」——**与修订 4 的示例句（「Q3、Q4 进行中」）不同，是因为 Q4 的 K2 还没冻结、运行排在 Q3 封存之后，按实际状态写**。去掉了登记项里已无用处的 `pending_status_zh` 字段。
5. **一处重复**：Q2／Q3 的问题块里，样本外的说明原来先写登记项的一句、再写文件里的详细说明，两句同义（真实 Q2 页面上就是这样）。现在文件写了详细说明就只写它，没写才写登记项的那一句。

研究会话（正在跑 Q3，约 3.5 小时）回执里的试导入拒绝码到手后，我再按真实字段名调整。**

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
- 修订 4 改变了呈现，所以金标测试现在先去掉修订 4 新增的呈现字段（判定依据、前向人话、与参照相同、基准提示）并把账户块的基准两臂拿掉，再与改造前导出的金标逐字段比较——金标文件本身没动，数字没变是断言出来的。Q1／Q2 的其他旧测试只在文字、两臂账户表、页头标签、研究区开头这些修订 4 改变的地方改了断言。

## 请你决定／核对的点

1. **K2 没有固定、由我在增补里定的字段名**（研究会话产出文件时最可能不同）：`random_control.{seeds,choice_points,distribution,baseline,verdict}` 里各字段的名字与类型（`choice_points.oos／is` 为整数；`distribution.g／net_R` 认「键 → 数」或 `[{q,value}]`；`baseline.share_beaten_g` 0–1）、`criteria.G1` 的三个样本数、敞口两个计数的键名、`reference_arms` 的位置。页面读法对分位数表、净 R、百分位都是宽松的（缺了不拒绝）。
2. **比 K2 字面更严的几处**：种子起点必须是 20261025，SUPPORTED／NOT_PASSED 要求恰好 1,000 个种子（K2 说同一组 1,000 个种子，同一门槛）；G1 不成立时必须自己写 `G1_NOT_MET`；参照臂和两部分随机对照都必须存在；候选臂的两个行业 RS 计数必填。
3. K2 把参照臂同时写在 `arms` 和 `reference_arms` 下，增补里两处都认；若研究会话只用一处，另一处可以删。

## 验证

- 新增测试：`tests/comparison_q3.test.js` 17 项（登记项自洽并核对 K2 实际 sha256、Q3b 判定与样本外与敞口、参照臂、随机对照卡与各条拒绝、分位数读法、校验失败、读模型）、`tests/comparison_q3_page.test.js` 6 项（四张卡的顺序与块、Q3 主卡主内容、随机对照卡与 Q3b 互不影响、清单、失败隔离）、登记项测试里 1 项真实 Q2 对金标；`tests/mobile_layout.test.js` 加入 Q3 主卡与随机对照卡（长代码，360／390 px 无整页横向滚动，且断言四张卡都渲染）。夹具 `tests/_q3_fixture.js`（合成数字，路径带 fixture，默认被拒）。
- 全量（临时工作树，设 `QRP_DESK_ROOT`，`node --test tests/*.test.js`，rebase 后）：232 项，231 过，0 失败，1 跳过（本机无 Ashare-V5 检出，不算通过）；`git diff --check` 无输出；页面脚本 `node --check` 通过。新增：Q3a2 只跑样本外 1 项、随机对照判定依据 1 项、修订 4 规则用在 Q3 卡 1 项、队列状态 1 项，另有诊断状态与页头句子的断言。
- 浏览器窗格（rebase 后重做）：临时端口 + 真实台账拷贝（真实 Q0、Q1、Q2 已锁定）+ 一份在真实 Q0 之上造的合成 Q3（拷到不带 fixture 字样的路径，页面才肯读）：四张卡（Q1、Q2、Q3 主卡、随机对照卡）都渲染；页面上「页面不重算」1 次、「暂无研究问题」0 次、「排队：Q1 之后」0 次，「判定依据」6 处（顶部 1、三张主卡各 1、随机对照两部分各 1），三行块 4 个（顶部 + 三张主卡）；1024、390、360 px 的 `scrollWidth` 都等于视口宽度（策略详情各章、Q3 主卡与随机对照卡各扫一遍）。另用真实台账拷贝（没有 Q3）读模型：「Q1、Q2 已锁定；Q3 进行中；Q4 排队，等 Q3 锁定」，Q3 条目「进行中：K2 已冻结…」、Q4 条目「排队：Q3 锁定之后开始」。验证后已杀服务并删除拷贝与种子脚本；运行中的服务和 `var/ledger` 没动。真实 Q3 文件还没有，所以真实页面上还看不到 Q3 的卡。

## 没有做的

- 没有导入任何真实 Q3 文件（还没有）；没有动 smartflow、HK、Desk；没有 HTTP 写入口。
- Q4 的登记项（等它的 K2）。
