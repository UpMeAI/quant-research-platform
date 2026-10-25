# Cycle × Research × Desk V8.1：PR #2 合并闸独立审查（2026-10-25）

证据类型：`TECHNICAL_CHECK`
审查人：V8.1 工程实施者（Claude；审查对象是 Codex 的工作，不是自己的）
对象：PR UpMeAI/quant-research-platform#2，分支 `codex/v8-1-m0-m1-workspace`，审查基线 `2e3bbae`
Production effect：`NONE`；未改任何冻结合同和既有回执，只改代码和测试，新增本文件。

## 结论

**修完下面 B1–B7 后可以合并；合并前没有剩余阻断项。** 金融数学与回执一致：我不用服务代码，另写脚本从 `var/evidence`
原始包重算，买入 29 @ 42.466897、卖出 29 @ 42.64、毛额 5.019987、双边 5 bps 1.2340500065、SEC 0.03、CAT 0.01 + 0.01、
TAF 0，成本 1.2840500065，净额 3.7359369935，与页面和回执逐位相同。窗口内全部 12 个交易日的成交文件共 2 个事件，
41 条扫描里只有 1 次 paper OPEN（MSFU），没有被忽略的成交。

回执声称而代码没有做到的，只有 B4（M1 PASS 并不检查诊断）和 B7（发布状态写死）；其余声明都有对应代码。

## 已修复（新提交在同一分支）

| 编号 | 位置（2e3bbae） | 问题 | 修复 |
|---|---|---|---|
| B1 | `services/strategy-diagnostics/index.js:573-582` | 默认诊断结果在进程内永久缓存。常驻服务启动后输入包被改动或删除，页面仍显示 `VERIFIED`；第一次读取失败也会一直粘在 `INVALID/MISSING`，直到重启。 | 30 秒 TTL 读取器 `createDiagnosticReader`，到期重新做封印、hash 与对账；`readFreshDiagnostic()` 供一次性闸用。 |
| B2 | `…/index.js:50-54` `ceilCent` | `Math.ceil((v - EPSILON) * 100)` 对恰好整分的金额多进一分：0–2000 美元里 9164/200000 个整分值错（2.2 → 2.21）。当前案所有费用 < 0.10 美元，不受影响，所以没被测试发现；二十个 session 重导出后成交更大就会出错。 | 先取 12 位有效数字再向上取整。整分值全对，真正超过整分的值（3.0000000021 分）仍进一分。 |
| B3 | `apps/research-api/index.js:123-125` | 无 token 时只靠绑定 127.0.0.1 保护，没有 Host 校验。同机浏览器被 DNS rebinding 欺骗后，任何网页都能读 `/api/workspace`。改成常驻 launchd 服务后暴露窗口变长。 | 无 token 时 Host 头必须是 `127.0.0.1` / `localhost` / `[::1]`，否则 403 `RESEARCH_HOST_NOT_LOOPBACK`；有 token 时不依赖 Host。 |
| B4 | `services/runtime-research-loop/index.js:246-251` | M1 PASS 闸只检查“已登记的非空文件按类型挂齐”。首案诊断是 `INVALID/MISSING` 时，M1 PASS 仍能记录。 | 有 canonical 诊断生产者的 case（`RRC-US-V5-3000-V8-1-M0`），M1 PASS 必须现场 `readFreshDiagnostic().state === 'VERIFIED'`，否则 `PRODUCT_MILESTONE_M1_DIAGNOSTIC_NOT_VERIFIED`。其他 case 行为不变。 |
| B5 | `…/strategy-diagnostics/index.js:64-65` | 封印顺序用 `localeCompare`。冻结的包 digest `8f878007…` 只在 ICU en-US 排序下成立，按码元序得到 `ed089b72…`（`producer/native/` 里 `book-rows.json` 与 `REVIEW_…` 的大小写顺序不同）。`LANG=C` 的 Linux 上 ICU 可能退化为码元序，导出端与校验端 digest 不一致。 | 固定比较器 `comparePackagePaths`（先不分大小写，再比码元），复现四个已冻结 digest（整包、desk、decision-inputs、native），与 ICU en-US 结果相同，不依赖环境。 |
| B6 | `…/index.js:146-148`；`:288-291`；`:450` | ① 没有 `mode` 的仓位既不进 paper 也不进 shadow，绕过身份与占位核对；② 只读 10-09 与 10-14 两个成交文件，其余日期的成交会被忽略，`paper_fills` 写死为 2。 | ① 每个仓位必须是 paper 或 shadow，否则 `US_V5_M1_SCAN_POSITION_MODE_UNKNOWN`；② 遍历窗口内所有成交文件，事件总数必须恰为 2，否则 `US_V5_M1_UNTRACED_TRADE_EVENTS`，`paper_fills` 取实数。 |
| B7 | `services/research-workspace/index.js:356` | `release` 写死 `NOT_RELEASED`，M1 以后变为 `CONTROLLED_VERIFIED` 或 `TARGET_DELIVERED` 时页面仍说未发布，与 P1“Web 只消费里程碑投影”冲突。 | 由 M1 阶段状态推出：`TARGET_DELIVERED` / `CONTROLLED_PENDING_RELEASE` / `NOT_RELEASED`。 |

