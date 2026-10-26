# CRYPTO_Q0_RESULT_V1 · QRP 导入规格（Quick Shot V3 长历史 Q0）· DRAFT

状态：**DRAFT，未冻结，不得实现。** 起草：QRP 规格会话，2026-10-26。冻结：V8.1 协调会话（冻结前可改；冻结后只能另出冻结说明）。
Production effect：`NONE`。本文不改任何研究结果、判据、锁、证据、生产参数或权限；不写代码，不改 `config/strategy_profiles.v1.json`。
QRP 基线：`origin/main` `8c479e2`。

需要选择的地方列出选项，推荐项标 ★；全部选择汇总在第 12 节。

## 0. 依据与结论先行

### 0.1 输入（按内容 sha256 引用）

| 文件 | 位置 | SHA-256 |
|---|---|---|
| 封存结果 `QS_V3_M2_Q0_RESULT_V1.json`（1,118,038 字节） | smartflow `research/crypto-qrp-onboarding` @ `44f3eac3`：`trading-system-v2/docs/evidence/qrp-crypto-v1/`；Mac `research-data/qrp_crypto_v1/q0-qs/`（两处逐字节相同） | `bd83dd6ec1754dbc0b3338aefd826f29aa4f885afc05dced80ae4c826bdbfd45` |
| QS K2（§1 规则清单，§3 M1，§5 = Q0 规格） | smartflow @ `44f3eac3`：`trading-system-v2/docs/QS_V3_QRP_ONBOARDING_K2_DRAFT_V1.md` | `fc1e63f93915f89be837adc0016a45d2e9207a3f5c89e2bea98030c9105f4be4` |
| 冻结裁定 1（R-HALT、R-FUND、R-BTC 等读法；F3 A0 与标签） | 同上 `CRYPTO_QRP_ONBOARDING_FREEZE_1.md` | `5c60426ed21bb76dac95b1993714aa884f310a2d14ec65241fe304b5d2751fe3` |
| 冻结裁定 2（G3 截止日与资金费；G4 QS 进入 Q0、近似写进规则清单） | 同上 `CRYPTO_QRP_ONBOARDING_FREEZE_2.md` | `b7e3578b73b71bd1594185cce2a727cb02ed91369d5dba75e8c087aa4014819b` |
| 第 2 次执行报告 | 同上 `CRYPTO_QRP_ONBOARDING_RUN_2_REPORT.md` | `2c5ccf2a25ae7dd3a6556f330fa4fc167dc79125e688382f9016d22ebb538c83` |
| A0 结果 `QS_V3_A0_RESULT.json` | Mac `research-data/qrp_crypto_v1/a0-qs/`；smartflow 同目录 | `c35a0bc7b895a7afa702d8b2aad8674e184aabffddf965a8ac4da15416474442` |
| M1 封存包清单 `m1-manifest.json`（= smartflow `M1_QS_MANIFEST.json`） | Mac `research-data/qrp_crypto_v1/m1-qs/`（11 MB） | `7c342a05db9959092d0a06b491060ffbf11472cb3b5c80a062940ccbbd40e080` |
| US_V5 Q0 导入规格 / 冻结说明 1 / 冻结说明 2 | QRP `docs/contracts/` | `23689c99…` / `b1700f37…` / `f44c4b62…` |
| 多策略档案注册表验收 V1 | QRP `docs/contracts/QRP_MULTI_STRATEGY_PROFILE_REGISTRY_ACCEPTANCE_V1.md` | `f24dd987…` |
| V8.1 产品里程碑修订 4 | QRP `docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_AMENDMENT_4.md` | `fd2bf0ee…` |
| UX 修订 4（D1 判定依据） | QRP `docs/contracts/CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_4.md` | `9590ef9e…` |

### 0.2 今天的导入器读这份文件会怎样（实测，不是推断）

在临时目录里，用 `profiles.use()` 把一个 QS 测试档案与生产注册表合并，对 Mac 上的真实文件跑 `readSealed` → `validateWhole` → `buildBlocks`（只读；临时账本目录运行后仍为空，没有写 `var/ledger`、`var/evidence`）：

| 位置 | 结果 | 原因 |
|---|---|---|
| `readSealed` | 通过 | sha256 与旁证相符；11 个顶层字段都在（另有 `halt_events`、`forward` 两个） |
| `validateWhole` | **整文件拒绝** `Q0_VERDICT_ENGINE_APPROXIMATION_MISSING` | 文件写的是 `engine_approximation.approximations`，导入器要 `engine_approximation.missing` |
| 第 1 块 回测周期与覆盖 | 失败 | 分段没有 `tradable_carriers`、`pool_overlap_ratio`；年度普查是 `tradable_contracts` |
| 第 2 块 账户结果 | 失败 | `arms.CASH` 没有 `equity` 序列 |
| 第 3 块 胜率与赔率 | 失败 | 统计行没有 `cost_bps`，文件写 `cost: 'BASE' / 'FEES_X2'` |
| 第 4 块 压力 | 失败 | 缺场景行的数字字段**不存在**（不是 `null`）；补上之后，下一处是 `status: 'SAME_AS_BASELINE'` 不认识 |
| 第 5 块 半凯利 | 失败 | 没有 `replay.fixed_60`（文件是 `fixed_7_2`）；另外非 LEGACY 档案读 `half_kelly.floor`，文件写的是 `floor_usd`，于是 600 这条底线**没有被核对** |
| 第 6 块 三态结论 | 可读 | 依据两行都是「区间跨过门槛」，与 `INSUFFICIENT` 一致 |
| 主数字 | 「尚无」 | 导入器找 `cost_bps === 5` 的行；即使补上，标签写死「5 bps」 |
| 胜率表相位 | 错 | 有 `PLUS_60MIN`、无 `MINUS_60MIN` 时，US 的「相位 ±60 分钟…120 分钟扫描」说明出现，晚一小时那行被改名为「相位 ±60 分钟」 |

在内存里逐块修补之后：「最大损失」主数字 = 698.67，场景 `SCAN_PHASE_PLUS_60MIN`（与执行报告一致）；结论 `INSUFFICIENT`。

### 0.3 本草稿怎么做

- 文件**原样**导入：不改文件、不重算、不改标签。下面每一条读法都只针对**没有** `projection_shape: LEGACY_V1` 的档案；US_V5（LEGACY_V1）的代码路径与输出一行不变。
- 新的按策略取值的读法全部放进档案的一个新对象 `q0_reading`（第 2 节）。LEGACY_V1 档案不得带它，非 LEGACY 档案必须带它。
- 规格名用 `CRYPTO_Q0_RESULT_V1`：它是「加密 Q0 结果文件的导入读法 V1」。本次只有 QS 一个档案项；C17_V2 的 Q0 将来复用这些读法，但它的 schema 名、档案项与差异另行冻结。

