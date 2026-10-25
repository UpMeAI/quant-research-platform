# US_V5_M2_Q1_RESULT_V1 · QRP 导入规格（K3，候选对比类别）

状态：**提议，随 PR 合并；协调会话合并即冻结。** 实现者起草，2026-10-25。
上游：Q1 研究规格 `docs/contracts/US_V5_M2_Q1_T3_DEFERRED_TIME_STOP_K2_V1.md`（sha256 `84c96c2843b196046ec17045b20e4dcaf02e0117e8291243a23b3be51990bb02`，裁定 5 = 结果文件顶层字段；本文不改动它）；
`docs/contracts/US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE.md` 加 FREEZE_1／FREEZE_2（封存、不重算、压力行形状、三行分写规则，本文沿用）；
`docs/contracts/US_V5_M2_RESEARCH_PROGRAM_V1.md` 修订 1（M1.4 判定词汇、M1.5 结果文件）；`CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_3.md`。
实现：`services/candidate-comparison/index.js`、`apps/research-cli/import_candidate_comparison.js`、`schemas/index.js`（`COMPARISON_EVALUATION_LOCK_V1`）；测试夹具 `tests/_q1_fixture.js`（合成数字，只用于测试）。

K2 裁定 5 只固定了顶层字段名，正文和裁定对个别位置写法不同（`arms` 的键、`forward` 放哪、`verdict.class`）。
下面是导入器对**子字段**的读法，目的是让研究会话产出的文件一次导入通过；两种写法并存处，列出导入器都认的位置。
Q0 导入器、Q0 卡和 Q0 文件的读法一概不变。

## 1. 文件、封存与结果锁

- 一个 JSON 加旁边的 `<文件名>.sha256`；路径必须是绝对路径；路径里带 `fixture / demo / mock / synthetic` 的文件不当作实际来源。封存、旁证、复现规则同 Q0（错误码前缀由 `Q0_RESULT_` 换成 `Q1_RESULT_`）。
- 导入命令（完成权威执行，读文件、追加一条 `COMPARISON_EVALUATION_LOCK_V1`，不写别处）：
  `QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_candidate_comparison.js --file <绝对路径> --registered-by V8_1_COORDINATOR`
- `result_id = Q1-<文件 sha256 前 16 位>`，结果类别 `CANDIDATE_COMPARISON_V1`。同一题（Q1）只锁一次；改锁须 `--supersedes <当前 result_id> --defect-ref <引用> --reason <原因>`，旧锁保留。
- 锁里记录：文件路径与 sha256、所引用的 Q0 `baseline_result_id`、`oos_reuse`、输入序列摘要与引擎 blob 摘要（算法同 Q0）、K2 与本规格的引用。`production_effect` 恒为 `NONE`。
- 页面每次现场复验文件 sha256 与锁里记录一致（stat 指纹＋TTL：成功缓存 10 分钟，失败 15 秒）；文件被改、被删、旁证丢失，整节写「尚未完成：结果文件校验失败：<原因>」，不显示任何数字。

## 2. 顶层字段与子字段（`*` 为导入器必须读到的）

必须出现的顶层字段：`identity`、`inputs`、`gates`、`arms`、`stats`、`stress`、`half_kelly`、`formula_table`、`verdict`、`diagnosis_items`、`reproducibility`、`comparison`、`oos_reuse`。`forward` 见下表。`corrections`、`engine_run` 不要求。

