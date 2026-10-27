# Desk 复盘 → QRP 研究问题 → 采用结论回到 Desk：QRP 一侧说明（草案）

> 状态：**DRAFT 2026-10-27**，随 desk 草案一起由协调会话冻结；冻结前不写代码。
> 主稿：portfolio-desk `docs/REVIEW_LOOP_ACCEPTANCE_V1_ADDENDUM_6.draft.md`（分支 `draft/review-loop-addendum-6-research-routing`）。契约归 desk；本文只写 QRP 要做什么、为什么。
> 本仓库是公开的：本文不含 desk 的复盘事实。导入的 desk 内容只进 `var/`（已被 `.gitignore` 忽略），不进 git、文档或证据包。

## 1. 现状：为什么四条策略的回链都是 0，US_V5 一直写「尚未回到 Desk」

| 事实 | 位置 |
|---|---|
| 回链账本 `var/ledger/runtime-research-loop/links.jsonl` 不存在，没有任何代码调用过 `registerReviewQuestion` | `services/runtime-research-loop/index.js:465` |
| `cases.jsonl` 只有 US_V5 的 case。QS V3、C17_V2、US_CORE 的 case_ref 只登记在策略档案里，`registerReviewQuestion` 对它们会报 `LOOP_CASE_NOT_FOUND` | `config/strategy_profiles.v1.json` |
| 「锁定结果回链」只接受旧实验引擎（`experiments.verifyFreeze` + `RESULT_LOCKED`）的锁 | `services/runtime-research-loop/index.js:495`–`:507` |
| 现在真实的研究结果都是基线锁（`BASELINE_EVALUATION`）或对比锁（`COMPARISON_EVALUATION_LOCK_V1`）：US_V5 Q0–Q5、另三条策略的 Q0。它们走不进上面那条路 | `var/ledger/research/{baseline,comparison}_evaluations.jsonl` |
| 「已有 N 项回到 Desk」数的是带 `result_hash` 的回链，所以永远是 0 | `services/research-workspace/index.js:498`、`:367` |
| US_V5 已有 5 项 Owner 采用决定在 QRP 账本里，desk 看不到 | `var/ledger/research/adoption_decisions.jsonl` |
| 冻结的闭环验收说采用决定由 Desk `REVIEW_LOOP_WEEK_V1` 产出；UX 修订 6 实际把它记在 QRP | `docs/contracts/CYCLE_RESEARCH_DESK_RUNTIME_RESEARCH_LOOP_ACCEPTANCE_V1.md` §1.3、K4；`services/research-adoption/index.js` |

## 2. QRP 要做的五件事（desk 主稿冻结、desk 契约准入之后）

1. **导入 desk 研究队列**（主稿 §4）。
   - 新 CLI 只读本机 desk checkout 的 `docs/review-loop/research-queue/`（`QRP_DESK_ROOT`，同 `services/desk-strategy-directory` 的读法），核对文件 hash 和它的 `sourceWeek`。
   - 每个 `questionKey` 只在第一次出现时登记一条回链，复用 `RUNTIME_RESEARCH_LINK_V1`，不另建问题账本（主稿 D6 ★）。字段这样填：
     - `desk_candidate_ref` = desk 候选号；
     - `desk_evidence_ref`、`desk_evidence_hash` = 首次出现的队列文件和它的 sha256；
     - `research_question_ref` = `DQ-<questionKey>`；Owner 选「并入」时取那个 QRP 题号。
   - 之后的周 `link_id` 相同，什么也不写。
   - Owner 挑选状态、出现周数这些 desk 状态，每次现读最新一份队列，不存副本：QRP 闭环验收 D1「不复制 Desk 状态机」。
2. **补开运行态 case。** 为 QS V3、C17_V2、US_CORE 按档案的 case_ref 开 case，字段与档案一致。不然它们的 desk 问题无处挂。
3. **回链接受基线锁和对比锁。** `linkLockedResult` 增加一种绑定：`{result_id, file_sha256}`，现场复验该锁 `LOCKED_VERIFIED`，而且没有被同题新锁取代。旧实验引擎那条路保持不变。
   - 研究会话冻结 K2 时写上 `desk_question_key`，锁才能对上回链。
   - 结论映射照 B4 写成 PASS、FAIL、INSUFFICIENT；`adoption_state` 仍从 `NOT_DECIDED` 起。
4. **导出回程文件 `QRP_RESEARCH_RETURN_V1`**（主稿 §5.1，契约归 desk，生产者 QRP）。
   - 新 CLI 从 `adoption_decisions.jsonl`（每个对象取有效记录）、两本锁账本和 `links.jsonl` 投影出两部分：`decisions[]`，以及研究进行中的 `questions[]`。
   - 带各账本的 sha256，写到 desk checkout 的 `docs/review-loop/research-return/`。这一步由协调会话随周档提交，QRP 不写 desk 的其他路径。
   - 不新增判断，不改任何锁、判据或采用记录。
5. **改「回到 Desk」的数法。** 读 desk git 的周档 `researchReturns[]`，数其中被引用、而且 `recordHash` 一致的 QRP 采用决定（`kind = DECISION`）。
   - 这才是一次真实往返；不再数回链的 `result_hash`。
   - 研究队列表的「来源」列，对 desk 来的题写「Desk 复盘 <候选号> · <首次出现的周>」，状态写「待 Owner 挑选」「Owner 不做」「已立研究，待冻结 K2」等。

## 3. 采用决定只记一处（主稿 D7 ★）

- Owner 的采用决定只记在 QRP `RESEARCH_ADOPTION_DECISION_V1`。desk 周档引用 `record_id` 和 `record_hash`，不另记一遍。
- 冻结的闭环验收 §1.3、K4 不改写，加一份协调说明：K4 的「采用决定」= QRP 采用记录；「后续运行版本」= 生产者的版本登记，由 desk 周档引用。
- 同步改 `runtime-research-loop/index.js:573` 的 `authority.review_and_adoption`：拆成 `review: DESK_REVIEW_LOOP_WEEK_V1` 和 `adoption: QRP_RESEARCH_ADOPTION_DECISION_V1`。

## 4. 不做

- QRP 不重扫 desk 的发现，不定去向，不替 Owner 挑选或采用。
- QRP 不写 desk 的周档、候选或收件箱。
- 导入的 desk 事实不进本仓库的 git。

## 5. 完成证据（QRP 部分）

- **E1 测试**：
  - 队列重复导入不多出回链；
  - 同键跨周只有一条；
  - 并入时挂到已有题；
  - 基线锁和对比锁的回链能复验，锁被取代时拒绝；
  - 回程文件对 Q1–Q5 的映射逐行等于账本；
  - 导入只写 `var/`。
- **E2 运行**：导入 desk 第一份研究队列后，US_CORE 的 `link_count` 为 1；第一份带回程的 desk 周档提交后，US_V5 页头写「已有 5 项回到 Desk」。
- **E3 产品**：随 desk 主稿 E3，由 Owner 抽查。
