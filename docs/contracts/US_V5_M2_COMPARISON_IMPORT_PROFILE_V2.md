# US_V5_M2 候选对比结果 · QRP 导入规格 V2（按题目登记，含 Q2 登记项）

状态：**提议，随 PR 合并；协调会话合并即冻结。** 实现者起草，2026-10-25。
上游：Q2 研究规格 `docs/contracts/US_V5_M2_Q2_SIGNAL_VS_LEVERAGE_K2_V1.md`（sha256 `660237c8823a5961c70ca78c8685343adb34ff2b35f192146d630a508f45ff6a`，裁定 4–6）；
Q1 导入规格 `docs/contracts/US_V5_M2_Q1_RESULT_V1_IMPORT_PROFILE.md`（已冻结，本文不改动它，也不改 Q1 的任何行为）；
Q0 导入规格加 FREEZE_1／FREEZE_2（封存、不重算、压力行形状、三行分写规则，本文沿用）。
实现：`services/candidate-comparison/registry.js`（登记）、`questions/q1.js`、`questions/q2.js`（登记项）、`common.js`（与题目无关的读法）、`index.js`（引擎）；
测试：`tests/comparison_registry.test.js`、`tests/_q2_fixture.js`（合成数字，只用于测试）。

Q1 导入规格把一道题的东西写死了：K2 sha256、候选臂键、判据集、必填常数、样本外必须复用、没有归因块。
V2 把这些放进**按题目 id 登记的登记项**；导入器与页面只读登记项。以后的题目（Q3、Q4）= 加一个登记项，随冻结的导入规格一起合并。

## 1. 登记项里有什么

| 字段 | 含义 |
|---|---|
| `question_ref`、`code_prefix`、`schema` | 题目 id（Q1、Q2…）；错误码前缀（`<题目>_…`）；结果文件 `identity.schema`，导入器按它找登记项 |
| `k2` | `{ref, sha256}`：冻结的 K2 文件路径与 sha256。结果文件 `identity.k2.sha256`（或 `k2_sha256`）必须等于它 |
| `profile_ref` | 本题适用的导入规格文件，写进结果锁 |
| `candidate` | 候选臂键与别名（`arms.<键>`、压力行 `arms.<键>`），页面上的名字 |
| `run_gates` | K2 点名的运行门；带结论的文件里必须全在且 `state:'PASSED'` |
| `criteria` | 判据集：每条的种类（`met`／`triggered`）和标题 |
| `constants` | 必填冻结常数，被改拒绝 |
| `checkVerdict` | 标签不能越过算术证据的规则（SUPPORTED／NOT_PASSED 各需要什么） |
| `mirror` | 判定的镜像状态（Q1 的 `t3_state`）；没有就不要求 |
| `oos_reuse` | 样本外期望：`expected`（true／false）、原因码 `OOS_REUSED_FOR_SELECTION` 的规则、是否必须写 `oos_reuse_detail`、采用条件里的话 |
| `attribution`、`exposure` | 是否必须有归因块（Q2a）、两臂敞口披露 |
| `top_level` | 必须出现的顶层字段 |
| `blocks`、`builders`、`edge_labels` | 页面卡片的块和顺序；块的构造器；三态的人话（Q2 的 SUPPORTED 与别处不同） |

**登记项的 `k2.sha256` 必须等于仓库里那份冻结 K2 文件的实际 sha256**（测试逐条核对），所以登记项不能悄悄指向别的文件。

## 2. Q1 的登记项（不变）

内容与 Q1 导入规格逐项相同：候选臂 `CANDIDATE_T3`（别名 `T3`）；判据 G1、P1–P4、F1–F3；必填常数 δ\* 0.15、δ_g 0、`comparison.bonferroni.level` 0.9833；`oos_reuse` 必须为 `true` 且 `verdict.reason_codes` 含 `OOS_REUSED_FOR_SELECTION`；`t3_state` 镜像；七道运行门（含孪生门）；没有归因块；七块页面。
**验证**：用仓库里封存的真实 Q1 文件（`var/evidence/us-v5-m2-q1-2026-10-25/`）与真实 Q0 基线在临时台账里重新导入，`result_id` 仍是 `Q1-52d8296ffb10626b`，锁字段集合相同，页面投影与改造前导出的金标（`tests/golden/q1_real_projection.json`）逐字段相同（改造后只多了 `title_zh`），卡片 HTML 与改造前逐字节相同。

