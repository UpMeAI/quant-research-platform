# Cycle × Research × Desk V8.1：Q1 候选对比导入器与「研究与对比」页面的实施回执（2026-10-25）

依据：协调会话 10-25 的任务（对冻结的 Q1 K2：QRP `main` f8698b6，sha256 `84c96c2843b196046ec17045b20e4dcaf02e0117e8291243a23b3be51990bb02`，裁定 5 = 结果文件布局）；导入规格 `docs/contracts/US_V5_M2_Q1_RESULT_V1_IMPORT_PROFILE.md` 随本 PR 提交，**合并即冻结**。实施者：Claude（QRP 工程）；合并闸和部署由协调者做。Production effect：`NONE`。

## 做了什么

1. **导入器 `services/candidate-comparison/index.js`**（与 Q0 同一套封存纪律，共用 `baseline-evaluation` 的内部工具；Q0 的行为不变）。
   - 结果类别 `CANDIDATE_COMPARISON_V1`（`SUPPORTED／NOT_PASSED／INSUFFICIENT`，对应 K2 的 PASS／FAIL／INSUFFICIENT；BLOCKED 不出结论，拒绝）；锁 `COMPARISON_EVALUATION_LOCK_V1`（`result_id = Q1-<sha256 前 16 位>`），台账 `research/comparison_evaluations.jsonl`。
   - 导入命令：`apps/research-cli/import_candidate_comparison.js`，完成权威执行，只追加一条锁；同一文件重放幂等；同一题已有锁时拒绝，改锁须 `--supersedes --defect-ref --reason`，旧锁保留。
   - 页面读取：每次现场复验文件 sha256，stat 指纹＋TTL 缓存（成功 10 分钟、失败 15 秒），同 Q0。
2. **拒绝规则（整文件失败关闭，全部有测试）**：
   - 任务明确要求的三条：`baseline_result_id` 必须是已存在的 Q0 基线锁；`oos_reuse` 为真时必须带 `OOS_REUSED_FOR_SELECTION`；任何一行 `forward` 的 `in_verdict` 不是 `false`；`SUPPORTED` 违反 F3（`U_g ≤ 0`）。
   - 我加的（见下「请你决定的点」）：基线必须是**当前**那一把（`Q1_BASELINE_NOT_CURRENT`）；`arms.BASELINE.summary` 五项逐项等于 Q0 `arms.D.summary`（`BASELINE_REPRO` 门在 QRP 侧的落地核对）；`oos_reuse: false` 拒绝（K2 裁定 4 规定写 `true`）；K2 点名的七道运行门必须全在且 `PASSED`；`δ*`、`δ_g`、Bonferroni 98.33% 被改拒绝；`SUPPORTED` 须各判据成立、`L_D>0`、`L_g>0`、`U_D≥δ*`、主样本 ≥ 30 笔且 ≥ 10 块、引擎不是近似；`NOT_PASSED` 须有 F1／F2／F3 之一的证据；判据逐项缺失或两处写法不一致拒绝；压力有缺而 `SUPPORTED` 不写 `STRESS_SCENARIO_MISSING` 拒绝（同 Q0 FREEZE_2 G3）。
3. **页面**：策略详情「研究问题与方案对比」一节最上面是候选对比卡，七块固定顺序：问题 → 账户结果（原版／候选／候选 − 原版）→ 受影响交易的改善（主 S、次 B）→ 判据逐条（G1、P1–P4、F1–F3 各一句人话）→ 压力两臂逐行加差 → 三态结论与采用条件 → 前向（标「前向，只报不判，不并入结论」）。
   - 第 6 块永远分三行写在主内容里：「优势结论：…」「压力评价不完整：缺场景 K 个、无效输入 L 个［、候选臂缺项 M 个］（列出场景）」「采用条件：未满足（独立样本不足，等前向成熟［；必要压力缺失，§6.7］）」，不折叠。
   - 尚无结果时整节写「尚未完成：研究会话尚未交付封存的对比结果」；文件校验失败写「尚未完成：结果文件校验失败：<原因>」，不显示数字。块级失败只让那一块写「尚未完成：<原因>」。
   - 「待验证问题清单」里对应 Q1 的一条：无结果时写「K2 已冻结，等研究会话交付封存的对比结果（见研究与对比）」，有结论后写「已完成：<结论>（见研究与对比）」，并带「查看研究与对比 →」链接到本节。Q0 的回测结论卡**未改动**（测试逐字比对：有／无 Q1 时 Q0 卡的 HTML 相同；`data-block` 仍是原来的六个，对比块用 `data-cmp-block`）。
