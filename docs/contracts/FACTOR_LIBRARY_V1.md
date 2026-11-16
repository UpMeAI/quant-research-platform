# 因子库 · FACTOR_LIBRARY_V1（P0）

- 依据：研究框架修订 2026-11-16「因子库、AI 自动挖掘、赛马与样本外模拟盘验证」，**Owner 2026-11-16 23:50 CST 签字**（「签研究修订（默认）」）。
  - 签字页 `RESEARCH_FRAMEWORK_AMENDMENT_20261116_SIGNATURE_1.md`（sha256 `39f8c17c…`）；
  - 签字文本：修订 4 `RESEARCH_FRAMEWORK_AMENDMENT_20261116_FACTOR_LIBRARY_AI_MINING.signed.fd22876f.md`（sha256 `fd22876f…`），§2、§3.6、§8；
  - `EFFECTIVE_FROM = 2026-11-16T23:50:00+08:00`。
  - 协调会话目录的文件，不在 git 里，按 path + sha256 绑定（`contract_ref`），做法同 QRP #92。P0（#95）绑的是草稿 ddeb2eea，签字后改绑到这里。
- 状态：已签字。挖掘仍未开：P1 合并、★e 门槛、`MINING_SPACE_V1` 和留出段日期冻结之前，任何挖掘都不跑（遗传规划也不跑）。本库没有 DSL、没有生成方、没有任何模型接口调用。
- 代码：
  - `services/factor-library/index.js`：结构校验、构建、源文件核对；
  - `services/factor-library/legacy.js`：旧规则因子补登记的数据（改这里，不改 JSON）；
  - `services/factor-library/build.js`：唯一写出口；
  - `services/factor-library/correlation.js`：相关性与去重的纯函数；
  - `services/mining-gate/index.js`：G-MINE 九项骨架；
  - `services/research-mechanism-register/index.js` 的 `isRegistered`：因子挂机制的引用检查。
- 测试：`tests/factor_library.test.js`、`tests/factor_library_dedupe.test.js`、`tests/mining_gate.test.js`，全部是合成夹具或钉版源文件的只读 `git show`。
- production_effect: NONE。不读行情，不写生产，不接任何导入器。

## 1. 文件与生产者

`config/research_factor_library.v1.json` 只有一个生产者，做法同主表「一个生产者」：

```
node services/factor-library/build.js            # 核对：文件字节 = build() 输出，且每条绑定 MATCH
node services/factor-library/build.js --write    # 全部绑定 MATCH 才写
```

测试核对提交的字节等于 `build()` 的输出，手改会让测试失败。源文件只用 `git show <commit>:<path>` 读，不 checkout；兄弟仓位置取 `QRP_V6_ROOT` / `QRP_SMARTFLOW_ROOT`，否则取 QRP 仓的同级目录 `Ashare-V6`、`smartflow`。兄弟仓或钉版提交不在本机时，源文件核对的测试跳过（标「非通过」），`--write` 拒写。

顶层字段：`schema`、`contract_ref`、`producer`、`registered_at`、`registered_by`、`sources[]`（钉版提交）、`dedupe`（去重门槛）、`factors[]`、`not_registered[]`、`production_effect`。

## 2. 每个因子（`FACTOR_LIBRARY_ENTRY_V1`，草稿 §2.2）