## 1. 文件与封存

1. 沿用 US 导入规格第 1 节：一个 JSON 加 `<文件名>.sha256`；绝对路径；路径里带 `fixture / demo / mock / synthetic` 的不当作实际来源；页面每次现场复验 sha256。
2. 导入的文件位置。US 的两个 Q0 锁都指向 QRP 自己的 `var/evidence/…`（不进 git）。
   - ★(a) 照 US 先例：把 Mac 上的文件和旁证原样拷到 `var/evidence/qs-v3-m2-q0-2026-10-26/`，核对 sha256 后从那里导入。
   - (b) 直接从 `research-data/qrp_crypto_v1/q0-qs/` 导入（同一目录下还有 `superseded-1/` 等，路径更容易指错）。
3. 命令（完成权威执行；只追加一条 `BASELINE_EVALUATION_LOCK_V1`）：
   `QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_baseline_evaluation.js --file <绝对路径> --strategy QUICK_SHOT_V3_1000USDT --registered-by V8_1_COORDINATOR`
4. `result_id = Q0-bd83dd6ec1754dbc`；case = `RRC-QUICK-SHOT-V3-1000USDT-V8-1-M0`。这是这个 case 的第一把锁，**不带** `--supersedes`（第 8 节）。
5. 锁记录里的 `plan_ref` / `amendment_ref` 取自档案（第 2 节），它们进 `lock_hash`，所以随本规格一起冻结。

## 2. P1 · QS 策略档案项

### 2.1 提议的档案项（冻结后由实现会话写进 `config/strategy_profiles.v1.json`；本草稿不写）

```json
{
  "strategy_ref": "QUICK_SHOT_V3_1000USDT",
  "case_ref": "RRC-QUICK-SHOT-V3-1000USDT-V8-1-M0",
  "market": "CRYPTO_USDM_PERP",
  "currency": "USDT",
  "display_name": "Quick Shot V3",
  "comparators": [
    { "key": "BTC_BUY_HOLD", "label_zh": "BTC 买入持有", "role": "MARKET" },
    { "key": "CASH", "label_zh": "现金", "role": "CASH" }
  ],
  "floor": { "value": 600, "currency": "USDT", "rule_label_zh": "Rule 1b 的 600 USDT（1,000 USDT 的 40% 线）" },
  "baseline_result_schema": "QS_V3_M2_Q0_RESULT_V1",
  "import_profile_id": "docs/contracts/CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE.md",
  "comparison_import_profile_ids": [],
  "phase_words": { "PRODUCTION": "h+1 开盘成交", "PLUS_60MIN": "晚一小时成交（h+2 开盘）" },
  "segment_words": { "IS": "开发期", "OOS": "样本外" },
  "cost_model_id": "CRYPTO_M1_RESEARCH_COST_V1",
  "m1_evidence": {
    "manifest_ref": "docs/evidence/CYCLE_RESEARCH_DESK_QS_V3_M1_NATIVE_DIAGNOSTIC_2026-10-26.json",
    "manifest_sha256": "<该 QRP 证据清单写成后的 sha256，第 9.5 节>",
    "diagnostic_schema": "QS_V3_M1_STRATEGY_DIAGNOSTIC_V1",
    "producer": "QS_V3_M1_PRODUCER_V1"
  },
  "forward_observation_source_key": "QUICK_SHOT_V3_1000USDT",
  "research_program": {
    "plan_ref": "smartflow:research/crypto-qrp-onboarding@44f3eac3:trading-system-v2/docs/QS_V3_QRP_ONBOARDING_K2_DRAFT_V1.md",
    "amendment_ref": "smartflow:research/crypto-qrp-onboarding@44f3eac3:trading-system-v2/docs/CRYPTO_QRP_ONBOARDING_FREEZE_2.md",
    "default_question": null,
    "queue": {
      "Q4": { "title": "风控维度：总上限、每合约仓数、保证金、账本止损", "status": "未立题：Quick Shot V3 尚无 M2 研究计划", "after": [] }
    }
  },
  "q0_reading": {
    "main_row": { "segment": "OOS", "cost": "BASE", "phase": "PRODUCTION" },
    "cost_words": { "BASE": "基础成本", "FEES_X2": "手续费 ×2" },
    "phase_note_zh": "只有一种相位压力：晚一小时成交（h+2 开盘）。生产在收盘后几分钟成交，没有更早的相位（K2 §5）。",
    "census_columns": [
      { "field": "tradable_contracts", "label_zh": "可交易合约" },
      { "field": "liquid_contracts_20m", "label_zh": "24h 成交额 ≥ 2,000 万 USDT 的合约" }
    ],
    "market_g_path": "stats.g_vs_btc.OOS",
    "kelly": {
      "floor_field": "floor_usd",
      "fixed_arm": { "key": "fixed_7_2", "label_zh": "按现行固定每笔 7.2 USDT 风险" },
      "thresholds": [
        { "field": "p_below_floor", "value": 600, "label_zh": "Rule 1b 40% 线" },
        { "field": "p_below_book_stop_750", "value": 750, "label_zh": "25% 账本止损线" }
      ]
    },
    "forward": { "net_field": "net_usdt", "ledger_must_equal_strategy_ref": true },
    "funding_exclusion": { "count_field": "excluded_funding_missing", "share_field": "excluded_share", "rule_ref_zh": "R-FUND (a)" },
    "disclosures_zh": [
      "样本外复用：2024-01-01 起的同一缓存已被调参研究 V1 用于选出 V3 参数（K2 §5，oos_reuse = true）；真正没用过的只有 2026-10-01 起的尾部与 T 起的前向。"
    ]
  },
  "shared_constraints": [
    { "key": "A19_LOSS_BUDGET", "label_zh": "A19 共享亏损预算", "peers": ["C17_V2_4000USDT"], "display_zh": "共享，未复算", "rule_ref": "QS-C5" }
  ]
}
```

### 2.2 选择