## 3. Q2 的登记项（出自 Q2 K2 裁定 4–6）

- **身份**：`identity.schema = US_V5_M2_Q2_RESULT_V1`，`result_kind = CHALLENGER_VS_BASELINE`，`identity.k2.sha256 = 660237c8…`，`baseline_result_id`（同 Q1，必须是当前的 Q0 锁，原版臂逐项等于 Q0 的 `arms.D`）。`result_id = Q2-<文件 sha256 前 16 位>`。
- **候选臂** `CANDIDATE_1X`（别名 `1X`）：`arms.CANDIDATE_1X` 与每个压力行的 `arms.CANDIDATE_1X`。
- **运行门**（八道，缺或不是 PASSED 都拒绝）：`ACCEPTANCE`、`INPUTS`、`BASELINE_REPRO`、`INERT_Q0F`、`INERT_Q1`、`ROUTING_CENSUS`、`ATTRIBUTION_RECONCILE`、`PROBE`。Q1 的孪生门（`INERT_TWINS`、`TWIN_PARITY`）不要求。
- **判定只按配对 g**（单变体，95% 区间，**没有 Bonferroni**；`comparison.bonferroni` 有也不当判据）：
  - `verdict.class = CANDIDATE_COMPARISON_V1`；`state ∈ SUPPORTED｜NOT_PASSED｜INSUFFICIENT`；没有 `t3_state`（镜像状态只有 Q1 有，锁里写 `null`）；
  - 冻结常数：`verdict.delta_g = 0`、`verdict.delta_R = 0.10`（被改拒绝，`Q2_VERDICT_DELTA_CHANGED`）；
  - 区间两端 `verdict.L_g`、`verdict.U_g`（缺则取 `comparison.g_vs_baseline.ci_95`）；
  - **SUPPORTED** 须：`criteria` 里 G1 成立、P_G 成立、F3 未触发；`L_g > 0`；`U_g > 0`；`criteria.G1` 里写明 `baseline_oos_trades`、`candidate_oos_trades`、`changed_entries` 且都 ≥ 30；引擎不是近似；
  - **NOT_PASSED** 须：G1 成立（G1 不成立时一律证据不足，K2 三态）、`U_g ≤ 0`、F3 触发；
  - **INSUFFICIENT** 随时允许；
  - 次指标（候选臂自身的每笔净 R 对 +0.10 R，及配对 ΔR 的描述）**不参与判定**，只在页面报告并标出相对 +0.10 R 的位置。
