# US_CORE_Q0_RESULT_V1 · QRP 导入规格（美股核心轮动长历史 Q0）· DRAFT

状态：**DRAFT，未冻结，不得实现。** 起草：US_CORE 研究设计会话，2026-10-26。冻结：V8.1 协调会话（冻结前可改；冻结后只能另出冻结说明）。
Production effect：`NONE`。本文不改任何研究结果、判据、锁、证据、生产参数或权限；不写代码，不改 `config/strategy_profiles.v1.json`。
QRP 基线：`origin/main` `fd74149`（含 #31 UX 修订 7、#32 Quick Shot V3 导入）。
范本：`docs/contracts/CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE.md`（`001c9041…`，已冻结并实现）。凡本文没写的读法，一律沿用它对非 LEGACY 档案的读法；本文只写 US_CORE 与它不同的地方。

需要选择的地方列出选项，推荐项标 ★；全部选择汇总在第 12 节。

## 0. 依据与结论先行

### 0.1 输入（按内容 sha256 引用）

| 文件 | 位置 | SHA-256 |
|---|---|---|
| 封存结果 `US_CORE_M2_Q0_RESULT_V1.json`（1,170,886 字节） | smartflow `research/us-core-qrp-onboarding` @ `dfe3dcf2`：`trading-system-v2/docs/evidence/us-core-qrp-v1/`；Mac `research-data/qrp_us_core_v1/q0-9e682940/`（两处逐字节相同） | `c5b6fc7e1e29fff97332f5ce7b033725f901f096111da5c1e7e7ad5fa4cc96e9` |
| K2（§1.2 规则清单，§3 M1，§4 A0，§5 Q0，§6 结果字段） | 同上 `docs/US_CORE_QRP_ONBOARDING_K2_DRAFT_V1.md` | `25585dc0acaa27617d66e7eea97c70e8e57aca8a96e42b678aa74c8d46959e41` |
| 冻结裁定 1（11 项全取 ★：R-CMP、R-SEG、R-METRIC、R-HALT、R-KELLY、R-COST 等） | 同上 `docs/US_CORE_QRP_ONBOARDING_FREEZE_1.md` | `3c7fa425cfda4b732461d1173631c2ef5c55f8ba926e1ce1ad940ab1538b4d90` |
| A0 裁定 1（R1 按当日在效读法、R2 一个 float32 步长、R3 未记录、R4 两种读法、R5 当前 D） | 同上 `docs/US_CORE_QRP_ONBOARDING_A0_RULING_1.md` | `50823436049d05ef5901f0047916f82a806a0c488f526a93eb64277272c3d94e` |
| 第 2 次运行报告 | 同上 `docs/US_CORE_QRP_ONBOARDING_RUN_2_REPORT.md` | `192c9c04dac25e3dff2e1bd4232f41eec552b2ad64b5c0477a8e8997a535a6b8` |
| A0 结果（两种读法） | 同上 `docs/evidence/us-core-qrp-v1/US_CORE_A0_RESULT.json` | `67a473f4894f555d4cf7f1061075db32515e13eaf1ad25661f058d3d20927f27` |
| 规则清单 | 同上 `docs/evidence/us-core-qrp-v1/US_CORE_RULE_INVENTORY.json` | `66c645b8d0f7f5f08e087ad2802bb8d6640a6b64cc1c0d376feda7c0c768d55f` |
| M1 封存包清单 `MANIFEST.sha256`（118 个文件，1.1 MB） | Mac `research-data/qrp_us_core_v1/m1/`；HK `/root/qrp-us-core-v1/out/m1/` | `75d9ed07d8d75622a8cebdf81acd9a76e0d5c8024a18b1132265a6927423e434` |
| CRYPTO_Q0_RESULT_V1 导入规格（冻结） | QRP `docs/contracts/` | `001c9041937bef41…` |
| US_V5 Q0 导入规格 / 冻结说明 1 / 冻结说明 2 | QRP `docs/contracts/` | `23689c99…` / `b1700f37…` / `f44c4b62…` |
| UX 修订 4 / 修订 7 | QRP `docs/contracts/` | `9590ef9e…` / `b1532e32…` |
| 多策略档案注册表验收 V1、V8.1 产品里程碑修订 4 | QRP `docs/contracts/` | `f24dd987…`、`fd2bf0ee…` |

### 0.2 今天的导入器读这份文件会怎样（实测，不是推断）

- **测法**：在临时目录（`git archive fd74149`）里，用 `profiles.use()` 把一个 US_CORE 测试档案加进生产注册表。档案仿 QS 的形状，是今天的校验器能接受的最近形状：`main_row` = OOS / BASE / NEXT_OPEN，`market_g_path` = `stats.g_vs_spy.OOS`，`kelly` 照 QS 结构。
- 然后对真实文件跑 `readSealed` → `validateWhole` → `buildBlocks`。只读：没有追加锁，没有写 `var/ledger`、`var/evidence`。

| 位置 | 结果 | 原因 |
|---|---|---|
| `readSealed` | 通过 | sha256 与旁证相符；11 个顶层字段都在（另有 `arms_is`、`trades`、`forward`） |
| `validateWhole` | **整文件拒绝** `Q0_VERDICT_DELTA_CHANGED`（`null/0`） | 文件 `delta_R = null`（K2 R-METRIC：没有 R），导入器要 0.10 |
| ↳ 在内存里补上后 | `Q0_VERDICT_ENGINE_APPROXIMATION_MISSING` | 文件没有 `engine_approximation.approximations`（规则清单没有 `APPROXIMATED`，只有 `missing: []`） |
| ↳ 再补 | `Q0_VERDICT_NOT_FROM_MAIN_ROW` ×3 | 统计行写 `cost_bps: 5`，没有 `cost`；没有 `n`、`mean_R_ci`；G 区间在行内 `g_diff_spy_ci`，不在 `stats.g_vs_spy.OOS.ci` |
| 第 1 块 回测周期与覆盖 | 失败 | 普查列是 `sessions` / `tradable_carriers` / `upro_sessions` / `tqqq_sessions`，档案要的 `tradable_contracts` 不存在 |
| 第 2 块 账户结果 | **可读** | D 61,200 / SPY 买入持有 29,161 / 现金 9,000，2018-01-02 → 2026-09-30 |
| 第 3 块 胜率与赔率 | 失败 | 行内没有 `win_rate`、`n`：本策略的胜率按「持有段」写在 `episodes.lev` / `episodes.bench` 里 |
| 第 4 块 压力 | **可读** | 已执行 9、模拟或补充 2、缺场景 1、参照 1、风控维度 4；最大损失 25,567（`PHASE_NEXT_CLOSE`）。场景名是英文 `label` |
| 第 5 块 半凯利 | 失败 | 没有 `replay`：文件 `half_kelly.state = NOT_APPLICABLE`（R-KELLY ★a） |
| 第 6 块 三态结论 | 可读，但不全 | 只有 G 一行；没有现金一行；R 一行不该有 |
| 结论区块 | 「尚未回测」 | 找不到主数字行 |
| 原因码 | 意思错 | 文件的 `CI_STRADDLES_DELTA` 指「Δg 区间跨过 0」，导入器的词是「每笔净 R 跨过 +0.10 R」；`G_VS_CASH_CI_STRADDLES_ZERO`、`OOS_REUSED_IN_DEVELOPMENT` 没有登记 |

