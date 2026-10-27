# Cycle × Research × Desk 运行态／研究态闭环验收 V1 · 协调说明 1

状态：**FROZEN**（2026-10-27，协调会话冻结裁定 1 R1：desk 复盘验收 V1 修订 6 的 D1–D10 全部采用 ★）
被说明：`docs/contracts/CYCLE_RESEARCH_DESK_RUNTIME_RESEARCH_LOOP_ACCEPTANCE_V1.md`（sha256 `f04f6baa67ea66f8c8b326c5119b64f5dd156442c3efc861e60a612564d9eccc`）。原文不改，本说明只记录 D6、D7 对它的读法，以及补开运行态 case 时两个字段的协调会话裁定（§3）；冲突时以本说明为准。
依据：desk 修订 6 主稿 §5.5、§8 的 D6、D7；QRP 一侧说明 `draft/desk-review-routing-note` ＠ `fc2d5b4` 的 §2 第 2、3 条与 §3；协调会话裁定 2026-10-27（§3）。

## 1. 采用决定只记一处（D7 ★）

- 冻结文本 §1 第 3 条、§2 的 K4 写「采用决定」由 Desk `REVIEW_LOOP_WEEK_V1` 记录。实际做法改为：
  - K4 的「采用决定」= QRP 的采用记录 `RESEARCH_ADOPTION_DECISION_V1`（`var/ledger/research/adoption_decisions.jsonl`，每个结果对象取有效记录）。Owner 的决定只记在这里，带原话、时刻和决定记录文件的 sha256。
  - desk 周档 `REVIEW_LOOP_WEEK_V1` 只引用它：可选块 `researchReturns[]` 写 `recordId` 与 `recordHash`，不另记一遍。
  - K4 的「后续运行版本」= 生产者自己的版本登记（S17 版本号或 V6 `key@version`），由 desk 周档引用；QRP 不记。
- desk 周档仍是「运行复盘 → 研究问题」的协调合同；desk 记录的是 Owner 对 desk 候选的挑选（立研究、并入、不做、先放着），那是「研究不研究」，不是「采用不采用」。
- 代码同步：`services/runtime-research-loop` 读模型的 `authority` 把原来的 `review_and_adoption` 拆成两项：
  - `review: 'DESK_REVIEW_LOOP_WEEK_V1'`；
  - `adoption: 'QRP_RESEARCH_ADOPTION_DECISION_V1'`。
- 「已有 N 项回到 Desk」从此数被 desk 周档 `researchReturns[]` 引用、而且 `recordHash` 一致的 QRP 采用决定（`kind = DECISION`），不再数带 `result_hash` 的回链。

## 2. 锁定结果回链也接受基线锁和对比锁（D6 ★）

- 冻结文本 B3 只允许 `verifyFreeze=true` 且 `RESULT_LOCKED` 的实验回链。这条路保持不变。
- 另加一种绑定：`{result_id, file_sha256}` 指向一把基线锁 `BASELINE_EVALUATION_LOCK_V1` 或对比锁 `COMPARISON_EVALUATION_LOCK_V1`。绑定时现场复验：
  - 锁是 `LOCKED_VERIFIED`；
  - 是同一 case、同一题当前的那把，没有被替代；
  - 锁的 case 就是回链的 case，文件 sha256 等于期望值。
- 回链行写 `result_ref = QRP:<result_id>:LOCKED`、`result_hash` = 锁文件的 sha256。结论照 B4 机械映射：`SUPPORTED → PASS`、`NOT_PASSED → FAIL`、`INSUFFICIENT → INSUFFICIENT`，词表外拒绝。采用状态仍从 `NOT_DECIDED` 起。

## 3. 补开运行态 case：两个字段的协调会话裁定（协调会话裁定 2026-10-27）

QS V3（`QUICK_SHOT_V3_1000USDT`）与 C17_V2（`C17_V2_4000USDT`）的 M1 封存包与 Q0 文件里，有两个 `openCase` 必填字段没有结构化来源。协调会话裁定如下：

| 字段 | 裁定的取值 | 2026-10-27 的值 | 依据 |
|---|---|---|---|
| `baseline.version_ref` | 该 case 当前 Q0 基线锁的 `result_id`（开 case 时从锁账本现读，不写死） | QS `Q0-bd83dd6ec1754dbc`；C17 `Q0-e80c42523b30f768` | 冻结基线就是这把锁定的 Q0 结果；Q0 文件没有 `identity.d_version` |
| `runtime_lane.mode` | `PAPER`（两条都是） | `PAPER` | Owner 10-25：真实行情上的纸面交易就是真实运行。C17 交易行的 `dry_run` 是纸面账本的标志（`AGENT_MODE=dry_run`） |

- 代码：`services/runtime-research-loop/profile_cases.js` 的 `COORDINATOR_RULINGS`，每条写明裁定日期与本节引用。表里没有的策略不能借用；既没有结构化来源、也没有裁定的字段照旧拒绝（`CASE_FACT_MISSING:<字段>`）。
- 由裁定推出、不另作裁定的一项：`runtime_lane.real_order = 0`，因为纸面账本不下真实订单。
- 其余字段取自已封存的事实，每一级都现场核对 sha256：
  - 档案登记的 M1 证据清单（`m1_evidence`）→ 加密 M1 封存清单 `m1-manifest.json`。QS 走证据清单登记的输入包；C17 的证据清单本身就是这份封存清单。
  - `runtime_lane.source_ref`、`source_hash` = 这份封存清单与它的 sha256。
  - `runtime_lane.version_ref` = `<ledger>@<productionHead>`。
  - `runtime_lane.as_of`、`data_quality.as_of` = `window.toExclusive`；`data_quality.known_at` = `capturedAt`。
  - `data_quality.status`、Cycle 写合同自带的 `UNKNOWN`。
- US_CORE 不在裁定范围内：版本取 Q0 文件的 `identity.d_version`，运行方式取包里运行账本的 `mode`。
- 研究隔离（三项 `false`）是 QRP 的平台不变量；证据清单写了 `safety` 块时必须与它一致。
- 开 case 写 QRP 本机账本，是运行上的一步，由协调会话在主检出上执行。

## 4. 不变

- 研究不下单、不激活、不写运行态，生产影响为 `NONE`。
- QRP 不复制 desk 状态机：desk 的挑选状态、出现周数、题目原文都不存进 QRP 账本，显示时现读 desk 最新一份研究队列。
- desk 的复盘事实只进本机 `var/`（`.gitignore` 已忽略），不进本仓库的 git、文档或证据包。
