# CRYPTO_Q0_RESULT_V1 导入规格 · 增补 1（C17_V2 长历史 Q0）· DRAFT

状态：**DRAFT，未冻结，不得实现。** 起草：QRP 规格会话，2026-10-26。冻结：V8.1 协调会话（冻结前可改；冻结后只能另出冻结说明）。
Production effect：`NONE`。不改任何研究结果、判据、锁、证据、生产参数或权限；不写代码，不改任何 `config/`。
QRP 基线：`origin/main` `fd74149`（UX 修订 7 与 PR #32 都已合并）。
被增补：`docs/contracts/CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE.md`，sha256 `001c9041937bef4108d7e1eca903b597b9db66664efe9585073c10bebd64cf36`（下称「导入规格」；第 12 节 17 项全部 ★，协调会话裁定已附在文末）。导入规格原文一字不改；本增补与它冲突时，以本增补为准，且只对 C17_V2 档案生效。
实现依赖：QRP PR #32（导入规格的实现）已于 2026-10-26 合并为 `fd74149`，含 UX 修订 7 的适配 `0315190`。本增补的实现以 `fd74149` 或其后的 main 为基线。

需要选择的地方列出选项，推荐项标 ★；全部选择汇总在第 8 节。

## 0. 依据与结论先行

### 0.1 输入（按内容 sha256 引用）

| 文件 | 位置 | SHA-256 |
|---|---|---|
| 封存结果 `C17_V2_M2_Q0_RESULT_V1.json`（1,144,702 字节） | smartflow `research/crypto-qrp-onboarding` @ `4d704291`：`trading-system-v2/docs/evidence/qrp-crypto-v1/`；Mac `research-data/qrp_crypto_v1/q0-c17/`（两处逐字节相同） | `26691b6c3a2c42277f33f28e2622de56d7f26eea16d371ef9193f0dfe2fe9e4e` |
| C17 Q0 执行报告 | 同上 `trading-system-v2/docs/CRYPTO_QRP_ONBOARDING_C17_Q0_REPORT.md` | `f487eaf08ed56f9045ee2a19ce77096359b19ecc16474fb7d74460fcd4b68a3a` |
| C17 K2（§5 = Q0 规格，§5.1 R-UNIV-C17 等读法） | 同上 `trading-system-v2/docs/C17_V2_QRP_ONBOARDING_K2_DRAFT_V1.md` | `fdcec0ef4b47e8b1266bedbfd4202e1d5218a49e410af51eda097e69fa06eb37` |
| 加密冻结裁定 1 / 2 | 同上 `CRYPTO_QRP_ONBOARDING_FREEZE_1.md` / `_FREEZE_2.md` | `5c60426e…` / `b7e3578b…` |
| C17 A0 结果 / A0 报告 | 同上 `C17_V2_A0_RESULT.json` / `CRYPTO_QRP_ONBOARDING_C17_A0_REPORT.md` | `7db86cf023609a2b473b00b13e3a9bae2ef748d1f967aa491f77e256426a1ffa` / `f90fbdab31622c5b07d359b15a1169c93a6fcefd0ea73ffb9149a9eb4c20ecb3` |
| 惰性硬门结果（研究版引擎 `ea803a60…`） | 同上 `q0-gate-5dafbc66/C17_INERTNESS_RESULT.json` | `88394dd2a7b99fc1ff611a181735316dff56fd436a0e99b65470f6b32bf97e60` |
| M1 封存包清单 | smartflow 同目录 `M1_C17_MANIFEST.json`；Mac `research-data/qrp_crypto_v1/m1-c17/` | `907adfb75d4f1a5067f285c01bd6cadc8695acef08bfab86576cf01f50881c9b` |
| 研究代码（永不合并） | smartflow `research/c17-engine-qrp` @ `5dafbc66`（引擎选项 + `c17-q0.js`）、`687597f9`（车道脚本） | 引擎：生产 `71bae2c1…`，研究版 `ea803a60…` |
| UX 修订 5 / 勘误 1 / 6 / 7 | QRP `docs/contracts/` | `2f9f97f7…` / `7d56e67a…` / `7375f7a4…` / `b1532e32…` |

### 0.2 现在的 main 读这份文件会怎样（实测，不是推断）

把 main `fd74149` 的树用 `git archive` 解到临时目录（PR #32 合并前的 `6a050186` 也跑过一遍，结果相同），用 `profiles.use()` 加一个按第 1 节填写的 C17 测试档案，对真实文件跑 `readSealed` → `validateWhole` → `digests` → `buildBlocks`。临时账本目录运行后仍为空。

| 位置 | 结果 | 原因 |
|---|---|---|
| `readSealed`、`validateWhole` | 通过 | 14 个顶层字段（多出 `non_major_arm`、`halt_events`、`forward`）；规则清单 4 条已知近似与 `approximations` 相等；主数字行、G 区间同源 |
| `digests`（锁的输入摘要） | **拒绝导入** `Q0_INPUT_SERIES_INCOMPLETE` | `inputs.series[]` 没有 `sha256`，写的是 `derived_sha256{crypto_r2, live_cache}` 与 `minute_sha256{…}` |
| 第 1 块 | 失败 | 没有 `inputs.census`（主臂只有 2 个合约）；档案校验器也要求 `census_columns` 非空 |
| 第 4 块 压力 | 失败 | 金额字段是 `max_loss_usdt`；补上之后，下一处是 3 行补充行 `simulated: false`（导入器要求补充行 `simulated: true`） |
| 第 2、3、5、6 块 | 可读 | — |
| 判定依据 | 可读 | 第 1 行就是研究会话的标签「使用的是研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价、stop_loss_history 空源），结论最高只能是证据不足」 |
| 原因码 | 有一个未登记 | `ENGINE_APPROXIMATION_A0_FAILED_F3` → 主内容只会写「另有 1 个技术原因码」 |
| 前向行 | 可读但不完整 | 写成「15 笔」，其中 2 笔未平；研究会话的说明（止损移动未写库）和「10-20 起全规则」子行都没读 |
| `halt_events`、`non_major_arm` | 没有任何代码读 | 开发期 2022-05-08 的 Rule 1 停止事件和非主流近似臂的明细在页面上看不到 |

在内存里逐项修补之后：「最大损失」主数字 = 3,723.77，场景 `SCAN_PHASE_PLUS_60MIN`（与执行报告一致）；`RISK_MAX_POSITIONS_3` 被认出「与参照相同」；`HALT_HONORED` 按「与当前 D 参照相同」读。

另读代码（`fd74149` 的 `services/research-workspace/summary.js`）：总览的一句话结论模板只写「（证据不足）」，**不写引擎近似标签**（第 2 节）。

### 0.3 本增补怎么做