### 0.3 本草稿怎么做

- 文件**原样**导入：不改文件，不重算，不改标签或角色。US_V5（LEGACY_V1）和 Quick Shot V3（CRYPTO_Q0_RESULT_V1）的代码路径与输出一行不变（第 11 节 D1 金样）。
- 新增一个「主指标形态」：`q0_reading.metric.kind`。
  - `PER_TRADE_R`：Quick Shot 今天的读法，档案缺这一项时按它读，所以 QS 不改。
  - `G_GAP`：US_CORE 的读法。没有 R，主指标是样本外年化对数增长差。
- 其余新读法（A0 两种读法、高亮的风控行、半凯利不适用、场景中文名、原因词）都放进 US_CORE 档案自己的 `q0_reading` 子项。QS 档案不写它们，读法不变。

## 1. 文件与封存

1. 沿用 US 导入规格第 1 节。
2. 导入的文件位置：
   - ★(a) 照 US / QS 先例，把 Mac 上的文件和旁证原样拷到 `var/evidence/us-core-m2-q0-2026-10-26/`，核对 sha256 后从那里导入；
   - (b) 直接从 `research-data/qrp_us_core_v1/q0-9e682940/` 导入。
3. 命令：`QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_baseline_evaluation.js --file <绝对路径> --strategy US_CORE_9000USD_3X_GATEOBS --registered-by V8_1_COORDINATOR`
4. `result_id = Q0-c5b6fc7e1e29fff9`；case = `RRC-US-CORE-9000-V8-1-M0`。这是这个 case 的第一把锁，不带 `--supersedes`；文件里没有 `identity.supersedes`。
5. 运行 1 的 A0 文件（`f553c11c…`，只有 K2 原文读法）只在 smartflow 的 `superseded-1/` 里，不导入，也不在页面上出现。

## 2. P1 · US_CORE 策略档案项

### 2.1 提议的档案项（冻结后由实现会话写进 `config/strategy_profiles.v1.json`；本草稿不写）

```json
{
  "strategy_ref": "US_CORE_9000USD_3X_GATEOBS",
  "case_ref": "RRC-US-CORE-9000-V8-1-M0",
  "market": "US_EQUITY",
  "currency": "USD",
  "display_name": "US_CORE",
  "comparators": [
    { "key": "SPY_BUY_HOLD", "label_zh": "SPY 买入持有", "role": "MARKET" },
    { "key": "CASH", "label_zh": "现金", "role": "CASH" }
  ],
  "floor": { "value": 5400, "currency": "USD", "rule_label_zh": "Rule 1b 的 5,400（9,000 的 40% 线）" },
  "baseline_result_schema": "US_CORE_M2_Q0_RESULT_V1",
  "import_profile_id": "docs/contracts/US_CORE_Q0_RESULT_V1_IMPORT_PROFILE.md",
  "comparison_import_profile_ids": [],
  "phase_words": { "NEXT_OPEN": "下一开盘成交", "NEXT_CLOSE": "下一收盘成交", "ONE_SESSION_LATE": "晚一个交易日成交" },
  "segment_words": { "IS": "开发期", "OOS": "样本外" },
  "cost_model_id": "US_V5_M1_RESEARCH_COST_V1",
  "m1_evidence": {
    "manifest_ref": "docs/evidence/CYCLE_RESEARCH_DESK_US_CORE_M1_NATIVE_DIAGNOSTIC_2026-10-26.json",
    "manifest_sha256": "<该 QRP 证据清单写成后的 sha256，第 9 节>",
    "diagnostic_schema": "US_CORE_M1_STRATEGY_DIAGNOSTIC_V1",
    "producer": "US_CORE_M1_PRODUCER_V1"
  },
  "forward_observation_source_key": "US_CORE_9000USD_3X_GATEOBS",
  "research_program": {
    "plan_ref": "smartflow:research/us-core-qrp-onboarding@dfe3dcf2:trading-system-v2/docs/US_CORE_QRP_ONBOARDING_K2_DRAFT_V1.md",
    "amendment_ref": "smartflow:research/us-core-qrp-onboarding@dfe3dcf2:trading-system-v2/docs/US_CORE_QRP_ONBOARDING_A0_RULING_1.md",
    "default_question": null,
    "queue": {}
  },
  "q0_reading": {
    "metric": { "kind": "G_GAP", "min_months": 30 },
    "main_row": { "segment": "OOS", "cost_field": "cost_bps", "cost": "5", "phase": "NEXT_OPEN" },
    "cost_words": { "5": "每边 5 bp", "15": "每边 15 bp" },
    "phase_note_zh": "生产在收盘后决定、下一个交易日开盘成交；另有两种相位压力：下一收盘成交、晚一个交易日成交（K2 §5）。",
    "census_columns": [
      { "field": "tradable_carriers", "label_zh": "可交易的 3x 载体（UPRO、TQQQ）" },
      { "field": "sessions", "label_zh": "交易日" }
    ],
    "g_paths": { "market": { "point": "g_diff_spy", "ci": "g_diff_spy_ci" }, "cash": { "point": "g", "ci": "g_ci" }, "months": "months" },
    "winrate": { "basis": "EPISODES", "tier": "lev", "label_zh": "3x 持有段", "other_tiers": [{ "tier": "bench", "label_zh": "1x 持有段" }] },
    "kelly": {
      "mode": "NOT_APPLICABLE",
      "floor_field": "floor_usd",
      "probabilities": [
        { "field": "p_below_floor", "label_zh": "权益曾低于 5,400（Rule 1b 40% 线）" },
        { "field": "p_end_below_start", "label_zh": "期末低于起点 9,000" }
      ],
      "events": { "path": "rule1b_events.OOS", "label_zh": "样本外主臂越过 40% 线" }
    },
    "forward": { "kind": "EQUITY", "ledger_field": "book", "ledger_must_equal_strategy_ref": true },
    "a0": { "dual_reading": true, "ruling_sha256": "50823436049d05ef5901f0047916f82a806a0c488f526a93eb64277272c3d94e",
      "literal_note_zh": "按 K2 原文：A0-1、A0-2 未通过（U6 在窗口中间才部署；09-28 的 ^TNX 收盘差一个 float32 步长）" },
    "highlights": [
      { "key": "RULE1B_HONORED", "scenario": "RISK_RULE1B_HONORED", "label_zh": "若照 Rule 1b 停止", "diagnosis_id": "DX-RISK-1" }
    ],
    "oos_reuse": { "reason_code": "OOS_REUSED_IN_DEVELOPMENT",
      "text_zh": "样本外在开发时已用过：这条规则 2026-08-15 在 2010–2026 的同一份数据上选出（oos_reuse = true）；真正没用过的只有 2026-10-01 起的前向。" },
    "reason_words_zh": {
      "CI_STRADDLES_DELTA": "相对 SPY 买入持有的年化对数增长差，95% 区间跨过门槛 0（这一条本身不足以判定）",
      "G_VS_CASH_CI_STRADDLES_ZERO": "相对现金的年化对数增长，95% 区间跨过 0（这一条本身不足以判定）",
      "OOS_REUSED_IN_DEVELOPMENT": "样本外在开发时已用过"
    },
    "scenario_words_zh": {
      "BASELINE": "当前 D 参照（样本外）",
      "COST_15BPS": "费用：每边 15 bp",
      "PHASE_NEXT_CLOSE": "下一收盘成交",
      "PHASE_ONE_SESSION_LATE": "晚一个交易日成交",
      "INTERVAL_20110701_20111230": "区间重放 2011-07 → 2011-12",
      "INTERVAL_20150803_20160229": "区间重放 2015-08 → 2016-02",
      "INTERVAL_20181001_20181231": "区间重放 2018-10 → 2018-12",
      "INTERVAL_20200219_20200430": "区间重放 2020-02 → 2020-04",
      "INTERVAL_20220103_20221031": "区间重放 2022-01 → 2022-10",
      "INTERVAL_20250219_20250430": "区间重放 2025-02 → 2025-04",
      "EXTREME_DOWNTURN_2008": "极端下跌 2007–2009",
      "RISK_RULE1B_HONORED": "风控：照 Rule 1b 停止",
      "RISK_NO_MACRO_GATE": "风控：关掉宏观闸",
      "RISK_PRE_U6_MACRO": "风控：U6 之前的收益率读法",
      "RISK_WHOLE_SHARES": "风控：整股"
    },
    "reference_arms": true,
    "dev_arms_path": "arms_is"
  }
}
```

