# Cycle × Research × Desk V8.1：工程交接回执（Claude 接手 Codex 的工程，2026-10-25）

规格：`Cycle_Research_Desk_金融策略投资系统设计与实施规格_V8_1.md`（SHA-256 `ecfdda23…`），附录 C 模板
验收：V8.1 产品里程碑验收 V1 + 修订 1–3；人类工作台 UX V1 + 修订 1–2（均未改动）
实施者：Claude（接手 Codex）。**本回执的作者不是独立复核者**；合并闸的最终判断属于协调者。
Production effect：`NONE`

## 结论

- PR #2 审查完成：金融数学与回执一致，发现 7 项必须修的缺陷（B1–B7），已在 PR 分支修复；另有 7 项后续（A1–A7），不阻断合并。详见
  `CYCLE_RESEARCH_DESK_V8_1_PR2_MERGE_GATE_REVIEW_2026-10-25.md`。
- Research 页面的 launchd plist 与安装器已入库，**未安装**（等协调者合并 PR #2）。
- M1 证据包现在可重建：smartflow PR #30 里的只读导出命令，对同一窗口、同一部署提交得到逐字节相同的 64 文件包（sha256 `8f878007…`）。
- `var/ledger/` 上远端的方案已写成提议，待决定。
- 产品阶段没有变化：M0 `CONTROLLED_VERIFIED`（Owner 已确认，`PME-24d3b7285fe5b561`）；M1 `NOT_VERIFIED`（等 Owner 做 A2.6 整条任务）；M2/M3 `NOT_VERIFIED`；M4/M5 `OUT_OF_SCOPE`。