- 封存文件**原样**导入：不改文件、不重算、不改标签、不改行角色。
- 新读法只走两条路，保证 US_V5 与 Quick Shot V3 的页面和 API 逐字节不变：
  1. **档案开关**：写在 C17 档案 `q0_reading` 的新键里（第 1.3 节）。QS 档案不写这些键，行为不变。
  2. **文件字段触发**：只在 C17 文件里存在、QS 文件里不存在的字段才触发，例如 `inputs.series[]` 缺 `sha256` 而有 `derived_sha256`、`identity.engine_sha256`、`verdict.uncapped_state`、`engine_approximation.flag = true`。
- 每条新读法在第 6 节的缺口表里标明属于哪一条路。

## 1. P1 · C17_V2 档案项、case、比较对象与底线

### 1.1 提议的档案项（冻结后由实现会话写进 `config/strategy_profiles.v1.json`；本草稿不写）

```json
{
  "strategy_ref": "C17_V2_4000USDT",
  "case_ref": "RRC-C17-V2-4000USDT-V8-1-M0",
  "market": "CRYPTO_USDM_PERP",
  "currency": "USDT",
  "display_name": "C17_V2",
  "comparators": [
    { "key": "BTC_BUY_HOLD", "label_zh": "BTC 买入持有", "role": "MARKET" },
    { "key": "CASH", "label_zh": "现金", "role": "CASH" }
  ],
  "floor": { "value": 1800, "currency": "USDT", "rule_label_zh": "Rule 1b 的 1,800 USDT（3,000 USDT 的 40% 线）" },
  "baseline_result_schema": "C17_V2_M2_Q0_RESULT_V1",
  "import_profile_id": "docs/contracts/CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE_ADDENDUM_1.md",
  "comparison_import_profile_ids": [],
  "phase_words": { "PRODUCTION": "4H 收线后第一个检查点", "PLUS_60MIN": "晚一小时决定（+60 分钟检查点）" },
  "segment_words": { "IS": "开发期", "OOS": "样本外" },
  "cost_model_id": "C17_V2_M1_RESEARCH_COST_V1",
  "m1_evidence": {
    "manifest_ref": "docs/evidence/C17_V2_M1_PACKAGE_MANIFEST_2026-10-26.json",
    "manifest_sha256": "907adfb75d4f1a5067f285c01bd6cadc8695acef08bfab86576cf01f50881c9b",
    "diagnostic_schema": "C17_V2_M1_STRATEGY_DIAGNOSTIC_V1"
  },
  "forward_observation_source_key": "C17_V2_4000USDT",
  "research_program": {
    "plan_ref": "smartflow:research/crypto-qrp-onboarding@4d704291:trading-system-v2/docs/C17_V2_QRP_ONBOARDING_K2_DRAFT_V1.md",
    "amendment_ref": "smartflow:research/crypto-qrp-onboarding@4d704291:trading-system-v2/docs/CRYPTO_QRP_ONBOARDING_FREEZE_2.md",
    "default_question": null,
    "queue": {
      "Q4": { "title": "风控维度：熔断与日停、去风险系数、总持仓、30 h 冷却", "status": "未立题：C17_V2 尚无 M2 研究计划", "after": [] }
    }
  },
  "q0_reading": {
    "main_row": { "segment": "OOS", "cost": "BASE", "phase": "PRODUCTION" },
    "cost_words": { "BASE": "基础成本", "FEES_X2": "手续费 ×2" },
    "phase_note_zh": "只有一种相位压力：晚一小时决定（4H 收线后 +60 分钟的检查点）。本结果按 K2 §5 每根 4H 收线只在第一个 10 分钟检查点决定一次；生产每 10 分钟扫描一次，两者的差见补充行「每 10 分钟扫描」（不进结论）。",
    "census_columns": [],
    "universe_note_zh": "主臂只交易 BTC / ETH（R-UNIV-C17 (a)）；非主流 3 个槽在主臂里空着（规则 C17-U2..U6 未实现），非主流见补充的近似臂。",
    "market_g_path": "stats.g_vs_btc.OOS",
    "stress_money_field": "max_loss_usdt",
    "stress_columns": [
      { "field": "max_drawdown", "label_zh": "最大回撤", "format": "PCT" },
      { "field": "circuit_trips", "label_zh": "熔断跳闸", "format": "INT" }
    ],
    "supplementary_kinds": { "RULE_BOUNDARY": "规则边界", "APPROXIMATION_SIZE": "近似大小" },
    "conclusion_supplementary": [ { "scenario": "ENGINE_SCAN_EVERY_10MIN", "label_zh": "按生产节奏每 10 分钟扫描" } ],
    "supplementary_arm": {
      "field": "non_major_arm",
      "title_zh": "非主流近似臂（补充，只报不判，不进结论）",
      "rows": [
        { "field": "with_non_majors", "label_zh": "主流 + 非主流（代理标的池）", "stress_scenario": "NON_MAJOR_APPROXIMATION_ARM" },
        { "field": "majors_only_same_window", "label_zh": "同窗口只主流（对照）", "stress_scenario": "NON_MAJOR_ARM_MAJORS_ONLY_SAME_WINDOW" }
      ]
    },
    "halt_events": {
      "rule_words": { "RULE_1_DRAWDOWN_AT_STOP_LINE": "Rule 1：自起点回撤到 50% 停止线" },
      "rule_1b_words": { "NOT_EVALUABLE_SHARED_OVERSEAS_BUCKET": "Rule 1b 看海外桶（含其他账本），不复算" }
    },
    "r_digits": 3,
    "kelly": {
      "floor_field": "floor_usd",
      "fixed_arm": { "key": "current_rule", "label_zh": "按现行定仓规则" },
      "thresholds": [
        { "field": "p_below_floor", "value": 1800, "label_zh": "Rule 1b 40% 线；看重抽路径中的最低权益" }
      ],
      "probability_digits": 2
    },
    "forward": {
      "net_field": "net_usdt", "ledger_must_equal_strategy_ref": true,
      "sub_rows": [ { "field": "current_d_full_from_2026_10_20", "label_zh": "其中 2026-10-20 起全部现行规则同时在效" } ]
    },
    "funding_exclusion": { "count_field": "excluded_funding_missing", "share_field": "excluded_share", "rule_ref_zh": "R-FUND (a)" },
    "disclosures_zh": [
      "样本外复用：2021–2026 的 BTC / ETH 已被 C17 的多项研究使用（保真度 B21 / H22 / R23 / W21 等）（K2 §5，oos_reuse = true）；真正没用过的只有尾部与前向。",
      "R 的定义：每笔开仓时的计划风险（plannedRiskUsdt，150.75 × 系数），不是固定金额（K2 §5）。"
    ]
  },
  "shared_constraints": [
    { "key": "A19_LOSS_BUDGET", "label_zh": "A19 共享亏损预算", "peers": ["QUICK_SHOT_V3_1000USDT"], "display_zh": "共享，未复算", "rule_ref": "C17-R2" }
  ]
}
```

