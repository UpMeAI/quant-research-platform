# 海外研究封存结论 · 导入规格 V1 · 修订 4（凯利 m 前推七个单元；门的裁定）

状态：随 QRP PR 交协调会话审阅，协调会话合并即采用。

依据：
- 协调会话的门裁定 `artifacts/coordinator/KELLY_M_WFO_K2_V1_TRIAL_GATES_RULING_20261111.md`（sha256 `99203316…`）；
- 冻结页 `KELLY_M_WFO_K2_V1_FREEZE_1.md`（`57be5478…`）；
- 研究框架修订（过拟合控制）§2.4 的 G-TRIAL-PRE 与 G-TRIAL-SEAL（`services/trial-ledger/gates.js`）。

母规格与修订 1–3 原文不改。台账不改写，只追加新题。

## 1. 新增 7 题

全部绑定同一组文件，按 sha256 钉住：

| 角色 | 文件 | sha256 |
|---|---|---|
| 结果 | smartflow `b0abc9c8`：`docs/evidence/kelly-m-wfo/KELLY_M_WFO_RESULT_V1.json` | `e51343a3…` |
| K2 | 协调会话目录 `KELLY_M_WFO_K2_V1.draft.md` | `41fc1499…` |
| 冻结 | 协调会话目录 `KELLY_M_WFO_K2_V1_FREEZE_1.md` | `57be5478…` |
| 运行日志 | smartflow `7e6783e0`：`RESEARCH_RUN_LOG_V1.json` | `8aa32f11…` |
| 门的裁定 | 协调会话目录（见上） | `99203316…` |

K2 于 2026-11-11 08:57 CST 冻结（`k2_frozen_at`），因此这 7 题都要过两道门。

| entry_id | 策略 | 对象 | 期望结论 | 回程 verdictState |
|---|---|---|---|---|
| US5-KWFO | US_V5 | O1 单本上限 | 不做 | 通过（无 F1、无 F2） |
| UC-KWFO | US_CORE | O2 单本上限 | 做 | 证据不足（参数不稳）（读自文件） |
| C17-KWFO | C17_V2 | O3 单本上限 | 不做 | 通过（无 F1、无 F2） |
| QS-KWFO | QUICK_SHOT_V3 | O4 单本上限 | 不做 | 通过（无 F1、无 F2） |
| US5-KWFO-BUCKET | US_V5 | O5 海外桶联合线（US_V5 为自由项） | 不做 | 通过（无 F1、无 F2） |
| C17-KWFO-PAIR / QS-KWFO-PAIR | C17_V2 / QUICK_SHOT_V3 | O6 加密两本联合线 | 不做 / 不做 | 通过（无 F1；F2 不适用） |

- 结论读自文件 `verdicts[i].verdict`，证据强度读 `verdicts[i].evidence`。
- O2 的收紧候选 0.415、协调裁定（暂不起草修订）和两条不利事实写在 `note_zh` 里，与结果文档的协调裁定节（smartflow `78e73fa8`）一致。
- 「做」≠ 生产采用。

## 2. 门的裁定（`entry.trial_gates_ruling`）

裁定页按 sha256 绑定：锁的 `refs` 多一行 `RULING`，锁的 `trial_gates` 写明 `ruling_ref` 和 `ruling_sha256`。裁定页原文必须写出它放行的状态和每个原因码，否则拒绝（`RULING_TEXT_DOES_NOT_STATE`）。

**G-TRIAL-PRE**：门的状态记 `DEVIATION_ACCEPTED`，不记 PASS，也不记「不适用」。原因码只许下面两个（`DEVIATION_CODES`），每个都要在台账里核实为真，否则拒绝（`RULING_FACT_NOT_HOLD`）：

| 原因码 | 必须成立的事实 |
|---|---|
| `PRE_NO_TRIAL_ID_IN_K2` | K2 原文确实没有写出台账 id |
| `PRE_REGISTERED_AFTER_FREEZE_BEFORE_FIRST_RUN` | 至少一行登记晚于冻结；本族每个预登记行都不晚于裁定写的首次计算时刻（否则 `PRE_REGISTERED_AFTER_FIRST_RUN`） |