```yaml
任务与阶段: V8.1 工程交接（PR #2 合并闸审查与修复；Research 页面 launchd；M1 证据包可重建；账本版本化提议）。不提升任何阶段。
产品交付:
  本阶段产品承诺: 让 M1 的交付环境可重复（常驻服务、可重建证据）；不新增终端功能
  实际用户入口: http://127.0.0.1:4311/#strategy-detail?strategy=US_V5_ETF_3000USD&section=health（当前是手动进程 pid 3552，旧代码；launchd 服务安装后同一地址）
  环境与发布状态: CONTROLLED_PENDING_RELEASE；launchd 未安装；TARGET_DELIVERED 无证据
  本期新增可用功能: 无终端新功能。工程侧：诊断读取带 TTL；Host 头防 rebinding；M1 PASS 须诊断 VERIFIED；封印顺序与环境无关；发布状态由里程碑推出
  实际支持范围: US_V5_ETF_3000USD，PAPER（真实行情），smartflow 2382c2d1，NYSE 2026-10-08 至 2026-10-23（12 个 session）
  完整用户操作与真实对象: 未做用户操作。实现者在备用端口 4399、用 plist 同样的最小环境启动同一入口并探测（见下）；Owner 的 A2.6 走查尚无
  用户所得结果与后续状态: 无新的用户结果。后续：协调者合并→安装服务→Owner 走查→记录 M1
  限制或异常场景与实际显示: 伪造 Host 头 403；POST 405；/api/runtime/* 403；诊断输入的大小或 mtime 一变立即重验、原地改写至多 10 分钟内被抓到，失败只缓存 15 秒（单元测试）
  对应12_2里程碑及判断: M0 CONTROLLED_VERIFIED；M1 NOT_VERIFIED；M2/M3 NOT_VERIFIED；M4/M5 OUT_OF_SCOPE
执行职责与复核职责: Claude 实施；复核＝协调者合并闸（未执行）。Codex 的 COMPLETE 声明不被采信
目标仓库_分支_原任务: UpMeAI/quant-research-platform codex/v8-1-m0-m1-workspace（PR #2）；wendy926/smartflow claude/v8-1-us-qrp-adapter（PR #30）
基线提交与交付提交: QRP 2e3bbae → 2db3ac4（B1–B7 修复）→ 7ba0fd7（审查记录）→ 4b002ac（launchd）→ 本回执所在提交；smartflow c04a2caf → b5012202（Codex 原样，变基）→ aedb72e3（导出命令）
范围:
  策略_账本_模式: US_V5_ETF_3000USD / PAPER / 真实行情
  当前D版本: smartflow 2382c2d14eb66c1cef5a7df35c7cdb543c507853（生产部署；重建时复核 HEAD 相等）
  原实验基线: US_V5_ETF_6000USD（冻结前身，不回填）
  原问题_诊断_研究槽引用: 无已选 US_V5 研究问题；M2 问题由 Owner 定
完成情况:
  工程实现: 完成并自测（QRP 83 项 82 过 0 失败 1 跳过；smartflow 7 个相关套件 78 项全过）；合并闸复核待协调者
  实际运行: 导出命令对真实生产主机运行一次并逐字节重建；launchd 服务 FALSE（未安装）
  产品用户任务: FALSE（Owner A2.6 未做）
  研究结论与压力结论: EVIDENCE_INSUFFICIENT 不变（12 session < 20）；压力未运行
证据:
  输入_配置_工具_成本: 重建包 package_sha256 8f8780075209802582dc387186a3cb5ade71d892187791f99b73a375e83280cd，64 文件 17,492,223 字节；三个分组 digest 与 manifest 相同；四个回放引擎文件 sha256 与 manifest 相同；成本 1.2840500065 由独立脚本复算
  原生回放_账户对账: 重建包上 QRP strategy-diagnostics 返回 VERIFIED，净损益 3.7359369935；原生回放 READY / parity MATCHED / 41 ticks
  决策差异及解释: 无变化
  样本用途_尝试记录: 12 个 session；重导出计划在 smartflow docs/US_V5_M1_EVIDENCE_EXPORT.md
  净结果_压力_结果锁: 未运行
  适用UX及AC逐项结果: 未重新评估；前端未改，后端改动均有测试
  权限_降级_重复导入检查: 备用端口 4399 实测（plist 同款最小环境）：诊断 VERIFIED；完成权威 CONFIGURED；POST /api/workspace 405；Host 头伪造 403；/api/runtime/pending-activations 403；POST /api/runtime/ack 403；GET / 200。导出命令拒绝覆盖已有 --out
生产影响:
  是否涉及生效或资金: 否
  原权限或决定引用: 未使用交易凭证；未下单/撤单；未写生产参数、账本、桌面收件箱、数据库或 pm2；生产主机只读 SSH，临时目录用后删除，部署 HEAD 与 pm2 进程未变
未完成与阻断:
  - 协调者合并 PR #2 与 smartflow PR #30（我未合并）
  - 安装 launchd 服务（ops/launchd/install.sh install），之后手动进程 pid 3552 被替换
  - Owner 在实际入口完成 A2.6 整条任务，再由协调者记录 M1
  - 2026-11-04 之后的 ≥20 session 重导出（新证据 ID）与 N 个回合通用化的诊断（审查 A1）
  - var/ledger 方案待决定（私有仓库／同库／本机备份）
  - 研究者期望页面展示当前 US_V5 回测结论（区间、胜率盈亏比、压力最大亏损、半凯利复利）：属于 M2，页面没有
下一步与责任方:
  - 协调者：审阅并合并 PR #2、#30；运行安装器；按方案文件决定账本；提醒 Owner 走 A2.6
  - Owner：A2.6 走查；M2 研究问题
  - V8.1 工程：11-05 CST 上午重导出；诊断通用化与新冻结修订；证据 hash 复验投影（A3）
```

## 常驻服务的占用（供协调者判断是否迁 VPS）

在备用端口 4399 用 plist 同款最小环境（`env -i`）实测，页面是 `/api/workspace?strategy_ref=US_V5_ETF_3000USD`：

| 项 | 数值 |
|---|---|
| 刚启动，未访问 | RSS 约 36 MB |
| 第一次打开页面（现场做完整校验：解压 92 MB 扫描记录、64 个文件 hash、账户对账） | 3.6 秒，RSS 约 334 MB |
| 之后同一页面 | 约 37 毫秒；连续 40 次加全部只读视图后 RSS 约 350 MB（不再增长） |
| 重新校验 | 输入文件 stat 指纹变化时立即；否则成功结果满 10 分钟后的下一次访问（这一次访问多花 3–4 秒，RSS 仍在 350 MB 附近） |
| CPU | 空闲 0%；日志只有启动几行，没有逐请求日志，无需轮转 |
| 磁盘 | QRP 检出（不含 `.git`）37 MB，其中证据包 17 MB、账本 1 MB；`.git` 18 MB；合计约 55 MB。launchd 日志 < 1 KB |

