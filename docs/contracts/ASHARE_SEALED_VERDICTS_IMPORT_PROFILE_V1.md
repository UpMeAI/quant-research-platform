# A 股研究封存结论 · 导入规格 V1（ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1）

状态：随 QRP PR 交协调会话审阅；协调会话合并即采用。依据：desk 复盘闭环修订 8（FREEZE_1，sha256 `154a829a…`）§5「A 股导入」。Production effect：`NONE`。

## 0. 范围

- 导入 A 股研究已封存、结论为「做」或「不做」的文件，一题一条锁：记录类型 `ASHARE_SEALED_VERDICT_V1`，锁模式 `ASHARE_SEALED_VERDICT_LOCK_V1`，台账 `research/ashare_sealed_verdicts.jsonl`。
- 不导入：A 股 Q0 账户（不读）、只描述不判定的读数、校准门（A05）、前向影子、未封存的研究（修订 8 §3）。

## 1. 绑定与导入

与海外规格 §2、§3 同一套：全部按 sha256 绑定，Ashare-V6 的文件钉在提交上（`git show <commit>:<path>`），协调会话目录的文件按 sha256 绑定；`stage` 取字节并核对，`import` 只有完成权威能写，整批校验后追加，重复导入是幂等重放，改锁要 supersede、缺陷引用和理由。错误码沿用 `OVERSEAS_VERDICT_` 前缀。

## 2. 本版登记的 8 题

| entry_id | 簿 | 结果 sha256（前 12 位） | 提交 | 期望结论 |
|---|---|---|---|---|
| CN-R-ETF-1 | INDEX_BOOK | `6eda510cd7dd` | `84adf8b9` | 做 |
| CN-R-ETF-1-A1 | INDEX_BOOK | `3759a1835c06` | `abe9a3fe` | 做 |
| CN-R-ETF-2-510300 / 510500 / 588000 / 159967 / 510880 | INDEX_BOOK | `d45595910e42` | `d62dde22` | 不做 ×5（K2 §6 逐只判定） |
| CN-PVS-0 | ASHARE_V6_PAPER | `ddeb4ed7f03c` | 不在 git，`PVS_0_CONCLUSION_1.md` | 做 |

CN-PVS-0 的结论读自封存文字（`read.pattern`），`verdictState` 是冻结页要求必须写的那一句。

## 3. 真导入

```bash
node apps/research-cli/import_ashare_verdicts.js stage --ashare-v6-root /abs/Ashare-V6 --artifacts-root /abs/artifacts/coordinator --out /abs/var/evidence/ashare-verdicts-<date>
QRP_PRODUCT_MILESTONE_AUTHORITY=<完成权威> node apps/research-cli/import_ashare_verdicts.js import --evidence /abs/var/evidence/ashare-verdicts-<date> --registered-by <完成权威>
```