另外三条也要相符：
- 本族最后一行的登记时刻等于裁定写的预登记时刻；
- 运行日志写了 `first_run_at` 时，它等于裁定写的首次计算时刻；
- 每行仍须是 PREREGISTERED，`k2_sha256` 等于这份 K2。

锁的 `pre_deviation` 写出原因码和三个时刻：冻结 08:57 CST、预登记 09:23:18 CST、首次计算 09:31:33 CST。

**G-TRIAL-SEAL**：照查不变。
- 每个预登记行都有结果；
- 运行日志里没有未登记的计算；
- 本族有 OVERFIT_DISCLOSURE_V1；
- 原有的 sha256 和期望结论校验全部照旧。

新增一条：披露行的 DSR 是 `NOT_APPLICABLE` 时，题必须带裁定，而且披露行引用的就是这一页（`SEAL_DISCLOSURE_NOT_APPLICABLE_WITHOUT_RULING` / `SEAL_DISCLOSURE_RULING_MISMATCH`）。

没有裁定的题行为不变。修订前冻结的题若带了裁定，拒绝（`RULING_ON_UNGATED_ENTRY`）。

## 3. 披露行：`trial_ledger.js disclose-na`

`discloseNotApplicable` 每族写一条 OVERFIT_DISCLOSURE_V1，按裁定 §2：
- **必须引用的文件**：一页按 sha256 绑定的裁定，并写出理由；冻结页可选。
- **只放行两个字段**：`dsr`、`pbo` 写 `NOT_APPLICABLE`（`NOT_APPLICABLE_FIELDS`）。
- **其余字段照 `disclose` 的算法**：
  - N（原始计数、是否下限）、本题新增配置数、段标签照算；
  - 只能由收益序列算出的 N̂、V、SR0、ŜR、γ3、γ4、T、PSR(0) 写 `UNKNOWN`，原因 `NO_RETURN_SERIES_DSR_NOT_APPLICABLE`；
  - 证据闸门照 `overfitColumn` 走，「做 · 有支持证据」照样降为「证据不足」。

本题四族的输入在 smartflow `3cf61fd0` 的 `docs/evidence/kelly-m-wfo/lane/DISCLOSE_NA_<族>.json`。在台账副本上的读数：

| 族 | N | 本题新增配置数 | 段标签 |
|---|---|---|---|
| US_V5 | 30（下限） | 4 | SEEN |
| US_CORE | 17（下限） | 6 | SEEN |
| C17_V2 | 24（下限） | 6 | SEEN |
| QS_V3 | 14（下限） | 6 | SEEN |

## 4. 回程 `state_zh`

desk 回程的 verdictState 必填。本题结果文件对「通过」的对象不写状态字（证据强度为 null），登记表用 `state_zh` 补上，用词取冻结 K2 §5 判定表的原词。

`services/desk-review-routing/sealed.js` 只在文件里既没有登记的 state、没有带限定语的结论、也没有证据强度时才用它。登记表也没写时，照旧拒绝（`RETURN_SEALED_STATE_MISSING`）。

## 5. 真导入（合并之后，按顺序）

1. **写披露行**：在真实台账上执行四次，用完成权威，每族一次：
   `trial_ledger.js disclose-na --spec <DISCLOSE_NA_<族>.json> --registered-by <完成权威>`
2. **stage**：`import_overseas_verdicts.js stage --smartflow-root <smartflow> --artifacts-root <artifacts/coordinator> --out var/evidence/overseas-verdicts-2026-11-11-kwfo`
3. **import**：先在台账副本上试（`QRP_DATA_DIR`），再导入真实台账（协调会话）。

预期（副本上已验证）：
- 追加 7 条锁，原有 31 条是幂等重放，原有行逐字节不变；
- 7 条锁都是 `pre: DEVIATION_ACCEPTED`、`seal: PASS`；
- desk 回程打开时 sealedVerdicts 45 条，其中 7 条是本题，通过 desk schema。
