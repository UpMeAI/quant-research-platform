# 候选对比导入规格 V2 · 附录 3：Q5 登记项、原版臂来源（`baseline_arm_ref`）、参照行与采用建议核对表

状态：**提议，随 PR 合并；协调会话合并即冻结。** 研究会话起草，2026-10-26。

上游：
- Q5 研究规格 `docs/contracts/US_V5_M2_Q5_T3_ON_A25_COMBINATION_K2_V1.md`（sha256 `30d743264e2e93257e16384e0b2432d8688ed591521a85cd76cad7a0c423f457`），裁定 ★1–★4 (a)。本附录不改动它。
- 导入规格 V2、附录 1、附录 2：封存、复现、基线链、压力行形状、三行分写、配对 g 判定、敞口附加行、只报行。本附录全部沿用。
- UX 修订 6：采用决定记录由协调会话另写；本附录只核对结果文件里的建议与预先冻结的规则一致。

实现：
- `services/candidate-comparison/questions/q5.js`：登记项、冷却计数（两臂）、建议核对表的校验与卡片；
- `services/candidate-comparison/index.js`：`checkBaselineArmRef`；
- `common.js` 的 `baseKeysOf` / `baseLabelOf`，以及 `paired_g.js` 的 `changedKeyOf`。没有 `baseline_arm` 和 `g1_changed_key` 的登记项读法与之前相同，Q1–Q4 不变；
- `report_only.js` 可读别的顶层键（`doc_key`），每行的 g 字段（`g_key`）可配置，成熟交易可缺（`n_optional`）；Q4 的读法不变；
- 配置与页面：
  - `config/strategy_profiles.v1.json` 把本附录列进 US_V5 的 `comparison_import_profile_ids`，计划队列加 Q5（在 Q1、Q4 之后）；
  - `config/strategy_detail_notes.v1.json` 的研究队列加 Q5（第二轮，带自己的来源）；
  - 页面认出参照行卡片的列名与建议核对表卡片。

## 1. 登记项

| 项 | 值 |
|---|---|
| 题目 | `Q5`，队列顺序 5，结果类别 `CANDIDATE_COMPARISON_V1` |
| schema | `US_V5_M2_Q5_RESULT_V1`；`result_kind` = `CHALLENGER_VS_BASELINE` |
| K2 | 上述路径与 sha256 |
| 原版臂 | 键 `BASELINE_A25`，名字「原版（D+A25：冷却只在开仓时武装）」，来源见第 2 节 |
| 候选臂键 | `CANDIDATE_T3_ON_A25` |
| 运行门 | 以下 8 个，都必须 `PASSED`：`ACCEPTANCE`、`INPUTS`、`ENGINE_FILES_UNCHANGED`、`COMPOSE_KEYS`、`PARITY_T3_OFF`、`PARITY_A25_OFF`、`BASELINE_REPRO_D`、`NOCD_T3_REPRO` |
| 判据集与常数 | G1 / P_G / F3；δ_g = 0、δ_R = 0.10；95% 区间，单一比较；98.33% 区间只报不判（★2 (a)）；G1 先判 |
| G1 的「改变」 | `criteria.G1.changed_total` = 改变的入场 + 改变的出场（★1 (a)）；`SUPPORTED` 要求两臂成熟交易各 ≥ 30 且 `changed_total` ≥ 30；`changed_entries`、`changed_exits`、`deferred_trades` 照报 |
| 样本外 | `oos_reuse` 必须是 `true`；`verdict.reason_codes` 必须含 `OOS_REUSED_FOR_SELECTION`；`oos_reuse_detail` 必须有文字 |
| 归因 | 不要求 |
| 敞口 | 要求。两臂都要有 `cooldown_blocked_signals {open_scan, other}` 和 `arms_not_set {gate_refusal {…}, other_no_open {…}}`，因为两臂都是 A25；形状坏了就拒绝（`Q5_EXPOSURE_DISCLOSURE_INVALID`） |
| 顶层字段 | 同 V2，另加 `reference_rows`；`recommendation` 不在必填之列（见第 4 节） |

## 2. 原版臂来源（`baseline_arm_ref` 读法）

导入规格 V2 要求原版臂逐项等于 Q0 的 `arms.D`。Q5 的原版是 Q4 的候选臂，所以登记项写 `baseline_arm.ref = {question_ref: 'Q4', arm: 'CANDIDATE_COOLDOWN_ON_OPEN'}`。导入器按以下顺序核对：

