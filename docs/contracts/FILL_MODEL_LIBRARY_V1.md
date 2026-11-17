# FILL_MODEL_LIBRARY_V1 · 统一成交模型库（骨架）

- 依据：引擎建模验收合同 `ENGINE_MODELING_ACCEPTANCE_V1`，Owner 2026-11-17 00:15 CST 签字。
  - 签字文本 `artifacts/coordinator/ENGINE_MODELING_ACCEPTANCE_V1.signed.8d214ddf.md`（sha256 `8d214ddf…`）：§0.1（实盘节奏，逐个账本）、§2.2（E2 统一成交模型库的验收）；
  - 签字页 `artifacts/coordinator/ENGINE_MODELING_ACCEPTANCE_V1_SIGNATURE_1.md`（sha256 `d1d61283…`）；
  - 实施规格 `artifacts/coordinator/FILL_MODEL_LIBRARY_V1_SPEC.draft.md`（sha256 `90814c60…`）：§1 位置、§2 规则、§3 逐个账本的声明、§4 骨架范围。
- 性质：骨架。不改 V6 和 smartflow，不接任何引擎；各引擎的迁移另开 PR（签字文本 §5 第 4、6 步）。不改任何账本的实盘行为。

## 1. 位置与用法（规格 §1）

- 唯一的源码：QRP `packages/fill-model/`。纯 JavaScript，没有依赖，不读行情，不写文件，不读宿主时钟（时间一律是毫秒数）。
  - `index.js`：十二条规则（每条一个纯函数，按单个事件调用）；
  - `series.js`：每条规则沿时间序列的逐行用法（第 j 行只用第 0…j 行），G-CAUSAL 按它跑；引擎回放也可以照这个样子调用。
- V6 和 smartflow：用 `tools/fill-model-vendor/vendor.js --target <仓库根> [--commit <QRP 提交>]` 把某个 QRP 提交里的字节原样拷到 `vendor/fill-model/`，旁边写 `PIN.json`（`FILL_MODEL_VENDOR_PIN_V1`：QRP 提交号、每个文件的 sha256）。再把 `tools/fill-model-vendor/fill-model-vendor-guard.test.template.js` 拷进自己的测试（node:test 与 jest 都能跑）：拷来的字节必须等于钉住的提交，漂移、缺文件、多余文件都红。做法同数据集登记表的 PIN。

## 2. 规则（规格 §2）

价格方向：`BUY` 加滑点、`SELL` 减滑点；按最小价位对齐时，对齐方向不利于自己（买向上、卖向下）。

| 规则 | 输入 | 输出 |
|---|---|---|
| `NEXT_OPEN` | 下一根开盘价、滑点 bps、方向、可选最小价位与涨跌停带 | 成交价 |
| `GAP_THROUGH_LEVEL_AT_OPEN` | 价位、开盘价、穿越方向（`DOWN` / `UP`） | `{filled, price}` 或 `NOT_GAPPED` |
| `SAME_BAR_STOP_FIRST` | 最高、最低、止损、止盈、持仓方向 | `STOP` / `TARGET` / `NONE`（两个都碰到判 `STOP`） |
| `LIMIT_CROSS_ONE_TICK` | 限价、最小价位、最高、最低、方向 | 越过一个价位才成交，按限价 |
| `PREV_DAY_VOLUME_CAP` | 前一交易日量（已按拆分换算）、参与率（默认 0.1）、想成交的数量、每手股数 | 可成交数量；读不到前一日量 → 0、`PREV_VOLUME_MISSING`（函数不接受当天量） |
| `TOUCH_MINUTE_CLOSE` | 触价那一分钟的收盘价、滑点、方向 | 成交价 |
| `TICKER_LAST_PLUS_SLIPPAGE` | 扫描时刻的最新成交价、滑点、方向 | 成交价 |
| `MARKET_AFTER_POLL` | 轮询时刻、1 分钟线、滑点、方向 | 开始时刻严格晚于轮询的第一根的开盘价 |
| `TIERED_LIMIT_STOP` | 触发价、触发时刻、方向、1 分钟线、档位（默认 2% / 60 秒、4% / 300 秒） | 成交价、档位（1、2、`MARKET`）、成交分钟 |
| `POLL_EVERY(interval)` | 时段窗口、间隔 | 轮询时刻序列（`priceAtPoll` 给出轮询看到的价格） |
| `FORMING_BAR_AS_OF_POLL(barInterval)` | 1 分钟线、轮询时刻、大 K 线间隔、对齐起点 | 正在形成的那根（只用轮询前已收完的分钟线） |
| `SCAN_SCHEDULE(spec)` | `INTERVAL`、`COMPLETED_1H`（开盘后 1 分钟只管出场，此后每根收完的 1 小时线结束后 1 分钟执行；提前收盘只到最后一根完整的）、`ROUND_ROBIN_BATCHES` | 扫描时刻序列 |

