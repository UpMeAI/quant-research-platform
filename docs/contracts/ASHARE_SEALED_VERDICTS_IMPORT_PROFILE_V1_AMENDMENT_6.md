# A 股研究封存结论 · 导入规格 V1 · 修订 6（R-XM-1：个股本闲置现金停放，两题；G-MECH、G-CAUSAL 走门的裁定）

- **状态：** 随 QRP PR 交协调会话审阅，协调会话合并即采用。V1 正文与修订 1–5 一字不改。Production effect：`NONE`。
- **本修订做两件事：**
  1. 往登记表加两题；
  2. 给 G-MECH、G-CAUSAL 各加一条门的裁定路径，写法同 `trial_gates_ruling`。

依据：
- **K2：** `R_XM_1_ASHARE_IDLE_CASH_K2_V1.draft.480ec87f.md`（`480ec87f…`）。台账行的 k2_sha256 就是它，所以 K2 绑它。冻结页 FREEZE_1（`5794f7c3…`，k2_frozen_at 2026-11-17T15:42:02+08:00）另绑。
- **K2 附注：** NOTE_1（`4ecde74c…`，G-PARITY 记号）、NOTE_2（`900d38cc…`，实盘 T0 检查算入同一开盘的本卖出回笼，封顶），都按 sha256 绑定。
- **结果裁定：** 封存结果页 `c13e03fa…` 与 ★R1 裁定页 `28bf76ca…`（Owner「R1 选 b」）。作为同题另一封存文件（ALSO）绑定。
- **门的裁定页：** `R_XM_1_IMPORT_GATES_RULING_1.md`（`46861c5b…`；协调会话 ★IMP1 = (a)，2026-11-17T20:15:00+08:00 冻结；草稿 `09ecea27…` 只读保留）。G-TRIAL PRE、G-MECH、G-CAUSAL 三处偏差都出自这一页，按 sha256 绑定。

## 1. 加入登记表的两题

| entry_id | 读法 | 期望 → 结论 |
|---|---|---|
| `CN-RXM1-M` | `rows.RXM1_M.verdict` | `做` → 做（有支持，★R1 (b)） |
| `CN-RXM1-B` | `rows.RXM1_B.verdict` | `不做` → 不做 |

- **结果文件：** `R_XM_1_ASHARE_IDLE_CASH_RESULT_V1.json`（`1b277f27…`），放在协调会话目录。它是 Linux 封存 `rxm1/sealed-20261117` 里 `RXM1_RESULT.json` 的逐字节副本（SEAL_MANIFEST `63de15fa…`）。
- **运行日志：** `R_XM_1_ASHARE_IDLE_CASH_RESEARCH_RUN_LOG_V1.json`（`5f253bb3…`），同一封存里 `RUN_LOG.json` 的逐字节副本。
- **M 的读数：**
  - 配对 g +1.47 %/年，95 % [+1.35 %, +1.59 %]；
  - ΔMDD −4.46 个百分点；
  - T0 缺口 0。
- **M 的过拟合门读法（★R1 (b)）：**
  - 族方差 V 不用本题自己的行（RXM1_M、RXM1_M_LOWCOST、RXM1_B），只用 R8_X04 三行与 R21 两行：V 0.0165，N 50，T 76，DSR 1，证据门不降级。
  - 台账里的机械披露 OVD-95fd157215597f79（DSR 0.033）原样保留。读法出自绑定的 ★R1 裁定页。
- **B：** T0 缺口 34 次、53,415 元（K2 §5.5 的必要条件不满足）。NOTE_2 封顶读法下仍是 34 次，最宽读法下也有 31 次。
- **指数本：** 不出判定（K2 §6），不进登记表。

## 2. 五道门

K2 冻结在 RF1112（2026-11-15T22:47:42+08:00）、附录 1（2026-11-17T00:00:00+08:00）与 G-PARITY（2026-11-17T00:24）之后，五道门都过。

| 门 | 结果 | 依据 |
|---|---|---|
| G-TRIAL PRE | DEVIATION_ACCEPTED（`PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN`） | 12 行同一时刻登记，07:48:36.403Z，晚于冻结 07:42:02Z、早于首次计算 07:54:06.728Z。走现有的 `trial_gates_ruling` 路径。 |
| G-TRIAL SEAL | PASS | 12 行 RESULT；运行日志各行的 rule_config_hash 都已登记。门读本族本 K2 的最后一条披露，即 OVD-02f289abe66f0225，两题相同；M 自己的披露也在台账里。 |
| G-MECH | **DEVIATION_ACCEPTED**（`MECHANISM_PRIOR_TABLE_NOT_IN_K2`、`AI_ROLE_K2_LINE4_READ_AS_NONE`） | 见 §3.1 |
| G-CAUSAL | **DEVIATION_ACCEPTED**（`CAUSALITY_SCOPE_MISSING` → N/A: RISK_K_OR_ACCOUNT_LAYER） | 见 §3.2；A1 范围内，5 行在成本门内 |
| G-COST | PASS | CN_A 下限 2.5 + 10 bp |
| G-PARITY | PASS | NOTE_1 两个分序列记号，KG 1.17.0 `f4b24f41` |

## 3. 门的裁定路径（本修订新增）

### 3.1 G-MECH：`entry.mechanism_ruling = { spec, deviations[], line4_text? }`