- **market**：★ `CRYPTO_USDM_PERP`（K2 §5「市场_策略_账本_模式」原文）；或 `CRYPTO`（测试档案的写法）。只作登记和显示。
- **plan_ref / amendment_ref**：★(a) 指向 smartflow 的固定提交 `44f3eac3`，sha 记在本规格 0.1；(b) 把 K2 与两份冻结裁定原样镜像进 QRP `docs/contracts/`。(a) 不产生第二份合同文本。
- **queue**：★(a) 只登记 Q4 一项，让诊断清单 QS-D4 的 `proposed_experiment: 'Q4'` 显示为「未立题」，而不是「实验状态未登记」；(b) 空队列。题目标题取 K2 §5 风控维度一行的四项，不是新立题。
- **oos_reuse 说明**：K2 §5 要求「oos_reuse = true，必须写明」，但封存文件里没有这个字段。★(a) 用档案的 `disclosures_zh` 写一行（文字来自冻结 K2，不是数字），放在「判定依据」下面的「另须知道」；(b) 不写。

### 2.3 校验器（`services/strategy-profiles`）新增

1. `projection_shape: LEGACY_V1` 的档案带 `q0_reading`、`shared_constraints` 或 `m1_evidence.producer` 任一项 → `STRATEGY_PROFILE_FIELD_TYPE`（保证 US_V5 不受影响）。
2. 非 LEGACY 档案缺 `q0_reading` 或其必填子项 → `STRATEGY_PROFILE_FIELD_MISSING`。
3. `q0_reading.main_row.cost` 必须是 `cost_words` 的键；`main_row.phase` 必须是 `phase_words` 的键；`main_row.segment` 必须是 `segment_words` 的键。
4. `kelly.thresholds[0].value` 必须等于 `floor.value`；各 `field` 不重复；`value` 为正数。
5. `shared_constraints[]` 的每一项不得含数字类型的值（第 10 节）；`display_zh` 必须是「共享，未复算」。
6. `m1_evidence.producer` 必须是已登记的生产者 id（第 9.5 节），否则 `DIAGNOSTIC_PRODUCER_NOT_REGISTERED`。

## 3. P2 · K2 主判据与「判定依据」（UX 修订 4 D1）

### 3.1 判据常量

K2 §5：主指标 = 样本外每笔扣费后净 R 均值（R = 7.2 USDT），δ = +0.10 R；次指标 = 账本年化对数增长相对 BTC 买入持有之差，δ_g = 0；按月分块 bootstrap 95%；样本 < 30 为证据不足。与 US 计划冻结值完全相同。

- ★(a) `DELTA_R`、`DELTA_G`、`MIN_TRADES`、`ci_method` 仍是代码常量，不进档案；现有的等值检查（`Q0_VERDICT_DELTA_CHANGED`、`Q0_VERDICT_CI_METHOD_CHANGED`）照样拒绝不同的值。将来某条策略的 K2 用了别的值，再修订本规格。
- (b) 现在就把四个值搬进档案并校验。

### 3.2 主数字

- 取 `stats.rows` 中 `segment = q0_reading.main_row.segment`、`cost = main_row.cost`、`phase = main_row.phase` 的一行（QS：`OOS` / `BASE` / `PRODUCTION`）。LEGACY_V1 仍按 `cost_bps === 5`。
- 标签：`<segment_words.OOS>每笔扣费后净 R 均值（<cost_words[main_row.cost]>，<phase_words.PRODUCTION>；门槛 +0.10 R）`。
  QS 页面：「样本外每笔扣费后净 R 均值（基础成本，h+1 开盘成交；门槛 +0.10 R）」，数值 +0.19 R，95% 区间 −0.15 R 至 +0.52 R。
- 主数字下面一行写资金费排除（第 5.6 节）。

### 3.3 结论与主数字同源（整文件检查，新增）

文件的 `verdict` 没有 `mean_R`、`g`，点估计在统计行里。为保证「结论」和「依据」来自同一次运行：

- `[verdict.L_R, verdict.U_R]` 必须逐值等于主数字行的 `mean_R_ci`，`verdict.n_trades` 必须等于该行的 `n`；
- `[verdict.L_g, verdict.U_g]` 必须逐值等于 `q0_reading.market_g_path` 指向的 `ci`（QS：`stats.g_vs_btc.OOS.ci`）。
- 不等 → 拒绝导入，`Q0_VERDICT_NOT_FROM_MAIN_ROW`，后面写哪一项不等。真实文件三项都相等。
- 判据行的点估计：R 行取 `verdict.mean_R`，没有时取主数字行的 `mean_R`；G 行沿用现在的写法（不写点估计）。

### 3.4 页面文字（真实文件，测试逐字断言）

- 结论：「证据不足」。
- 判定依据（主内容）：
  1. 「每笔扣费后净 R 均值 +0.19 R，95% 区间 −0.15 R 至 +0.52 R，区间跨过门槛 +0.10 R」
  2. 「相对 BTC 买入持有的账户年化对数增长差 95% 区间 −70.2% 至 79.2%，区间跨过门槛 0」
  3. 「门槛在看到结果前已冻结」
- 另须知道：`disclosures_zh` 的一行（若 2.2 选 (a)）。
- 最大的限制：「每笔扣费后净 R 均值、相对 BTC 买入持有的账户年化对数增长差的 95% 区间跨过判定门槛，现有样本不足以判定。」（与结论不矛盾）
- 原因码 `CI_STRADDLES_DELTA` 已登记，主内容不出现英文码（UX 修订 4 D1.3）。

## 4. P3 · 规则清单、APPROXIMATED、A0

### 4.1 词汇

`gates.rules[].status` 对非 LEGACY 档案认四个值：`IMPLEMENTED`（已实现）、`NOT_IMPLEMENTED`（未实现）、`NOT_APPLICABLE`（不适用）、`APPROXIMATED`（已知近似）。其他值 → 拒绝导入，`Q0_RULE_STATUS_UNKNOWN`。
真实文件：已实现 18、已知近似 6（QS-U1、E1、E2、X2、X3、C4）、不适用 3（QS-K9、C5、C7）。

- 每条 `APPROXIMATED` 必须有非空的 `code_ref` 和 `note_zh`（冻结裁定 2 G4：A0 窗口实测到的偏差一并披露）。缺 → `Q0_APPROXIMATION_SIZE_NOT_DISCLOSED`。
- `verdict.engine_approximation` 对非 LEGACY 档案：`flag` 为布尔；`approximations` 为数组，且必须与 `APPROXIMATED` 规则 id 的集合相等（不计顺序），否则 `Q0_ENGINE_APPROXIMATIONS_MISMATCH`；`missing` 可省略，省略按 `[]` 读。（今天的整文件拒绝就在这里。）
- `NOT_IMPLEMENTED` 与 A0 未通过仍按 US 第 3 节第 6 条：必须 `flag = true`。