1. **Q0 锁照旧核对。** `baseline_result_id` 必须是现有的、当前的 Q0 锁，文件未漂移。D 的基线锁不变。
2. **引用的形状。** `identity.baseline_arm_ref` 必须是 `{result_id, arm, sha256}`，其中 `arm` 等于登记项的臂名；否则 `Q5_BASELINE_ARM_REF_MISSING`。
3. **所引的锁存在。** `result_id` 必须是同一 case 里 Q4 的锁，否则 `Q5_BASELINE_ARM_REF_LOCK_NOT_FOUND`。
4. **sha256 相符。** `sha256` 必须等于那份锁记录的文件 sha256，否则 `Q5_BASELINE_ARM_REF_SHA256_MISMATCH`。
5. **是当前的锁。** 它必须是 Q4 当前的锁，否则 `Q5_BASELINE_ARM_REF_NOT_CURRENT`。
6. **同一个基线。** 那份锁引用的 Q0 基线必须与本文件相同，否则 `Q5_BASELINE_ARM_REF_BASELINE_DIFFERS`。
7. **所引文件可读、未漂移。** 读那份封存文件（sha256 旁证照查）。读不了为 `Q5_BASELINE_ARM_REF_FILE_UNREADABLE`，漂移了为 `Q5_BASELINE_ARM_REF_FILE_DRIFTED`。
8. **摘要逐项相同。** 原版臂的摘要（期末资本、CAGR、最大回撤、最长水下期、是否恢复）与所引那一臂逐项相同（相对误差 1e-9），否则 `Q5_BASELINE_ARM_DIFFERS_FROM_REF`。

## 3. 参照行（`reference_rows`）

一个数组，必须包含这三行（键名固定）：

| 键 | 内容 | g 字段 |
|---|---|---|
| `REF_D` | 原版 D（Q0 的 D 臂） | `g_vs_baseline`（对 D+A25） |
| `REF_D_T3` | D+T3（Q1 的候选臂） | `g_vs_baseline`（对 D+A25） |
| `COMBINED_VS_D` | 组合 D+A25+T3 对原版 D | `g_vs_reference`（对 D）；没有成熟交易数 |

- **每行：** `in_verdict` 必须是 `false`。
- **拒绝条件：** 少一行为 `Q5_REFERENCE_ROW_MISSING`；`in_verdict` 不是 `false` 为 `Q5_REFERENCE_ROW_IN_VERDICT`；缺整个数组为 `Q5_RESULT_TOP_LEVEL_MISSING`。
- **改变的笔数：** 取 `changed_vs_baseline.total`，组合行取 `changed_vs_reference.total`。
- **其余数字读不出来：** 只让这张卡写「尚未完成」。
- **显示：** 页面单独一张卡，标「只报不判」。g 一栏的列名说明前两行对 D+A25、组合行对 D。

## 4. 采用建议核对表（`recommendation`，K2 ★3 (a)）

- **结论是证据不足时**（`INSUFFICIENT`），必须有 `recommendation`：
  - `checks` 含第 1–6 项，第 1–4 项写 `yes: true | false`；第 5、6 项是反证（`counter: true`），只列出；
  - `recommendation` 是 `ADOPT` 还是 `NOT_ADOPTED`，必须与第 1–4 项一致：全「是」→ `ADOPT`，任一「否」→ `NOT_ADOPTED`。
  - 拒绝条件：缺块为 `Q5_RECOMMENDATION_MISSING`，项不全为 `Q5_RECOMMENDATION_CHECKS_INCOMPLETE`，与核对不一致为 `Q5_RECOMMENDATION_INCONSISTENT`。
- **结论不是证据不足时**，不许带建议（`Q5_RECOMMENDATION_NOT_ALLOWED`）。这时采用按结论本身走：
  - 有支持证据 → 采用路径，T3 走签字；
  - 未通过 → 不采用。
- **页面：** 主卡之后一张卡，「待 Owner 决定（建议采用 / 建议不采用）」，列出六项与市场经验分析。决定本身由协调会话按 UX 修订 6 写 `RESEARCH_ADOPTION_DECISION_V1` 或 `RECOMMENDATION` 记录；导入器不替 Owner 决定。

## 5. 不做的事

- 不重算任何业务数字。差值、核对结果都取文件里的数，只核对一致性。
- 不写生产参数、账本或 HK。A25 已采用，不受本题影响。T3 是否采用由 Owner 决定。
