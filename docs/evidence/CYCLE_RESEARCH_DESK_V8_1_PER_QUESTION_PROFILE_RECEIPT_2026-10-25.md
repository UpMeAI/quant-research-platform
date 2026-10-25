# Cycle × Research × Desk V8.1：候选对比导入规格按题目登记（Q2 登记项）的实施回执（2026-10-25）

依据：协调会话 10-25 的任务（Q1 导入规格写死了一道题，Q2 导不进来）；Q2 K2（QRP `main` 7370c23，`docs/contracts/US_V5_M2_Q2_SIGNAL_VS_LEVERAGE_K2_V1.md`，sha256 `660237c8823a5961c70ca78c8685343adb34ff2b35f192146d630a508f45ff6a`，裁定 4–6）。导入规格 V2 `docs/contracts/US_V5_M2_COMPARISON_IMPORT_PROFILE_V2.md` 随本 PR 提交，**合并即冻结**。实施者：Claude（QRP 工程）；合并闸和部署由协调者做。Production effect：`NONE`。

## 做了什么

1. **题目登记** `services/candidate-comparison/registry.js`：按题目 id 登记，每项写明 K2 路径与 sha256、候选臂键、判据集与必填常数、样本外期望（含原因码规则）、是否必须有归因块与敞口披露、页面块与三态人话。导入器（`index.js`）只剩与题目无关的引擎；Q1 的东西搬进 `questions/q1.js`，Q2 在 `questions/q2.js`。题目由结果文件的 `identity.schema` 判断，命令行可加 `--question Q2` 显式指定（与文件不符拒绝，未登记拒绝）。错误码前缀跟着题目（`Q1_…`、`Q2_…`）。
2. **Q1 的登记项逐项复现今天的行为——已核对**：
   - 用仓库里封存的真实 Q0（`Q0-2604282b935f85d3`）与真实 Q1 文件在临时台账里重新导入：`result_id` 仍是 **`Q1-52d8296ffb10626b`**，锁字段集合相同。
   - 页面投影与**改造前**导出的金标（`tests/golden/q1_real_projection.json`，用改造前的代码生成）逐字段相同，只多了一个 `title_zh`；渲染出来的 Q1 卡片 HTML 与改造前**逐字节相同**（用页面脚本渲染同一份真实投影，前后各存一份对比）。
   - 原有的 Q1 导入器测试 28 项一字未改全部通过；页面测试只做了一处机械改动（读模型的 `comparison` 改成 `comparisons[0]`，见下）。
3. **Q2 的登记项（Q2 K2 裁定 4–6）**：候选臂 `CANDIDATE_1X`；判据 G1、P_G、F3；只按配对 g 判（95% 区间，没有 Bonferroni；SUPPORTED 要 `L_g>0`，NOT_PASSED 要 `U_g≤0`，其余证据不足；次指标对 +0.10 R 只报不判）；冻结常数 `delta_g 0`、`delta_R 0.10`；`oos_reuse` 必须 `false`（带 `OOS_REUSED_FOR_SELECTION` 反而矛盾，并要写 `oos_reuse_detail`）；运行门八道（含 `INERT_Q1`、`ROUTING_CENSUS`、`ATTRIBUTION_RECONCILE`）；必须有**归因块**（各栏各类相加对上合计，合计加监管费按日进位差对上账户盈亏，残差 0，监管费日进位差单列一行，**对的是基线臂的净盈亏**，对到候选臂也拒绝）；必须有**两臂敞口披露**。
4. **页面**：「研究与对比」里每个已锁定的题目一张卡，按队列 Q1、Q2；Q1 第一张在没有任何结果时仍写「尚未完成：研究会话尚未交付封存的对比结果」。Q2 九块：问题 → 账户结果 → 账户对数增长与每笔净 R（次指标、路由、单股 2×）→ 敞口变化披露 → 判据逐条 → 压力 → **Q2a 归因表** → 三态结论 → 前向（写明为什么为空）。SUPPORTED 在 Q2 里读作「完整账户的对数增长更好（不等于信号 alpha 更大）」，顶部结论、文字第一行和待验证清单的状态都用它；三行（优势结论／压力评价不完整／采用条件）照旧分开写。待验证清单里 Q2 那一条在锁定后写「已完成：…」并带链接，未锁定时原样不动。
5. **其他**：锁 schema `COMPARISON_EVALUATION_LOCK_V1` 的 `t3_state` 改为可选（只有带镜像状态的题目才有；已有的锁仍然合法）；命令行加 `--question`；移动宽度测试里加入 Q2 卡片（带长代码）。

