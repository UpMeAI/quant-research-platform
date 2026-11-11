# 海外研究封存结论 · 导入规格 V1 · 修订 6（C17 成本与选择、US_CORE 账户级风险，两个单元）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。母规格与修订 1–5 原文不改；台账不改写，只追加新题。
本修订另加一个门的偏差码 `PRE_CONDITIONAL_ID_NOT_CHOSEN`（§2.1），依据协调会话 11-12 的裁定 `52f4c897…`。

## 1. 新增 2 题

| entry_id | 策略 | 结果 sha256（前 12 位） | 提交 | 期望结论 |
|---|---|---|---|---|
| C17-COSTSEL | C17_V2 | `39d2fd67e631` | `35f5f7d7` | 不做 |
| UC-ACCTRISK | US_CORE | `a16163c1eabe` | `cef860e5` | 不做 |

**C17-COSTSEL 绑定的文件**（全部按 sha256 钉住）：
- 结果 `docs/evidence/c17-cost-sel-v1/C17_COST_SELECTION_RESULT_V1.json`（smartflow `research/c17-cost-sel-run`）；
- K2 `C17_COST_SELECTION_K2_V1.draft.md`（`e15902b9…`）；
- 冻结 `C17_COST_SELECTION_K2_V1_FREEZE_1.md`（`085317e0…`，11-11 23:33:43 CST）；
- 运行日志 `RESEARCH_RUN_LOG_V1.json`（同一提交，`983aef77…`）。

**UC-ACCTRISK 绑定的文件**：
- 结果 `docs/evidence/uc-acct-risk-v1/US_CORE_ACCOUNT_RISK_RESULT_V1.json`（smartflow `research/us-core-acct-risk-run`）；
- K2 `US_CORE_ACCOUNT_RISK_K2_V1.draft.md`（`2104095f…`）；
- 冻结 `US_CORE_ACCOUNT_RISK_K2_V1_FREEZE_1.md`（`c10fb687…`，11-11 23:54:13 CST）；
- 运行日志 `RESEARCH_RUN_LOG_V1.json`（同一提交，`ed788544…`）。

**读法**：
- C17-COSTSEL：结论读 `decision`，证据强度读 `evidence_strength_short_zh`，允许用途读 `allowed_use_zh`，正文读 `first_paragraph_zh`。
- UC-ACCTRISK：结论读 `verdict.decision`，证据强度读 `verdict.evidence`，允许用途与正文同上。

**note_zh**（协调会话 11-12 指定的两条读法）：
- C17：被挡的那类入场在历史上是赢家，实盘那 21 笔的亏损在历史上不成立。
- US_CORE：用每年约 1.5 个百分点换回撤略浅，不划算；深回撤来自凯利上限之前。

两题都是「不做」，生产不变。

## 2. 两道门

- **G-TRIAL-PRE 记 `DEVIATION_ACCEPTED`，原因码只有新码 `PRE_CONDITIONAL_ID_NOT_CHOSEN`。** 依据协调会话 11-12 的门的裁定 `C17_COSTSEL_US_CORE_ACCT_RISK_TRIAL_GATES_RULING_20261112.md`（sha256 `52f4c897c3878a35a6a89729653b6548572bce4cec3a20fe3819a764175d50f6`，一页管两题）。
  - 实际要跑的行都在冻结前预登记，k2_sha256 等于 K2：C17 5 行，11-11 23:33:07 CST；US_CORE 5 行，23:53:47 CST。
  - 两份 K2 §2 还写了只在没选的 ★ 下才登记的条件 id，它们没有登记，原来的 PRE 会按 `PRE_NOT_REGISTERED` 拒绝。裁定逐个列出：

    | 题 | 台账 id | 标签 | ★ |
    |---|---|---|---|
    | C17-COSTSEL | `TRL-b42e30d24f319f9c` | CCS_B_N4 | ★3 (b) |
    | C17-COSTSEL | `TRL-7c6664a0db2a14fd` | CCS_T_N4 | ★3 (b) |
    | C17-COSTSEL | `TRL-5553ab546ff539ca` | CCS_T_NM | ★5 (b) |
    | UC-ACCTRISK | `TRL-01598f92e7d4339b` | UCR_V | ★1 (c) |

  - 两份冻结页对这些 ★ 都选了 (a)：C17 `★1–★5 → (a)`，US_CORE `★1 → (a)` … `★5 → (a)`。