### 2.2 选择

- **比较对象标签**：
  - ★(a) `SPY 买入持有`（与 US_V5 同一写法；US_V5 的 SPY 也是总收益，修订 2 M2.5）。「总收益（含分红）」由第 2 块读文件 `arms.SPY_BUY_HOLD.basis` 写一次。
  - (b) 标签写成 `SPY 买入持有（总收益）`：一句话结论和数字卡都会带上这几个字。
- **plan_ref / amendment_ref**：★ 指向 smartflow 固定提交 `dfe3dcf2`，sha 记在 0.1，同 QS 先例；不镜像进 QRP。
- **queue**：★ 空。US_CORE 还没有 M2 实验题；诊断清单里每条 `proposed_experiment` 都是 `null`，并写了 `no_topic_reason`。
- **成本模型**：★ 冻结裁定 1 R-COST，复用 `US_V5_M1_RESEARCH_COST_V1`，不新写模块（第 9 节）。
- **场景中文名 `scenario_words_zh`**：文件的 `label` 大多是英文（补充行是中文）。
  - ★(a) 档案按场景 id 给显示名；它只是页面上的名字，取自冻结 K2 §5 的说法。文件的 `label` 原文放进技术详情，不改文件，也不改角色。
  - (b) 照 G1 显示英文原文。
- **参照臂**：★(a) 第 2 块折叠显示文件里 `role: REFERENCE` 的四个参照臂，标「参照，不进判定」；(b) 不显示。
- **开发期账户**：文件把开发期三臂放在 `arms_is`，不是 `arms.IS`。★(a) 档案写 `dev_arms_path`，折叠只报，同 QS §4.4 (a)；(b) 不显示。

### 2.3 校验器（`services/strategy-profiles`）新增

1. `q0_reading.metric` 缺省按 `{ kind: 'PER_TRADE_R' }` 读，QS 档案不改。`kind` 只认 `PER_TRADE_R`、`G_GAP`，其他 → `STRATEGY_PROFILE_FIELD_TYPE`。
2. `G_GAP` 档案必须有：
   - `g_paths.market` / `g_paths.cash`（`point`、`ci`）、`g_paths.months`；
   - `metric.min_months`（正整数）；
   - `winrate.basis = 'EPISODES'` 与 `winrate.tier`；
   - `kelly.mode`。
   缺 → `STRATEGY_PROFILE_FIELD_MISSING`。
3. `main_row.cost_field` 缺省为 `cost`（QS 不改）。`main_row.cost` 必须是 `cost_words` 的键；比较时用 `String(row[cost_field]) === main_row.cost`。
4. `kelly.mode = 'NOT_APPLICABLE'`：
   - 不得带 `fixed_arm`、`thresholds`；
   - `probabilities[]` 每项 `field` 不重复，`label_zh` 非空；
   - `floor_field` 必填。
   缺省 `mode` 按 `FIXED_RISK` 读（QS 不改）。
5. `a0.dual_reading = true` 时 `ruling_sha256` 必须是 64 位十六进制。
6. `highlights[]`：每项 `scenario` 以 `RISK_` 开头，`key` 不重复，最多 2 项（不在页面上堆高亮）。
7. `reason_words_zh` 只能覆盖文字，不得改变判定。键必须是大写下划线的原因码。
8. `scenario_words_zh` 的值必须是非空中文串。
9. LEGACY_V1 档案带以上任一新子项 → `STRATEGY_PROFILE_FIELD_TYPE`（同 QS §2.3 第 1 条）。

## 3. P2 · 主判据（`G_GAP`）与「判定依据」

### 3.1 判据（K2 §5 R-METRIC，冻结裁定 1）

- 主指标：样本外年化对数增长差 Δg = g_D − g_SPY(总收益)；δ_g = 0；按自然月分块 bootstrap 95%；样本单位 = 月，至少 30 个月。
- 三态：
  - `SUPPORTED`：L(Δg) > 0 且 L(g_D − g_现金) > 0，月数 ≥ 30，A0 通过，规则清单无 `NOT_IMPLEMENTED`；
  - `NOT_PASSED`：U(Δg) ≤ 0；
  - `INSUFFICIENT`：其余。
- 判据常量：
  - ★(a) `DELTA_G = 0` 与 `ci_method` 仍是代码常量；`G_GAP` 的月数门槛读 `metric.min_months`（30）。`G_GAP` 档案要求 `verdict.delta_R === null`：有值即拒绝，`Q0_VERDICT_DELTA_CHANGED`。
  - (b) 把 δ_g、月数门槛都搬进档案。