### 1.2 选择

- **strategy_ref**：固定为 `C17_V2_4000USDT`，没有选择。它同时是 V8.1 修订 4 A4.2 的策略身份、封存文件的 `identity.strategy_ref` 和前向账本名。
- **case_ref**（导入规格 A4.2 建议格式 `RRC-<策略>-<资金>-V8-1-M0`）：
  - ★(a) `RRC-C17-V2-4000USDT-V8-1-M0`：与账本名逐字对应，同 QS 的做法（`QUICK_SHOT_V3_1000USDT` → `RRC-QUICK-SHOT-V3-1000USDT-…`）。资本以后再变，名字也不用跟着改。
  - (b) `RRC-C17-V2-3000USDT-V8-1-M0`：写现行资本，但与账本名不一致，资本再变就又不对。
- **主臂与资本**：主臂只交易 BTC / ETH，本金 3,000 USDT（A18，2026-10-07 起）。账本名里的 4000 是 A4.2 冻结的身份，不是本金。页面第 1 块一行，数字取自文件：「主臂只交易 BTCUSDT、ETHUSDT；本金 3,000 USDT、每笔基准风险 150.75 USDT（结果文件 `identity.config`）；账本名 C17_V2_4000USDT 沿用 V8.1 修订 4 的策略身份」。随后接 `universe_note_zh`。
- **比较对象**：`BTC_BUY_HOLD`（MARKET）+ `CASH`，与 `verdict.comparators` 一致。口径按冻结裁定 1 R-BTC (a)：BTCUSDT 永续收盘价，只计价格变化，同起点 3,000 USDT。
  - 引擎证据：`c17-q0.js` `btcCurve()`，在 smartflow `687597f9` 的第 273–279 行：段起点前最后一根已收盘 1m 的收盘价买入一次，之后只按收盘价变化。
  - UX 修订 5 E2 的口径行：★(a) 在 `config/strategy_detail_notes.v1.json` 登记 C17 一项，只写 `comparators.BTC_BUY_HOLD`：
    - `definition_zh`：「BTC 买入持有 = 同本金 3,000 USDT、同起点一次买入 BTCUSDT 永续，一直持有到区间结束，中间没有任何买卖。」
    - 口径按本结果 sha256 绑定，值为新增的口径词 `PRICE_ONLY_NO_FUNDING`「只计价格变化，不计资金费」，附上面的引擎证据。现有的两个词「含分红」「不含分红」对永续合约不成立。
    - QS 不登记，行为不变。

    (b) 不登记：页面不写口径行（今天的 QS 就是这样），读者看不到「不计资金费」。
- **底线**：1,800 USDT（K2 §5：3,000 的 Rule 1b 40% 线），等于文件 `half_kelly.floor_usd`。页面每处写「1,800 USDT」，带币种，不与 US_V5 的 1,800 美元混淆。
- **M1**（不在本增补范围，只定档案怎么填才能先导入 Q0）：
  - ★(a) 把 smartflow 的 M1 包清单（`907adfb7…`）原样拷进 QRP `docs/evidence/C17_V2_M1_PACKAGE_MANIFEST_2026-10-26.json` 作为 `manifest_ref`；不写 `producer`；`cost_model_id` 写 `C17_V2_M1_RESEARCH_COST_V1`（不登记）。
    - 诊断按 PR #32 的规则失败关闭（`DIAGNOSTIC_PRODUCER_NOT_REGISTERED`），C17 的 M1 显示未验证，A4 不会给它记 M1 PASS。
    - C17 的 M1 成本模型与生产者另立规格（C17-F1 用 `closeTrade` 自己的成本函数，与 QS 不同）。届时把 `manifest_ref` 换成 QRP 自己的证据清单（同导入规格 §9.5）。
  - (b) 先写 QS 的成本模型 id：会让 C17 借用 QS 的成本规则，违反注册表 R2「不借用别的策略的成本模型」。

### 1.3 新档案键（全部可选；QS 与 US_V5 不写，行为不变）

| 键 | 作用 | 无此键时 |
|---|---|---|
| `census_columns: []`（空数组） | 不读 `inputs.census`，第 1 块改写 `universe_note_zh` 与「交易标的：<`inputs.series[].symbol`>」 | 校验器仍要求非空（QS 不变） |
| `universe_note_zh` | 第 1 块的标的说明 | 不写 |
| `stress_money_field` | 压力行与「与参照相同」比较读哪个金额字段 | `max_loss_usd`（导入规格 §5.2 ★(a)） |
| `stress_columns[]` | 压力表在「笔数」「每笔均值 R」后另加的列，`format` ∈ `PCT` / `INT` / `MONEY`；缺值空着 | 不加列 |
| `supplementary_kinds` | 允许 `simulated: false` 的补充行（第 3.1 节） | 补充行必须 `simulated: true`（US 冻结说明 2 G2） |
| `conclusion_supplementary[]` | 结论区块里的补充行一句（第 3.1 节） | 不写 |
| `supplementary_arm` | 读顶层补充臂（第 3.2 节） | 不读 |
| `halt_events` | 读停止事件（第 4 节） | 不读 |
| `r_digits`（2 或 3） | 本档案页面上所有 R 值的小数位 | 2 |
| `kelly.probability_digits`（1 或 2） | 半凯利两臂的概率小数位 | 1 |
| `forward.sub_rows[]` | 前向块里的子行（第 3.3 节） | 不写 |

校验器：LEGACY_V1 档案带任一新键 → `STRATEGY_PROFILE_FIELD_TYPE`；`r_digits` ∉ {2, 3}、`probability_digits` ∉ {1, 2}、`format` 不认识、`supplementary_kinds` 为空对象、`supplementary_arm.rows[]` 缺 `field` / `label_zh` / `stress_scenario` → 拒绝。

### 1.4 小数位的选择

- R 值三位小数：
  - ★(a) C17 档案 `r_digits: 3`。每 10 分钟扫描那一行 +0.09823479 R 两位小数会写成「+0.10 R」，正好等于门槛 +0.10 R，读者会以为它够到了门槛；三位小数写「+0.098 R」，与执行报告一致。
  - (b) 保持两位。
- 跌破底线的概率两位小数：
  - ★(a) `probability_digits: 2`。0.0695 一位小数写「7.0%」，与报告的 6.95% 不一致；两位小数写「6.95%」。
  - (b) 一位小数。

QS 档案不写这两个键，仍是两位与一位（「+0.19 R」「31.4%」不变）。

## 2. P2 · 「研究引擎近似的当前 D（缺：…）」怎么显示