## 请你决定／核对的点

1. **K2 没有固定、由我在 V2 里定的字段名**（研究会话产出文件时最可能与此不同，试导入的拒绝码会指向它们）：
   - 敞口披露放在 `comparison.exposure.{BASELINE,CANDIDATE_1X}`，每臂四个必填字段 `avg_notional_usd`、`time_in_market_ratio`、`notional_cap_rejections`、`notional_cap_reductions`；
   - 归因块的形状：`attribution.{oos,is}.{by_class[], total, reconcile{account_pnl,sum_components,residual,reg_daily_rounding}}`，各栏在 `usd:{<栏>:数}`／`r:{…}`，不适用的栏写 `null`；
   - `criteria.G1` 里的三个样本数 `baseline_oos_trades`、`candidate_oos_trades`、`changed_entries`；
   - 次指标 `comparison.secondary.{literal,paired}`、路由 `comparison.routing`、`oos_reuse_detail`、`forward.reason_zh`（这几项页面只显示，缺了不拒绝）。
   研究会话回执里的试导入拒绝码到手后我对照检查。
2. **比 K2 字面更严的几处**（出处都在 K2，但写得不是机械条件）：NOT_PASSED 要求 G1 成立（K2：G1 不成立一律证据不足）；SUPPORTED 要求 `criteria.G1` 里写出三个样本数且都 ≥ 30；敞口披露对任何判定状态都必填（裁定 4「必须同时披露」）；归因对基线臂净盈亏的容差是 1e-3 USD（臂 summary 只存 4 位小数），内部对账容差是 K2 的 1e-6。
3. 读模型里 `strategyDetail.comparison`（单个）换成 `comparisons`（数组）；页面是唯一消费者，已同步改；`readModel({comparison})` 注入点仍接受单个投影或数组。

## 验证

- 新增测试 30 项：`tests/comparison_registry.test.js` 22（登记项自洽并核对 K2 文件的实际 sha256、真实 Q1 文件对金标、Q2 的各条拒绝与投影、归因对账的各种破坏、题目选择与错误码、缓存分题、锁定后改文件只坏 Q2 一张卡）、`tests/comparison_q2_page.test.js` 8（两张卡的顺序与块、Q2 主内容与归因表、清单、校验失败只坏 Q2、读模型）；`tests/mobile_layout.test.js` 增加 Q2 卡片（360／390 px 无整页横向滚动，且断言两张卡都渲染）。夹具 `tests/_q2_fixture.js`（合成数字，路径带 fixture，默认被拒）。
- 全量（临时工作树，设 `QRP_DESK_ROOT`，`npm test`）：184 项，183 过，0 失败，1 跳过（本机无 Ashare-V5 检出，不算通过；比上一个 PR 的 154 项多出的 30 项就是本 PR 新增的）。
- 浏览器窗格：临时端口上用**真实台账的拷贝**（真实 Q0、真实 Q1 已锁定）加一份在真实 Q0 文件之上造的合成 Q2：真实 Q1 卡片照常显示（证据不足），Q2 九块渲染、归因表对账 0；360 px 下八条路由无整页横向滚动。验证后已杀服务并删除拷贝与种子脚本；运行中的服务和 `var/ledger` 没动。

## 没有做的

- 没有导入任何真实 Q2 文件（还没有）；没有动 Q1 的任何行为和已冻结的 Q1 导入规格；没有动 smartflow、HK、Desk；没有 HTTP 写入口。
- Q3、Q4 的登记项（等各自的 K2）。