### 4.2 `APPROXIMATED` 是否等于「缺口」

冻结裁定 1 F3：A0 通过，长历史 Q0 标「当前 D」；A0 不通过才标「研究引擎近似的当前 D」并封顶「证据不足」。冻结裁定 2 G4：QS A0 7 项通过，标「当前 D」，长历史近似写进 `gates.rules` 并披露大小。文件 `flag = false`。

- ★(a) `APPROXIMATED` **不算**缺口：不要求 `flag = true`，不封顶三态。`SUPPORTED` 仍要求 A0 通过、无 `NOT_IMPLEMENTED`，另加 4.1 的大小披露。这与 F3、G4 一致，真实文件导入通过。
- (b) 算缺口，要求 `flag = true`：真实文件（`flag = false`）会被拒绝，而文件不能改标签。与 G4 冲突，不可用。
- (c) 不要求 `flag = true`，但只要有 `APPROXIMATED` 就不接受 `SUPPORTED`：比 F3 更严。对本文件没有影响（本来就是 `INSUFFICIENT`）。选它等于给 F3 加一条封顶规则，应由协调会话明说。

### 4.3 页面文字

- 引擎标签（第 1 块）：头取 `verdict.label_zh`（G1 规则），缺时写「当前 D」。`flag = false` 且有已知近似时整句为
  「当前 D（引擎对齐关卡 A0 通过；长历史已知近似 6 条，见规则清单）」。LEGACY_V1 的「规则清单无缺口」一句不变。
- 规则清单折叠在技术详情里，标题「规则清单（已实现 18 · 已知近似 6 · 不适用 3）」。每条已知近似写 id、`note_zh`、`code_ref`；计数只是数行，不是计算。
- A0：主内容写「引擎对齐关卡 A0：通过」；`gates.A0.ref` 原文（含 `c35a0bc7…`）放在技术详情。QRP 现在不导入 A0 文件，只显示引用（A0 文件的核对随 M1 证据，第 9 节）。
- 其他关卡（`PREFILTER_SAFE`、`signals`、`skips`）只进技术详情，例如「预筛门：A0 窗口 224,367 个合约小时全量判定，漏掉 0 个信号」。

### 4.4 第 1 块、第 2 块的其余字段

- 分段：非 LEGACY 档案的 `tradable_carriers`、`pool_overlap_ratio` 可省略，省略时该列不显示（不写 0，不写「未知」）。
- 年度普查：列由 `q0_reading.census_columns` 决定（QS：可交易合约、24h 成交额 ≥ 2,000 万 USDT 的合约）。
- 现金臂：非 LEGACY 档案中，`role = CASH` 的比较臂可以没有 `equity`；此时只显示它的 `summary`，不画序列，也不拿 D 的日期去补。`MARKET` 臂与 D 仍须有同日期序列。
- 开发期账户 `arms.IS`：★(a) 折叠显示「开发期账户（开发期，只报）」，三臂 `summary` 原样；(b) 不显示。主账户表只读样本外三臂。
- D 臂逐笔数：显示「逐笔记录 869 行」，不做「869 − 13 − 1」之类的推算；主统计笔数看胜率表（855）。

## 5. P4 · 压力

### 5.1 角色（冻结说明 2 G2，不变）

真实文件 16 行：当前 D 参照 1（`BASELINE`）；压力场景 11（费用 3、晚一小时成交 1、出场粒度 1m 1、区间重放 5、`HALT_HONORED` 1）；风控维度 4（`RISK_*`）。

### 5.2 「最大损失」主数字

- 范围按 G2：只取已执行、非模拟、有数字、`in_headline` 不是 `false` 的压力场景行。
- 真实文件：**698.67 USDT，场景「晚一小时成交（h+2 开盘）」**（`SCAN_PHASE_PLUS_60MIN`，`max_loss_usd = 698.66806435`）。风控维度「保证金 10 → 15」的 894.52 是 Q4 的输入，只报不判，不进主数字。
- 字段名：文件写 `max_loss_usd`，数值单位是 USDT（`identity.config.capital_usdt = 1000`）。
  - ★(a) 字段名照读 `max_loss_usd`，单位一律取档案 `currency`；非 USD 档案的页面不得出现「美元」「US$」。
  - (b) 要求 `max_loss_usdt`：会拒绝这份封存文件，而文件不能改，不可用。
  - (c) 以后的新 schema 可依次接受 `max_loss`、`max_loss_<币种小写>`、`max_loss_usd`；一个文件同时写两个且值不同 → 拒绝。本次不需要。
- 金额位数：★ 非 LEGACY 档案的压力金额写两位小数（「698.67 USDT」；2020-03 区间重放的 7.68 不会被写成 8）。US_V5 仍是整数美元。

页面：「最大损失：698.67 USDT（场景：晚一小时成交（h+2 开盘））」。

### 5.3 缺场景：出场粒度 1m

- 行：`EXIT_GRANULARITY_1M`，`status: MISSING_SCENARIO`、`missing: true`，**没有**数字字段。
- 非 LEGACY 档案：缺场景／无效输入行的数字字段**不存在**按 `null` 读；存在且不是 `null` 仍 `INVALID`（不允许用 0 或估计补位）。LEGACY_V1 维持「必须显式 `null`」。
- 原因按 G1：`missing_reason` 已带「缺场景：」前缀，去掉后页面写「缺场景：1m 缓存（/root/c17-swap-v1）不在冻结裁定 2 允许拷贝的输入范围内；A0 窗口里 1h 读法 8/9 出场原因相同（JCTUSDT：1h 读成 GAP，生产为 STOP）」。
- 角色：K2 §5 写它「只报不判，供诊断」，但它的 id 不带 `RISK_`、也没有 `in_headline: false`，按 G2 的识别规则是压力场景。
  - ★(a) 按 G2 当压力场景：压力评价不完整，采用条件未满足（保守方向；不改变优势结论）。
  - (b) 档案登记一个「只报的压力 id」清单，把它排除在完整性之外：压力评价会变成「完整」，偏乐观，且是 QRP 替文件改角色。
- 三行（G3，结论区块一次）：
  1. 「优势结论：证据不足」
  2. 「压力评价不完整：缺场景 1 个、无效输入 0 个（出场粒度 1m 对 1h：缺场景）」
  3. 「采用条件：未满足（必要压力缺失，§6.7）」

### 5.4 新状态 `SAME_AS_BASELINE`

两行用它：`HALT_HONORED`（压力场景：样本外没有停止事件）、`RISK_NO_BOOK_STOP`（风控维度：主臂本就不执行自动停止）。两行只有 `end_capital`。