| 顶层 | 子字段 |
|---|---|
| `identity` | `schema`* = `US_V5_M2_Q1_RESULT_V1`；`result_kind`* = `CHALLENGER_VS_BASELINE`；`k2`*：`{sha256* = 上述 K2 的 sha256}`（也认扁平的 `k2_sha256`）；`baseline_result_id`*（或 `baseline:{result_id, sha256}`，两处都写时必须一致；写了 `baseline.sha256` 就必须等于 Q0 锁里的文件 sha256）；`smartflow_commit`*（40 位）、`engine_files`*（路径 → blob sha）——摘要算法同 Q0；`d_version`、`t3_acceptance_sha256`、`command`、`seed`；`oos_reuse`：`{reused:{from,to}, independent:[…]}`（页面用来写「已被 T3 研究读过的区间」和独立证据，缺则取 K2 裁定 4 的 2023-01-03 至 2026-10-02） |
| `inputs` | 同 Q0：`series`*（每条含 `sha256`、`symbol`、`source_host`、`source_ref`），`census`、`segments` |
| `gates` | K2 点名的七道运行门必须都在且 `state:'PASSED'`：`ACCEPTANCE`、`INPUTS`、`BASELINE_REPRO`、`INERT_Q0F`、`INERT_TWINS`、`TWIN_PARITY`、`PROBE`。文件里其他带 `state` 的门也必须是 `PASSED`。任一不过，K2 规定是 BLOCKED、不出结论，所以不会有带结论的文件 |
| `arms` | `BASELINE`*（也认 `D`）、`CANDIDATE_T3`*（也认 `T3`）、`SPY_BUY_HOLD`、`CASH`，每臂 `equity:{dates, values}`（四臂日期相同、值为正）与 `summary:{end_capital, cagr, max_drawdown, longest_underwater_sessions, recovered}`；`end_capital` 必须等于权益序列末点。`CANDIDATE_T3` 可加 `deferred_sessions`。`window` 键忽略 |
| `stats` | 要求存在；页面不读它（两臂各 12 行的统计留作研究会话的报告） |
| `stress` | `rows`*：每行 `{scenario, label, simulated:boolean, arms:{BASELINE, CANDIDATE_T3}, diff}`；臂格 `{max_loss_usd, longest_underwater_sessions, recovered, end_capital}`；`diff` = 候选 − 基线，三项（`max_loss_usd`、`end_capital`、`longest_underwater_sessions`）必须与两臂数字相符。**缺场景／无效输入行**沿用 Q0 FREEZE_1／2：`status:'MISSING_SCENARIO'｜'INVALID_INPUT'`，原因取 `missing_reason`→`reason_zh`→`reason`，数字全为 `null`，无 `arms`。**补充行** `status:'SUPPLEMENTARY_NOT_IN_CONCLUSION'`，`simulated:true`、`in_headline:false`；候选臂可整格缺项：`{missing:true, missing_reason, 数字:null}`（K2 规定 SPY／QQQ 合成行的 T3 臂缺项，不算压力不完整）。其他行的候选臂缺项算压力不完整，原版臂不得缺项。行角色同 Q0 FREEZE_2（STRESS／REFERENCE `BASELINE`／RISK_DIMENSION `RISK_*`／SUPPLEMENTARY） |
| `comparison` | `question`（或 `question_zh`）*；`candidate_label_zh`（缺则页面用 K2 正文的候选描述）；`baseline_result_id`（写了必须与 `identity` 一致）；`populations`*：`{S, B}`（也认 `comparison.S`／`comparison.B`，主总体也认 `comparison.D`），每个 `{n_aff*, blocks*（或 n_blocks）, mean_dR*, ci_95*:[lo,hi], ci_98_33*:[lo,hi], n_total, n_zero, mde}`；`g_vs_baseline`*：`{value*, ci_95*, ci_98_33*}`；`bonferroni`*：`{level}`，必须是 0.9833；`criteria`：`{G1,P1,P2,P3,P4:{met:boolean}, F1,F2,F3:{triggered:boolean}}`（也认裸 boolean；`F2` 可带 `which:'P2'｜'P4'`，`G1` 可带 `baseline_oos_trades`）；`secondary`：`{mean_dR_all_time_exits, n_time_exits, by_reason:[{reason,n,mean_dR}]}`；`per_trade` 要求不强制，页面不读 |
| `forward` | 数组（或 `{rows:[…]}`），也认 `comparison.forward`；顶层优先。每行 `{stream:'B'｜'S', file, line, file_sha256*（64 位）, text／text_zh, in_verdict*:false, …其他标量事实}`；`S_RUN_BLOCKED` 这类行照列。**任何一行 `in_verdict` 不是 `false` 都拒绝** |
| `oos_reuse` | 顶层布尔值*，**必须是 `true`**（K2 裁定 4），且 `verdict.reason_codes` 含 `OOS_REUSED_FOR_SELECTION`；`false` 或缺原因码都拒绝，不能把复测说成独立样本外 |
| `verdict` | `class`* = `CANDIDATE_COMPARISON_V1`；`state`* ∈ `SUPPORTED｜NOT_PASSED｜INSUFFICIENT`；`t3_state`* ∈ `PASS｜FAIL｜INSUFFICIENT`（对应 SUPPORTED／NOT_PASSED／INSUFFICIENT，不一致拒绝；`BLOCKED` 不出结论，拒绝）；`delta_star`* = 0.15、`delta_g`* = 0（冻结值）；`L_D`、`U_D`、`L_g`、`U_g`（98.33%；缺则取 `comparison` 里对应区间）；`reason_codes`*；`engine_approximation:{flag}`；`fail_label`（FAIL 的数据充分度说明）。G1／P1–P4／F1–F3 的真假可写在 `comparison.criteria`，也可写在 `verdict.criteria` 或 `verdict` 直下；各处都写时必须一致 |
| `diagnosis_items`、`half_kelly`、`formula_table` | 要求存在；页面不读 |
| `reproducibility` | 同 Q0：`command`、`runs[≥2]` 的 `sha256` 全同、`identical:true` |

## 3. 整文件失败关闭（拒绝导入）

不重算业务数字，只拒绝「标签越过算术证据」和「证据链断了」：