- 整文件检查（`G_GAP`，替代 `PER_TRADE_R` 的那几条）：
  - `SUPPORTED` 须满足 L_g > 0、`L_g_cash` > 0、`n_months ≥ min_months`、A0 通过、无缺口，否则 `Q0_VERDICT_SUPPORTED_WITHOUT_EVIDENCE` 或 `Q0_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL`；
  - `NOT_PASSED` 须 U_g ≤ 0，否则 `Q0_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE`。
  - 冻结说明 2 G3 的 `STRESS_SCENARIO_MISSING` 检查照旧。

### 3.2 主数字

- 取 `stats.rows` 中 `segment = OOS`、`cost_bps = 5`、`phase = NEXT_OPEN` 的一行。
- 标签：「样本外年化对数增长差，相对 SPY 买入持有（每边 5 bp，下一开盘成交；门槛 0）」。
- 数值 **+8.5%**，95% 区间 **−12.5% 至 +29.1%**。g 用现有的一位小数百分比格式；原值在技术详情。
- **紧挨主数字的下一行**（主内容，不折叠）：`q0_reading.oos_reuse.text_zh`。
  - 条件：文件 `verdict.oos_reuse === true`，且 `reason_codes` 含 `OOS_REUSED_IN_DEVELOPMENT`。
  - 两者不一致（一个有一个没有）→ 拒绝导入，`Q0_OOS_REUSE_NOT_DISCLOSED`。
  - 这一行是协调会话要求的「主数字旁的样本外复用标记」。

### 3.3 结论与主数字同源（`G_GAP` 版）

- `[verdict.L_g, verdict.U_g]` 必须逐值等于主数字行的 `g_diff_spy_ci`；
- `[verdict.L_g_cash, verdict.U_g_cash]` 必须逐值等于主数字行的 `g_ci`；
- `verdict.n_months` 必须等于该行的 `months`；`verdict.g_diff_spy` 必须等于该行的 `g_diff_spy`。
- 不等 → `Q0_VERDICT_NOT_FROM_MAIN_ROW`，写明哪一项。真实文件四项都相等。
- `verdict.n_trades`（140 次换档）只在技术详情里显示，不是样本单位。

### 3.4 页面文字（真实文件，测试逐字断言）

- 结论：「证据不足」。
- 判定依据（主内容）：
  1. 「相对 SPY 买入持有的年化对数增长差 +8.5%，95% 区间 −12.5% 至 +29.1%，区间跨过门槛 0」
  2. 「相对现金的年化对数增长 +22.0%，95% 区间 −4.7% 至 +48.7%，区间跨过门槛 0」
  3. 「样本外 105 个月（门槛 30 个月）」
  4. 「门槛在看到结果前已冻结」
- 最大的限制：「相对 SPY 买入持有与相对现金的年化对数增长，95% 区间都跨过门槛 0，现有样本不足以判定。」
- 原因码由 `reason_words_zh` 覆盖后写中文，主内容不出现英文码（UX 修订 4 D1.3）。档案未覆盖的码仍用全局词表。
- **不得出现**：「每笔扣费后净 R」「+0.10 R」「成熟交易」「笔」作为样本单位。

## 4. P3 · 规则清单、A0 的两种读法

### 4.1 规则清单

- 文件 25 条：已实现 10、不适用 15、未实现 0、已知近似 0。
- UC-D1（Yahoo 事后修订）、UC-E5（缺 bar 的处理）是 `IMPLEMENTED`，另带 `approximation` 文字。这是冻结 K2 §1.2 的写法，文件不能改成 `APPROXIMATED`。
  - ★(a) 照文件读作「已实现」。技术详情的规则清单里，这两条下面写它们的 `approximation` 原文，标「附近似说明」。引擎标签：「当前 D（引擎对齐关卡 A0 按 A0 裁定 1 通过；规则清单无未实现项，2 条附近似说明）」。
  - (b) 页面把它们改称「已知近似」：等于 QRP 替文件改状态，不采用。
- `verdict.engine_approximation.approximations` 缺失：
  - ★(a) 非 LEGACY 档案在规则清单没有 `APPROXIMATED` 时，缺失按 `[]` 读；有 `APPROXIMATED` 而缺失仍拒绝。这对 QS 没有影响，QS 文件写了这个字段。
  - (b) 只对 `G_GAP` 档案放宽。

### 4.2 A0：两种读法都要显示（A0 裁定 1 R3、R4）

文件 `gates.A0`：`state: PASSED`、`basis: 'A0 ruling 1'`、`passed_checks: '5 / 5'`、`k2_literal: {state: FAILED, passed_checks: '3 / 5'}`、`unknown_counts: {A0-1: 36, A0-2: 6}`、`result_sha256: 67a473f4…`、`rows`（逐项计数）。

整文件检查（`a0.dual_reading = true` 时）：
- `gates.A0.basis`、`k2_literal.state`、`k2_literal.passed_checks`、`unknown_counts` 必须都在，否则 `Q0_A0_DUAL_READING_MISSING`；
- `identity.a0_ruling_1_sha256` 必须等于档案 `a0.ruling_sha256`，否则 `Q0_A0_RULING_MISMATCH`；
- `gates.A0.result_sha256` 必须等于 `identity.a0_result_sha256`。

页面（第 1 块主内容，一行，不折叠）：

「引擎对齐关卡 A0：按 A0 裁定 1 通过（5 / 5）；按 K2 原文 3 / 5（A0-1、A0-2 未通过：U6 在窗口中间才部署；09-28 的 ^TNX 收盘差一个 float32 步长）；未记录 42 项（A0-1 36、A0-2 6），不计入一致或不符」

- 「5 / 5」「3 / 5」、两个计数取自文件；括号里的原因取自档案 `a0.literal_note_zh`，即 A0 裁定 1 R1/R2 的事实；「42」是两个计数之和，属于页面只做计数的范围。
- 技术详情：`gates.A0.rows` 逐项计数，A0 结果 sha，裁定 sha。
- 其他关卡 `TWIN_PARITY`、`SLICE_PARITY` 按现有 `gateLine` 进技术详情：「TWIN_PARITY：通过」「SLICE_PARITY：通过」。

### 4.3 第 1 块其余

- 分段：IS 2010-02-11 → 2017-12-29（1,986 个交易日），OOS 2018-01-02 → 2026-09-30（2,198 个交易日）；`tradable_carriers = 2`、`pool_overlap_ratio = 1` 照显示。
- 年度普查：两列（可交易的 3x 载体、交易日），2010 → 2026。

## 5. P4 · 压力

### 5.1 角色（冻结说明 2 G2，不变）

真实文件 17 行：

| 角色 | 行数 | 内容 |
|---|---|---|
| 当前 D 参照 | 1 | `BASELINE` |
| 压力场景 | 9 | 费用 1、相位 2、区间重放 6 |
| 缺场景 | 1 | `EXTREME_DOWNTURN_2008` |
| 补充 | 2 | 合成 3x 2000–02、2007–09；`simulated: true`、`in_headline: false`、`SUPPLEMENTARY_NOT_IN_CONCLUSION` |
| 风控维度 | 4 | `RISK_*` |