- ★(a) 认这个状态，记为「与当前 D 参照相同」：
  - 不从参照行抄任何数字；表里这行写「与当前 D 参照相同」和文件自己的 `end_capital`。
  - 一致性：该行 `end_capital` 必须等于 `BASELINE` 行的 `end_capital`（容差 1e-6），否则压力块 `INVALID`；文件没有 `BASELINE` 行时同样 `INVALID`。
  - 不进「最大损失」，不算缺场景（不让压力评价变成不完整），单独计数。
- (b) 当缺场景：压力评价会被错误地写成缺 2 个。
- (c) 照抄参照行的数字：违反「页面不重算」。

计数行（非 LEGACY 档案）：「已执行 9 个压力场景（另有 1 个与当前 D 参照相同），模拟或补充 0 个，缺场景 1 个，无效输入 0 个；另有当前 D 参照 1 行、风控维度 4 行（只报不判，不进最大损失）。缺场景和无效输入不计为已执行的压力。」LEGACY_V1 的计数行不变。

### 5.5 风控维度行

只报不判，留在表里，不进主数字（G2）。以下两条只用于非 LEGACY 档案（US_V5 的 Q0 卡不变）：
- 与参照行完全相同的风控维度行（`RISK_OPEN_CAP_100`：数字与 `BASELINE` 逐项相同）按 UX 修订 4 D3.3 标「与参照相同」；判断「相同」只比较文件里两行的字段，不计算。
- 压力表另显示文件自带的「笔数」「每笔均值 R」两列（`n`、`mean_R`），缺时空着。

### 5.6 资金费缺失排除（R-FUND (a)，现在没有位置）

- 读 `stats.rows[].excluded_funding_missing`（整数 ≥ 0）与 `excluded_share`（0–1），字段名由 `q0_reading.funding_exclusion` 指定。主数字行缺这两个字段 → 第 3 块 `INVALID`。
- 页面：
  - 主数字下面一行：「主统计不计资金费缺失的 13 笔（占 1.5%，R-FUND (a)）」；
  - 胜率表加一列「资金费缺失排除」：样本外各行「13 笔（1.5%）」，开发期各行「1 笔（0.3%）」。
- R-FUND (a) 规定占比 > 5% 时研究会话加一行「按同期全市场中位数」压力：
  - ★(a) QRP 只显示笔数与占比，不判断是否该加；
  - (b) 占比 > 5% 而压力表没有 `FUNDING_MEDIAN` 开头的行时，按缺一个压力场景计（压力评价不完整）。需要先冻结这个场景 id。
  本文件 1.5%，两种选择结果相同。

## 6. P5 · 半凯利

### 6.1 读法

- `p, p_ci, b, b_ci, f_star, f_half` 照旧。
- 底线：非 LEGACY 档案读 `q0_reading.kelly.floor_field` 指定的字段（QS：`floor_usd`），必须等于 `floor.value`（600）；字段缺失 → 第 5 块 `INVALID`。（修掉 0.2 的「600 没被核对」。）
- 固定风险臂：`replay.<kelly.fixed_arm.key>`（QS：`fixed_7_2`）；LEGACY_V1 仍读 `fixed_60`。
- 阈值：两臂都必须有 `kelly.thresholds[].field` 列出的每个概率（QS：`p_below_floor`、`p_below_book_stop_750`），各在 0–1。
- 一致性（第 5 块 `INVALID`，不重算）：`f_star ≤ 0` 时 `f_half` 必须为 0；`verdict.L_R ≤ 0` 时 `f_half` 必须为 0（K2 §5「L_R ≤ 0 → 半凯利 = 0」）。真实文件：`f_star = −0.06143094`，`L_R = −0.15189273`，`f_half = 0`，两条都满足。
- 重抽条数：`identity.config.resamples`（10,000）存在时写进固定风险臂的副标题；不存在就不写。

### 6.2 页面文字（真实文件）

- 首行沿用现有句子：「不支持按凯利加仓：区间下沿的半凯利比例为 0」。
- 卡 1「按半凯利定仓」：期末资本区间 1,000 USDT 至 1,000 USDT；最大回撤 0.0%；跌破 600 USDT（Rule 1b 40% 线）的概率 0.0%；跌破 750 USDT（25% 账本止损线）的概率 0.0%；文件的 `note`「半凯利 = 0：不支持按凯利加仓」。
- 卡 2「按现行固定每笔 7.2 USDT 风险」（副标题「重抽 10,000 条路径」；重抽方法不在文件里，页面不写）：期末资本区间 **170 USDT 至 4,701 USDT**；最大回撤 22.1%；跌破 600 USDT（Rule 1b 40% 线）的概率 **31.4%**；跌破 750 USDT（25% 账本止损线）的概率 **49.7%**。
- 脚注：「研究计算，不是仓位建议；现行仓位规则不变。底线：Rule 1b 的 600 USDT（1,000 USDT 的 40% 线）；另报 750 USDT（25% 账本止损线）。」
- 期末资本区间写整数（与 US 相同）；概率与回撤用现有一位小数格式（已核对：0.3135 → 31.4%，0.497 → 49.7%）。

## 7. P6 · 前向行

### 7.1 读法（新增，只报不判）

文件 `forward`：`{in_verdict: false, ledger: "QUICK_SHOT_V3_1000USDT", trades: 10, net_usdt: −50.5909008, mean_R: −0.7026514}`。

- 只对非 LEGACY 档案读；US 的投影 JSON 不加这个字段（D1 金样不变）。不加第 7 块：六块结构不变，前向是第 2 块（账户结果）末尾的一行。
- 检查（只让这一行无效，不影响结论）：`in_verdict === false`；`ledger` 等于档案 `strategy_ref`（R3.3）；`trades` 为非负整数；`net_usdt`（字段名取 `q0_reading.forward.net_field`）与 `mean_R` 为有限数。不满足时这一行写「前向记录无效：<原因>」。
- 前向数字**永不**进判据、主数字、压力或半凯利。

### 7.2 页面文字

- 第 2 块末尾：「前向记录（PAPER 账本 QUICK_SHOT_V3_1000USDT，只报不判，不进结论）：10 笔，净 −50.59 USDT，每笔均值 −0.70 R。」（R 用现有两位小数格式；原值在技术详情。）
- 「前向观察」一节：HK 前向配置里没有 QS 一组，今天会写「尚无属于这项策略的前向观察。」，与 Q0 卡里的 10 笔矛盾（UX 修订 4 D4 的同类问题）。改为：「Q0 结果文件里带有前向记录 10 笔（只报不判）；HK 前向影子：本策略尚未登记。」
- `config/hk_forward_observations.v1.json`：★ 本次不加 QS 组；以后有 HK 前向影子时放在 `strategies.QUICK_SHOT_V3_1000USDT`。