文件：`verdict.label_zh` = 「研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价、stop_loss_history 空源）」；`engine_approximation.flag = true`；`gates.A0.state = FAILED`；`verdict.uncapped_state = INSUFFICIENT`；原因码 `CI_STRADDLES_DELTA`、`ENGINE_APPROXIMATION_A0_FAILED_F3`。

### 2.1 检查（文件字段触发：`flag = true` 的非 LEGACY 档案；QS 是 `false`，不触发）

1. `verdict.label_zh` 必须以「研究引擎近似的当前 D」开头，并逐字包含 `gates.A0.residuals_missing_zh` 的每一项（A0 未通过时）。否则拒绝导入，`Q0_ENGINE_LABEL_INCOMPLETE`：标签不得比证据更轻。
2. `engine_approximation.missing` 必须与 `NOT_IMPLEMENTED` 规则 id 的集合相等（同 `approximations` 对 `APPROXIMATED` 的检查），否则 `Q0_ENGINE_GAPS_MISMATCH`。真实文件：C17-U2..U6，两边相等。
3. `verdict.uncapped_state` 存在时必须是三态之一，否则 `Q0_VERDICT_STATE_UNSUPPORTED`。`flag = true` 时 `state` 不得是 `SUPPORTED`（已有检查）。

### 2.2 显示位置：标签整句出现，永不截断、不折叠

1. **总览的一句话结论**（UX 修订 7 J1.1；改 `summary.js` 的模板，只在 `flag = true` 时生效）：在结论头之后、采用部分之前，加一个分句。
   - ★(a) 结论在前，标签紧跟：「现行版本样本外期末 7,737，低于 BTC 买入持有的 14,665（证据不足）；所用引擎为研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价、stop_loss_history 空源），结论最高只能是证据不足」。
   - (b) 标签放最前：「研究引擎近似的当前 D（缺：…）：样本外期末 7,737，低于 …（证据不足）」。不符合修订 6 / 7「结论在前」。
   - C17 现在没有对比结果与研究队列，所以句子到此为止，没有采用部分。
   - 基线 Q0 没有采用决定（修订 6 H1：基线 = 不适用），一句话里不写「采用 / 不采用」。
2. **回测结论卡的结论区块**：
   - 结论行下面固定一行「引擎：研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价、stop_loss_history 空源）」，主内容，不进 `<details>`。
   - 判定依据第 1 行沿用现有句子：「使用的是研究引擎近似的当前 D（缺：…），结论最高只能是证据不足」。
   - 最大的限制沿用现有句子：「使用的是研究引擎近似的当前 D（缺：…），结论最高只能是证据不足。」
   - 去重：结论区块里标签整句可以出现在「引擎」行、判定依据和最大的限制三处。这是导入规格已有的两处加本增补要求的一处，修订 4 D3 的去重条款不适用于这一句。
3. **第 1 块（回测周期与覆盖）**：
   - 引擎标签沿用 PR #32（`flag = true` 时取 `label_zh`）。
   - 下面一行写 A0 为什么没通过，取 `gates.A0.diagnostic_zh` 原文：「引擎对齐关卡 A0：未通过——注入生产成交后 A0-2..A0-7 通过、A0-1 2,687 / 2,688；不一致全部来自出场观测（R1 生产缺陷、R2 60 秒观测、R3 扫描时刻价、R4 亚秒时钟）」。
   - 惰性硬门（`gates.INERTNESS`）进技术详情：「惰性硬门：通过（研究选项都不设时，研究版引擎与生产引擎输出逐字节相同，冻结裁定 2 G1.2）」。
4. **判定依据的「另须知道」**：
   - 先写 `disclosures_zh` 两行；
   - 再写一行封顶说明：`uncapped_state` 与 `state` 相同时写「按冻结裁定 1 F3 封顶前的判定也是证据不足，封顶没有改变结论」；不同时写「封顶前的判定：<三态词>；按冻结裁定 1 F3 封顶为证据不足」。
5. **原因码**：在 `REASON_WORDS` 登记 `ENGINE_APPROXIMATION_A0_FAILED_F3`「引擎对齐关卡 A0 未通过：按冻结裁定 1 F3，结论最高只能是证据不足」（全局登记；US 与 QS 文件没有这个码，输出不变）。主内容不出现英文码（修订 4 D1.3）。
6. **来源区**：
   - 研究版引擎 `ea803a60…`（`research/c17-engine-qrp`，永不合并）、生产引擎 `71bae2c1…`、惰性硬门结果 `88394dd2…`，取自 `identity.engine_sha256` 与 `identity.inertness_ref`；
   - 这两项同时进锁的引擎摘要（第 6 节 G-12）。

### 2.3 页面文字（真实文件，测试逐字断言）

- 一句话结论：见 2.2 第 1 条 ★(a)。
- 结论：「证据不足」；修订 5 E6 的固定说明照旧。
- 主数字：「样本外每笔扣费后净 R 均值（基础成本，4H 收线后第一个检查点；门槛 +0.10 R）」，+0.076 R，95% 区间 −0.010 R 至 +0.163 R。
- 主数字下：「主统计不计资金费缺失的 12 笔（占 2.1%，R-FUND (a)）」。
- 判定依据：
  1. 「使用的是研究引擎近似的当前 D（缺：60 秒成交观测、扫描时刻成交价、stop_loss_history 空源），结论最高只能是证据不足」
  2. 「每笔扣费后净 R 均值 +0.076 R，95% 区间 −0.010 R 至 +0.163 R，区间跨过门槛 +0.10 R」
  3. 「相对 BTC 买入持有的账户年化对数增长差 95% 区间 −65.8% 至 33.2%，区间跨过门槛 0」
  4. 「门槛在看到结果前已冻结」
- 优势结论一行：「优势结论：证据不足」。压力场景没有缺场景或无效输入，所以没有「压力评价不完整」「采用条件」两行（冻结说明 2 G3）。

## 3. P3 · 补充行：只报不判，永不进结论，始终可见

「始终可见」= 在回测结论卡的主内容里，不放进 `<details>`。修订 7 J3 的默认折叠只针对对比卡，不适用于 Q0 卡的这些行。

### 3.1 压力表里的补充行（`status: SUPPLEMENTARY_NOT_IN_CONCLUSION`）

真实文件 5 行：

