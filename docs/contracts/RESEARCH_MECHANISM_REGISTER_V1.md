# 研究机制登记 · QRP_RESEARCH_MECHANISM_REGISTER_V1

- 依据：研究框架修订 2026-11-12 §4（机制登记与去重）、§5（K2 §0 加四行）、§2.4（AI 输入检查）。协调会话目录的文件，按 sha256 绑定。
  - 绑定冻结页 `RESEARCH_FRAMEWORK_AMENDMENT_20261112_FREEZE_1.md`（`c9742ea0…`，2026-11-15T22:47:42+08:00）；
  - 它冻结草稿修订 1（`d7f85a87…`）与冻结审阅修订 3（`d943d342…`），E1–E19、G1–G20 全取 (a)；
  - 绑定与生效时刻只写在 `services/research-framework-amendment-20261112/index.js` 一处，本门与 G-CAUSAL 共用。
- 代码：
  - `services/research-mechanism-register/index.js`：登记表、校验、交叉核对、分诊查询；
  - `services/research-mechanism-register/gate.js`：G-MECH、K2 §0、AI 输入；
  - `apps/research-cli/mechanism_query.js`：命令行。
- 测试：`tests/research_mechanism_register.test.js`、`tests/research_mechanism_gate.test.js`，全部是合成夹具。
- production_effect: NONE。只读，不写分诊台账，不改任何封存文件、锁或结论。

## 1. 登记表 `config/research_mechanism_register.v1.json`

格式照层登记（`config/research_layer_register.v1.json`）：require 时校验，缺字段就抛错（`MECHANISM_REGISTER_*`）。

**`mechanisms[]`** 一个机制 = 一个效应 + 所在的层 + 作用的决策点；参数、阈值、窗口长短都不算新机制。

| 字段 | 规则 |
|---|---|
| `mechanism_id` | `<前缀>.<主题>.<变体>`，正则 `^(SEL\|RISK\|ACCT\|EXEC)\.[A-Z0-9_]+\.[A-Z0-9_]+$`，不重复 |
| `layer` | 与前缀一一对应：SEL = `SELECTION_TIMING`、RISK = `RISK`、ACCT = `ACCOUNT`、EXEC = `NA_EXECUTION`。诊断、工程、待定的题不登记机制 |
| `decision_point` | `SELECT` 选标的 / `DIRECTION` 方向 / `ENTRY` 入场 / `EXIT` 出场 / `SIZING` 仓位 / `COST` 成本 |
| `title_zh`、`description_zh` | 各一行；泛化写法，不含 Owner 原话和生产风控数字 |
| `parent` | 可选；必须已登记，不成环 |

**`entries[]`** 一题一市场一条。键 = `item_id` + `market`，不重复。

| 字段 | 规则 |
|---|---|
| `item_id` | 总表编号或 `study_ref` |
| `strategy_ref` | 族（试验台账的 `family_id`） |
| `market` | 只取 `CN_A` / `US_EQUITY` / `CRYPTO`；跨市场的题按读过的市场各登记一条 |
| `mechanism_ids[]` | 至少一个，都已登记 |
| `classified_by`、`reason_zh` | 理由一行，写明节号 |
| `conclusion` | 可选，只给已封存的题写；没有时查询里列为「在研」 |

**`conclusion{}`** 的事实从封存文件抄录，协调会话核对：

| 字段 | 规则 |
|---|---|
| `verdict` | `DONT` / `DO_INSUFFICIENT` / `DO_SUPPORTED` |
| `strength_zh` | 证据强度 |
| `power` | `{ value: 0–1 \| null, ge_80: true \| false \| null, effect_zh, source_zh }`。功效按先前 K2 预登记的判定效应算；`value` 有值时 `ge_80` 必须等于 `value ≥ 0.8`；只有 MDE80 时 `value = null`、`ge_80` 照比较结果写；读不到时两项都写 `null`，按「不到 80%」处理 |
| `family_id`、`sealed_on`、`seal_sha256` | — |
| `data_window` | `{from, to}`，`to` 不晚于封存日；读不到写 `null`，新数据记 UNKNOWN |
| `sealed_ref` | 可选：`ASHARE_SEALED_VERDICTS:<id>` 或 `OVERSEAS_SEALED_VERDICTS:<id>`。写了的，测试拿 QRP 封存结论 `ENTRIES` 核对 sha256、封存日、做 / 不做（`crossCheck`） |
| `state` | 状态会变，所以写明 `as_of`，由协调会话改写。`DO_INSUFFICIENT` 写 `{ shadow_running, as_of }`，`DO_SUPPORTED` 写 `{ live, as_of }`，`DONT` 不写 |

首版两部分都为空。机制 id 与补登记（§4.5）另开 PR 写入，协调会话核对。

## 2. 分诊查询（§4.3）

`query({ mechanism_ids, market, owner_named }, { registerBytes, registerCommit, marks, asOf })` 返回 `MECHANISM_PRIOR_TABLE_V1`。