## 8. P7 · 第一次运行显示为 SUPERSEDED，永不是结果

事实：第一次运行（代码 `3bcde85f`，结果 `50b3b14f…`）从未导入 QRP；QRP 账本里没有任何 QS 锁。封存文件的 `identity.supersedes[0]` 记着它（`state: SUPERSEDED`、`result_sha256`、`core_runs_sha256`、`kept_at`、`reason_zh`），另有 `identity.change_note_zh`。

- ★(a) 只导入第二次运行（`bd83dd6e…`）作为本 case 的**第一把锁**，不带 `--supersedes`；第一次运行只从文件的 `identity.supersedes[]` 显示：
  - 回测结论卡的「来源」区写一行：「已替代的第一次运行（SUPERSEDED，不是结果）：代码 3bcde85f，结果文件 50b3b14f…」；原因 `reason_zh` 与 `change_note_zh` 原文折叠在技术详情。
  - 不显示它的任何数字（文件里也没有），不给 `result_id`，不出现在锁列表、题目列表、里程碑证据里。
- (b) 先导入第一次运行再用锁的替代路线换成第二次：账本里会多一把「第一次运行」的锁，等于把它当过结果。不采用。

新增检查：
1. `identity.supersedes` 存在时，每项必须有 `state = 'SUPERSEDED'`、64 位十六进制的 `result_sha256`（不得等于本文件 sha256）和非空 `reason_zh`；否则拒绝导入，`Q0_SUPERSEDES_INVALID`。
2. 导入一个文件时，若它的 sha256 出现在同一 case 任何已锁文件的 `identity.supersedes[].result_sha256` 里 → 拒绝，`Q0_RESULT_IS_SUPERSEDED`；带 `--supersedes` 也拒绝。
3. 另一份「同一核心运行、未带审计记录」的封存 `2f0288d8…`（`superseded-2-no-audit/`）不在文件的 `supersedes` 里，页面不显示它；第二次运行锁定之后，它由现有的「一个 case 只锁一次」拒绝（`BASELINE_ALREADY_LOCKED`）。如果协调会话要求把它也写成显式拒绝，可在档案里加一个拒绝 sha 清单（选项，不推荐：多一处登记）。

## 9. P8 · `CRYPTO_M1_RESEARCH_COST_V1` 与 QS 的 M1 诊断

### 9.1 为什么要一个独立的生产者

`services/strategy-diagnostics/index.js` 的 `buildDiagnostic` 是 US_V5 专用：它核对 US 的 M1 验收文件，读 US 证据清单的 `cost_model` / `input_package` / `native_replay`，并按 2026-10-09、2026-10-14 两个日期取 US 的那笔交易。QS 的 M1 包（`QRP_CRYPTO_V1_M1_QS`，`7c342a05…`）是数据库行加文件的封存包，结构不同。所以要两样东西：一个成本模型（本节 9.2–9.4），一个按档案选择的生产者（9.5）。

### 9.2 成本模型 `CRYPTO_M1_RESEARCH_COST_V1`

模块 `services/strategy-diagnostics/cost_models/CRYPTO_M1_RESEARCH_COST_V1.js`，登记在 `cost_models/index.js`；`US_V5_M1_RESEARCH_COST_V1` 原样不动。参数来自 QRP 证据清单的 `cost_model` 块（9.5），值抄自冻结 K2 QS-F1..F4：

| 项 | 规则（K2） | 逐笔对账（M1 包 `db/quick_shot_v3_trades.jsonl` 的列） | 状态 |
|---|---|---|---|
| 手续费 | taker 0.04% / 边，按入场名义（QS-F1） | `fee_entry_usdt` 与 `fee_exit_usdt` 各等于 `notional × 0.0004`（1e-6） | `MEASURED_RECORDED`（库内列）+ 规则核对 |
| 滑点（入场） | 分档：24h 成交额 ≥ 10 亿 0.02%，≥ 3 亿 0.04%，否则 0.06%；入场档用信号的 `quote24h`（QS-F2） | `slippage_entry_usdt = notional × tier(detail.signal.quote24h)`（1e-6） | 同上 |
| 滑点（出场） | 出场档用出场前 24 根 1h | M1 包里没有这 24 根 1h：`slippage_exit_usdt` 按库内列读，并核对 `= notional × detail.exit.slippagePerSide`（1e-6），不重推档位 | `RECORDED_TIER_NOT_REDERIVED` |
| 资金费 | `方向 × Σ(入场, 出场] 结算费率 × 名义`（QS-F3），正数 = 本账本付出 | `funding_state = MEASURED`：`funding_usdt = side × Σ detail.exit.fundingSettlements[].fundingRate × notional`（1e-6，多 +1，空 −1）；`funding_settlements` 列只是个数，须等于事件数 | `MEASURED` |
| 资金费缺失 | R-FUND (a) | `funding_state` 不是 `MEASURED`（或缺事件）：值为 `null`，**不填 0**；该笔仍按库内 `net_pnl` 进账户等式，并单列「资金费缺失 N 笔」 | `MISSING` |
| 毛盈亏 | 毛亏损以 10 USDT 保证金为限（QS-F4） | `gross_pnl = side × (exit_price − entry_price) × quantity`（1e-6）；`liquidation_capped = 1` 时改核 `gross_pnl = −margin_used` | 规则核对 |
| 净 R | 净 R = 净额 ÷ 7.2（QS-P1、F4） | `net_r = net_pnl / 7.2`（1e-6；库内 8 位小数） | 规则核对 |

任何一项超出容差 → 诊断失败关闭，`CRYPTO_M1_COST_MISMATCH`，写明哪一笔、哪一项。成本模型只核对、不改写库内值。

起草时已在真实 M1 包上手算核对（可行性检查，不是测试）：10 笔的手续费、入场滑点（按 `quote24h` 定档）、出场滑点、资金费（按结算事件）、毛盈亏、净额、净 R 全部在 1e-6 内，`funding_settlements` 个数等于事件数。例：`MARSCOINUSDT` 多头 2 次结算 × 0.00005 × 240 = 0.024 = `funding_usdt`；`BTWUSDT` 空头 1 次 → −0.012（收入）。真实 10 笔都在 0.06% 一档，0.02% 与 0.04% 两档只能由合成夹具覆盖。

