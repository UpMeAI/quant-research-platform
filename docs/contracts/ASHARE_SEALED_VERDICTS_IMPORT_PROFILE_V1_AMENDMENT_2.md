# A 股研究封存结论 · 导入规格 V1 · 修订 2（行业 ETF 左侧埋伏 SECTOR_ETF_LEFT_1）

状态：随 QRP PR 交协调会话审阅；协调会话合并即采用。V1 正文与修订 1 一字不改，本修订只往登记表加一题。Production effect：`NONE`。
依据：K2 `SECTOR_ETF_LEFT_1_K2_V1.draft.md` §8（11-13 夜封存，QRP 台账记结果行）；冻结裁定 1 `SECTOR_ETF_LEFT_1_K2_V1_FREEZE_1.md`（★ 全部 (a)，生产去向 INSUFFICIENT → 做 = 前向影子）。

## 1. 加入登记表的一题

| entry_id | 簿 | 封存文件 | K2 | 冻结页 | k2_frozen_at | 期望 |
|---|---|---|---|---|---|---|
| CN-SECTOR-ETF-LEFT-1 | INDEX_BOOK | Ashare-V6 `933d47ff` `research/sector-etf-left-1/result-sector-etf-left-1.json` `77067969…` | `SECTOR_ETF_LEFT_1_K2_V1.draft.md` `34864588…` | `SECTOR_ETF_LEFT_1_K2_V1_FREEZE_1.md` `68bd7e9f…` | 2026-11-12T07:58:23+08:00 | INSUFFICIENT → 做 |

- **读法**：封存 JSON（不是文字结论）。`verdict.state` 是统计判定（INSUFFICIENT），`resolve` 把它写成页面结论「做」：冻结页的生产去向写明 INSUFFICIENT → 做 = 前向影子（研究账本，不新开生产账本，Owner 11-09）。同 UC-U08-Q0 的写法（Owner 10-06：INSUFFICIENT 而在纸面 = 做）。`verdict.reason`（G1_NOT_MET）进强度，`verdict.conclusion` 进正文。状态不是 INSUFFICIENT 就读不出期望值，导入拒绝（`VERDICT_NOT_AS_REGISTERED`）。
- **结果文档**：`artifacts/coordinator/SECTOR_ETF_LEFT_1_RESULT_V1.md`（`bd853a6a…`）不绑定进锁，结论只从封存 JSON 读；锁的 note_zh 引用它。

## 2. 试验台账门（G-TRIAL-PRE / G-TRIAL-SEAL）

K2 在过拟合控制修订（2026-11-11 00:00 CST 起）之后冻结，`gates.applies` 给 `FROZEN_AFTER_AMENDMENT`，两道门都过，不需要门的裁定页（不带 `trial_gates_ruling`）：

- **PRE**：K2 §9 写出 7 个 TRL id，7 行都是 PREREGISTERED，k2_sha256 等于 K2 全长 sha，登记于 2026-11-12 07:57:04 CST，早于冻结 07:58:23（冻结页「核对」一节）。
- **SEAL**：
  - 7 个预登记试验各有一条结果行（2026-11-13 记）；
  - 运行日志 `research/sector-etf-left-1/RESEARCH_RUN_LOG_V1.json`（Ashare-V6 `0a6ebc73`，`42d3ceee…`，按 sha256 绑定）每个账本运算都对得上已登记的 rule_config_hash；
  - 本族本题的 `OVERFIT_DISCLOSURE_V1` 已写。
- **月度序列**：封存文件里没有月度序列，台账要的 d 序列是在封存之后，用从未改动的封存命令导出的（`export-monthly.js` 预加载，Ashare-V6 `469445ce`）。只有当 run.js 写出的结果与封存文件逐字节相同、各臂的日差还原出封存的 g 时才写；两遍相同 `7fb3e802…`。
- **披露**（DSR、PBO 都照算法算，不是「不适用」）：
  - DSR = UNKNOWN（KNOWN_SR_LT_5：本族已知 ŜR 只有本题的 4 个）；
  - ★5 回退：按族 N = 39 的 Bonferroni，种子同 K2 §6（20261025），不过；
  - PBO：4 个计入配置的日对数收益，CSCV 16 块，结果 0.031；
  - 原结论是「做 · 证据不足」，过拟合校正列不适用，不降级。

## 3. 真导入

照 V1 §3：先备份台账，在副本上（`QRP_DATA_DIR`）试导入，核对后再写真台账。现有 10 份锁逐字节重放，只多 1 份新锁。