| 行 | `simulated` | `kind` | 期末 | 最大亏损 | 笔数 | 每笔均值 |
|---|---|---|---|---|---|---|
| `BOUNDARY_K5_OFF` 规则边界：K5 关 | false | RULE_BOUNDARY | 6,931.20 | 3,434.94 | 574 | +0.074 R |
| `BOUNDARY_EFFICIENCY_OFF` 规则边界：效率闸关 | false | RULE_BOUNDARY | 6,327.96 | 4,779.31 | 698 | +0.012 R |
| `ENGINE_SCAN_EVERY_10MIN` 近似大小：每 10 分钟扫描 | false | APPROXIMATION_SIZE | 13,198.71 | 3,192.38 | 607 | +0.098 R |
| `NON_MAJOR_APPROXIMATION_ARM` 非主流近似臂 | true | — | 3,636.90 | 2,409.27 | 568 | +0.012 R |
| `NON_MAJOR_ARM_MAJORS_ONLY_SAME_WINDOW` 同窗口只主流 | true | — | 3,591.02 | 2,071.13 | 292 | +0.050 R |

读法：

- US 冻结说明 2 G2 要求补充行 `simulated: true`。前 3 行是在真实历史上跑的（研究选项改一条规则，或量化一处近似），不是模拟序列，文件如实写了 `false`，而文件不能改。
  - ★(a) 档案有 `supplementary_kinds` 时，补充行可以 `simulated: false`，条件是 `kind` 是档案登记的词，且 `in_headline === false`（缺或 `true` → 压力块 `INVALID`）。这类行写「补充（<kind 词>，只报不判，不进结论）」，不写「模拟序列」。
  - (b) 照 G2 拒绝：压力块整块无效，不可用。
  - (c) 由 QRP 把它们当模拟行：等于替文件改标签。
- 所有补充行永远不进「最大损失」主数字、压力完整性或三行结论。效率闸关的 4,779.31 大于主数字 3,723.77，同样不进。
- 计数行（有 `supplementary_kinds` 的档案）：「已执行 9 个压力场景（另有 1 个与当前 D 参照相同），模拟 2 个，补充 3 个（规则边界 2、近似大小 1），缺场景 0 个，无效输入 0 个；另有当前 D 参照 1 行、风控维度 4 行（只报不判，不进最大损失）。缺场景和无效输入不计为已执行的压力。」
- 「最大损失」：「最大损失：3,723.77 USDT（场景：晚一小时决定（4H 收线后 +60 分钟的检查点））」。
- 另加两列 `stress_columns`（最大回撤、熔断跳闸），取文件值，缺值空着。`RISK_NO_CIRCUIT_DAY_HALT` 写 0 次，本身就是这个风控维度的读数。
- `RISK_MAX_POSITIONS_3` 与参照逐项相同，按 `stress_money_field` 比较后标「与参照相同」；研究会话的原因（主臂只有 2 个合约）在 label 里。

### 3.2 每 10 分钟扫描那一行进结论区块（`conclusion_supplementary`）

本结果按 K2 §5 字面「4H 收线后第一个 10 分钟检查点」决定，生产实际每 10 分钟扫描一次。差别很大：期末 13,199 对 7,737。只放在压力表里，读者不容易看到。

- ★(a) 结论区块在主数字下、判定依据之前加一行，数字取自该行与参照行（`BASELINE`），不计算差值：
  「补充（只报不判，不进结论）：按生产节奏每 10 分钟扫描，样本外 607 笔，每笔 +0.098 R，期末 13,198.71 USDT；当前 D 参照（4H 收线后第一个检查点）565 笔，每笔 +0.076 R，期末 7,737.41 USDT。这是研究引擎近似（C17-E1）的大小，不是另一个版本的结论。」
- (b) 另在总览一句话结论里也提一句：会让一句话变长；而且这是近似大小，不是结论。
- 检查：`conclusion_supplementary[].scenario` 必须是补充行，否则这一行写「补充行无效：<原因>」，结论不变。

### 3.3 非主流近似臂（顶层 `non_major_arm`，`supplementary_arm`）

- 读法：
  - `status = SUPPLEMENTARY_NOT_IN_CONCLUSION`、`simulated = true`、`in_headline = false` 三项必须成立；
  - 两行对象 `with_non_majors`、`majors_only_same_window` 的 `end_capital` 必须分别等于压力表对应行（`stress_scenario`）的 `end_capital`（容差 1e-6）。
  - 任一不成立 → 只有这个补充块写「非主流近似臂无效：<原因>」，结论与压力块不受影响。
- 位置：压力块里压力表的下面，主内容。标题「非主流近似臂（补充，只报不判，不进结论）」，窗口 2024-10-04 → 2026-09-30（`window`）。
  - 两行：笔数、每笔均值 R 与 95% 区间、胜率、期末、最大回撤；第一行另写「其中非主流 289 笔，每笔 −0.011 R」（`non_major_trades`、`non_major_mean_R`）。
  - 近似说明逐条照录 `approximations_zh`（4 条）。
  - `universe`、`dataset_used`、`trades` 只进技术详情（标的数 13、代理成员 sha `17f7ff7b…`）。
- 真实文件第一行：「主流 + 非主流（代理标的池）：568 笔，每笔 +0.012 R（95% 区间 −0.074 R 至 +0.096 R），胜率 49.5%，期末 3,636.90 USDT，最大回撤 41.8%」。

### 3.4 前向行（`forward`）

真实文件：`{in_verdict: false, ledger: C17_V2_4000USDT, window_from: 2026-10-07, trades: 15, closed: 13, open: 2, net_usdt: −670.5689548, mean_R: −0.51636663, current_d_full_from_2026_10_20: {closed: 2, net_usdt: −171.59160814, mean_R: −1.13825279}, note_zh: …}`。

- 读法（`closed`、`open`、`window_from`、`note_zh` 都是**有才读**；QS 的前向块没有这些字段，输出不变）：
  - `closed`、`open` 都存在时必须是非负整数且 `closed + open = trades`，否则前向行无效；
  - `window_from` 存在时写进括号；
  - `note_zh` 存在时**必须**显示，紧跟前向行，主内容。
  - 子行按档案 `forward.sub_rows`：对象必须有 `closed`、`net_usdt`、`mean_R`，否则只有子行无效。
- 页面（第 2 块末尾，三行，主内容）：
  1. 「前向记录（PAPER 账本 C17_V2_4000USDT，2026-10-07 起，只报不判，不进结论）：15 笔（已平 13、未平 2），净 −670.57 USDT，每笔均值 −0.516 R。」
  2. 「研究会话说明：只报不判；10-21 22:50 CST 起生产止损移动未写库（C17-D7），这些交易不代表规则本意」（`note_zh` 原文）。
  3. 「其中 2026-10-20 起全部现行规则同时在效：已平 2 笔，净 −171.59 USDT，每笔均值 −1.138 R。」
- 生产缺陷已由 smartflow #35 修复，2026-10-27 06:03 CST 部署。修复时间在诊断清单 C17-D7 里，页面照录；QRP 不推算「修复后」的前向数字。
- 「前向观察」一节（导入规格 §7.2 的同一写法）：「Q0 结果文件里带有前向记录 15 笔（只报不判）；HK 前向影子：本策略尚未登记。」