- **G-TRIAL-SEAL 照查**：
  - 每题 5 行都有结果（台账 trials 429 → 439）；
  - 运行日志各 5 条，没有未登记的计算；
  - 披露行存在：`OVD-3552418f115ebae4`（C17）、`OVD-8c06fad9355c4b51`（US_CORE）。
- **披露行的 DSR 是数值读法**：UNKNOWN，族里带 ŜR 的试验太少，算不出方差，工具按 Bonferroni 兜底。它不是 `NOT_APPLICABLE`，所以裁定不放行披露（不设 `disclosure_not_applicable`）。
  - PBO 是工具的默认读法 `NOT_APPLICABLE`（没有矩阵、配置数 < 4），门只对 DSR 的「不适用」要求裁定。
  - 两题的原判定都没有被降级。

### 2.1 新码 `PRE_CONDITIONAL_ID_NOT_CHOSEN`（`services/trial-ledger/gates.js`）

- **登记表写法**：`trial_gates_ruling.pre` 带 `codes: ['PRE_CONDITIONAL_ID_NOT_CHOSEN']` 和 `conditional_ids: [{ trial_id, star, option }]`。
  - 有这个码就必须有非空列表，有列表就必须有这个码。
  - `trial_id` 是单个台账 id，`star` 是正整数，`option` 是一个小写字母，id 不重复。
  - 不合格即拒绝：`RULING_CONDITIONAL_IDS_INVALID`。
- **裁定原文**：除修订 4 已有的 `DEVIATION_ACCEPTED` 和原因码之外，还要逐字写出每个条件 id 和它的「★n (x)」，否则拒绝 `RULING_TEXT_DOES_NOT_STATE`。
- **只放行列出的 id，并机器核实两条事实**，任一不成立即拒绝 `RULING_FACT_NOT_HOLD`：
  1. 台账 trials 里这个 id 没有任何行（不论 row_kind）。披露行只能指向已登记的判定臂，所以不另查。
  2. 冻结页（按 sha256 复验后读）对这个 ★ 选的不是这个选项。读法：
     - 「★n → (x)」与「★a–★b → (x)」两种写法；
     - 冻结页没有裁这个 ★，或者同一个 ★ 读出两个不同选项，都按不成立处理。
- **附加核实**：条件 id 必须写在 K2 里。
- **其余 PRE 检查照旧**：
  - K2 里其它每个 id 都要是 PREREGISTERED、k2_sha256 相同、不晚于冻结；
  - 本族同一 K2 的预登记行都要写在 K2 里；
  - 最后一次登记时刻要等于裁定写的 `preregistered_at`。
  - K2 里没被裁定列出的未登记 id 照旧按 `PRE_NOT_REGISTERED` 拒绝。
- **锁上记**：
  - `trial_gates.pre = DEVIATION_ACCEPTED`；
  - `pre_deviation.conditional_ids` 逐个记 id、★、选项；
  - `ruling_ref` / `ruling_sha256` 指向这一页。
- **今后的 K2**：§2 只写实际要跑的行，备选 ★ 不再给台账 id（协调会话冻结时核对），所以这个码只给这一页裁定的两题用。

## 3. 真导入（合并之后）

1. **stage**：`import_overseas_verdicts.js stage --smartflow-root <smartflow> --artifacts-root <artifacts/coordinator> --out var/evidence/overseas-verdicts-2026-11-12-ccs-ucr`
2. **import**：先在台账副本上试（`QRP_DATA_DIR`），再导入真实台账。

预期：
- 追加 2 条锁 `OSV-C17-COSTSEL-39d2fd67e631`、`OSV-UC-ACCTRISK-a16163c1eabe`，原有 39 条是幂等重放，原有行逐字节不变；
- 两条锁都是 `pre: DEVIATION_ACCEPTED`（`PRE_CONDITIONAL_ID_NOT_CHOSEN`，C17 3 个、US_CORE 1 个条件 id）、`seal: PASS`；
- desk 回程打开时 sealedVerdicts 48 条，通过 desk schema。