1. 封存：缺旁证、旁证与文件不符、缺顶层字段、未复现、`schema`／`result_kind`／K2 sha256 不符（`Q1_RESULT_*`、`Q1_K2_SHA_MISMATCH`、`Q1_RESULT_NOT_REPRODUCED`）。
2. 运行门：七道门任一缺失或不是 `PASSED`（`Q1_RUN_GATE_NOT_PASSED`）。
3. 基线链：`baseline_result_id` 必须是已存在的 Q0 基线锁（`Q1_BASELINE_LOCK_NOT_FOUND`），且是**当前**那一把（`Q1_BASELINE_NOT_CURRENT`）；写了基线文件 sha256 就须相符（`Q1_BASELINE_SHA256_MISMATCH`）；`arms.BASELINE.summary` 五项（期末资本、年化、最大回撤、最长水下期、是否恢复）逐项等于 Q0 的 `arms.D.summary`（`Q1_BASELINE_ARM_DIFFERS_FROM_Q0`——这是 `BASELINE_REPRO` 门在 QRP 侧的落地核对）。`identity` 与 `comparison` 的基线 id 不一致拒绝。
4. 结论：
   - `verdict.class`／`state`／`t3_state` 不自洽、`BLOCKED`、δ* 或 δ_g 或 Bonferroni 水平被改（`Q1_VERDICT_*`、`Q1_T3_STATE_MISMATCH`、`Q1_BLOCKED_HAS_NO_VERDICT`、`Q1_BONFERRONI_LEVEL_CHANGED`）；
   - `SUPPORTED` 须：G1、P1–P4 全成立，F1–F3 全未触发；`L_D > 0`、`L_g > 0`、`U_D ≥ δ*`；**`U_g > 0`（F3，违反则 `Q1_VERDICT_SUPPORTED_VIOLATES_F3`）**；主样本受影响交易 ≥ 30 笔且 ≥ 10 块；引擎不是近似；
   - `NOT_PASSED` 须有 F1（`U_D < δ*`）、F2（P1 成立而 P2 或 P4 不成立）或 F3（`U_g ≤ 0`）之一的证据；
   - `INSUFFICIENT` 随时允许（保守方向）；
   - 判据逐项缺失或各处不一致（`Q1_CRITERIA_INCOMPLETE`、`Q1_CRITERIA_DISAGREE`）。
5. 样本外复用（AC5）：`oos_reuse` 必须声明为 `true` 且带 `OOS_REUSED_FOR_SELECTION`（`Q1_OOS_REUSE_MUST_BE_DECLARED`、`Q1_OOS_REUSE_NOT_DECLARED`）。
6. 前向：缺 `forward`，或任何一行 `in_verdict` 不是 `false`（`Q1_FORWARD_ROWS_MISSING`、`Q1_FORWARD_IN_VERDICT`）。
7. 压力不完整时 `SUPPORTED` 不得盖住它：缺场景、无效输入或压力行候选臂缺项存在，而 `verdict.reason_codes` 不含 `STRESS_SCENARIO_MISSING`，拒绝（`Q1_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS`，同 Q0 FREEZE_2 G3）；模拟场景没标 `simulated:true` 拒绝。
8. 一题只锁一次（`COMPARISON_ALREADY_LOCKED`）；导入只由完成权威执行。

以上之外的缺项、字段无效，只让对应的一块写「尚未完成：<原因>」，其余块照常。

## 4. 页面（策略详情「研究与对比」一节，位于 Desk 研究问题之上）

七块，固定顺序：① 这个对比在问什么（问题、候选、主／次总体、样本外复测的标注）② 账户结果：原版与候选（加「候选 − 原版」一行）③ 受影响交易的改善（主 S、次 B；账户年化对数增长差；Bonferroni 说明）④ 判据逐条（G1、P1–P4、F1–F3，每条一句人话和成立／触发状态）⑤ 压力：两臂逐行对比（每行原版、候选、差；缺场景／无效输入／候选臂缺项照原因列出）⑥ 三态结论与采用条件 ⑦ 前向观察（标「前向，只报不判，不并入结论」）。

⑥ 永远把三行分开写在主内容里：
- 「优势结论：有支持证据／未通过／证据不足」；
- 压力有缺时「压力评价不完整：缺场景 K 个、无效输入 L 个［、候选臂缺项 M 个］（列出场景）」；
- 「采用条件：未满足（独立样本不足，等前向成熟）」——因为 `oos_reuse`；压力有缺时原因里再加「必要压力缺失，§6.7」，两条原因用分号并列。

没有对比结果时整节写「尚未完成：研究会话尚未交付封存的对比结果」；「待验证问题清单」里对应 Q1 的一条在有结论后写「已完成：<结论>（见研究与对比）」，没有时写「K2 已冻结，等研究会话交付封存的对比结果」，并链到本节。Q0 的回测结论卡不动。

## 5. 不做的事

- 不重算 P1–P4、F1–F3、区间、差值以外的任何业务数字；账户行的「候选 − 原版」和 P2 句子里的两个期末资本，是文件里已报数字的并排或相减，不是新判定。
- 不写生产参数、账本、HK；没有 HTTP 写入口；不用交易凭证。
- 采用任何改动都走 `US_CRYPTO_PAPER_FULL_RUN` 修订加 Owner 签字（K2 采用边界），不在 QRP。
