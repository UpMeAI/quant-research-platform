# 海外研究封存结论 · 导入规格 V1 · 修订 2（R-US-ETF-1）

状态：随 QRP PR 交协调会话审阅；协调会话合并即采用。起草：海外研究会话，2026-11-05 CST。
母规格：`OVERSEAS_SEALED_VERDICTS_IMPORT_PROFILE_V1.md` 与修订 1，原文不改。台账不改写：旧锁全部保留，本次只追加新题。

## 1. 新增 4 题（R-US-ETF-1，美股宽基 ETF 均值回归波段）

共同绑定：
- **结果**：smartflow `research/us-etf-r1-run` @ `3a635a49`，`R_US_ETF_1_RESULT_V1.json`，sha256 `406a061b…`；
- **K2**：@ `e41c43c4`，sha256 `1db0b65f…`；
- **冻结记录**：`R_US_ETF_1_K2_V1_FREEZE_RECORD.md`，sha256 `95b0408f…`，含勘误 1；勘误前为 `301d26b8…`。

| entry_id | 策略 | 读法（结果文件 `verdict_detail` 第几项） | 期望结论 |
|---|---|---|---|
| UC-RUE1-SPY | US_CORE | 0 | 不做 |
| UC-RUE1-QQQ | US_CORE | 1 | 不做 |
| US5-RUE1-VOO | US_V5 | 4 | 做 |
| US5-RUE1-SPMO | US_V5 | 5 | 做 |

- 结论、证据强度、允许用途都按条读结果文件，说明栏读 `first_paragraph_zh`。
- V5-SPY、V5-QQQ（第 2、3 项）按勘误 1 记为「不适用」，不登记为题，只写进 VOO 一条的说明。
- 「做」≠ 生产采用：替换属第 1 类修订，Owner 签字后才实施；进修订前须补一次 US_V5 账本级的线检查。

## 2. 真导入（合并后）

```bash
cd /Users/kaylame/KaylaProject/quant-research-platform
node apps/research-cli/import_overseas_verdicts.js stage --smartflow-root /Users/kaylame/KaylaProject/smartflow --artifacts-root /Users/kaylame/KaylaProject/artifacts/coordinator --out /Users/kaylame/KaylaProject/quant-research-platform/var/evidence/overseas-verdicts-2026-11-05-rue1
QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_overseas_verdicts.js import --evidence /Users/kaylame/KaylaProject/quant-research-platform/var/evidence/overseas-verdicts-2026-11-05-rue1 --registered-by V8_1_COORDINATOR
```

- 新题不需要 supersede。
- 预期：追加 4 条锁，其余 17 题都是重放；原有 24 行逐字节不变。
- 冻结记录若在导入前又被改过，stage 会因 sha256 不符停下。这时先更新登记表，再导入。