| 字段 | 规则 |
|---|---|
| `factor_id` | `<市场>[_<子池>].<类标>.<名>`，例如 `CN_A.MOM.RS60_MARKET_PCT`；不重复 |
| `market` / `universe` | `CN_A` / `US_EQUITY`；股票池写 `{id, version, definition_zh}` |
| `layer` | 只开 `SELECTION_CROSS_SECTION` |
| `class` / `class_reason_zh` | `VALUE`、`QUALITY`、`MOMENTUM`、`LOW_VOL`、`LIQUIDITY`、`SENTIMENT`、`VOLUME_PRICE`、`OTHER`；`OTHER` 必须写理由，其余写 `null` |
| `definition_zh` | 源文件定义的算式，一行 |
| `formula` | P0 只收代码引用 `CF:<repo>:<path>#<entry>`。其余文本都当作 DSL，留给 P1（`MINING_SPACE_V1`），P0 一律拒绝：`FACTOR_LIBRARY_FORMULA_DSL_RESERVED` |
| `inputs[]` | 读数，写成 `<命名空间>:<名>`（如 `V6_FEATURE:relative_strength_60`）。登记读数表在 P1，P0 只查写法 |
| `pit_available_at` | 何时可得，必填 |
| `horizon` | `{trading_days, state, note_zh}`：`DEFINED` 时为正整数；源文件没定义时 `trading_days = null`、`state = NOT_DEFINED_BY_SOURCE`，不填 0 |
| `economic_logic_zh` | 必填，一行 |
| `origin` / `mining` | `LEGACY_RULE`、`HUMAN`、`AI_MINED_LLM`、`AI_MINED_GP`；挖出的写 `mining{round_id, candidate_id}`，其余写 `null` |
| `status` | `LIVE_IN_RULE`、`RESEARCH`、`CANDIDATE`、`RETIRED`。`LIVE_IN_RULE` = 钉版提交上有在用的规则记录读它（V6 记录多为 `APPROVED_FOR_SHADOW`，模拟簿，不动真实资金）；只有补登记的旧规则因子能是 `LIVE_IN_RULE`，新因子上线照旧走 K2、封存、签字 |
| `mechanism_id` | 可选；写了就必须在机制登记表里（`FACTOR_LIBRARY_MECHANISM_UNKNOWN`） |
| `rule_ref` | 源规则记录的 key、version、authority_state、生效区间 |
| `weight_in_rule` / `composite` | 合成分写 `composite.components[]{factor_id, rule_component, weight}`；分量写 `weight_in_rule`，两边必须一致 |
| `correlation` | `NOT_COMPUTED`（写理由）或 `COMPUTED`（参考样本段、代码 sha256、与库内因子的 `pairs[]`） |
| `dedupe` | 去重决定；旧规则因子只能是 `LEGACY_BASELINE` |
| `evidence` | `{state, refs[]}`；旧规则因子只能是 `NOT_REJUDGED` |
| `source` / `code_refs[]` | 绑定：`{repo, commit(40 位), path, sha256, role, entry, extract[]}`。`extract` 写从源文件读到的值：`JSON_POINTER`（指针处的值，深相等）或 `TEXT`（逐字包含的算式）。旧规则因子必须有 `source` |
| `unverified[]` | 读不到或没核实的事实 `{field, reason_zh}`，不猜 |

## 3. 旧规则因子补登记（草稿 §2.4）

钉版：Ashare-V6 `83ab3af1`（origin/main）、smartflow `3b25fb61`（origin/main）。逐条的 sha256 与 extract 写在 JSON 里，测试逐条核对。

- ③ 复合分（`stock_book_five_stage_v4.json`，`55b818a1…`）：六个分量各一条，加合成分一条（`CN_A.COMPOSITE.STOCK_BOOK_V4`）。
- 主线排序 v7（`mainline_ranking_v7.json`，`69a9471a…`）：四个行业单元特征各一条，加合成分一条。`leaderQuantile` 是 `industry_leader_rs20` 的分位参数，`maxMissingShare` 是覆盖守卫，都不是读数，记在 `not_registered[]`。
- 核心池排序键（`core_pool_stock_momentum_transform_v2.json`）：`relative_strength_20`。消费者 `CORE_POOL_SELECTION` 已退役（2026-10-08 起不是 Paper 输入，`research-configuration.js`），登记为 `RETIRED`。
- 分析师上调信号（`analyst_revision_aggregation_v2.json`）。
- 行业 ETF 短名单排序键（`index_sector_selection_v3.json`，窗口在 `etf_realized_momentum_transform_v1.json`）。
- 美股 A23 行业相对强度（`us-v5-sector-rs.js`，S17 记录 `production-parameter-versions.json`），挂 `SEL.SECTOR_RS.RANK`。

## 4. 相关性与去重（草稿 §2.3，`correlation.js`）

- 截面值相关：每期两边都有值的证券（≥ 5 只）算 Spearman（平均秩），取各期均值；一期都没有 → `UNKNOWN`。
- 因子收益：每期收益对因子截面 z 分的 OLS 斜率；两条序列按日期对齐取 Pearson（≥ 12 期）。
- 去重读两者 |ρ| 的较大者，任一读不到即 `UNKNOWN`（`CORRELATION_UNKNOWN`，不判去留）。
- |ρ| > 0.7（严格大于）算冲突。0.7 标 `PENDING_FREEZE`（草稿「冻结时写定」）。
  - `KEEP_ONE`：挖掘段 ICIR 比每个冲突的已有因子都高才留新的；打平、读不到 ICIR，都留已有的；
  - `ORTHOGONALISE`：对冲突的已有因子做截面正交化（候选 z 分对已有因子 z 分加截距 OLS，取残差），算一次新尝试（`new_attempt`、`counts_toward_n`）。