`RISK_PRE_U6_MACRO` 与参照行四项相同，按 UX 修订 4 D3.3 标「与参照相同」（只比较两行的字段）。

### 5.2 「最大损失」主数字

- 范围按 G2。真实文件：**25,567 美元，场景「下一收盘成交」**（`PHASE_NEXT_CLOSE`，`max_loss_usd = 25567.25…`）。
- 这是复利后账户上的美元回撤，可能被误读成「9,000 本金里亏掉 25,567」。
  - ★(a) 主数字后面紧跟该行文件自带的 `max_drawdown`：「最大损失：25,567 美元（场景：下一收盘成交；回撤 47.6%，复利后账户上的美元数）」。
  - (b) 只写美元数。
- 金额位数：★ 美元整数，与 US_V5 同一格式（两条美股策略一致）；或两位小数（QS 的非 LEGACY 写法）。

### 5.3 2008：缺场景

- 行：`EXTREME_DOWNTURN_2008`，`missing: true`，`missing_reason`「2007–2009 没有可交易的 3x 载体（UPRO 2009-06-25、TQQQ 2010-02-11 上市）」，数字字段显式为 `null`。
- 三行（G3，结论区块一次）：
  1. 「优势结论：证据不足」
  2. 「压力评价不完整：缺场景 1 个、无效输入 0 个（极端下跌 2007–2009：缺场景）」
  3. 「采用条件：未满足（必要压力缺失，§6.7）」

### 5.4 补充：合成 3x（模拟，不进结论）

- 两行照 G2：`simulated: true`、`in_headline: false`，不进最大损失，不算已执行的压力。页面写文件的中文 `label` 原文（它已写明「模拟序列，不是可交易历史」），并加「模拟，不进结论」。
- 2000–02 一行：回撤 70.7%，期末 2,635。只在压力表里，不进主数字、总览或结论。

### 5.5 计数行（真实文件）

「已执行 9 个压力场景，模拟或补充 2 个，缺场景 1 个，无效输入 0 个；另有当前 D 参照 1 行、风控维度 4 行（只报不判，不进最大损失）。缺场景和无效输入不计为已执行的压力。」

## 6. P5 · 风控行高亮：`RISK_RULE1B_HONORED` 与停止记录的写入缺口

协调会话要求把这一行放在总览和回测结论卡的显眼处，同时它仍是只报不判的风控维度行（G2），不进最大损失，也不进结论。

### 6.1 读法（`q0_reading.highlights[]`）

- 行：`scenario = RISK_RULE1B_HONORED`，`report_only: true`，`end_capital = 6145.40`，`max_drawdown = 0.441`。
  - `halt_events[0]`：`session 2019-05-28`，`equity 6553.52`，`peak 11001.25`，`drawdown 0.4043`，`effect NEW_ENTRIES_REFUSED_FROM_NEXT_SESSION`。
- 对照数取 `BASELINE` 行的 `end_capital`（61,200.04），必须等于主数字行的 `end_capital`（1e-6）。
- 缺口一行取诊断清单里 `id = highlights[].diagnosis_id`（`DX-RISK-1`）的 `facts_zh[0]` 原文。
- 检查只让高亮这一行无效（写「风控高亮无效：<原因>」），不影响结论：
  - 行不存在、不是 `RISK_` 开头、`report_only !== true`；
  - `halt_events` 不是非空数组；
  - 参照与主数字行期末不等；
  - 诊断项不存在。

### 6.2 页面文字（真实文件）

回测结论卡，「判定依据」下面、「另须知道」上面，主内容，不折叠：

> **若照 Rule 1b 停止（只报不判，不进结论）**：样本外 2019-05-28 自起点峰值 11,001 回撤 40.4% 触发停止，之后不再开新仓，期末 6,145；现行主臂不执行停止，期末 61,200。
> 生产缺口（未修）：Rule 1b 停止记录写不进 US_CORE_*_GATEOBS（new-entry-halt-writer.js:41-42,91，recordHaltForReview → NOT_A_HALTABLE_BOOK）。

- 数字取整与千分位同总览（`whole`）；40.4% 是文件 `drawdown` 的一位小数。
- 第二行是诊断项原文，带文件名与行号（技术事实），保留英文代码名，不当作原因码。

### 6.3 不做

- 不把 6,145 当作结论、主数字或最大损失。
- 不改它的角色。
- 不在 US_V5 或 QS 页面显示。

## 7. P6 · 半凯利：`NOT_APPLICABLE`

### 7.1 读法（`kelly.mode = NOT_APPLICABLE`）

文件 `half_kelly`：
- `state: 'NOT_APPLICABLE'`；`reason`「没有止损与每笔风险单位，仓位是整袖资本按档位持有（FREEZE_1 R-KELLY ★a）」；
- `floor_usd: 5400`；`p_below_floor: 0.2556`；`p_end_below_start: 0.0554`；`paths: 10000`；`method`；
- `rule1b_events {OOS: 13 项, FULL: 20 项}`；`u5_alert_crossings_30pct {OOS: 23, FULL: 38}`。

第 5 块检查（只让本块 `INVALID`）：
- `state !== 'NOT_APPLICABLE'`；
- `reason` 为空；
- `floor_field` 指定的字段（`floor_usd`）缺失或 ≠ `floor.value`（5,400）；
- `probabilities[].field` 任一缺失或不在 0–1；
- `paths` 不是正整数；
- `events.path` 指向的不是数组。

### 7.2 页面文字（真实文件）

- 首行：「半凯利：不适用——没有止损与每笔风险单位，仓位是整袖资本按档位持有」（替代「不支持按凯利加仓…半凯利比例为 0」，那一句不得出现）。
- 卡：「按样本外月度分块重抽 10,000 条路径：权益曾低于 5,400 美元（Rule 1b 40% 线）的概率 25.6%；期末低于起点 9,000 的概率 5.5%」。
- 一行：「样本外主臂越过 40% 线 13 次（第一次 2019-05-28）」。次数是数组长度，日期是第一项的 `session`。
- 脚注：「研究计算，不是仓位建议；现行仓位规则不变。底线：Rule 1b 的 5,400（9,000 的 40% 线）。」

## 8. P7 · 胜率、前向、总览

### 8.1 第 3 块：持有段胜率（`winrate.basis = EPISODES`）

- 每个统计行读 `episodes[tier]` 的 `n`、`win_rate`、`payoff`、`mean_return`、`mean_days`，以及 `episodes[other].n`；同一行另显示 `g`、`g_diff_spy`（及区间）、`cagr`、`max_drawdown`、`end_capital`、`switches`。
- 12 行：开发期 / 样本外 × 5 / 15 bp × 三种相位。
- 不读 `mean_R`、`n`（行级），也不要求它们存在。
- 主数字行（样本外、5 bp、下一开盘）：
  - 3x 持有段 48 段，胜率 39.6%，赔率 3.76，平均每段 +6.9%，平均 91 天；
  - 1x 持有段 44 段。
