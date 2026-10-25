# US_V5_M2_Q0_RESULT_V1 · QRP 导入规格 · 冻结说明 2

状态：**随协调会话合并冻结**（2026-10-25）。起草：QRP 工程实施者；冻结人：V8.1 协调会话（合并本文件即冻结）。
冻结对象：`docs/contracts/US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE.md`，sha256 `23689c99a532f341f56cfe7bc8fd9147e835d62533ae45c90f03d151f35413eb`；
冻结说明 1 `US_V5_M2_Q0_RESULT_V1_IMPORT_PROFILE_FREEZE_1.md`，sha256 `b1700f37e2819e2096cf5cab49d3b0a8b1bbcf16a8b3457ffab0d10722b19073`。两份文件原样不改。
上游：M2 计划 V1、修订 1（M1.4 / M1.5）、修订 2（M2.1 / M2.4）；UX 修订 3；V8.1 §11 AC8。

本说明补充三点；与前两份冲突时以本说明为准。实现与测试：`services/baseline-evaluation`、`tests/baseline_evaluation.test.js`、`tests/research_web_render.test.js`。

## G1. 人读文字的语言：有中文变体就用中文变体

- 压力行的缺场景／无效输入原因：先取 `missing_reason`（冻结说明 1 F1 的字段），再取 `reason_zh`，最后取 `reason`。
  原因文本自己已带「缺场景：」或「无效输入：」前缀时，页面去掉这个前缀再写（页面格式是「<类别>：<原因>」）。
- 同一规则用于其余人读文字：`<字段>_zh` 非空就用它，否则用 `<字段>`。覆盖压力行的 `label`、`stress.conclusion`、诊断清单的 `facts`（`facts_zh` 是字符串数组）和 `no_topic_reason`。
- 页面不翻译英文。文件里的英文留英文，由研究会话产出中文。
- `stress.conclusion` 本身是中文时，页面直接把它写成「压力结论」；是英文时，页面写固定的中文句子（压力评价不完整：缺场景 K 个、无效输入 L 个…），英文原文折叠在「研究会话的原文」里。

## G2. 「最大损失」主数字的范围

压力表里的行分四种角色，按场景 id 和状态识别：

| 角色 | 识别 | 进「最大损失」 | 计入「已执行的压力场景」 |
|---|---|---|---|
| 压力场景（§5.2 在当前 D 上跑的：费用、滑点、扫描相位、区间重放、极端下跌） | 其余所有行 | **是**（已执行、非模拟、有数字、`in_headline` 不是 `false`） | 是 |
| 当前 D 参照 | `scenario = BASELINE` | 否 | 否，单列 |
| 风控维度（Q4 的输入，只报不判） | `scenario` 以 `RISK_` 开头 | 否 | 否，单列 |
| 补充情景 | `status = SUPPLEMENTARY_NOT_IN_CONCLUSION`（须 `simulated: true` 且 `in_headline: false`） | 否 | 否，按模拟计 |

- 缺场景（`MISSING_SCENARIO` 或 `missing: true`）、无效输入（`INVALID_INPUT`）、模拟行同样不进主数字。
- 所有行都留在表里，页面计数行写明：已执行 N 个压力场景，模拟或补充 M 个，缺场景 K 个，无效输入 L 个；另有当前 D 参照 B 行、风控维度 R 行（只报不判，不进最大损失）。
- 主数字取上述压力场景里 `max_loss_usd` 最大的一行并写明场景；没有这样的行写「尚无」。并列取文件里靠前的一行。
- 对已导入的 `Q0-24fb86c3609f7ef3` 不改变数值：US$1,084，场景 `SCAN_PHASE_PLUS_60MIN`。

## G3. AC8 机械检查：缺场景为不足

导入器拒绝这样的文件：`verdict.state = SUPPORTED`，同时有**压力场景角色**（G2）的行是缺场景或无效输入。错误码 `Q0_VERDICT_SUPPORTED_WITH_INCOMPLETE_STRESS`，后面列出场景 id。

- 参照行、风控维度行、补充行缺失或无效，不触发这条检查。
- `INSUFFICIENT`、`NOT_PASSED` 不受影响；有缺场景行的 `INSUFFICIENT` 照常导入，页面写「压力评价不完整」。
- 这条检查与冻结说明 1 之前的整文件失败关闭条件并列（导入规格第 3 节），不改变其中任何一条。
