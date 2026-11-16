# COST_MODEL_GATE_V1 · G-COST 成本门（导入）

- 依据：研究框架修订 2026-11-12 · 附录 1 §2（A2），**未冻结**。
  - 草稿：`artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_ADDENDUM_1_FILL_COST.draft.md`；
  - 冻结页：`artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_ADDENDUM_1_FREEZE_1.md`。
- 起因：`adapters/us-replay-core` 声明 `REPLAY_CORE_COSTS_NONE(CLOSE_MARK…)`，成本拆分写明佣金、滑点 `NOT_MODELLED_CLOSE_MARK`，「收益是毛收益」。此前导入器从没拦过用它判出的「做 / 不做」。
- 冻结页绑定（§2.5）：`services/research-framework-amendment-20261112-addendum-1` 写冻结页 `FREEZE`（path + sha256 + state，以及它冻结的草稿修订 1 的 sha256）和 `EFFECTIVE_FROM`，做法同 `services/research-framework-amendment-20261112`。`services/cost-gate` 从那里读，自己不写常量；A1 以后读同一个常量。
  - 已绑定（2026-11-16T22:07:39+08:00 冻结，`state = FREEZE_1`）：冻结页 sha256 `a33294818b799f67c5d0c23008d0434735e9e0ce7516d8028816e7c307de43c1`，冻结的草稿修订 1 sha256 `d64e88afa4fb5a5206d6beceaa073362d5e4dcc0d4835393bfffee2607d5aee0`。`tests/cost_gate.test.js` 在协调会话目录存在时按文件重算两处 sha256。
  - 冻结页没绑定（`PENDING_FREEZE`）时，在范围内的题一律拒绝（`COST_MODEL_FREEZE_UNBOUND`），不在范围内的不受影响。
  - `EFFECTIVE_FROM = 2026-11-17T00:00:00+08:00`：冻结页写定（冻结在此刻之前完成）。
- 性质：只改研究导入，不改交易、风控、账户规则，不改生产。门只会拒绝导入（失败即关），从不改写结论，也不会因此判「不做」。没有裁定放行的路径。
- 位置：海外与 A 股封存结论导入器共用的 `checkEntry`，一处调用，在原有校验、G-TRIAL、G-MECH、G-CAUSAL 之后运行。过门的题锁里多一个 `cost_gate` 块；不过门的不加字段，现有锁逐字节不变。

## 1. 哪些题过门

| 题 | 过门 |
|---|---|
| `kind = RESULT`，`k2_frozen_at ≥ EFFECTIVE_FROM` | 是 |
| `kind = RESULT`，`k2_frozen_at` 早于生效时刻 | 否（`FROZEN_BEFORE_EFFECTIVE`） |
| 没写 `k2_frozen_at`，`sealed_on` 早于生效日（CST） | 否（`SEALED_BEFORE_EFFECTIVE`） |
| 没写 `k2_frozen_at`，`sealed_on` 在生效日及以后 | 拒绝（`COST_MODEL_K2_FROZEN_AT_MISSING`） |
| `READING`（只报）、`STATUS`、`DRAFT` | 否 |

## 2. 读哪里：运行日志的每一行

依据是 `entry.run_log`（`RESEARCH_RUN_LOG_V1`，按 sha256 绑定）。结果文件与登记表都没有成本模型或读数种类字段；运行日志原有的行字段（`kind`、`reading`、`object`、`seed` 等）也不是判定读数的种类，所以新增 `verdict_metric_kind`。本族（`family_id = strategy_ref`）的每一行：

```json
{ "family_id": "…", "config_label": "T", "trial_id": "TRL-<16 位>", "rule_config_hash": "<64 位>",
  "verdict_metric_kind": "NET_RETURN_SERIES",
  "cost_model_ref": "REPLAY_CORE_PROFILE_COSTS",
  "cost_breakdown": { "model": "<目录外模型 id>", "commission_bps": 2.5, "slippage_bps": 10 } }
```

