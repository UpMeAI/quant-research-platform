# 海外研究封存结论 · 导入规格 V1 · 修订 1（标签与 N8）

状态：随 QRP PR 交协调会话审阅；协调会话合并即采用。起草：海外研究会话，2026-11-05 CST。
题源：协调会话审阅 #54 后的三处标签（2026-11-05）。
母规格：`OVERSEAS_SEALED_VERDICTS_IMPORT_PROFILE_V1.md`，原文不改。台账不改写：旧锁全部保留，新锁按 supersede 追加。

## 1. 三处更正与新增 N8

| 题 | #54 的写法 | 修订 1 | 依据 |
|---|---|---|---|
| C17-N7、QS-N7 | DRAFT「草稿（未冻结）」，绑定 K2 草稿 `fa6032d2` | STATUS「已冻结，运行中」，绑定冻结裁定 `CRYPTO_N7_TRADE_FREQUENCY_K2_FREEZE_1.md`（`0c10d255…`），K2 栏仍是 `fa6032d2` | 11-05 01:4x CST 冻结，A 遍已开跑 |
| UC-U08-Q0 | 结论栏「INSUFFICIENT」 | 结论栏「做」，证据强度栏写「统计判定 INSUFFICIENT（原因码）」 | Owner 10-06：页面结论只写做 / 不做；INSUFFICIENT 而在纸面上运行 = 做。当前 D（到价出场 10-29 起、凯利 0.42）在 HK 纸面账本上运行 |
| UC-U13-30M | RESULT「做」 | 新类型 READING「只报读数（不改规则）」 | 30 分钟读数只报不判，没有提出、也没有采用规则改动（R-A1-4） |
| C17-N8（新增） | — | STATUS「已冻结，待运行（排在 N7 之后）」，绑定冻结裁定 `C17_N8_NON_MAIN_K2_FREEZE_1.md`（`f3b1477c…`），K2 `404cd269` | 11-05 02:05 CST 冻结；新题，不需要 supersede |

## 2. 规格的补充

- **新类型 READING**：读封存文件（核 sha256，核期望值），但结论栏不写做 / 不做，只写登记的状态文字。结果 SHA-256 栏照常显示。
- **resolve**：RESULT 的统计态（目前只有 INSUFFICIENT）按登记的 resolve 写成做或不做，并写明依据（允许用途栏）。原统计态与原因码留在证据强度栏。登记表测试要求：凡期望值为 INSUFFICIENT 的 RESULT 都必须有 resolve。
- **登记修订号 rev**：同一绑定文件换了读法时 rev 加一，`result_id` 末尾加 `-r<rev>`，只能按 supersede 取代旧锁。rev 为 1 或不写的题，`result_id` 与 V1 相同，导入时照旧是幂等重放。
- **REIMPORT_PENDING**：登记已更新、台账里还是旧锁时，页面不按新读法显示旧锁，只写「登记已更新，等待按 supersede 重新导入」，不显示结论。
- **STATUS 的绑定文件**可以是冻结裁定（不在 git 里，按 sha256 绑定）。页面在「来源与哈希」里按登记写它的名称，并列出「取代的旧锁」。

## 3. 真导入（合并后）

```bash
cd /Users/kaylame/KaylaProject/quant-research-platform
node apps/research-cli/import_overseas_verdicts.js stage --smartflow-root /Users/kaylame/KaylaProject/smartflow --artifacts-root /Users/kaylame/KaylaProject/artifacts/coordinator --out /Users/kaylame/KaylaProject/quant-research-platform/var/evidence/overseas-verdicts-2026-11-05-r1
QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_overseas_verdicts.js import --evidence /Users/kaylame/KaylaProject/quant-research-platform/var/evidence/overseas-verdicts-2026-11-05-r1 --registered-by V8_1_COORDINATOR --supersedes C17-N7=OSV-C17-N7-fa6032d2fd67,QS-N7=OSV-QS-N7-fa6032d2fd67,UC-U08-Q0=OSV-UC-U08-Q0-5f85fd8a34cd,UC-U13-30M=OSV-UC-U13-30M-78a9b2aa53da --defect-ref "QRP#54 label review (coordinator 2026-11-05)" --reason "N7 frozen; page verdicts only 做/不做 (Owner 10-06); 30-minute reading is report-only"
```

- 新证据目录与 #54 的分开放；旧锁引用的旧目录不动。
- 结果：追加 5 条锁（4 条 supersede，加新题 C17-N8），其余 12 题是重放；原有 16 条锁逐字节不变。
- 重启 4311 之后、跑上面的导入之前，这 4 行显示 REIMPORT_PENDING。