峰值来自一次性解压和解析扫描记录；校验改成逐条并只保留需要的字段后，峰值从 380–440 MB 降到约 330 MB，macOS 的分配器不把这部分还给系统。
手动进程 pid 3552 现在显示 29 MB，是 macOS 压缩了空闲页，不能和上面的数字比。**按这些数字，本机没有迁移到 VPS 的触发条件**（数据 17 MB 级、驻留 350 MB 级）；
内存若成为问题，办法是把校验放进一次性子进程（审查 A9）。

## 交付路径：安装之后

`ops/launchd/install.sh install` 成功后会写一个**一次一个、不再变化**的安装回执 `var/release/research-web-install-<UTC>.json`
（git 提交、plist 的 sha256、监听地址、pid、GET/POST 探测码）。它可以按 `DELIVERY_RELEASE` 类型登记为产品证据。
安装本身不记录任何里程碑：`TARGET_DELIVERED` 需要 Owner 在这个入口完成 A2.6 整条任务（`USER_TASK`）、该回执（`DELIVERY_RELEASE`）和协调者的 `recordProductMilestone`。
页面的“发布状态”随 M1 阶段状态变化（审查 B7）。`install.sh status` 现在也打印 RSS 和磁盘占用。

## Q0（M2 研究计划）对导出命令与服务的需求

读了 `artifacts/coordinator/US_V5_M2_RESEARCH_PROGRAM_V1.md`。两个前置问题的答案：

**1. smartflow 的引擎能不能做 2020 年起的当前 D？**

- `scripts/lib/us-v5-replay.js` / `us-v5-plan-replay.js`（2382c2d1）**不是历史引擎**：它们重放生产记下来的 `US_V5_SCAN_RECORD_V2`，没有扫描记录的 session 一律 `UNKNOWN`。
  扫描记录最早是 2026-09-28，所以它们给不出 2020 年的任何东西，只适合作为“当前 PAPER 账本 2026-10-08 起”这一行（和 M1 证据包同源）。
- 能做整本账历史回放的只有 `scripts/research/replay-us-v5-universe-comparison.js`（Alpaca 30 分钟 SIP K 线 2019-06 起，`MEASURE_FROM=2020-01-02`，逐行离线跑整本账，含按时点测的流动性底线、5 bps/边、扫描相位、类别上限）。
  它支持 `--with-v3`（标的池 v3 即现行文件）；`BOOK` 常量（本金 6000、风险单元 120、日／周损失线 300/900、持仓 3）可由每条 `line.book` 覆盖，所以 3000/60/3 和 150/450 可以表达。
- **但它是对 A4/A6 年代账本逻辑的离线重写，不是部署的 worker**。A12（反转关闭）、A15/A16（标的池 v3、SPMO/VOO/SPXL）、A17（起点锚、前身共享限额）、10-14 的 K 线择时、换仓规则 U1 是否都在里面，我没有验证。
  Q0 需要先有一道**对齐关卡**：用同一个引擎、同一组 K 线跑当前 PAPER 窗口（2026-10-08 至今），与已封印的 12 session 原生回放和纸面账本逐项对（MSFU 29 股 @ 42.466897 开、10-14 TIME_STOP 平）。对不上就不能把 2020 年起的数字叫“当前 D”。
- 2020 年的可交易范围：现有缓存 `research-data/sel4_rsi_band_work` 有 81 条序列（含 v2/v2n3 的标的，v3 文件本身 45 行，需与 v3 取交集），截止 2026-10-02。
  从 2020 年第一个 session 起就有 K 线的是 67 条（指数、行业、杠杆行业载体）；单股杠杆 ETF 2022-08-09 起陆续上市（TSLL、CONL、AAPU、AAPB 2022-08-09；AMZU 09-07；GGLL 09-08；MSFU 09-09；NVDL 2022-12-13；AMDL 2024-03-18；METU 2024-06-05；MSTU 2024-09-18；NFLU 2024-09-27；NFXL 2024-10-03；PLTU 2024-12-11）。
  所以 IS（2020–2022）几乎只能交易指数／行业载体，和现行 D 主要交易的单股杠杆载体几乎不重叠，IS 与 OOS 不是同一套工具；报告必须按这个分段写，不能把今天的标的池当作 2020 年已知。