新增测试：`ceilCent` 20 万个整分值与超整分值；缓存 TTL（含失败不粘住）；Host 头防 rebinding；M1 闸（INVALID、MISSING 拒绝，真实包 VERIFIED 通过）；
未追踪成交与缺 mode；封印排序。

验证：`node --test 'tests/*.test.js'` 83 项，82 过，0 失败，1 跳过（本机无 Ashare-V5 检出，不算通过）；`schemas/validate.js` 0 违约；
`git diff --check` 通过；Research Web 内联脚本语法通过。

## 核对过且无问题

- **只读与 loopback 边界**：源码里只有 `packages/ledger` 的 `append` 会写文件，GET 视图都不调用它；没有 `child_process`、没有出站网络（`http_market_adapter_client` 只在配置了远程市场时启用）。所有 `POST /api/*`（不含 `/api/runtime/`）返回 405；`/api/runtime/*` 在 `QRP_RUNTIME_TOKEN` 未配置时一律 403。Web 只有一个 `fetch('/api/workspace')`（GET）。`bindConfiguration` 默认 127.0.0.1，非 loopback 缺 token 拒绝启动。
- **当前簿与前身身份**：41 条扫描外层身份、共享规则白名单、PAPER/shadow 占位、前身 lot 集合（恰为 `USV5_1791392582939_qoxauy` 一个、恰 5 条、平仓后 0 条）、当前 lot 身份、T 后开仓拒绝；这些断言在 `verifyScanRecord` / `verifyHandoverSeries` 里都是机械断言，并有反例测试（重标、T 后开仓、未知规则键、前身伪装成当前簿）。
- **失败关闭**：任何断言失败 → `MISSING` / `INVALID`，工作台把它们变成阻断项并且不给 `READY`；缺失不填零（开仓费用保持 `NOT_MEASURED`）。
- **`recordProductMilestone`**：幂等、同 ID 漂移拒绝、M0→M3 顺序、上游当前有效证据绑定、REVOKED 后旧下游不复活、TARGET_DELIVERED 需要发布证据，均有对应代码和测试。重放同内容的 PASS 不会复活已撤销阶段。
- **SEC 第 31 条费率**：SEC 费率公告 2026-2 确认 20.60 美元/百万、2026-04-04 生效（此前为 0）。Alpaca 费表的 TAF = 0、CAT 0.000003、取整规则我读不出（PDF 无法提取文字），按修订 2 的合同输入处理，未独立核对。

## 未修，作为后续（不阻断合并）

| 编号 | 位置 | 说明 | 责任 |
|---|---|---|---|
| A1 | `strategy-diagnostics/index.js:288-291, 310, 320, 361, 491` | 诊断写死“一个开平仓回合 + MSFU + 2026-10-09/10-14 + METU 拒绝”。对当前封印包是对的，漂移时失败关闭（B6 之后更严格）。但 11-04 之后的 ≥20 session 重导出只要多一笔成交，就会触发 `US_V5_M1_UNTRACED_TRADE_EVENTS` / `ROWS_COUNT_MISMATCH`。重导出需要新的 manifest 版本和通用化（N 个回合）的诊断，不能只换包。 | V8.1 工程，M2 前置 |
| A2 | `runtime-research-loop/index.js:104-109` | 完成权威是“环境变量字符串 == 调用方传入的 `recorded_by`”，是配置闸不是身份认证。能在检出里跑 node 并设置该变量的人就能记录。单用户阶段可接受；前提是永远没有 HTTP 入口（现状如此）。launchd 服务按指令把该变量设为仅用于显示，它没有任何可调用的写路径。 | Owner 知情 |
| A3 | `runtime-research-loop/index.js:316-338` | `productStagesFor` 在 PASS 之后不再复验证据文件 hash。事后改动或删除 `docs/evidence/*.md`，阶段仍显示 `CONTROLLED_VERIFIED`；证据台账里有当时的 hash，可以加只读的 `evidence_integrity` 投影。 | V8.1 工程 |
| A4 | `desk-strategy-directory/index.js:13, 46-48` | 在 Research 进程里 `require` 并执行同级 `portfolio-desk` 工作树的 3 个源文件；“Desk 权威目录”就是该工作树当时所在分支和脏状态。只读，但不是固定版本。plist 里显式写 `QRP_DESK_ROOT`。 | 协调者知情 |
| A5 | PR 内 `var/evidence/…` 64 个文件 | 仓库是 PUBLIC，包里有完整策略配置（风险单位、闸、持有天数、1h bars）和纸面账户路径。控制器记录了 Owner 同意提交；本审查不重开。`var/ledger/` 的提议（见 `CYCLE_RESEARCH_DESK_V8_1_VAR_LEDGER_VERSIONING_PROPOSAL_2026-10-25.md`）因此默认保持私有。 | Owner 已决定 |
| A6 | `runtime-research-loop/index.js:29` | `PRODUCT_SPEC_REF` 指向 `~/Downloads/…` 的绝对路径；规格 sha 已固定，路径只在 Owner 的 Mac 上有效。 | 无 |
| A7 | 页面内容 | 研究者期望策略页显示当前 US_V5 回测结论（区间、胜率盈亏比、压力最大亏损、半凯利复利）。当前页只有 12 个 session 的原版诊断，这些属于 M2，页面没有也不应伪造。 | Owner / M2 |