### 9.3 USDT 账户等式（残差 ≤ 1e-6）

- 起点：窗口 `2026-10-07T00:00Z` 时 1,000 USDT、持仓 0。
- 每笔：`net_pnl = gross_pnl − fee_entry_usdt − fee_exit_usdt − slippage_entry_usdt − slippage_exit_usdt − funding_usdt`（以库内列为准，不二次扣）。
- 终点：`1000 + Σ net_pnl = 949.4090992`（10 笔，Σ = −50.5909008）；未平仓按市值单列（当前 0 笔）。
- A19 共享预算只显示状态与引用（第 10 节），C17_V2 的盈亏不进本等式。

### 9.4 资金费的两套词

M1 包（生产）用 `MEASURED`；Q0 结果文件用 `MEASURED_ARCHIVE` / `FUNDING_MISSING`。两边各按自己的词显示，不互相映射；页面文字统一为「资金费：已测」「资金费：缺失」。

### 9.5 QS 的 M1 生产者与证据

- 档案 `m1_evidence.producer`：`QS_V3_M1_PRODUCER_V1`，模块 `services/strategy-diagnostics/producers/QS_V3_M1_PRODUCER_V1.js`。现有 `buildDiagnostic` 登记为 `US_V5_M1_PRODUCER_V1`。LEGACY_V1 档案不写 `producer`，默认 US 生产者；非 LEGACY 档案不写或写了未登记的 id → `DIAGNOSTIC_PRODUCER_NOT_REGISTERED`，诊断不借用别的策略的生产者。
- 证据照 US 先例：
  - QRP 写一份自己的证据清单 `docs/evidence/CYCLE_RESEARCH_DESK_QS_V3_M1_NATIVE_DIAGNOSTIC_2026-10-26.json`，含 `strategy_ref`、`case_ref`、`window`、`cost_model{model_ref, 参数}`、`input_package{relative_root, digest}`、`source_package{manifest_sha256: 7c342a05…}`；档案的 `manifest_sha256` 是这份清单的 sha256。
  - M1 包（11 MB）原样拷到 `var/evidence/qs-v3-m1-2026-10-07_2026-10-24/`，逐文件按 `7c342a05…` 清单核对 sha256。
- 一笔决策追踪按 K2 §3：`1000RATSUSDT` 2026-10-14 15:00Z 信号 → 开多 → TARGET +2.60 R。
- A4 规则不变：QS case 的阶段 PASS 只认 QS 自己的 case；M1 PASS 要求 `readFreshDiagnostic('QUICK_SHOT_V3_1000USDT').state === 'VERIFIED'` 且诊断的 `case_ref` 是 QS case；US 的证据和测试档案不能充当 QS 的运行证据。
- 本规格只定成本模型、账户等式与生产者接口。M1 诊断的页面分节（照 US M1 的结构）在生产者实现时另写验收，或由协调会话决定并入本规格的冻结说明。

## 10. P9 · A19 共享预算：「共享，未复算」

- 档案 `shared_constraints[]`（见 2.1）。每项只有文字：`key`、`label_zh`、`peers[]`（策略身份）、`display_zh`（固定为「共享，未复算」）、`rule_ref`。不得含数字类型的值（校验器拒绝）。
- 一致性：`rule_ref` 指向的规则在 Q0 文件里必须是 `NOT_APPLICABLE`（QS-C5 是，`note_zh`「A19 共享，只引用不复算」）；不是时这一行写「共享约束与规则清单不一致」，不影响结论。
- 页面（第 1 块，引擎标签下面一行）：「A19 共享亏损预算：与 C17_V2 共享，未复算（规则 QS-C5）」。peer 的显示名取 `config/m4_scope.v1.json` 中该策略的 `label_zh`。
- 选择：
  - ★(a) 只写文字，不显示任何预算数字；
  - (b) 显示 K2 QS-C5 原文里的 L = 1,600、E* = 2,400。这是两条策略合起来的数，按 R3.3「一条策略的数字不得出现在另一条策略的页面上，包括共享预算这类引用」，不采用。
- 永不进账户等式（9.3），永不出现在 US_V5 或 C17_V2 的页面数字里；将来 C17_V2 的档案写它自己的一项，指回 QS。

## 11. P10 · 确定性测试

实现会话必须全部通过；数字断言用真实文件时在 PR 里给出输出 sha256。

1. **US_V5 逐字节不变**：用 `qrp-profile-registry-d1/` 的 `capture.js`，在 `8c479e2` 与实现分支上各抓一次金样。US_V5 策略详情与 US_V5 的全部 API 响应逐字节相同；允许变化的只有 QS 自己的路由和列出 QS 的条目（例如 M4 面板里 QS 一项从「已列入 M4 范围，尚未接入」变为它自己的 M0–M3 状态）。PR 逐个列出变化的文件、原因和 sha256 对比。
2. **既有锁重导入相同**：`reimport.sh` 在临时账本副本里重导 Q0×2、Q1、Q2，锁记录与 hash 与真实账本相同。
3. **真实 QS 文件导入（临时账本）**：
   - `result_id = Q0-bd83dd6ec1754dbc`，`strategy_ref`、`case_ref`、`verdict_state = INSUFFICIENT`、`file_sha256` 正确；`inputs_digest`、`engine_digest` 写进 PR，冻结后作为金值；重复导入是幂等重放。
   - 再导 `superseded-1/` 的 `50b3b14f…` → `Q0_RESULT_IS_SUPERSEDED`（带不带 `--supersedes` 都拒绝）；导 `superseded-2-no-audit/` 的 `2f0288d8…` → `BASELINE_ALREADY_LOCKED`。
   - 真实 `var/ledger`、`var/evidence` 前后 sha 相同。