- **能放行的偏差只有两种（`RULING_DEVIATIONS`）：**
  - `MECHANISM_PRIOR_TABLE_NOT_IN_K2`：先前结论表的 sha256 不在 K2 正文里。
    - 门要核实：K2 里确实没有这个 sha256；裁定页写出表的 sha256、登记表提交与 as_of。
    - 表的其余检查照旧：as_of 不晚于冻结；那一版登记表的提交与 sha256 一致；用那一版登记表加 as_of 之前的数据段标签重算，逐字节相同。
  - `AI_ROLE_K2_LINE4_READ_AS_NONE`：第 4 行以「无」开头、后面还有说明，读作「无」。
    - 门要核实：第 4 行逐字等于 `line4_text`；它不是单独的「无」；行内没有大写类别记号；entry.ai_inputs 为空。
    - 裁定页写出 `line4_text` 原文。其余 AI 输入检查照旧。
- **页的写法：** 页上要写出 `DEVIATION_ACCEPTED` 和每个偏差码。
- **错误码：**
  - 页上缺字 → `MECHANISM_RULING_TEXT_DOES_NOT_STATE`；
  - 事实不成立 → `MECHANISM_RULING_FACT_NOT_HOLD`；
  - 形状不对 → `MECHANISM_RULING_INVALID`。只认 `spec`、`deviations`、`line4_text` 三个键，多出或不认得的键（例如 `status`）一律拒绝（审阅 #119 FIX-1）；
  - 页的字节缺失 → `MECHANISM_RULING_FILE_MISSING`；
  - 不过门的题带裁定 → `MECHANISM_RULING_ON_UNGATED_ENTRY`。
- **锁行：** `mechanism_gate` 多出 `state: DEVIATION_ACCEPTED`、`deviations`、`line4_read_as`、`ruling_ref`、`ruling_sha256`。导入器把裁定页作为 `MECH_RULING` 绑定、复验并列进 refs。
- **R-XM-1 的表：** `R_XM_1_MECHANISM_PRIOR_TABLE_V1.json`（`04c4aec8…`），登记表提交 `c6e1dd4a…`（K2 冻结时的 QRP main），as_of = 冻结时刻，路由 NORMAL_NO_PRIOR。

### 3.2 G-CAUSAL：`entry.causality_ruling = { spec, scope_not_applicable: <§3.2 五类之一> }`

- **适用情形：** K2 既没写 `CF:` 也没写「G-CAUSAL N/A」（本来报 `CAUSALITY_SCOPE_MISSING`），由裁定页读作「G-CAUSAL N/A: <码>」。
- **门要核的：**
  - 页上写出 `DEVIATION_ACCEPTED`、`CAUSALITY_SCOPE_MISSING` 与「G-CAUSAL N/A: <码>」，缺一个 → `RULING_TEXT_DOES_NOT_STATE`；
  - K2 里确实两样都没写，否则 `RULING_FACT_NOT_HOLD`。K2 里出现任何形式的「G-CAUSAL N/A」（全角冒号、括号、小写、全角斜杠、换行），也算写了范围，同样 `RULING_FACT_NOT_HOLD`（审阅 #119 FIX-2）。不带反引号的「CF:」说明（例如 K2 头部的知道时刻说明）不算范围声明；
  - 不绑证据，否则 `SCOPE_CONFLICT`；
  - 附录 1 范围内只放过 `RISK_K_OR_ACCOUNT_LAYER`，否则 `SCOPE_FILL_NOT_EXEMPT`；
  - 不和函数偏差、滞后规则混写，否则 `RULING_INVALID`。
- **锁行：** 记 `DEVIATION_ACCEPTED`（不记 NOT_APPLICABLE，也不记 PASS），带 `not_applicable_code`、`deviation`、`ruling_sha256`，以及 A1 的 `fill_scope`。
- **R-XM-1 为什么是账户层：** 它只决定个股本闲置现金放在哪里，不改本的任何入场、出场、仓位或选股，没有信号、特征、打分或过滤函数。附录 1 §1：「不适用：风控层调 k、账户层」。

### 3.3 已有各题不变

- 没有登记 `mechanism_ruling` 或 `causality_ruling.scope_not_applicable` 的题，两道门的代码路径与返回值不变。
- 证据：用 4bfa1295 与本分支各跑一遍同一个只读脚本，读真实锁台账的副本，比较 60 道已有题目的以下内容：
  - 4 个策略的海外锁投影；
  - 15 把 A 股锁的现场复验（`verifiedVerdict`）；
  - 每题的 result_id、绑定文件清单，以及 G-MECH、G-CAUSAL 的范围判断。
  - 两次输出逐字节相同（sha256 `5351c86a…`），错误 0。
- 脚本与两份输出都在 `research-data/r_xm_1_v1/import/`。

## 4. 真导入

合并之后再做，先备份台账：
1. 在 QRP 工作区执行 `stage --ashare-v6-root … --artifacts-root … --out <证据目录>`；
2. 执行 `QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR import --evidence <证据目录> --registered-by V8_1_COORDINATOR`。

预期：
- 登记表 15 → 17 题；
- 新增两把锁 `ASV-CN-RXM1-M-1b277f278a28`、`ASV-CN-RXM1-B-1b277f278a28`。每把都带：
  - `trial_gates` pre DEVIATION_ACCEPTED / seal PASS；
  - `mechanism_gate` 与 `causality_gate` 的 DEVIATION_ACCEPTED；
  - `cost_gate`、`parity_gate` 的 PASS。
- 原有 15 把锁逐字节不变。
- 已在 Mac 上用协调会话目录的真实文件加真实台账的副本预演过：两把锁的五道门读数与上面相同，refs 共 12 个角色。