## 4. P4 · 开发期 Rule 1 停止事件与 HALT_HONORED

文件 `halt_events`（形状与 QS 不同：QS 是 `{OOS: [], IS: []}`，C17 是对象）：

```
OOS: { events: [], stop_weeks: 0, rule_1b: "NOT_EVALUABLE_SHARED_OVERSEAS_BUCKET" }
IS:  { events: [ { rule: "RULE_1_DRAWDOWN_AT_STOP_LINE", at: "2022-05-09T00:00:00.000Z", period_to: "2022-05-08",
                   drawdown_pct: 50.08889093, closed: 395, expectancy_R: -0.0019, expectancy_t: -0.0334 } ],
       stop_weeks: 34, rule_1b: "NOT_EVALUABLE_SHARED_OVERSEAS_BUCKET" }
```

- 读法（档案 `halt_events` 打开时才读；QS 不读，不变）：
  - `drawdown_pct` 已是百分数，原样写「50.09%」，**不乘 100**；
  - 规则码按 `rule_words` 译；未登记的码只进技术详情，主内容写「另有 N 个停止事件规则码（见技术详情）」；
  - `rule_1b` 按 `rule_1b_words` 译。
- 一致性：样本外 `events` 为空 ⇔ `HALT_HONORED` 是 `SAME_AS_BASELINE`；不一致 → 压力块 `INVALID`（「停止事件与 HALT_HONORED 不一致」）。真实文件一致。
- 页面（压力块，紧跟 `HALT_HONORED` 那一行，主内容，标题「停止规则事件（R-HALT (a)：主臂不执行停止，只记事件）」）：
  1. 「样本外：周复盘 STOP 0 周，没有停止事件；第一次停止即停（HALT_HONORED）与当前 D 参照相同。」
  2. 「开发期（只报不判）：第一次在 2022-05-08 结束的那一周，Rule 1：自起点回撤到 50% 停止线（回撤 50.09%，当时已平仓 395 笔，每笔期望 −0.002 R）；开发期 STOP 周共 34 个。」
  3. 「Rule 1b 看海外桶（含其他账本），不复算。」
  - 「34 个」照录 `stop_weeks`，不写「之后另有」，不解读是否包含第一周。
  - `expectancy_R` 按 `r_digits` 写；`expectancy_t` 进技术详情。
- `HALT_HONORED` 行：沿用导入规格 §5.4 的「与当前 D 参照相同」（`end_capital` 7,737.41 = 参照行），不进最大损失，单独计数。
- 诊断清单 C17-D6（RISK，提议 Q4）照常显示；它的 Q4 由档案 `research_program.queue.Q4` 显示为「未立题」。

## 5. P5 · 半凯利：f\* < 0 → 0，与 P(权益 < 1,800 USDT)

文件：`p 0.49557522 [0.45389808, 0.53691498]`，`b 1.22409972 [1.07901852, 1.38071737]`，`f_star −0.05221179`，`f_half 0`，`floor_usd 1800`；`replay.half_kelly {end_capital_ci [3000, 3000], p_below_floor 0, max_drawdown 0}`；`replay.current_rule {end_capital_ci [2075.95, 23589.02], p_below_floor 0.0695, max_drawdown 0.35898315, note}`。

- 读法：导入规格 §6.1 不变，只是档案取值不同：
  - 底线字段 `floor_usd` 必须等于 1,800；
  - 固定风险臂键 `current_rule`；
  - 一个阈值 `p_below_floor`；
  - 一致性检查 `f_star ≤ 0 → f_half = 0`、`L_R ≤ 0 → f_half = 0`，真实文件两条都满足（`L_R = −0.00995004`）。
- 修订 5 E1 的算式行（数字取自文件，只格式化）：
  1. 「凯利比例 f\* = p − (1 − p) ÷ b，p 为样本外胜率，b 为赔率。」
  2. 「按保守下沿 p = 45.4%、b = 1.08，f\* = −5.2%。」
  3. 「f\* ≤ 0 → 半凯利 = 0：长期看下注越多亏得越多，不支持按凯利加仓。」
  4. 「这里的 p、b 与上面『胜率与赔率』表样本外、4H 收线后第一个检查点、基础成本那一行相同。」——PR #32 的 `source_row` 核对：`p` = 主数字行 `win_rate`，`b` = `payoff`，真实文件相等。
- P(权益 < 1,800 USDT) 的读法：
  - 执行报告 §7：这个概率看的是**重抽路径中的最低权益**是否跌破 1,800，不是期末权益。所以阈值标签写「Rule 1b 40% 线；看重抽路径中的最低权益」。
  - 文件没有写这层口径，标签文字来自报告。
  - ★(a) 照报告写进档案标签；(b) 只写「跌破 1,800 USDT 的概率」，读者会当成期末。
- 页面：
  - 卡 1「按半凯利定仓」：期末资本区间 3,000 USDT 至 3,000 USDT；最大回撤 0.0%；跌破 1,800 USDT（Rule 1b 40% 线；看重抽路径中的最低权益）的概率 0.00%；文件 `note`「半凯利 = 0：不支持按凯利加仓」。
  - 卡 2「按现行定仓规则」（副标题「重抽 10,000 条路径（重抽样路径，不是预测）」）：
    - 文件 `note` 原文「现行：每笔风险 150.75 × min(2, max(1, E / 3000)) × 去风险系数（生产区间）」；
    - 期末资本区间 **2,076 USDT 至 23,589 USDT**；最大回撤 35.9%；
    - 跌破 1,800 USDT（Rule 1b 40% 线；看重抽路径中的最低权益）的概率 **6.95%**。
  - 脚注：「研究计算，不是仓位建议；现行仓位规则不变。底线：Rule 1b 的 1,800 USDT（3,000 USDT 的 40% 线）。」（只有一个阈值，不写「另报」。）
  - 总览关键数字卡「半凯利」：写「0（不支持按凯利加仓）」。

## 6. P6 · C17 结果里，导入规格（QS 读法）没有覆盖的地方

「触发」列：**档案** = C17 档案的新键（QS 不写）；**文件** = 只在 C17 文件出现的字段；**全局** = 对所有档案生效、但 US / QS 文件里没有对应内容，所以输出不变。