- 节奏反例（签字文本 §2.2 第 4 条）：两次轮询之间先碰到又回来的价格，按轮询判不到（`priceAtPoll`）；正在形成的 1 小时线在第 n 分钟的高低价，只用到第 n 分钟为止的分钟线。
- 因果（§2.2 第 3 条）：`docs/evidence/fill-model-v1/` 的清单与合成夹具，`tools/causality-harness` 跑出 `CAUSALITY_EVIDENCE_V1.json`：十二条全部 `role: FILL`，T-C1、T-C2、T-C3 全 PASS。证据绑定规格的 sha256（`k2_sha256` = `90814c60…`，`study_ref` = `FILL_MODEL_LIBRARY_V1`），`code_sha` 是跑证据时的 QRP 提交。今后的 K2 按附录 1 A1 把成交函数写成 `CF:` 行时，可以按代码 sha 引用这份证据；库改了就重跑（`tests/fill_model_evidence.test.js` 核对字节）。

## 3. 逐个账本的声明（规格 §3）

- `config/fill_model_declarations.v1.json`（`FILL_MODEL_DECLARATIONS_V1`）：6 个账本、每个 2 段，共 12 条。每条写 K 线、节奏规则与参数、成交规则与参数、实盘出处（`<仓库>:<路径>:<行>`）、环境开关、锁。
- 环境开关不在仓库里，测试读不到：取协调会话 2026-11-17 00:16 CST 读到的值（HK 上读 pm2 的环境，Mac 上读 V6 调度器容器），每条写值与在哪里读的；协调会话每次部署之后重读一次，有变化就改这里。
- 结构校验：`services/fill-model-declarations` 的 `validate`（规则都在库里、节奏规则只放在 `cadence`、出处指向钉住的仓库、环境开关写明来源、每条锁的正则只有一个捕获组、每个账本两段、没锁的写明原因）。
- **锁定测试**（`tests/fill_model_declarations.test.js`）：按 `git show <钉住的提交>:<路径>` 读 V6 `83ab3af1` 与 smartflow `3b25fb61` 的源文件（只读），按正则取出常量的源码文字逐字比较，能算的再按算式比数值。仓库路径：环境变量 `QRP_V6_ROOT` / `QRP_SMARTFLOW_ROOT`，否则取 QRP 旁边的 `Ashare-V6` / `smartflow`；都不在时跳过并写明原因。实盘改了常量，这个测试就红；重钉提交时一并核对。
  - 锁住的：V6 盘中 60 秒（`DEFAULT_INTERVAL_MS = 60_000`）、上海时段 09:30–11:30 与 13:00–15:00、指数簿开盘 09:30:30；smartflow 的 US_V5 扫描节奏（`COMPLETED_1H`、`MINUTE_MS`、`ROUND_LAG_MS = MINUTE_MS` 即 :31 分、开盘 09:30、收盘 16:00、提前收盘 13:00）、US_V5 盯盘 60000 毫秒、杠杆 ETF 分级止损 2% / 60 秒与 4% / 300 秒、US_CORE 单边成本 0.0005、C17 入场每 10 分钟、Quick Shot 每分钟一批与 6 批、Quick Shot 出场 5 分钟。
  - #110 补的锁（#100 留下三条没锁的，每条都在源码里找到了常量）：五段个股簿滑点 10 bp（V6 `src/stock-book/paper-cost.js:5`，收盘段与触价段都锁）；US_CORE 16:35 日决策（`us-core-rotation-worker.js:495` 的 `16 * 60 + 35`）、触价时段 09:31–16:05（`:2018–2019`）、触价 60 秒一轮（`:2724`）；C17 出场保护 60 秒一轮（`strategy-worker.js:1556`）。现在 12 条全部有锁，共 28 条。
