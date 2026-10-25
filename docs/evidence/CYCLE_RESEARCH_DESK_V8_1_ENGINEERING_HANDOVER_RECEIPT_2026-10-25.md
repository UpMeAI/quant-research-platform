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
  限制或异常场景与实际显示: 伪造 Host 头 403；POST 405；/api/runtime/* 403；诊断输入漂移在 30 秒内显示 INVALID/MISSING 并出现阻断项（单元测试）
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

## 附：本轮在 QRP 上的改动（PR #2 分支新提交）

| 提交 | 内容 |
|---|---|
| `2db3ac4` | B1–B7 修复与 6 项新测试（`tests/product_milestone_diagnostic_gate.test.js` 新文件，另在 `strategy_diagnostics`、`runtime_transport_and_adapter_client` 测试中追加） |
| `7ba0fd7` | `CYCLE_RESEARCH_DESK_V8_1_PR2_MERGE_GATE_REVIEW_2026-10-25.md` |
| `4b002ac` | `ops/launchd/`：plist、`install.sh`（install／uninstall／status）、README |
| 本提交 | 账本方案提议与本回执 |

没有改动任何冻结合同和既有回执。两个行为收紧（M1 PASS 须诊断 VERIFIED、封印排序固定）与修订 2/3 的文字一致，没有放宽任何验收；
封印排序固定后四个已冻结 digest 全部不变（`8f878007…`、`12012aeb…`、`cccb6c20…`、`5969c30a…`）。