| # | 缺口 | 今天的结果 | 本增补 | 触发 |
|---|---|---|---|---|
| G-1 | `inputs.series[]` 没有 `sha256`，是 `derived_sha256{crypto_r2, live_cache}` + `minute_sha256{…}` | `digests` 拒绝导入（实测） | 第 6.1 节输入摘要 | 文件 |
| G-2 | 没有 `inputs.census`（主臂 2 个合约） | 第 1 块失败；校验器要求 `census_columns` 非空 | `census_columns: []` + `universe_note_zh` + 交易标的列表 | 档案 |
| G-3 | 金额字段 `max_loss_usdt` | 压力块失败（实测） | `stress_money_field`（导入规格 §5.2 选项 (c) 的按档案落地） | 档案 |
| G-4 | 3 行补充行 `simulated: false` + `kind` | 压力块失败（实测） | §3.1 `supplementary_kinds` | 档案 |
| G-5 | 原因码 `ENGINE_APPROXIMATION_A0_FAILED_F3` 未登记 | 主内容「另有 1 个技术原因码」 | §2.2 第 5 条登记中文 | 全局 |
| G-6 | 总览一句话结论没有引擎标签 | 只写「（证据不足）」 | §2.2 第 1 条 | 文件（`flag = true`） |
| G-7 | `halt_events` 新形状；开发期 Rule 1 事件 | 没有代码读 | §4 | 档案 |
| G-8 | 顶层 `non_major_arm` | 没有代码读，只显示两行压力 | §3.3 | 档案 |
| G-9 | 前向 `closed` / `open` / `window_from` / `note_zh` / 子行 | 「15 笔」含 2 笔未平；止损未写库的说明不显示 | §3.4 | 文件（有才读）+ 档案（子行） |
| G-10 | 半凯利固定臂 `current_rule`、一个阈值、概率 6.95% | 档案配好即可读；一位小数会写成 7.0% | §5、§1.4 | 档案 |
| G-11 | `gates.A0` = FAILED，带 `diagnostic_zh`、`residuals_missing_zh`；`gates.INERTNESS` | A0 只写「未通过」，原因不显示 | §2.2 第 3 条 | 文件 |
| G-12 | `identity.engine_sha256{production, research}` 与 `inertness_ref` | 不进锁、不显示；冻结裁定 2 G1.3 要求两个 sha 都记录 | §6.2 引擎摘要 + §2.2 第 6 条 | 文件 |
| G-13 | `verdict.uncapped_state` | 不读 | §2.1 第 3 条、§2.2 第 4 条 | 文件 |
| G-14 | `engine_approximation.missing` 与 `NOT_IMPLEMENTED` 集合没有核对 | 只核对了 `approximations` | §2.1 第 2 条 | 文件 |
| G-15 | 标签是否比证据轻没有核对 | 不检查 | §2.1 第 1 条 | 文件 |
| G-16 | 压力行另有 `max_drawdown`、`circuit_trips` | 不显示 | `stress_columns` | 档案 |
| G-17 | R 的定义不同（计划风险，不是固定 7.2 USDT） | 页面没有说明 | `disclosures_zh` 第 2 行 | 档案 |
| G-18 | 0.098 R 两位小数写成「+0.10 R」，概率 6.95% 写成「7.0%」 | 误读 | `r_digits`、`probability_digits` | 档案 |
| G-19 | 比较对象口径（修订 5 E2）：永续合约没有「分红」 | 说明登记只有两个分红词 | §1.2 新口径词 `PRICE_ONLY_NO_FUNDING` + C17 说明登记 | 全局（新词）+ 档案（登记） |
| G-20 | 诊断 C17-D1、C17-D6 提议 Q4 | 「实验状态未登记」 | 档案 `research_program.queue.Q4` | 档案 |
| G-21 | 总览「样本外胜率与赔率」卡的行名 | 已在 main 修好（`0315190`：非 LEGACY 用费用词与主数字行） | 不需新读法；C17 写「样本外 · 基础成本 · 4H 收线后第一个检查点」，第 7 节断言 | 已有 |
| G-22 | `arms.D.counts`（扫描 8,358 次、熔断 71、日停 3、K5 12 / 589、K7 114）、`stats.rows[].open_at_end`、`identity.config.scan` / `exit_observation` / `derisk_bands` | 不读 | 只进技术详情，不进主内容 | 文件 |
| G-23 | M1：C17 没有生产者和成本模型 | — | §1.2 M1 ★(a)：诊断失败关闭，另立规格 | 档案 |

### 6.1 G-1 输入摘要（锁的 `inputs_digest`）

- 系列项有 `sha256` 时，照导入规格与 US 原式不变（QS 锁的摘要不变）。
- 系列项没有 `sha256` 时：必须同时有 `derived_sha256` 与 `minute_sha256` 两个对象，且每个值都是 64 位十六进制，否则仍 `Q0_INPUT_SERIES_INCOMPLETE`。摘要元素为 `[symbol, role, source_host, source_ref, canonical({derived_sha256, minute_sha256})]`。
- 文件有 `inputs.manifests`（路径 → 64 位 sha）时，摘要为 `sha256(canonical({series: <排序后的元素>, manifests: <按路径排序的项>}))`。真实文件 5 份清单：`82e2c8fa…`、`84862003…`、`cc669c94…`、`30c6a372…`、`907adfb7…`。
- 只在系列项缺 `sha256` 时用这个新式。

### 6.2 G-12 引擎摘要（锁的 `engine_digest`）

- 文件有 `identity.engine_sha256` 时：两个值都必须是 64 位十六进制，否则 `Q0_ENGINE_BLOBS_MISSING`。摘要为 `sha256(canonical({smartflow, files: <排序后的 engine_files>, engine_sha256: {production, research}}))`。
- 没有这个字段时照原式（QS、US 不变）。

## 7. P7 · 实现会话必须加的测试

金样基线：main `fd74149`（PR #32 合并后；QS 用其真实锁或临时账本副本）。全部在临时账本里跑，真实 `var/ledger`、`var/evidence` 前后 sha 相同。

1. **US_V5 与 QS 逐字节不变**：
   - 用 `qrp-profile-registry-d1/capture.js` 在基线与实现分支上各抓一次金样。US_V5 与 QS 的策略详情（全部页签全部展开，加默认总览）以及两者的全部 API 响应，逐字节相同。
   - 允许变化的只有 C17 自己的路由，以及列出 C17 的条目（例如 M4 面板 C17 一项、策略目录里 C17 的接入状态）。PR 逐个列出变化的文件、原因和 sha256。
2. **既有锁重导入相同**：基线上已有的全部锁（US_V5 的 Q0 与各对比题，QS 的 Q0）在临时账本里重导，锁记录与 `lock_hash` 相同。证明 6.1 / 6.2 的新式没有碰到它们。
3. **真实 C17 文件导入（临时账本）**：
   - `result_id = Q0-26691b6c3a2c4227`，`strategy_ref = C17_V2_4000USDT`，`case_ref` 按 1.2 的选择，`verdict_state = INSUFFICIENT`；
   - `inputs_digest`、`engine_digest` 写进 PR，冻结后作为金值；
   - 重复导入是幂等重放。
