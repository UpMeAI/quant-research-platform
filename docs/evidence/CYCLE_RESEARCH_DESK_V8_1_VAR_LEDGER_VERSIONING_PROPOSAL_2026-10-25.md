# Cycle × Research × Desk V8.1：`var/ledger/` 上远端的方案（提议，未决定）

证据类型：`TECHNICAL_CHECK`（提议文件；不改变任何状态）
提出人：V8.1 工程实施者（Claude）。**决定权在协调者与 Owner**，本文不执行其中任何一项。
Production effect：`NONE`

## 现状（2026-10-25 实测）

`var/ledger/` 被 `.gitignore`（`var/`）忽略，只存在于 Mac 上的 QRP 主检出，共 992 KB：

| 目录 | 大小 | 内容 | 性质 |
|---|---|---|---|
| `runtime-research-loop/` | 6 KB（3 个文件、5 行） | case `RRC-US-V5-3000-V8-1-M0`、3 条产品证据登记、M0 里程碑 `PME-24d3b7285fe5b561` | **唯一的产品阶段真相**，丢了不可重建 |
| `self-audit/` | 5 KB（4 个文件、5 行） | 冻结基线、1 条 divergence、2 条已解决 incident、1 条 anomaly | V8.1 的质量记录，丢了只能凭文档重写 |
| `research/`、`shadow/`、`marketdata/`、`registry/`、`control-plane/` | 约 980 KB | CN_A 工程样例（`seed:ashare` / `mvp:ashare` 写出），页面只把它们放在“平台工程与历史样例”折叠区 | 可再生的样例，不是证据 |

丢失的后果：没有 `cases.jsonl` 时工作台找不到当前 case，M1 体检（`strategy-diagnostics`）不会挂到页面上，所有阶段回到 `NOT_VERIFIED`；
这是失败关闭（安全），但 M0 PASS 的原始记录时间、哈希和证据登记不能原样恢复。

两个会影响方案的事实：

1. 仓库 `UpMeAI/quant-research-platform` 是 **PUBLIC**。上面两个目录只有 10 行，但以后每次里程碑都要写入 `user_operation` / `user_result`（Owner 走查的原话和结论）、
   incident 的缺陷叙述；这些是 Desk 私域内容。
2. 四条记录里有本机绝对路径（`/Users/kaylame/KaylaProject/…`：3 条证据登记的 `source_ref`、case 的 `runtime_lane.source_ref`、基线的 `source_ref`）。
   `recordProductMilestone` 晋级时会按这些路径重新计算文件 SHA-256，所以账本绑定“写入它的那台 Mac”；换机器只能读（页面展示不需要路径存在），不能继续记录。

## 方案

| | A：同一仓库，取消忽略两个目录 | B：单独的私有仓库，作为 `var/ledger` 的检出 | C：只做本机带日期备份 |
|---|---|---|---|
| 做法 | `.gitignore` 改为 `var/*` + 例外 `var/ledger/runtime-research-loop/`、`var/ledger/self-audit/`；每次记录后 `git add` 提交 | 新建私有仓库（例如 `UpMeAI/qrp-ledgers`），`git init` 在 `var/ledger/`（QRP 的 `.gitignore` 已忽略 `var/`，两库互不干扰），内层 `.gitignore` 忽略 5 个样例目录，只跟踪上面两个 | 记录后复制到 `artifacts/ledger-backups/<date>/`，必要时再拷到 SanDisk |
| 恢复 | `git clone` / `git checkout` | `git clone <私有仓库> var/ledger` | 手工复制 |
| 审计痕迹 | 有（历史），但与代码 PR 混在一起 | 有（独立历史，只含账本） | 无 |
| 公开暴露 | **有**：账本内容进公开仓库，且不可撤回 | 无 | 无 |
| 需要的动作 | 一个改 `.gitignore` 的 PR | Owner 或协调者新建私有仓库；一个提交辅助脚本 | 无 |
| 风险 | 以后 Owner 走查原话、incident 叙述、本机路径公开 | 多一个仓库要记得提交；新建仓库是外部动作，需要明确授权 | 备份不是版本历史；单机故障仍可能同时丢备份 |

**提议（供决定）：B，仅跟踪 `runtime-research-loop/` 与 `self-audit/`，样例目录留在本机。** 理由是第 1 条事实：这些行以后会承载 Owner 的走查内容，而公开仓库的提交不可撤回。
A 只在 Owner 明确接受“账本内容公开”时才合适（证据包已按 Owner 的决定公开，但那是历史快照；账本是持续追加的记录，性质不同）。C 可以作为 B 落地前的过渡。

## 如果选 B，落地步骤（均未执行）

1. 创建私有仓库并给本机推送权限（外部动作，需 Owner／协调者明确授权）。
2. `var/ledger/` 内：`git init`；`.gitignore` 写入 `/research/`、`/shadow/`、`/marketdata/`、`/registry/`、`/control-plane/`；
   `.gitattributes` 写入 `*.jsonl merge=union`（账本只追加，单写入者，union 仅作兜底）。
3. 提交辅助 `ops/ledger/commit-ledger.sh`（只 `git add` 两个目录、先跑 `node schemas/validate.js` 通过才提交，不自动推送）；协调者在每次 `recordProductMilestone`、`registerProductEvidence`、自审计写入之后运行。
4. 首次提交当前的 10 行；记录提交号到下一份回执。
5. 恢复演练一次：在临时目录 `git clone` 后用 `QRP_DATA_DIR` 指向它，启动 Research 服务，确认 M0 显示 `CONTROLLED_VERIFIED` 且诊断挂载。

## 独立于上述选择的两个小改进（各自单独立项）

- 证据登记的 `source_ref` 允许“仓库相对路径 + 仓库内 SHA”，这样账本不再绑定某台机器的目录，也不带用户名；这是 `assertActualSourcePath` 的行为变化，需要新的冻结修订。
- 里程碑读模型在 PASS 之后复验证据文件 hash，漂移显示为 `EVIDENCE_DRIFTED`（见 PR #2 审查 A3）；它让“账本在远端、证据在仓库”的组合有可检查的一致性。

## 需要决定的事

1. 账本内容是否允许进入公开仓库（A）还是保持私有（B／C）？
2. 跟踪范围：仅两个真实账本，还是整个 `var/ledger/`？（提议：仅两个。）
3. 谁在什么时点提交（提议：协调者，每次记录之后）？
4. 是否立项“相对路径证据”（上面第一个改进）？