- **判据集**（`comparison.criteria`，也认 `verdict.criteria`／`verdict` 直下，各处都写时必须一致）：`G1:{met, baseline_oos_trades, candidate_oos_trades, changed_entries}`、`P_G:{met}`、`F3:{triggered}`。缺任何一条或各处不一致拒绝。
- **样本外**：顶层 `oos_reuse` 必须是 **`false`**（`Q2_OOS_REUSE_MUST_BE_FALSE`）；`verdict.reason_codes` **不得**含 `OOS_REUSED_FOR_SELECTION`（`Q2_OOS_REUSE_CONTRADICTS_CODE`）；顶层 `oos_reuse_detail` 必须写理由（字符串，或带中文字符串的对象，建议 `{reason_zh, other_studies_zh}`；`Q2_OOS_REUSE_DETAIL_MISSING`）。没有样本外复用，采用条件里就没有「独立样本不足」。
- **前向**：`forward` 为空数组（或 `{rows:[], reason_zh}`），原因写在 `forward.reason_zh` 或顶层 `forward_reason_zh`（页面显示）；任何一行 `in_verdict` 不是 `false` 仍拒绝。
- **敞口披露（必填，两臂都要）**：`comparison.exposure = {BASELINE:{…}, CANDIDATE_1X:{…}}`（也认 `verdict.exposure` 或各臂自己的 `arms.<臂>.exposure`），每臂：`avg_notional_usd`（≥ 0）、`time_in_market_ratio`（0–1）、`notional_cap_rejections`、`notional_cap_reductions`（非负整数），可加 `avg_actual_risk_usd`。缺或不合规拒绝（`Q2_EXPOSURE_DISCLOSURE_MISSING`／`_INVALID`）。
- **归因块 `attribution`（Q2a，必填）**：
  - `oos` 与 `is` 两段，每段：`window:[起,止]`；`by_class`：每类一行 `{class, label_zh?, n_trades, usd:{<栏>:数}, r:{<栏>:数}}`；`total:{n_trades, usd:{<栏>:数}, r:{…}}`；`reconcile:{account_pnl, sum_components, residual, reg_daily_rounding}`；可加 `per_trade`（不读）。
  - 栏（`<栏>`）是 `total.usd` 的键，各行必须带全；某类不适用的栏写 `null`（例如单股 2× 没有母序列拆分），加总时不计，**不写 0**。K2 的栏：母序列信号、杠杆与路径、单股 2×（不可分）、费用（含在成交价里的 5 bps／边）、监管费（逐笔未进位）；`attribution.columns:[{key,label_zh}]` 可给中文名。
  - **对账（拒绝条件，对应 `ATTRIBUTION_RECONCILE` 门）**：每栏各类相加 = `total`（1e-6）；`sum_components = Σ total.usd + reg_daily_rounding`；`residual = account_pnl − sum_components` 且 `|residual| ≤ 1e-6`（`Q2_ATTRIBUTION_DOES_NOT_RECONCILE`、`Q2_ATTRIBUTION_RESIDUAL_NONZERO`）。
  - **监管费按日进位差是自己的一行**（`reconcile.reg_daily_rounding`），不能混进任何一栏（栏名像「日进位」的拒绝：`Q2_ATTRIBUTION_DAILY_ROUNDING_NOT_SEPARATE`）。
  - **对的是原版臂的净盈亏**：`oos.reconcile.account_pnl` 必须等于 `arms.BASELINE` 的期末资本减权益序列起点（容差 1e-3 USD，因臂 summary 只存 4 位小数）；对到候选臂的净盈亏拒绝（`Q2_ATTRIBUTION_NOT_BASELINE_PNL`）。`is` 段没有对应的臂，只核内部对账。
  - 其余（`fill_limits`：拒绝逐条、削减逐笔；`definitions_zh`）页面显示，不进对账。
- **其他同 Q1**：封存与 sha256、复现、`stress.rows` 的形状与 `diff` 自洽、模拟场景标 `simulated`、压力有缺时 SUPPORTED 必须带 `STRESS_SCENARIO_MISSING`、前向不并入、基线链。
- **页面**：每个已锁定的题目一张卡，按队列顺序（Q1、Q2）。Q2 九块：问题 → 账户结果 → 账户对数增长与每笔净 R（g 的 95% 区间；次指标对 +0.10 R；被改换载体的入场与路由、单股 2× 的处理）→ 敞口变化披露（两臂）→ 判据逐条（G1、P_G、F3）→ 压力两臂逐行 → Q2a 归因表（原版 OOS 账本；R 折算、开发期、各栏定义在折叠里）→ 三态结论 → 前向（写明为什么为空）。
  - **SUPPORTED 的人话**：「完整账户的对数增长更好（不等于信号 alpha 更大）」，用在顶部的结论、第 6 行文字和待验证清单的状态里；三行文字照旧分开写（优势结论／压力评价不完整／采用条件）。

## 4. 导入

`QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_candidate_comparison.js --file <绝对路径> --registered-by V8_1_COORDINATOR [--question Q2]`：题目按文件的 `identity.schema` 判断；`--question` 与文件不符拒绝（`Q1_RESULT_SCHEMA_UNSUPPORTED` 一类），未登记的题目拒绝（`COMPARISON_QUESTION_NOT_REGISTERED`）。
同一题已有锁时拒绝，改锁须 `--supersedes <当前 result_id> --defect-ref --reason`；Q1 与 Q2 的锁互相独立。

## 5. 不做的事

- 不重算任何业务数字：归因的对账、g 的区间、敞口、次指标都是文件里已报的数字；页面上的「候选 − 原版」是两个已报数字的并排或相减。
- 不改 Q1 的任何行为，不改已冻结的 Q1 导入规格；不写生产参数、账本、HK；没有 HTTP 写入口。
- 采用任何改动都走 `US_CRYPTO_PAPER_FULL_RUN` 修订加 Owner 签字；载体偏好是 AMENDMENT_4／6／15 的已签内容，改它属于交易规则签字类。