4. **读模型** `services/research-workspace`：`strategyDetail.comparison` 与 `readModel({comparison})` 注入点（测试用），`linkComparison` 只改清单里 Q1 那一条的状态与链接。
5. **K2 布局的兼容处理**（K2 正文与裁定 5 在个别位置写法不同，导入规格里逐条列出，两种写法都认）：`arms` 的键（`BASELINE`／`D`，`CANDIDATE_T3`／`T3`）、`forward` 在顶层或 `comparison` 下、总体 `populations.{S,B}`／`comparison.{S,B}`／`comparison.D`、判据逐项在 `comparison.criteria`／`verdict` 下、`identity.baseline_result_id` 或 `identity.baseline.{result_id,sha256}`、`identity.k2.sha256` 或 `k2_sha256`。读到的位置不止一处时必须一致。

## 验证

- 新增 37 项测试：导入器 28 项（`tests/candidate_comparison.test.js`）、页面与读模型 9 项（`tests/candidate_comparison_page.test.js`），夹具 `tests/_q1_fixture.js`（合成数字，路径带 fixture，默认被拒）。
- 相关既有套件不变：`baseline_evaluation` 20、`research_web_render` 11、`research_workspace` 8、`schemas_and_fork_guard` 3、`product_milestone_diagnostic_gate` 1、`runtime_research_loop` 9，全部通过。
- 全量（临时工作树，设 `QRP_DESK_ROOT`，`npm test`）：153 项，152 过，0 失败，1 跳过（本机无 Ashare-V5 检出，不算通过；与上一个 PR 的 116 项相比，多出的 37 项就是本 PR 新增的）。
- **在真实 Q0 文件之上做了一次端到端**：用仓库里封存的真实 `Q0-2604282b935f85d3` 文件作基线，造一份合成的 Q1 文件（数字无意义，不入库），导入到 `var/ledger` 的**临时拷贝**（不是运行中服务的台账），`SUPPORTED` 导入通过——真实 Q0 的 `arms.D` 逐项核对、输入序列与引擎摘要都能读出。然后在 4399 端口的临时服务器上在浏览器窗格里看了桌面（1100 px）与手机（375 px）：七块全部渲染，三行分写，压力两臂表在 `table-wrap` 里；Q1 一条在待验证清单里写「已完成：有支持证据」并有链接。验证后已杀掉服务、删掉临时台账与种子脚本。
- 手机宽度下整页横向宽度为 423 px（> 375 px）：**线上已部署的页面（无本 PR）同样如此**，来源是顶部导航条，不是本卡片；本 PR 的卡片内容自身没有超宽元素。未处理，列为后续项。

## 请你决定的点

1. 我额外加的检查：基线必须是当前那一把锁；原版臂必须与 Q0 的 `arms.D` 逐项相同；`oos_reuse: false` 拒绝；K2 点名的七道门必须都在。它们都出自 K2 正文或裁定，但任务里没逐条写。如果研究会话的文件在这几处与我的读法不同，导入会拒绝并给出错误码，由你决定改导入规格（需要新修订）还是请研究会话改文件。
2. 未冻结的子字段名是我按 K2 正文和裁定写出的读法（见导入规格第 2 节）；研究会话按它产出文件最稳。合并即冻结，之后改读法需要新的冻结说明，不改已冻结文本。

## 没有做的

- 没有导入任何真实 Q1 文件（还没有）；真实台账 `var/ledger` 和运行中的服务没动。
- 没有动 smartflow、HK、Desk；没有写生产参数或账本；没有 HTTP 写入口。
- 手机页面整体宽度的既有问题（见上）。