4. **真实文件的页面断言**（逐字）：
   - §2.3 全部；§2.2 第 1、2、3 条三处标签整句，以及去掉 `<details>` 后标签仍在；
   - §3.1 计数行与「最大损失」行；§3.2 补充一行；§3.3 第一行；§3.4 三行；§4 三行；§5 两张卡的数字与算式四行；
   - A19 一行「A19 共享亏损预算：与 Quick Shot V3 共享，未复算（规则 C17-R2）」。
5. **C17 页面不得出现**：「undefined」「美元」「US$」「SPY」「5 bps」「相位 ±60 分钟」「120 分钟」「规则清单无缺口」「7.2 USDT」「600 USDT」，任何 US_V5 或 QS 的数字，原样的英文原因码。「1,800」只能紧跟「USDT」出现。US_V5、QS 页面不得出现任何 C17 数字。
6. **UX 修订 4–7 在 C17 页上**：
   - 判定依据存在且与 `verdict.state` 一致；「页面不重算」恰好 1 次；
   - 修订 5 E1 / E3（勘误 1）/ E4 / E6 的行存在；
   - 总览在 1280 × 800 下高度 ≤ 1,600 px；390 px 无整页横向滚动；
   - 补充行、前向三行、停止事件三行都不在 `<details>` 里。
7. **负例**（合成的 C17 形状夹具 `tests/_c17_q0_fixture.js`，数字是合成的，CI 不读真实文件），每条一个测试：
   - 系列项缺 `sha256` 也缺 `derived_sha256` / `minute_sha256`，或值不是 64 位 → `Q0_INPUT_SERIES_INCOMPLETE`；
   - `engine_sha256` 值不合法 → `Q0_ENGINE_BLOBS_MISSING`；
   - `missing` ≠ `NOT_IMPLEMENTED` 集合 → `Q0_ENGINE_GAPS_MISMATCH`；
   - `flag = true` 而 `label_zh` 不以「研究引擎近似的当前 D」开头，或缺任一 A0 残差 → `Q0_ENGINE_LABEL_INCOMPLETE`；
   - `uncapped_state` 不认识 → `Q0_VERDICT_STATE_UNSUPPORTED`；`flag = true` 且 `SUPPORTED` → 拒绝（不回归）；
   - 补充行 `simulated: false` 但 `kind` 未登记，或 `in_headline` 不是 `false` → 压力块 `INVALID`；最大亏损最大的补充行不进主数字；
   - 压力行只有 `max_loss_usd`、没有 `max_loss_usdt`（C17 档案）→ 压力块 `MISSING`；
   - 样本外停止事件非空而 `HALT_HONORED` 是 `SAME_AS_BASELINE` → 压力块 `INVALID`；`drawdown_pct` 原样显示，不乘 100；
   - `non_major_arm` 的 `simulated` 不是 `true`，或两行 `end_capital` 与压力行不等 → 只有补充块无效，结论与压力块不变；
   - 前向 `closed + open ≠ trades` → 前向行无效；`note_zh` 存在时一定显示；
   - `conclusion_supplementary` 指向非补充行 → 只有那一行无效；
   - `census_columns: []` 时忽略 `inputs.census`；QS 档案（非空列）缺 `inputs.census` → 第 1 块 `MISSING`（不回归）；
   - `r_digits: 3` 写「+0.098 R」，QS 夹具仍写两位；`probability_digits: 2` 写「6.95%」，QS 夹具仍写「31.4%」。
8. **档案校验器负例**：
   - LEGACY_V1 带任一新键 → 拒绝；
   - `r_digits` / `probability_digits` 越界、`stress_columns[].format` 不认识、`supplementary_kinds` 空对象、`supplementary_arm.rows[]` 缺字段 → 拒绝；
   - `strategy_detail_notes` 的新口径词只在登记了证据时被接受。
9. **一句话结论**：
   - C17 夹具（`flag = true`）出现标签分句；
   - QS（`flag = false`）与 US_V5 的句子与基线逐字相同；
   - C17 没有采用一览时句子不带采用部分。
10. **全量**：带 `QRP_DESK_ROOT=/Users/kaylame/KaylaProject/portfolio-desk` 的 QRP 全量测试 0 失败；schema 校验；Research Web `node --check`；`git diff --check`。

交付：一个 PR 到 QRP main，冻结后的本增补（与冻结说明）原样作为第一个提交。真实锁的导入、合并与重启 `com.upmeai.qrp-research-web` 由协调会话做。

## 8. 待冻结选择汇总（★ = 推荐）

| # | 选择 | ★ | 其他 |
|---|---|---|---|
| 1 | case id（§1.2） | `RRC-C17-V2-4000USDT-V8-1-M0`（与账本名一致） | `RRC-C17-V2-3000USDT-V8-1-M0` |
| 2 | BTC 口径说明（§1.2，修订 5 E2） | 登记 C17 说明，新口径词「只计价格变化，不计资金费」 | 不登记，不写口径行 |
| 3 | M1（§1.2） | 拷入 M1 包清单，不写生产者，诊断失败关闭，另立规格 | 借用 QS 成本模型（违反 R2） |
| 4 | R 值小数位（§1.4） | C17 三位（+0.098 R 不被写成 +0.10 R） | 两位 |
| 5 | 概率小数位（§1.4） | C17 两位（6.95%） | 一位（7.0%） |
| 6 | 一句话结论里标签的位置（§2.2） | 结论在前，标签分句紧跟 | 标签在最前 |
| 7 | `simulated: false` 的补充行（§3.1） | 档案登记 `kind` 后接受，写「补充（规则边界 / 近似大小）」 | 照 G2 拒绝（不可用）；当模拟行（改标签） |
| 8 | 每 10 分钟扫描那一行（§3.2） | 结论区块一行（与参照并列，不算差值） | 另进总览一句话 |
| 9 | 跌破 1,800 的口径（§5） | 标签写「看重抽路径中的最低权益」（来自报告 §7） | 只写「跌破 1,800 的概率」 |

不需要选择、直接定下的：strategy_ref `C17_V2_4000USDT`；比较对象 BTC 买入持有 + 现金；底线 1,800 USDT；停止事件与 HALT_HONORED 的读法（§4）；前向读法（§3.4）；输入与引擎摘要的新式（§6.1、§6.2）；原因码登记（§2.2 第 5 条）。这些都可以在冻结时改。

## 9. 不做

- 不改封存文件，不重算任何数字，不替研究会话改标签、角色或 `simulated`。
- 不改导入规格原文、US_V5 的值与输出、QS 的读法与输出。
- 不写代码，不改 `config/` 下任何文件，不导入任何锁，不碰真实 `var/ledger`、`var/evidence`，不重启 4311。
- 不合并 `research/c17-engine-qrp`；不在 Mac 上取 Binance；不拷原始数据。
