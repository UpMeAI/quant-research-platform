# 加密 M2 轮次导入（导入规格增补 2）· 实施回执 · 2026-10-27

依据：`docs/contracts/CRYPTO_Q0_RESULT_V1_IMPORT_PROFILE_ADDENDUM_2.md`（与冻结文本 `fed57d4c` 逐字节相同，sha256 `e94cd79f87ecabfaff91c3df8e6f55194c94aadbaabfb743ccfe8fde425db3f8`）；
协调冻结裁定 `LOOP_AND_IMPORT_DRAFTS_20261027_FREEZE_1.md` R2（主 Mac `artifacts/coordinator/`，sha256 `8232993436a6d9da48c28de81da2e0f6f077d4f1af63255bc3b998436ba902a3`），D1–D8 全部 ★。
Production effect：`NONE`。没有新运行，smartflow 与 HK 只读。

## 1. 证据（D8 ★，进 git）

`var/evidence/c17-v2-m2-r1-2026-10-27/`（10 个文件 + 3 份 `.sha256`）与 `var/evidence/qs-v3-m2-r1-2026-10-27/`（4 个文件 + 1 份 `.sha256`）。
每个文件取自 smartflow 对应提交（`3f986ec9`、`db2e5230`、`0907219c`）或主 Mac `artifacts/coordinator/`，sha256 与增补 2 §0.1 逐一相同。

## 2. HK 只读核对（D6 ★，写前向登记之前）

| 影子 | 时间（CST） | 看了什么 | 结果 |
|---|---|---|---|
| C17 组合候选影子账本 | 2026-10-27 18:58 | `pm2 jlist`；`reports/c17-v2-candidate-shadow/chain.jsonl` 第 1 条与最后 1 条的 kind、at、k2 字段 | strategy-worker online（09:26:59Z 起，env `C17_CAND_SHADOW_ENABLED=1`）；第 1 条 START `2026-10-27T09:27:03.038Z`，k2.sha256 `443bdfcc…`；最新 SCAN `10:57:03Z`，共 11 条 |
| QS 只做空影子（从纸面账本推出） | 2026-10-27 19:00 | `pm2 jlist`；main-app 日志里的扫描行与停开仓 / 账本止损 / 前向复盘 FAIL 代码 | main-app online；QuickShot 每分钟扫描，T_start（16:45:06）前后连续（16:40 → 18:59）；16:00 起没有任何停止代码 |

没有读任何权益、开仓、平仓或盈亏数字。

## 3. 导入（临时账本，真实账本的副本；真实账本未写）

```
R1-229940c24a2246bc  C17_V2_4000USDT         基线 Q0-e80c42523b30f768  10 个文件  K2 443bdfcc…
R1-c679d4c92c2d67a1  QUICK_SHOT_V3_1000USDT  基线 Q0-bd83dd6ec1754dbc   4 个文件  K2 ef424705…
```

重导是幂等重放（`replay: true`）。

## 4. 页面（真实账本副本 + 两把轮次锁）

- 总览卡片：
  - C17：「Q0 证据不足（A0 未通过）；第 1 轮已做：缺口分解 + 组合候选已冻结，前向影子运行中，最早 2027-04-30 查看，2 题待研究」
  - QS：「Q0 证据不足；第 1 轮已做：缺口分解 + 组合候选已冻结，前向影子运行中，最早 2027-04-30 查看，2 题待研究」
- 页头：「…4 个已锁定 Q0 回测结论（1 个已有锁定的方案对比、1 个已有 Owner 采用决定、2 个已做第 1 轮、前向影子运行中）…」
- D1（同一账本副本，base `c35aba7` 对分支）：US_V5_ETF_3000USD、US_CORE、US_V5_ETF_6000USD、ASHARE_V6_PAPER 的卡片与七个页签 HTML 逐字节相同；US_V5 详情 JSON 只有 M1 包的检出根路径一行不同（两个检出的目录名）。不同的只有 C17 / QS 的页面、策略总览页头与卡片、全局前向观察页（新登记的两条）。
- J5.1（真 Chrome，1280 × 800）：C17 总览 1,057 px、QS 总览 1,032 px（≤ 1,600）；「研究与对比」全部折叠 ≤ 800 px（≤ 3,000）；390 px 宽下总览、研究、前向、全部展开、`card=R1` 都没有整页横向滚动。

## 5. 测试

| 运行 | 检出 | tests | pass | fail | skip |
|---|---|---|---|---|---|
| main `c35aba7` | 真实检出（`QRP_DESK_ROOT` 设为本机 portfolio-desk） | 361 | 360 | 0 | 1 |
| 本分支 | worktree，本机未进 git 的 var/evidence 原样复制进来，同一 `QRP_DESK_ROOT` | 374 | 373 | 0 | 1 |

逐条比对：两次的 361 条旧测试状态完全相同，多出的 13 条是新测试 `tests/m2_round_import.test.js`，全部通过。跳过的 1 条两边相同（E8 真实 Q3 的另一分支）。

## 6. 交协调会话确认的一处读法

导入规格 §7.2 那句「Q0 结果文件里带有前向记录 N 笔（只报不判）；HK 前向影子：本策略尚未登记。」的前提是「HK 前向配置里没有这一组」。增补 2 D6 登记了两条加密影子以后，这一句改为保留 Q0 前向记录的前半句、后半句换成现有的 HK 运行句：「Q0 结果文件里带有前向记录 15 笔（只报不判）；HK 上已在跑 1 条前向影子（1 条尚未导入）。」（QS 为 10 笔）。`tests/c17_v2_q0_import.test.js` 与 `tests/qs_v3_q0_import.test.js` 的这一条断言随之更新。