- `trial_id`：必填。试验台账里本族、本 K2 的预登记行给出**角色、阶段和市场**；运行行写了 `role`、`stage`、`rule_config_hash` 的必须一致，运行行不能改标签。
- `verdict_metric_kind`：必填，取值 `NET_RETURN_SERIES`、`NET_PNL_SERIES`（收益类），或 `IC`、`RANK_IC`、`HIT_RATE`、`EVENT_STUDY`（信号类）。
- `cost_model_ref`：门内的行必填；其余行可写可不写，门不看。
- `cost_breakdown`：只在 `cost_model_ref` 不在适配器目录里时用。单边 bps，两项都必须是非负数字。

## 3. 三类行（§2.2、§2.3）

| 类 | 台账登记行 | 读数种类 | 成本 |
|---|---|---|---|
| 门内 | 角色 ∈ `VERDICT_ARM`、`BASELINE`、`WFO_FOLD`、`STRESS`，**且**阶段 ∈ `BOOK`、`ABLATION`、`WFO`、`FORWARD` | 只能是收益类 | 必须计成本（§4） |
| 只看信号 | 角色 `SIGNAL_TEST`，**或**阶段 `SIGNAL` | 只能是信号类；报收益类 → `COST_MODEL_SIGNAL_RETURN_CLAIM` | 不查 |
| 其余 | `REPORT_ONLY_VARIANT`、`DIAGNOSTIC_ARM`、`REPRO`、`NULL_DRAW`、`UNCOUNTED_HISTORY`（门内角色在 `SIGNAL` 阶段归「只看信号」） | 只能是收益类 | 不查（可以用毛收益模型） |

- 收益类之外的读数出现在门内或「其余」行 → `COST_MODEL_METRIC_KIND_MISMATCH`；取值不在上表 → `COST_MODEL_METRIC_KIND_INVALID`。
- 一题本族一行都没有 → `COST_MODEL_NO_RUNS`。门内没有行：全是只看信号的 → 通过，`state: SIGNAL_ONLY`；否则 → `COST_MODEL_NO_VERDICT_RUN`。
- 角色与阶段两张表写在 `services/cost-gate`（`IN_SCOPE_ROLES`、`IN_SCOPE_STAGES`），加载时核对它们都是试验台账认得的值。冻结页如有改动，以冻结页为准。

## 4. 门内的行怎样算「计成本」

- **目录里的模型**（`adapters/us-replay-core`、`adapters/crypto-replay-core` 的 `manifest.cost_model_version` 与 `cost_breakdown()`）：按适配器的拆分判。佣金（`commission`，没有时取 `fees`）与滑点都写了、都不是 `NOT_MODELLED*` 才算计成本；`REPLAY_CORE_COSTS_NONE` 一律算毛收益。不计成本 → `COST_MODEL_GROSS_VERDICT`。行里另写的拆分不算。
- **目录外的模型**（V6/Q0、smartflow、Python 车道的引擎，§2.4）：行里必须自报 `cost_breakdown`。
  - 没有 → `COST_MODEL_UNKNOWN`；`model` 与 id 不一致 → `COST_MODEL_BREAKDOWN_MODEL_MISMATCH`；
  - `commission_bps`、`slippage_bps` 不是非负数字 → `COST_MODEL_BREAKDOWN_NOT_NUMERIC`；
  - 登记行的市场没有下限 → `COST_MODEL_NO_FLOOR`；低于下限 → `COST_MODEL_BELOW_FLOOR`。

### 4.1 下限表（单边 bps；协调会话 11-16 认可的默认值，冻结时确认或改动，每项一行）