- 列名用「段」，不用「笔」。
- 公式表：文件 `formula_table.kind = FORMULA_NOT_BACKTEST`，`basis`「per 3x episode: p·ln(1 + b·L) + (1 − p)·ln(1 − L)…」。页面写「公式推算，不是回测」，`basis` 原文进技术详情；`cells` 的 `loss_per_episode` 列照显示。
- `phase_note_zh` 写在表上方。

### 8.2 第 2 块末：前向（`forward.kind = EQUITY`）

- 文件 `forward`：`{in_verdict: false, book: 'US_CORE_9000USD_3X_GATEOBS', from: '2026-10-08', to: '2026-10-23', start_equity: 9000, end_equity: 7836.21192664, return: −0.1293…}`。
- 检查（只让这一行无效）：
  - `in_verdict === false`；
  - `book` 等于 `strategy_ref`；
  - `start_equity`、`end_equity`、`return` 为有限数；
  - `return` 与 `end_equity / start_equity − 1` 相差 ≤ 1e-6（核对，不重算显示值）。
- 页面：「前向记录（PAPER 账本 US_CORE_9000USD_3X_GATEOBS，只报不判，不进结论）：2026-10-08 → 2026-10-23，9,000 → 7,836（−12.9%）。」
- 「前向观察」一节：「Q0 结果文件里带有前向记录（只报不判）；HK 前向影子：本策略尚未登记。」
  - `config/hk_forward_observations.v1.json`：★ 本次不加 US_CORE 组。
  - HK 上跑着的 `us-core-whipsaw-band075-shadow` 是候选的影子，登记它属于以后的实验题。

### 8.3 总览（UX 修订 7 J1）

**一句话结论**（服务端模板）：
- `sentenceOf` 头一段对 US_CORE 原样成立：「现行版本样本外期末 61,200，高于 SPY 买入持有的 29,161（证据不足）」。
- 没有锁定的对比结果，修订 6 的采用一览为 `null`，所以没有后半句。
- `G_GAP` 档案另加两段，模板写在 `summary.js`。只有档案有 `oos_reuse` / `highlights` 时才加，所以 US_V5、QS 的句子不变。
- 完整句：

  > 现行版本样本外期末 61,200，高于 SPY 买入持有的 29,161（证据不足；样本外在开发时已用过）；若照 Rule 1b 停止，2019-05-28 起不再开新仓，期末 6,145。

**关键数字卡**（`tilesOf`），6 张，每张链接到细节：

| # | 卡 | 内容 | 链接 |
|---|---|---|---|
| 1 | 现行对比 SPY 买入持有的期末 | 61,200 对 29,161，2018-01-02 → 2026-09-30 | `section=runtime&block=account` |
| 2 | 最大回撤 | 46.1% 对 33.7% | 同上 |
| 3 | 样本外 3x 持有段胜率与赔率 | 39.6%、3.76，48 段；行标「样本外 · 每边 5 bp · 下一开盘成交」 | `block=winrate` |
| 4 | 半凯利 | 「不适用」；「权益曾低于 5,400 的概率 25.6%」 | `block=kelly` |
| 5 | 若照 Rule 1b 停止（新卡 `rule1b`） | 期末 6,145 对现行 61,200；停止日 2019-05-28；下面一行小字「生产缺口：停止记录写不进本账本（未修）」 | `block=stress` |
| 6 | 最长水下期与「期末是否回到最高点」 | 508 个交易日；期末未回到最高点 | `block=account` |

- **没有「采用率」卡**：`overview` 为 `null` 时 `tilesOf` 本来就不加它。有对比题锁定之前不显示，也不显示「—」。
- **研究结论与采用一览**：不显示（同上）。
- **现在生效的规则版本与待办**：Desk 登记的现行版本照现有 `rulesOf`。「下一步研究」为空时写「尚未立题」。生产缺口不列为待办：它不是研究队列的一项，已在卡 5 与结论卡出现。

**长度**：J5.1 ≤ 1,600 px（1280 × 800），390 px 宽无整页横向滚动；测试断言。

## 9. P8 · M1：`US_V5_M1_RESEARCH_COST_V1` 复用与 US_CORE 生产者

### 9.1 为什么要一个生产者

- US 的 `buildDiagnostic` 读 US_V5 的证据清单与交易行；QS 的生产者读数据库行。
- US_CORE 的 M1 包是账本 JSON 加决策输入（M1 包 `75d9ed07…`）。
- 所以要登记 `US_CORE_M1_PRODUCER_V1`，模块 `services/strategy-diagnostics/producers/US_CORE_M1_PRODUCER_V1.js`。成本模型不新写。

### 9.2 成本：复用 `US_V5_M1_RESEARCH_COST_V1`（R-COST ★a）

- 一个袖持有某载体的一段 = 一个来回：开仓事件是买入，平仓事件是卖出。
- 9000 簿窗口内**没有已平仓的来回**：10-08 两笔交接买入至 10-23 仍持有。
- 所以：
  - 已平仓来回 0 个，`calculateCosts` 不调用；
  - 未平仓 2 笔只列入场侧：签署成本各 2.25（= 4,500 × 5 bp，已含在成交里，与账本 `buyFee` 相等，1e-6）；
  - 监管费覆盖层的 CAT 买入侧，按模块的 `ceilCent` 与同一组费率参数单列，标「未平仓：只计入场侧」。
  - 卖出侧的 SEC / TAF / CAT 不写「0」，写「未发生」。
- `US_V5_M1_RESEARCH_COST_V1.js` 的 sha 不变。

### 9.3 USD 账户等式（残差 ≤ 1e-6）

- 起点：2026-10-08 开盘前 9,000，两袖各 4,500 现金。
- 每笔买入：`units = cash × (1 − 0.0005) ÷ 开盘价`（12 位小数）。UPRO 29.259367449148、TQQQ 54.634074299787，与账本逐位相等（A0-3 已验）。
- 每天：`权益 = Σ 袖 (cash + units × 收盘价)`（8 位小数规范化）；终点 7,836.21192664（10-23）。
- 只用本簿的行；前身簿（6000 GATEOBS 等）的盈亏不进等式（A4.3）。

### 9.4 证据与一次决策追踪（K2 §3）

- QRP 证据清单 `docs/evidence/CYCLE_RESEARCH_DESK_US_CORE_M1_NATIVE_DIAGNOSTIC_2026-10-26.json`，含：
  - `strategy_ref`、`case_ref`、`window`；
  - `cost_model{model_ref, 参数}`；
  - `input_package{relative_root, digest}`、`source_package{manifest_sha256: 75d9ed07…}`。