- **漂移核对**（#110）：`verifyLocks(doc, { commits: { <仓库>: <40 位提交号> } })` 换一个提交核对同一份声明，钉住的提交不变；命令行 `node tools/fill-model-declarations/check-locks.js --commit ashare-v6=<sha> --commit smartflow=<sha>`，有 FAIL 或 SKIPPED 时退出码 1。钉住的提交仍是 §0.1 读代码时的 V6 83ab3af1（Mac 调度器镜像 `ashare-v6-main:83ab3af1`，协调会话 11-17 09:59 读出）和 smartflow 3b25fb61；协调会话部署后用这个命令核对新部署的提交，全过再改钉。#110 写入时核对过 V6 main b3d05845 与 smartflow main 93428ef8：28/28 PASS。

## 4. 容量模型（签字文本 §2.2 第 6 条，#110）

- `services/capacity-model`（`CAPACITY_REPORT_V1`）：容量模型 = `PREV_DAY_VOLUME_CAP` 加上每笔的参与率报告。上限只调库里的 `PREV_DAY_VOLUME_CAP`，不另算。
- `participationReport({ fills, participation = 0.1, lotSize = 1 })`：每笔 `{ id, symbol, date, side, desired, prevDayVolume, lotSize? }` → `{ quantity, cap, participation（成交 ÷ 前一日量）, desiredParticipation（想要的 ÷ 前一日量）, state }`。
  - 四种状态分开记：`WITHIN_CAP`、`CAPPED`、`PREV_VOLUME_MISSING`（前一日量读不到：未知，成交 0，参与率 null，不当 0、不回退到当天量）、`PREV_VOLUME_ZERO`（读到了，是 0：上限 0，参与率 null）。
  - 带当天量的成交（`todayVolume`、`sameDayVolume`、`volume`）拒收：`CAPACITY_SAME_DAY_VOLUME_REFUSED`。
  - 汇总：四种状态的计数、已知笔数、参与率的最大值与 p50 / p95（最近秩，只在前一日量已知且大于 0 的成交上算；没有就 null）、想要的参与率的最大值、未成交数量（其中前一日量未知的部分单列）。
- `capacityAxis(report)`：赛马的容量轴，`status: MODELLED_PREV_DAY_VOLUME_CAP_V1`、汇总、报告的 sha256；报告先过自洽核对（`CAPACITY_REPORT_INVALID`）。
- 两个适配器（`adapters/ashare-local`、`adapters/replay-core-bridge`）：作业的原生结果带了 `capacity_report` 才填容量轴；没带的照旧 `NOT_IMPLEMENTED_P4`，`normalize_result` 的输出与改动前逐字节一致（`tests/capacity_model.test.js` 记了改动前在 c6e1dd4 上算出的 sha256）。
- 谁出报告：回放引擎在成交时调 `PREV_DAY_VOLUME_CAP` 的那一处（V6 五段个股簿补量上限的 PR，签字文本 §5 第 4 步）。在那之前没有作业带报告，容量轴照旧。

## 5. 范围之外

- 引擎迁移（V6、smartflow）另开 PR（签字文本 §5 第 4、6 步）。
- `schemas/index.js` 不改（规格 §4 第 6 条）。
