# 海外研究封存结论 · 导入规格 V1（OVERSEAS_SEALED_VERDICTS_IMPORT_PROFILE_V1）

状态：随 QRP PR 交协调会话审阅；协调会话合并即采用。起草：海外研究会话，2026-11-05 CST。
题源：Owner 2026-11-05「研究站点页面也需要保持更新」；协调会话 11-05 指示，把 11-03 起海外研究封存的结论导入 QRP，挂在各自策略上。
Production effect：`NONE`。

## 0. 范围

- 导入 2026-11-03 起海外研究会话封存的结论，按题挂在各自策略的详情页上：C17_V2_4000USDT、QUICK_SHOT_V3_1000USDT、US_V5_ETF_3000USD、US_CORE_9000USD_3X_GATEOBS。
- 每题一条锁，记录类型 `OVERSEAS_SEALED_VERDICT_V1`，锁模式 `OVERSEAS_SEALED_VERDICT_LOCK_V1`。
- 已有专门导入器的结论不在本规格内，照旧：Q0、Q1–Q6、GAP、Q0S、M2 轮次、Carry V2。
- 前向影子题只登记「冻结的影子规格 + 部署状态」，不导入任何前向数值。

## 1. 三类题

| kind | 绑定文件 | 页面「结论」列 |
|---|---|---|
| RESULT | 封存结果文件（JSON） | 从文件原样读：结论、证据强度、允许用途、说明 |
| DRAFT | K2 草稿（未冻结） | 「草稿（未冻结）」 |
| STATUS | 冻结的前向影子规格 | 「前向影子运行中」，附部署核对日期 |

- RESULT 的结论按登记的 JSON 路径读出。
- 登记表同时写下期望结论（例如「不做」）。读出的与期望不同，就整批拒绝。

## 2. 绑定（全部按 sha256）

- **smartflow 的文件**：钉在提交上（`git show <commit>:<path>`），包括结果文件、K2、同题的另一封存文件，以及放在 smartflow 的冻结记录。
- **协调会话的冻结记录**：`artifacts/coordinator/…`，不在 git 里，按 sha256 绑定。
- **取证据**（`import_overseas_verdicts.js stage`）：
  - 取出每个绑定文件，sha256 不符就停；
  - 写进证据目录，每个文件带 `.sha256` 旁注；
  - 再写一份 `STAGE.json` 清单。
- **导入**（`import_overseas_verdicts.js import`）：
  - 只有完成权威能写；
  - 整批先校验（文件、旁注、期望结论），全部通过才追加锁。

## 3. 锁

- 一题一条：`result_id = OSV-<entry_id>-<绑定文件 sha256 前 12 位>`。
- 同一文件重复导入是幂等重放，不写新行，台账旧字节不变。
- 同一题已有另一份锁时拒绝，除非 `supersedes` 指向当前锁，并给出缺陷引用与理由。旧锁保留。
- 锁里不放任何前向数值，只记 sha256、引用、结论文字与日期。

## 4. 页面

- 位置：策略详情「研究与对比」页签，「研究队列」之后，标题「海外研究结论（2026-11-03 起封存）」。
- 表格列：题、结论、证据强度、允许用途 / 说明、日期（封存日；草稿为起草日）、K2 SHA-256、结果 SHA-256。
- 每题可展开：说明原文、来源与哈希（每个绑定文件的引用与完整 sha256、smartflow 提交、锁定时间）。
- 每次读页面都现场复验 sha256：文件漂移显示「校验未通过」与原因；文件缺失显示 MISSING。两种情况都不显示结论。
- 「做」≠ 生产采用：生产变更照旧要 Owner 签字。

## 5. 本版登记的 16 题

| entry_id | 策略 | 类型 | 绑定文件 sha256（前 12 位） | K2 |
|---|---|---|---|---|
| C17-Q4 | C17_V2 | RESULT | `baa60ba86c44` | `56a976593f4f` |
| C17-N2 | C17_V2 | RESULT | `3cc7a2cff18b` | `1849879db0f5` |
| C17-N4 | C17_V2 | RESULT | `83fda6e7d4d9` | `008e416f9248` |
| C17-N4-SHADOW | C17_V2 | STATUS | `56ccf0b8cfa3` | — |
| C17-N6 | C17_V2 | RESULT | `37d8c9d16b0a` | `fd7783507c2e` |
| C17-N7 | C17_V2 | DRAFT | `fa6032d2fd67` | 同左 |
| QS-Q4 | QUICK_SHOT_V3 | RESULT | `baa60ba86c44` | `56a976593f4f` |
| QS-N7 | QUICK_SHOT_V3 | DRAFT | `fa6032d2fd67` | 同左 |
| US5-X06 | US_V5 | RESULT | `97677edb6542` | `9698d490575e` |
| US5-N3 | US_V5 | RESULT | `c9b473398ef6` | `309c400e1e5d` |
| US5-N5 | US_V5 | RESULT | `9416bc71c2b8` | `6b834e8a2f8c` |
| US5-Q6-M1-SHADOW | US_V5 | STATUS | `56c60d9bb79e` | — |
| UC-U08-Q0 | US_CORE | RESULT | `5f85fd8a34cd` | `ab4302b7e492` |
| UC-U13-30M | US_CORE | RESULT | `78a9b2aa53da` | `0ac538ea0b73` |
| UC-N1 | US_CORE | RESULT | `0fe7c5976ece` | `8be74d382f2b` |
| UC-X08 | US_CORE | RESULT | `14e8f567c623` | `59ac9e5e931c` |

- 完整 sha256、钉版提交与冻结记录都写在 `services/overseas-sealed-verdicts/index.js` 的 `ENTRIES` 里。
- 补充：
  - US5-Q6-M1-SHADOW 引用已有的 Q6 锁 `Q6-0510c7da07196bb2`。
  - UC-X08 的 K2 是 Owner 签署的验收（`f7664c1b`）。
- N7 冻结、封存之后，用新的 RESULT 题 supersede 草稿题（§3）。新增题目只改登记表，并写进本规格的下一版。