- M1 包原样拷到 `var/evidence/us-core-m1-2026-10-08_2026-10-23/`，逐文件按 `MANIFEST.sha256` 核对。
- 决策追踪：
  1. 10-07 收盘，前身簿决定两袖 3x；
  2. 10-08 开盘交接买入（`BOOK_HANDOVER_OPEN`）；
  3. 之后 11 天持有：逐日 close 对 SMA200 / SMA50，宏观 `normal`，利差闸 S2 / S3 → `DISPLAY_ONLY`；
  4. 10-23 权益 7,836.21。
- 一项缺项的显示：Rule 1b 停止记录写不进本簿（UC-G4）。
- A4 不变：US_CORE 的阶段只认自己的 case 与证据；US_V5 的证据、测试档案不能充当。

## 10. P9 · 没有共享约束

- US_CORE 不与其他账本共享亏损预算。
- 海外桶 V3（16,000，40% 线）是桶级规则，冻结 K2 写「只引用不复算」，规则清单里没有单列的一条。
  - ★(a) 档案不写 `shared_constraints`，页面不出现桶的数字；
  - (b) 加一项「海外桶 V3：与 US_V5、C17_V2、Quick Shot V3 共享，未复算」。规则清单没有对应的 `NOT_APPLICABLE` 条目，按 QS §10 的一致性检查会写「不一致」，所以不推荐。

## 11. P10 · 确定性测试

实现会话必须全部通过；用真实文件的断言在 PR 里给出输出 sha256。

1. **D1 金样：US_V5 与 QS 逐字节不变。**
   - 用 `qrp-profile-registry-d1/` 的 `capture.js`，在 `fd74149` 与实现分支上各抓一次：US_V5、Quick Shot V3 的策略详情（全部页签）与全部 API 响应。
   - 允许变化的只有：US_CORE 自己的路由；列出 US_CORE 的条目（策略总览一行、M4 面板里 US_CORE 一项从「已列入 M4 范围，尚未接入」变为它自己的 M0–M3 状态）。
   - PR 逐个列出变化的文件、原因和 sha256 对比。
2. **既有锁重导入相同**：`reimport.sh` 在临时账本副本里重导真实账本里现有的全部锁（US_V5 的 Q0 与各对比题锁、QS Q0），锁记录与 hash 与真实账本相同。
3. **真实 US_CORE 文件导入（临时账本）**：
   - `result_id = Q0-c5b6fc7e1e29fff9`；`strategy_ref`、`case_ref`、`verdict_state = INSUFFICIENT`、`file_sha256` 正确；`inputs_digest`、`engine_digest` 写进 PR，冻结后作为金值。
   - **重复导入是幂等重放**：同一把锁，不追加第二条记录。
   - 用 `--strategy US_V5_ETF_3000USD` 导这个文件 → `Q0_RESULT_SCHEMA_UNSUPPORTED`；用未登记的 `--strategy` → `STRATEGY_PROFILE_NOT_REGISTERED`，账本不写。
   - 真实 `var/ledger`、`var/evidence` 前后 sha 相同。
4. **真实文件的页面断言**（逐字）：
   - 第 3.2 节主数字与紧挨的样本外复用行；
   - 第 3.4 节判定依据四行与最大的限制；
   - 第 4.2 节 A0 一行；
   - 第 5.2 节最大损失；第 5.3 节三行；第 5.5 节计数行；
   - 第 6.2 节两行（结论卡）；第 7.2 节首行、卡、越线一行；
   - 第 8.2 节前向两句；第 8.3 节一句话结论与 6 张卡。
5. **US_CORE 页面不得出现**：
   - 「USDT」「BTC」「每笔扣费后净 R」「+0.10 R」「成熟交易」「5 bps」「相位 ±60 分钟」「120 分钟」「h+1」「半凯利比例为 0」「采用率」；
   - 任何 US_V5 或 QS 的数字。
6. **US_V5 与 QS 页面不得出现**：「US_CORE」「5,400」「61,200」「若照 Rule 1b 停止」。
7. **UX 修订 4 D5 / 修订 7 J5 在 US_CORE 页上**：
   - 结论区块含「判定依据」，且与 `verdict.state` 一致；
   - 去掉 `<details>` 后不含已登记的英文原因码；
   - 「页面不重算」恰好 1 次；三行结论块恰好 1 次；
   - 总览 ≤ 1,600 px，390 px 无整页横向滚动。
8. **负例**：合成的 US_CORE 形状测试夹具 `tests/_us_core_q0_fixture.js`，数字是合成的，CI 不读真实文件。每条一个测试：
   - `G_GAP` 而 `delta_R` 不是 `null` → `Q0_VERDICT_DELTA_CHANGED`；
   - `L_g/U_g`、`L_g_cash/U_g_cash`、`n_months`、`g_diff_spy` 任一与主数字行不等 → `Q0_VERDICT_NOT_FROM_MAIN_ROW`；
   - `SUPPORTED` 而 L_g ≤ 0、或 L_g_cash ≤ 0 → `Q0_VERDICT_SUPPORTED_WITHOUT_EVIDENCE`；
   - `SUPPORTED` 而月数 < 30 → `Q0_VERDICT_SUPPORTED_SAMPLE_TOO_SMALL`；
   - `NOT_PASSED` 而 U_g > 0 → `Q0_VERDICT_NOT_PASSED_WITHOUT_EVIDENCE`；
   - `SUPPORTED`、2008 缺场景而无 `STRESS_SCENARIO_MISSING` → `Q0_VERDICT_SUPPORTED_HIDES_INCOMPLETE_STRESS`（G3 不回归）；
   - `oos_reuse: true` 而原因码缺 `OOS_REUSED_IN_DEVELOPMENT`，或反过来 → `Q0_OOS_REUSE_NOT_DISCLOSED`；
   - `gates.A0` 缺 `k2_literal` 或 `unknown_counts` → `Q0_A0_DUAL_READING_MISSING`；
   - `identity.a0_ruling_1_sha256` 与档案不等 → `Q0_A0_RULING_MISMATCH`；
   - 有 `APPROXIMATED` 而 `approximations` 缺失 → `Q0_VERDICT_ENGINE_APPROXIMATION_MISSING`；没有 `APPROXIMATED` 而缺失 → 通过；
   - `NOT_IMPLEMENTED` 而 `flag = false` → `Q0_ENGINE_APPROXIMATION_NOT_DECLARED`（不回归）；
   - 补充行未标 `simulated: true` → `Q0_STRESS_SIMULATED_NOT_FLAGGED`（不回归）；
   - `half_kelly.state` 不是 `NOT_APPLICABLE`、`floor_usd ≠ 5400`、概率不在 0–1、`paths` 非正整数 → 半凯利块 `INVALID`；
   - 高亮行不存在 / 不是 `RISK_` / 无 `halt_events` / 参照期末 ≠ 主数字行期末 → 只有高亮一行无效，结论不变；
   - `forward.in_verdict = true`、`book` 不是本策略、`return` 与 `end_equity / start_equity − 1` 不符 → 只有前向一行无效；
   - 路径带 `fixture` 的文件按非实际来源拒绝（不回归）。
