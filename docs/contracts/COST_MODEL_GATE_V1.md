# COST_MODEL_GATE_V1 · G-COST 成本门（导入）

- 起因：`adapters/us-replay-core` 声明 `cost_model_version: REPLAY_CORE_COSTS_NONE(CLOSE_MARK…)`，成本拆分写明佣金、滑点 `NOT_MODELLED_CLOSE_MARK`，「收益是毛收益，不得按已计成本解读」。此前没有一道门挡住用这种回放判出的结论以「做 / 不做」导入。
- 生效：`EFFECTIVE_FROM = 2026-11-17T00:00:00+08:00`，只写在 `services/cost-gate`。**这是假设值，等协调会话确认**。此刻及之后冻结的 K2 过门，此前已冻结的不追溯：现行海外与 A 股登记表没有一题过门，已有的锁行逐字节不变。
- 性质：只改研究导入，不改交易、风控、账户规则，不改生产。门只会拒绝导入（失败即关，错误码 `COST_MODEL_*`），从不改写结论，也不会因此判「不做」。没有裁定放行的路径。
- 位置：海外与 A 股封存结论导入器共用的 `checkEntry`，在原有校验、G-TRIAL、G-MECH、G-CAUSAL 之后运行。过门的题锁里多一个 `cost_gate` 块；不过门的不加字段。

## 1. 范围

| 题 | 过门 |
|---|---|
| `kind = RESULT`，`k2_frozen_at ≥ EFFECTIVE_FROM` | 是 |
| `kind = RESULT`，`k2_frozen_at` 早于生效时刻 | 否（`FROZEN_BEFORE_EFFECTIVE`） |
| 没写 `k2_frozen_at`，`sealed_on` 早于生效日（CST） | 否（`SEALED_BEFORE_EFFECTIVE`） |
| 没写 `k2_frozen_at`，`sealed_on` 在生效日及以后 | 拒绝（`COST_MODEL_K2_FROZEN_AT_MISSING`） |
| `READING`（只报）、`STATUS`、`DRAFT` | 否（不出「做 / 不做」） |

## 2. 读哪里：运行日志的每一行

依据是 `entry.run_log`（`RESEARCH_RUN_LOG_V1`，按 sha256 绑定，由执行会话随结果一并封存）。它是唯一逐行记下「哪一次运算、哪个试验、用哪个成本模型」的文件；结果文件与登记表都没有成本模型字段。本族（`family_id = strategy_ref`）的每一行必须写：

```json
{ "family_id": "…", "config_label": "T", "trial_id": "TRL-<16 位>", "rule_config_hash": "<64 位>",
  "cost_model_ref": "REPLAY_CORE_PROFILE_COSTS",
  "cost_breakdown": { "model": "…", "components": { "commission": …, "slippage": … } } }
```

- `trial_id`：在试验台账里有本族、本 K2 的登记行。**角色取登记行**（K2 冻结前预登记的那一行）；运行日志写了 `role`、`rule_config_hash` 的，必须与登记行一致。
- `cost_model_ref`：模型 id 取「(」之前的部分。
  - 是适配器声明过的成本模型（目录 `CATALOGUE`：`adapters/us-replay-core`、`adapters/crypto-replay-core` 的 `manifest.cost_model_version` 与 `cost_breakdown()`）→ 按适配器的拆分判，行里另写的拆分不算；
  - 不是 → 这一行必须自带 `cost_breakdown.components`（`model` 写了的话要与 id 一致），按同一条规则判；两样都没有 → `COST_MODEL_UNKNOWN`。

## 3. 规则

- **计成本**：佣金（`commission`，没有时取 `fees`）与滑点（`slippage`）两项都写了，且都不是 `NOT_MODELLED*`。`REPLAY_CORE_COSTS_NONE` 无论拆分怎么写都算毛收益。
- **判定用的运行**：试验台账里除 `REPORT_ONLY_VARIANT`、`DIAGNOSTIC_ARM`、`REPRO` 之外的所有角色（`VERDICT_ARM`、`BASELINE`、`WFO_FOLD`、`STRESS`、`SIGNAL_TEST`、`NULL_DRAW` 等）。它们必须计成本，否则 `COST_MODEL_GROSS_VERDICT`（拆分缺项是 `COST_MODEL_BREAKDOWN_INCOMPLETE`）。
- **只报、诊断、复现**可以用毛收益模型，但模型也要判得出（写 `cost_model_ref`，适配器目录之外的要自带拆分），计成本与否记进锁。
- 本族至少一行判定用的运行，否则 `COST_MODEL_NO_VERDICT_RUN`。

## 4. 错误码

`RUN_LOG_MISSING`、`RUN_LOG_NOT_JSON`、`RUN_LOG_INVALID`、`RUN_LOG_K2_MISMATCH`、`RUN_LOG_ROW_INVALID`、`RUN_TRIAL_ID_MISSING`、`REF_MISSING`、`REF_INVALID`、`TRIAL_NOT_REGISTERED`、`ROLE_MISMATCH`、`RUN_TRIAL_MISMATCH`、`UNKNOWN`、`BREAKDOWN_MODEL_MISMATCH`、`BREAKDOWN_INCOMPLETE`、`GROSS_VERDICT`、`NO_VERDICT_RUN`、`K2_FROZEN_AT_INVALID`、`K2_FROZEN_AT_MISSING`、`EFFECTIVE_FROM_INVALID`、`CATALOGUE_INVALID`，前缀都是 `COST_MODEL_`。

## 5. 锁里记什么

```json
"cost_gate": { "applies": true, "state": "PASS", "effective_from": "…", "k2_frozen_at": "…",
  "verdict_runs": 2, "other_runs": 1, "gross_other_runs": 1,
  "cost_models": [{ "model_id": "…", "source": "adapters/crypto-replay-core | RUN_LOG_ROW", "counts_costs": true, "verdict_bearing": true }] }
```

## 6. 待协调会话确认

1. 生效时刻 `2026-11-17T00:00:00+08:00`（假设值）。
2. 判定用角色的范围：本合同把 `BASELINE`、`WFO_FOLD` 等也算判定用（凯利前推题的结论出自 `WFO_FOLD` 行，没有 `VERDICT_ARM`）；只放开只报、诊断、复现三类。
3. 适配器目录之外的研究引擎（例如各市场仓库自己的回放）用运行日志行自带的拆分声明成本；不另设平台侧的引擎目录。