4. **真实文件的页面断言**（逐字）：第 3.2 节主数字；第 3.4 节判定依据三行与最大的限制；第 5.3 节三行；第 5.2 节最大损失；第 5.4 节计数行；第 5.6 节排除行；第 6.2 节两张卡的四个数字；第 7.2 节两句；第 8 节 SUPERSEDED 一行（且页面不含 `Q0-50b3b14f`）；第 10 节 A19 一行。
5. **QS 页面不得出现**：「美元」「US$」「SPY」「1,800」「5 bps」「相位 ±60 分钟」「120 分钟」「规则清单无缺口」；任何 US_V5 数字。US_V5 页面不得出现任何 QS 数字或「USDT」。
6. **UX 修订 4 D5 在 QS 页上**：结论区块含「判定依据」且与 `verdict.state` 一致；去掉 `<details>` 后不含已登记的英文原因码；「页面不重算」恰好 1 次；三行结论块恰好 1 次（没有对比卡）。
7. **负例（合成的 QS 形状测试夹具 `tests/_qs_q0_fixture.js`，数字是合成的，CI 不读真实文件）**，每条一个测试：
   - `approximations` 与 `APPROXIMATED` 集合不等 → `Q0_ENGINE_APPROXIMATIONS_MISMATCH`；
   - `APPROXIMATED` 缺 `note_zh` → `Q0_APPROXIMATION_SIZE_NOT_DISCLOSED`；未知规则状态 → `Q0_RULE_STATUS_UNKNOWN`；
   - `NOT_IMPLEMENTED` 而 `flag = false` → `Q0_ENGINE_APPROXIMATION_NOT_DECLARED`（不回归）；
   - 若 4.2 选 (c)：有 `APPROXIMATED` 而 `SUPPORTED` → 拒绝；
   - 判据区间或笔数与主数字行不等、G 区间与 `g_vs_btc.OOS.ci` 不等 → `Q0_VERDICT_NOT_FROM_MAIN_ROW`；
   - `identity.supersedes` 项无效或含本文件 sha → `Q0_SUPERSEDES_INVALID`；
   - 缺场景行带数字（存在且非 null）→ 压力块 `INVALID`；缺场景行数字字段缺失 → 通过；
   - `SAME_AS_BASELINE` 行的 `end_capital` 与参照行不等、或没有参照行 → 压力块 `INVALID`；
   - `floor_usd` ≠ 600 或缺失 → 半凯利块 `INVALID`；`f_star ≤ 0` 或 `L_R ≤ 0` 而 `f_half > 0` → 半凯利块 `INVALID`；缺第二个阈值字段 → 半凯利块 `INVALID`；
   - `forward.in_verdict = true` 或 `ledger` 不是本策略 → 只有前向一行无效，结论不变；
   - 主数字行缺 `excluded_funding_missing` → 胜率块 `INVALID`；
   - `SUPPORTED` 且压力场景缺失而无 `STRESS_SCENARIO_MISSING` → `Q0_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS`（G3 不回归）。
8. **档案校验器负例**：LEGACY_V1 档案带 `q0_reading` / `shared_constraints` / `producer` → 拒绝；非 LEGACY 缺 `q0_reading` → 拒绝；`main_row.cost` 不在 `cost_words` → 拒绝；`thresholds[0].value ≠ floor.value` → 拒绝；`shared_constraints` 含数字 → 拒绝；`producer` 未登记 → 拒绝。
9. **M1 成本模型**：真实 M1 包 10 笔逐项对账 ≤ 1e-6、账户等式终点 949.4090992 残差 ≤ 1e-6（本机验收脚本，结果写进 PR）；合成夹具：资金费缺失一笔 → `MISSING`、值为 `null`、不是 0；任一项超容差 → `CRYPTO_M1_COST_MISMATCH`。`US_V5_M1_RESEARCH_COST_V1.js` 的 sha 不变。
10. **A4**：QS case 可按 M0→M1→M2→M3 用自己的证据记录；用 US_V5 的证据、测试档案或跳阶段记 QS 阶段 → 拒绝；QS 诊断不是 `VERIFIED` 时 M1 PASS → 拒绝。
11. **全量**：带 `QRP_DESK_ROOT=/Users/kaylame/KaylaProject/portfolio-desk` 的 QRP 全量测试 0 失败；schema 校验；Research Web `node --check`；`git diff --check`；QS 与 US_V5 详情页在 390 px 与 1280 px 无整页横向滚动。

交付：一个 PR 到 QRP main，冻结后的本规格（与冻结说明）原样作为第一个提交；真实锁的导入、合并与重启 `com.upmeai.qrp-research-web` 由协调会话做。

## 12. 待冻结选择汇总（★ = 推荐）

| # | 选择 | ★ | 其他 |
|---|---|---|---|
| 1 | 导入的文件位置（§1） | 拷到 `var/evidence/qs-v3-m2-q0-2026-10-26/` | 直接从 `research-data` 导入 |
| 2 | `market`（§2.2） | `CRYPTO_USDM_PERP` | `CRYPTO` |
| 3 | plan / amendment 引用（§2.2） | smartflow `44f3eac3` 固定引用 | 镜像进 QRP |
| 4 | 题目队列（§2.2） | 只登记 Q4（未立题） | 空队列 |
| 5 | oos_reuse 说明（§2.2） | 档案 `disclosures_zh` 一行 | 不写 |
| 6 | 判据常量（§3.1） | 代码常量不变 | 搬进档案 |
| 7 | `APPROXIMATED` 是否算缺口（§4.2） | 不算，不封顶（F3、G4） | (b) 算缺口（拒绝本文件，不可用）；(c) 不算但封顶 `SUPPORTED` |
| 8 | 开发期账户（§4.4） | 折叠只报 | 不显示 |
| 9 | 压力金额字段名（§5.2） | 照读 `max_loss_usd`，单位取档案币种 | 要求 `max_loss_usdt`（不可用）；多名依次接受（以后） |
| 10 | 压力金额位数（§5.2） | 非 LEGACY 两位小数 | 整数 |
| 11 | 1m 出场缺场景的角色（§5.3） | 按 G2 当压力场景（压力不完整） | 只报清单（压力变完整） |
| 12 | `SAME_AS_BASELINE`（§5.4） | 认作「与参照相同」，核对 `end_capital`，单独计数 | 当缺场景；抄参照数字 |
| 13 | 资金费 > 5% 未加中位数行（§5.6） | 只显示 | 按缺场景计 |
| 14 | HK 前向配置（§7.2） | 本次不加 QS 组 | 加空组 |
| 15 | 第一次运行（§8） | 只锁第二次，第一次从文件 `supersedes` 显示 | 走锁的替代路线 |
| 16 | `2f0288d8…` 显式拒绝（§8） | 不另登记（一锁规则已拒绝） | 档案加拒绝清单 |
| 17 | A19 显示（§10） | 只写文字 | 显示 L / E* |

## 13. 不做

- 不改封存文件、不重算任何数字、不替研究会话改标签或角色。
- 不改 US_V5 的值、LEGACY_V1 的行为与输出。
- 不写代码，不改 `config/strategy_profiles.v1.json`、`config/hk_forward_observations.v1.json`、`config/m4_scope.v1.json`。
- 不导入任何锁，不碰真实 `var/ledger`、`var/evidence`，不重启 4311。
- 不拷 3.2 GB 原始数据，不在 Mac 上取 Binance。