9. **档案校验器负例**：
   - `metric.kind` 未知；`G_GAP` 缺 `g_paths`；
   - `NOT_APPLICABLE` 半凯利带 `thresholds`；
   - `main_row.cost` 不在 `cost_words`；
   - `highlights` 不是 `RISK_` 或超过 2 项；
   - `reason_words_zh` 键不合规；
   - LEGACY_V1 带 `metric` / `highlights` / `a0`。
   每条一个测试。
10. **M1**：真实 M1 包上，交接买入的 units、`buyFee`、10-23 终点 7,836.21192664 残差 ≤ 1e-6（本机验收脚本，结果写进 PR）；合成夹具：任一超容差 → 诊断失败关闭；`US_V5_M1_RESEARCH_COST_V1.js` sha 不变。
11. **A4**：
    - US_CORE case 可按 M0→M1→M2→M3 用自己的证据记录；
    - 用 US_V5 / QS 的证据或跳阶段 → 拒绝；
    - `config/m4_scope.v1.json` 的 US_CORE 一项 `strategy_ref` 由 `null` 改为 `US_CORE_9000USD_3X_GATEOBS`，并有断言。
12. **全量**：
    - 带 `QRP_DESK_ROOT=/Users/kaylame/KaylaProject/portfolio-desk` 的 QRP 全量测试 0 失败；
    - schema 校验；Research Web `node --check`；`git diff --check`；
    - US_CORE、QS、US_V5 详情页在 390 px 与 1280 px 无整页横向滚动。

交付：一个 PR 到 QRP main，冻结后的本规格（与冻结说明）原样作为第一个提交。真实锁的导入、合并与重启 `com.upmeai.qrp-research-web` 由协调会话做。

## 12. 待冻结选择汇总（★ = 推荐）

| # | 选择 | ★ | 其他 |
|---|---|---|---|
| 1 | 导入的文件位置（§1） | 拷到 `var/evidence/us-core-m2-q0-2026-10-26/` | 直接从 `research-data` 导入 |
| 2 | 比较对象标签（§2.2） | `SPY 买入持有`（同 US_V5），总收益由 `basis` 写一次 | 标签带「（总收益）」 |
| 3 | plan / amendment 引用（§2.2） | smartflow `dfe3dcf2` 固定引用 | 镜像进 QRP |
| 4 | 题目队列（§2.2） | 空 | — |
| 5 | 场景中文名（§2.2） | 档案 `scenario_words_zh`，英文原文进技术详情 | 显示英文原文 |
| 6 | 参照臂（§2.2） | 第 2 块折叠显示，「参照，不进判定」 | 不显示 |
| 7 | 开发期账户（§2.2） | `dev_arms_path`，折叠只报 | 不显示 |
| 8 | 判据常量（§3.1） | δ_g 与 ci 方法仍是代码常量，月数门槛读档案；`G_GAP` 要求 `delta_R = null` | 全部搬进档案 |
| 9 | 附近似说明的已实现规则（§4.1） | 照文件读「已实现」，另写近似原文 | 页面改称「已知近似」（不采用） |
| 10 | `approximations` 缺失（§4.1） | 非 LEGACY 且无 `APPROXIMATED` 时按 `[]` 读 | 只对 `G_GAP` 放宽 |
| 11 | 最大损失写法（§5.2） | 美元数后紧跟该行回撤百分比 | 只写美元数 |
| 12 | 金额位数（§5.2） | 美元整数（同 US_V5） | 两位小数 |
| 13 | HK 前向配置（§8.2） | 本次不加 US_CORE 组 | 加空组 |
| 14 | 共享约束（§10） | 不写（海外桶不在规则清单单列） | 加海外桶一行 |

协调会话点名要的几项，不设选项：
- §3.2 主数字旁的样本外复用行；
- §4.2 A0 两种读法与未记录计数；
- §6 Rule 1b 停止行在结论卡与总览的高亮及写入缺口；
- §5.3 2008 缺场景；
- §5.4 合成 3x 只作模拟补充；
- §7 半凯利不适用、改报 P(权益 < 5,400)；
- §8.3 总览的句子与卡，没有采用率卡。

## 13. 不做

- 不改封存文件，不重算任何数字，不替研究会话改标签或角色。
- 不改 US_V5（LEGACY_V1）与 Quick Shot V3 的值、读法与输出。
- 不写代码，不改 `config/strategy_profiles.v1.json`、`config/hk_forward_observations.v1.json`、`config/m4_scope.v1.json`。
- 不导入任何锁，不碰真实 `var/ledger`、`var/evidence`，不重启 4311。
- 不修生产的停止记录写入缺口（smartflow `new-entry-halt-writer.js`），只显示它。


## 协调会话裁定（冻结时，2026-10-26）

以上草案原文一字未改。出处：QRP 分支 `claude/us-core-q0-import-profile-draft`，提交 `860c5c4b`，内容 sha256 `d12011fd4f153cdde17fcd5d8855c97da835e738f907847004c3939751fa93d4`。
依据：
- Owner 2026-10-26 同意「三批接入」并要求加速；
- US_CORE 冻结裁定 1（`3c7fa425…`）与 A0 裁定 1（`50823436…`）；
- Q0 结果 `c5b6fc7e…`；
- 研究题 R1B-1（Owner 2026-10-26「Rule 1b 那个研究题先立起来」）。

1. 第 12 节第 1–13 项**采用 ★**。
2. **第 14 项改取 (b)**：加一行共享约束：「海外桶 Rule 1b：US_V5、US_CORE、C17_V2、QS V3 合计 16,000，自起点峰值回撤 ≥ 40% 全体停新开仓，只有 Owner 解除（共享，未复算；研究题 R1B-1）」。
   - 理由：Rule 1b 是海外桶规则（A5.6、A17 V3 桶），不是 US_CORE 自己的规则。
3. **§6.2 的第一行改写如下**，测试逐字断言：
   > **若照 Rule 1b 停止（近似：只按 US_CORE 自己的曲线套 40% 线，停后不解除；真实规则看海外桶合计、由 Owner 解除，见研究题 R1B-1；只报不判，不进结论）**：样本外 2019-05-28 自起点峰值 11,001 回撤 40.4% 触发停止，之后不再开新仓，期末 6,145；现行主臂不执行停止，期末 61,200。
4. **§6.2 第二行前加「Q0 封存时（2026-10-26）的」**，即「Q0 封存时（2026-10-26）的生产缺口（未修）：…」。
   - 写入端补上 US_CORE 一型后，这一行仍按封存事实显示，不需要重新封存。
5. 实现以 QRP PR 交付，排在 C17 增补 1 的实现之后，并在其上 rebase。由协调会话核对、合并、导入真实锁并重启 4311。