| 市场（登记行 `market`） | 佣金下限 | 滑点下限 | 合计下限 | 来源 |
|---|---|---|---|---|
| `CRYPTO`（`CRYPTO`、`CRYPTO_*`） | 2 | 2 | — | smartflow `4d9558e5`（replay core 钉版）：`agent/v5-agent-config.js`（`d9460528…`）`MAKER_FEE_PCT 0.0002`，目录模型最便宜的一档，更严的备选是 `TAKER_FEE_PCT 0.0004` = 4；`scripts/lib/replay-core-adapters/c17.js`（`45e9ce0e…`）`slipTiers` 最低一档 0.0002 |
| `US`（`US`、`US_*`） | 0 | 0 | 5 | QRP `4e7bab82`：`docs/evidence/CYCLE_RESEARCH_DESK_US_V5_M1_NATIVE_DIAGNOSTIC_2026-10-24.json`（`8429553d…`），`US_V5_M1_RESEARCH_COST_V1` 的 `strategy_bps_each_side 5`。来源只给合计，不拆佣金和滑点，所以按 `commission_bps + slippage_bps ≥ 5` 比 |
| `CN_A`（`CN`、`CN_A`、`CN_A_*`） | 2.5 | 10 | — | Ashare-V6 `513e00c1`：`config/v6/research/index_sleeve_v5.json`（`aa4a430c…`）`commissionBps 2.5`、`slippageBps 10`；个股簿 `stock_book_paper_v4.json`（`c65f5b95…`）为 2.6 / 10。印花税不计入下限。`config/paper-execution-policy.v1-under-review.json` 的成本全为 null，不作来源 |

其他市场（例如 `HK`）没有下限：目录外引擎的门内行一律 `COST_MODEL_NO_FLOOR`。

## 5. 要写新字段的运行日志生产者

`k2_frozen_at ≥ EFFECTIVE_FROM` 的 RESULT，运行日志每行要写 `trial_id`、`verdict_metric_kind`，门内的行还要写 `cost_model_ref`，目录外的引擎再写 `cost_breakdown`：

- V6 / Q0 执行器（A 股研究，目录外，按 CN_A 下限）；
- smartflow 的回放导出（replay core 两个目录模型写 `cost_model_ref` 即可；自己的研究脚本按 CRYPTO / US 下限自报）；
- Python 车道（目录外，按市场下限自报）。

## 6. 错误码（前缀 `COST_MODEL_`）

`FREEZE_UNBOUND`、`EFFECTIVE_FROM_INVALID`、`K2_FROZEN_AT_INVALID`、`K2_FROZEN_AT_MISSING`、`RUN_LOG_MISSING`、`RUN_LOG_NOT_JSON`、`RUN_LOG_INVALID`、`RUN_LOG_K2_MISMATCH`、`RUN_LOG_ROW_INVALID`、`NO_RUNS`、`NO_VERDICT_RUN`、`RUN_TRIAL_ID_MISSING`、`TRIAL_NOT_REGISTERED`、`ROLE_MISMATCH`、`RUN_TRIAL_MISMATCH`、`METRIC_KIND_INVALID`、`METRIC_KIND_MISMATCH`、`SIGNAL_RETURN_CLAIM`、`REF_MISSING`、`REF_INVALID`、`UNKNOWN`、`BREAKDOWN_MODEL_MISMATCH`、`BREAKDOWN_NOT_NUMERIC`、`NO_FLOOR`、`BELOW_FLOOR`、`GROSS_VERDICT`、`CATALOGUE_INVALID`。

## 7. 锁里记什么

```json
"cost_gate": { "applies": true, "state": "PASS | SIGNAL_ONLY", "effective_from": "…", "k2_frozen_at": "…",
  "freeze": { "path": "…", "sha256": "…", "state": "FREEZE_1" },
  "cost_gated_runs": 2, "signal_only_runs": 1, "other_runs": 1,
  "cost_models": [{ "model_id": "REPLAY_CORE_PROFILE_COSTS", "source": "adapters/crypto-replay-core" },
                  { "model_id": "…", "source": "RUN_LOG_ROW", "floor_market": "CN_A", "commission_bps": 2.5, "slippage_bps": 10 }] }
```