- **市场**：`CRYPTO_USDM_PERP` 按 `CRYPTO` 比较。
- **数据段标签**：只取同市场、`registered_at ≤ asOf` 的 `DATA_SEGMENT_MARK_V1`（默认读本机试验台账）。
- **每个 id 各查一次**：同 id、同市场的结论按 `sealed_on` 排序，同一天按登记表顺序。**最晚一条是先前结论**。
- **新数据**：满足下面任一条就算有新数据（`new_data.state = YES`）。
  1. 同市场任一族有效的 UNSEEN 段（`trial-ledger` `segmentsFor` 的读法：后写覆盖先写，没标的日期当 SEEN）不完全落在先前窗口内；
  2. 同市场有晚于先前窗口的 FORWARD_READ；
  3. 有更晚的结论。

  先前窗口为 `null` 时记 `UNKNOWN`。

| 先前结论（最晚一条） | 条件 | `route` |
|---|---|---|
| `DONT`，`ge_80 = true` | 新数据 `NO` | `NOT_DO_SETTLED`：不做（已判），引用封存 sha256，不写新 K2 |
| `DONT`，`ge_80 = true` | 新数据 `YES` 或 `UNKNOWN` | `NORMAL_CITE_PRIOR` |
| `DONT`，`ge_80` 为 `false` 或 `null` | — | `NORMAL_STATE_DIFFERENCE` |
| `DO_INSUFFICIENT` | 影子在跑 / 不在跑 | `ATTACH_TO_SHADOW` / `NORMAL_CITE_PRIOR` |
| `DO_SUPPORTED` | 已上线 / 未上线 | `QUARTERLY_ABLATION` / `NORMAL_CITE_PRIOR` |
| 没有结论 | — | `NORMAL_NO_PRIOR` |

- **Owner 点名**（`owner_named: true`）一律 `NORMAL_OWNER_NAMED`，列表照附。
- **多个 id**：去向都相同时沿用那个去向；不相同时记 `NORMAL_MIXED`。所以只有每个 id 都是 `NOT_DO_SETTLED`，整体才是 `NOT_DO_SETTLED`。
- **父、子 id** 上的结论只列在 `related`，不参与路由。
- **在研**：同 id 的在研题列在 `in_progress`。
- 「不做（已判）」只是分诊读数，不是研究结论。
- 分诊台账（`RESEARCH_TRIAGE_V1`）的码表与 desk 同表，本查询**没有**接进去。接入要先改 desk 码表，另开 PR。

表的规范字节由 `tableBytes()` 生成：键排序的 JSON 加换行。同样的输入（登记表字节、提交、标签）得到逐字节相同的表。

## 3. 导入器的门（§4.4、§5、§2.4）

**接入位置**：`services/overseas-sealed-verdicts` 的 `checkEntry`，在 G-TRIAL 之后。A 股导入器走同一套 `importVerdicts`。

**适用范围**：
- 只对 `entry.k2_frozen_at ≥ EFFECTIVE_FROM` 的题生效。
- `EFFECTIVE_FROM` = 冻结页写出的生效时刻 `2026-11-15T22:47:42+08:00`（E13 / G14 同一个常量）；此前冻结的 K2 不追溯。
- 封存在生效日及以后、却没写 `k2_frozen_at` 的题，拒绝。
- 不适用的题照原样写锁，锁行逐字节不变；适用且通过时，锁行加 `mechanism_gate{}`。
- 门只拒绝导入，不改结论。

**K2 §0 四行**：K2 正文必须有下面四个标签，每个标签后面不为空；缺第 n 行即 `K2_SECTION0_LINE_MISSING:<n>`。
- `**机制**：`
- `**预期失效方式**：`
- `**可能被哪条现行规则解释**：`
- `**AI 输入**：`

第 2、3 行只是披露，内容不评价。

**G-MECH**：
- 第 1 行写出的 id 集合 = `entry.mechanism_ids`（`MECHANISM_K2_IDS_MISMATCH`）。
- `entry.mechanism_prior_table` 按 sha256 绑定一份 `MECHANISM_PRIOR_TABLE_V1`，以绑定文件的身份进证据目录，角色 `MECH_PRIOR`。
- 导入器依次核对：
  1. 这个 sha256 写在 K2 正文里；
  2. 表的 `query` 与 entry 的 id、市场一致；
  3. `as_of ≤ k2_frozen_at`；
  4. 表写了登记表提交（`register.commit`）；
  5. `git show <commit>:config/research_mechanism_register.v1.json` 的 sha256 与表一致；
  6. id 都在那一版登记表里；
  7. 用那一版登记表、加上 `as_of` 之前登记的标签重算，逐字节相同。

  不过即 `MECHANISM_*`。

**AI 输入**：
- `entry.ai_inputs` 必须有（`AI_ROLE_INPUTS_MISSING`）。
- 每项 `{ category, ref, desc_zh }`，类别只有 `EXTRACTED_FACT`（`AI_ROLE_CATEGORY_NOT_ALLOWED`）。
- 与第 4 行一致（`AI_ROLE_K2_LINE_MISMATCH`）：
  - 空数组 ⇔ 第 4 行写「无」；
  - 否则第 4 行里 `EXTRACTED_FACT` 出现的次数 = 项数，且不写别的类别。

## 4. 命令行

```
node apps/research-cli/mechanism_query.js --mechanism-id <id> [--mechanism-id <id> …] --market CN_A|US_EQUITY|CRYPTO \
  --as-of <ISO +08:00> [--owner-named true] [--register-commit <40 hex> [--repo <QRP 仓库>]] [--out <file.json>]
```

- K2 冻结时用 `--register-commit`。G-MECH 只认带提交的表。
- 参数未知或缺失时失败即关。