- 去重决定只是研究读数，从不改任何规则；改生产照旧走 K2。

## 5. G-MINE 骨架（草稿 §4，`services/mining-gate`）

九项各一个函数，作用于一个候选结果对象；`evaluate()` 依次跑完，全过时 `eligible_status = RESEARCH`。门只拒绝，不改写输入对象的任何字段（包括 `status` 与结论），失败即关，错误码 `MINE_*`。P0 不接任何导入器。

| # | 项 | 门槛来源 | 错误码 |
|---|---|---|---|
| 1 | DSR ≥ `DSR_MIN`，`n_trials` = 本族累计尝试数（调用方给 `familyTrialCount`） | `services/trial-ledger/overfit.js` | `MINE_DSR_BELOW_MIN` / `_UNKNOWN` / `_N_NOT_CUMULATIVE` / `_N_UNKNOWN` |
| 2 | PBO ≤ `PBO_MAX`，`pbo_scope = ROUND_CANDIDATE_SET` | 同上 | `MINE_PBO_ABOVE_MAX` / `_UNKNOWN` / `_SCOPE` |
| 3 | 留出段 IC ≥ 0.02、ICIR ≥ 0.3（不重叠持有期） | ★e | `MINE_IC_BELOW_MIN` / `MINE_ICIR_BELOW_MIN` / `MINE_ICIR_OVERLAPPING` |
| 4 | 五组 Spearman ≥ 0.9（门自己算） | ★e | `MINE_MONOTONICITY_BELOW_MIN` / `_INPUT` |
| 5 | 持有期加倍的 IC ≥ 0.5 × 原 IC | ★e | `MINE_DECAY_BELOW_HALF` / `_BASE_NOT_POSITIVE` |
| 6 | 只做多前 20%、相对等权股票池；成本 ≥ G-COST `FLOORS`（CN_A 2.5 + 10 bps，卖出印花税）；年化超额 > 0 | `services/cost-gate` | `MINE_NET_COST_BELOW_FLOOR` / `_EXCESS_NOT_POSITIVE` / `_SCOPE` |
| 7 | 对现有账本（库里同市场 `LIVE_IN_RULE`）：净信息比提高 > 0，或截距 t ≥ 2 | ★e | `MINE_MARGINAL_NOT_POSITIVE` / `_BOOK_MISMATCH` |
| 8 | 覆盖库内同市场每个因子；|ρ| ≤ 0.7，或冲突的都已正交化且计入 N | 因子库 `DEDUPE` | `MINE_CORRELATION_ABOVE_MAX` / `_LIBRARY_INCOMPLETE` / `_UNKNOWN` / `_ORTHOGONALISED_NOT_COUNTED` |
| 9 | 机制已登记、写了经济逻辑与失效方式、写成早于留出段打分；G-MECH 分诊不是 `NOT_DO_SETTLED` | 机制登记表 | `MINE_MECHANISM_UNKNOWN` / `_FIELDS` / `_AFTER_HOLDOUT` / `_NOT_DO_SETTLED` |

★e 的数（第 3–5、7 项）在 `THRESHOLDS` 一个常量块里，`state = PENDING_FREEZE`。冻结前 `evaluate()` 一律返回 `MINE_THRESHOLDS_UNFROZEN`，一项都不跑；写了 `FROZEN` 却缺冻结页 path + sha256 或数不是有限数，返回 `MINE_THRESHOLDS_INVALID`。冻结由协调会话在第一轮之前做，届时以冻结页 sha256 绑定，换掉这个块。

## 6. P0 不做的（草稿 §7.1）

DSL 解析与求值、白名单算子的 G-CAUSAL 证明、`MINING_SPACE_V1` / `MINING_ROUND_V1`、试验台账角色 `MINED_CANDIDATE` 与累计 N、留出段保管服务、`ai_inputs` 新类别、生成方（遗传规划、大模型）：都在 Owner 签字之后的 P1、P2。