- 数据凭据：缓存里的 `credentialSource` 是 `us-value-selector/.env`（Alpaca 密钥对）。继续拉 2026-10-02 之后的 K 线要用同类凭据；研究规则是“不使用交易凭据”，所以要么用只有行情权限的密钥，要么只用已 sha 封存的缓存，需先定。

**2. QRP 里有没有放“外部产出的封存回测结果＋输入哈希＋结果锁”的位置？**

部分有，缺三样：

- 有：`DATASET_SNAPSHOT_V1`（`checksums`、`source_refs`、`coverage`、`lineage_hash`）可以放序列 sha256 和年度普查；`ExperimentSpec` 冻结域含 `dataset_snapshot_ref`、`seed`、`costs`、`primary_metric`、`failure_condition`；
  回测产物只能经市场 Adapter 的 `run_backtest` 进来，产物带 `result_hash`，`recordResult` 再把它锁成 Result Lock；smartflow 的 US Adapter（`research-adapter/us`）就是这条路：读带自检 sha 的封存 bundle。
- 缺 1：US bundle 合同（`US_V5_QRP_NATIVE_REPLAY_V1`）把入口钉死为 `scripts/lib/us-v5-plan-replay.js`，并且 `bundle-builder.js:279` 的 `mechanical_adjudication` 恒为 `INCONCLUSIVE / PLAN_ADHERENCE_CASE…`——它是“计划依从”案例，永远给不出通过。Q0 的长历史引擎过不了这一关。
- 缺 2：Result Lock 的判定词汇是 `CHALLENGER_WINS / CHAMPION_HOLDS / INCONCLUSIVE`，并要求 `artifact.mechanical_adjudication.verdict` 与登记的结论一致；Q0 的判据是 δ=+0.10 R、δ_g=0、月分块 bootstrap 区间，且比较对象是 SPY 和现金，不是“冠军对挑战者”。需要一种新的判定类别（或新的 bundle 合同版本）来表达“原版 vs 基准”和它的区间规则。
- 缺 3：`linkLockedResult`（Desk 回链）要求 `frozen.spec.champion_ref === case.strategy_ref` 且挂在一个 Desk 研究问题上；Q0 是“基线评价”，没有 Desk 问题，需要明确它在 M3 回链里的位置。

我没有动这些。

**对导出命令和服务的具体需求**：

- 导出命令：Q0 的“前向（当前 PAPER 账本，只报不判）”那一行可直接用 11-05 的 20 session 重导出包；引擎对齐关卡也用它作参照。2020 年起的历史回放**不走**这个命令。
  若 Q0 要把封存结果放进 QRP，包的目录结构和 seal 定义（`comparePackagePaths` + `packageSeal`）可以复用，但要新的 manifest。
- 服务：策略详情顶部的“回测结论”卡是 `research-workspace` 读模型 + `index.html` 的变化，属于即将到来的产品修订；本轮我没有改 `index.html`。读取 Q0 封存结果应沿用 `strategy-diagnostics` 的做法（封印校验 + stat 指纹缓存），否则每次页面刷新都会重新读几十 MB。

## 附：本轮在 QRP 上的改动（PR #2 分支新提交）

| 提交 | 内容 |
|---|---|
| `2db3ac4` | B1–B7 修复与 6 项新测试（`tests/product_milestone_diagnostic_gate.test.js` 新文件，另在 `strategy_diagnostics`、`runtime_transport_and_adapter_client` 测试中追加） |
| `7ba0fd7` | `CYCLE_RESEARCH_DESK_V8_1_PR2_MERGE_GATE_REVIEW_2026-10-25.md` |
| `4b002ac` | `ops/launchd/`：plist、`install.sh`（install／uninstall／status）、README |
| `96fbe0f` | 账本方案提议与本回执（首版） |
| 本提交 | 诊断缓存改为指纹＋TTL、扫描记录逐条校验（A9）、安装回执与 RSS／磁盘打印；回执补充占用实测与 Q0 前置回答；审查补 A8、A9 |

没有改动任何冻结合同和既有回执。两个行为收紧（M1 PASS 须诊断 VERIFIED、封印排序固定）与修订 2/3 的文字一致，没有放宽任何验收；
封印排序固定后四个已冻结 digest 全部不变（`8f878007…`、`12012aeb…`、`cccb6c20…`、`5969c30a…`）。
