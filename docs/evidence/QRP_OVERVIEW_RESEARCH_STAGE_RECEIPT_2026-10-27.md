# QRP 策略总览：研究进度（回执，2026-10-27）

## 缺陷

`#strategies` 让 Owner 读成「只有 US ETF 做完了研究」：

- 页头写「其中 2 个已与 Research 建立关联」。这个数只数运行态 case 的回链，没数已锁定的 Q0。
- US_V5 3000 的卡片只在 US_V5 是「所选策略」时才写实际状态。从别的策略回到总览后，它写「已接入，暂无研究问题」，虽然 Q1–Q5 已锁定、采用决定已记录。
- US_CORE、C17、QS 的卡片写死「Q0 回测结论已锁定；运行态 case 尚未建立」。

## 验收（协调会话任务说明，实现前冻结）

1. 每条策略的研究进度只取自 QRP 的权威登记与账本：
   - `config/strategy_profiles.v1.json`、`config/m4_scope.v1.json`；
   - `var/ledger/research/` 的 `baseline_evaluations`、`comparison_evaluations`、`adoption_decisions`、`hypotheses`、`experiments`。
2. 进度包括：
   - M1、A0、Q0 的状态与结论；
   - 方案对比几题；
   - 采用决定；
   - 待研究的题。
3. 页头数到每一条有研究记录的策略。不按策略写死状态文字。
4. 有推导的测试；在 1280 × 800 下量页面高度。

## 实现

- `services/research-workspace/stage.js`（新）：
  - `stageOf(facts)` 是纯推导：进度代码、结论句、卡片四行（体检与基线／方案对比／采用决定／待研究）和计数。
  - `factsOf` 读事实，`countsOf`／`countsSentence` 给页头计数。每个值的来源：
    - M1：档案 `m1_evidence` 的清单 sha256 现场核对，加诊断生产者是否登记。不跑完整体检。
    - A0、Q0 结论：当前锁的投影。
    - 替代链：`baseline_evaluations`。
    - 对比：`comparison_evaluations` 的投影。
    - 采用：`adoption_decisions` 的有效记录，计数用 `research-adoption/overview` 的 `adoptionOf`／`summaryOf`，与详情页同一套。
    - 轮次：详情说明登记。
    - 待研究：档案研究计划队列（`queueState`），加 Desk case 回链里还没锁定的问题（题名与是否已锁取自 `hypotheses`／`experiments`）。没有回链的平台工程样例不算任何策略的题。
- `services/baseline-evaluation`：投影加 `a0: { state, basis_zh }`，原样读出封存文件的 `gates.A0`。`a0DualLine` 改用同一个依据词转换，输出不变。
- `services/research-workspace/index.js`：
  - 每条策略挂 `research_stage`，与所选策略无关。
  - 页头用计数句。`counts.research_connected` 改为「有研究记录」的策略数。
  - 删除写死的 `BASELINE_LOCKED_LABEL` 两处补丁。接入标签改为进度结论句。
  - 例外：所选策略带运行态 case 时，详情页头仍照修订 4 D4 写，冻结措辞不变。
- `apps/research-web/index.html`：策略卡显示结论句与四行；状态标签紧跟标题，「查看完整策略详情」贴卡片底部。

## 证据

- 测试：
  - 新增 `tests/research_stage.test.js`，13 项：
    - 推导 9 项逐字断言；
    - 读模型 4 项用临时账本：Q0／Q1 锁、采用记录、C17 锁、Desk 回链与工程样例。它们证明：选哪条策略，进度与页头逐字相同；页头数到每条有记录的策略；总览不出现「建立关联／运行态 case 尚未建立／暂无研究问题」。
  - `tests/research_workspace.test.js` 首项改为逐条断言进度代码。账本为空时，已登记档案的四条写「已接入，Q0 尚未锁定」，与 M4 面板的「已接入」一致；CARRY 写「已列入 M4 范围」。
- 全量 `npm test`（`QRP_DESK_ROOT` 指向本机 Desk）：
  - 改动前：348 项，346 通过，0 失败，2 跳过；
  - 改动后：361 项，359 通过，0 失败，2 跳过；
  - 两项跳过都是既有的：本机没有 Ashare-V5；工作树里没有真实 Q3 文件。
- `git diff --check` 无输出；页面脚本语法检查通过。
- 真实台账拷贝（`var/ledger` 的副本，本工作树起在临时端口 4391，量完已停；4311 未动）：
  - 页头：「其中 5 个有研究记录：4 个已锁定 Q0 回测结论（1 个已有锁定的方案对比、1 个已有 Owner 采用决定），1 个作为冻结基线关联；另有 1 个已列入 M4 范围、尚未接入。」
  - US_V5 3000：「Q0 未通过；方案对比 5 题已锁定，已决定 5 题（采用 3、不采用 2）」。
  - US_CORE：「Q0 证据不足；方案对比尚未开始」。
  - C17：「Q0 证据不足（A0 未通过）；方案对比尚未开始，1 题待研究」。C17 的 M1 行写「QRP 尚无它的诊断生产者」。
  - QS：「Q0 证据不足；方案对比尚未开始，1 题待研究」。
- 页面高度（内置浏览器，先设 1280 × 800，`innerWidth` = 1280）：
  - 4311 现行：1,347 px；
  - 本分支：1,683 px；
  - 1280 与 390 px 宽下 `scrollWidth` = 视口宽度，没有整页横向滚动。
- 读模型前后对比（同一份台账，origin/main 与本分支，八种选择逐条比较 JSON）：
  - 变化只在 `research`／`research_stage`、页头计数与那句话，以及无运行态 case 的策略的详情页头标签与副标题。
  - US_V5 详情页头、所有回测／对比／采用区块逐字相同。

## 仍然为假

- US_V5 详情页头（修订 4 D4 的句子）仍写「尚未回到 Desk」：`returnedToDesk` 只数 case 回链，不读采用记录。改它要先定 D4 的措辞，本 PR 不动。
- 总览的 M1 只说明体检包已登记、清单一致，不等于 M1 产品里程碑通过；里程碑仍按原完成权威记录。
