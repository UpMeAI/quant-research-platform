# A 股研究封存结论 · 导入规格 V1 · 修订 7（R-STK-1 D4 初筛与排序；X07b A 股风控线）

- **状态：** 草稿，随 QRP PR 交协调会话审阅。★ 选项都写了默认 (a)，协调会话冻结本页、合并即采用。V1 正文与修订 1–6 一字不改。Production effect：`NONE`。
- **本修订只做一件事：** 往登记表加两题。门的代码一行不改。

## 1. 加入登记表的两题

| entry_id | 读法 | 期望 → 结论 | 锁编号 |
|---|---|---|---|
| `CN-R-STK-1-D4` | `d4.pairs.C_RS.J2.state` | `INSUFFICIENT` → 做 = 前向影子（候选 C_RS_FLOOR） | `ASV-CN-R-STK-1-D4-63e91f82312c` |
| `CN-X07B` | `judged.verdict_zh` | `不做` → 不做（NOT_PASSED，U_G_AT_OR_BELOW_ZERO） | `ASV-CN-X07B-4c84761fc7f9` |

两题都是 `ASHARE_V6_PAPER`、`RESULT`、封存 2026-11-18。结论文件直接绑 Mac 封存副本（协调会话目录 `evidence/<封存目录>/`，与 Linux 封存逐字节相同）。不另做副本。

### 1.1 D4

- **结论文件：** `evidence/rstkd4-sealed-20261118/RSTKD4_VERDICT.json`（`63e91f82…`）。
- **同题另一封存文件（ALSO）：**
  - 结果页 `R_STK_D4_SCREEN_RANKING_K2_V1_RESULT_1.md`（`722931c2…`）；
  - 结果页附注 1 `…_RESULT_1_NOTE_1.md`（`32fb2a41…`）；
  - 封存目录的 `SHA256SUMS`（`36b8bb26…`）。
- **K2：** 冻结页 `R_STK_D4_SCREEN_RANKING_K2_V1_FREEZE_1.md`（`571806b6…`，正文逐字保留草稿 `55247349…`）。不另绑冻结页。
- **K2 附注（K2_NOTE）：** 附注 1–7、NOTE_8（`bd908704…`）与 NOTE_8 澄清 1（`4e04d69d…`），共 9 页，按 sha256 绑定。判定运行的 ACCEPTANCE 门核过的就是冻结页、附注 1–7 与 NOTE_8，澄清 1 是运行头部点名的另一页。
- **读法：** INSUFFICIENT 按 `resolve` 写成「做」，用途写前向影子的去向（结果页 §4）。
- **note_zh：** 写 J2、J1、排序效应与 T_RS 基座的读数，都照封存 JSON 原样（年化 g，小数，不换算、不取整）。另写结果页 §5 的披露与结果页附注 1 的两节。

### 1.2 X07b

- **结论文件：** `evidence/x07b-sealed-20261118/X07B_RESULT.json`（`4c84761f…`）。
- **ALSO：** 结果页 `X07B_ASHARE_RISK_LINES_K2_V1_RESULT_1.md`（`ee39f38e…`）、封存目录的 `SHA256SUMS`（`dccfdb24…`）。
- **K2：** 草稿终稿 `X07B_ASHARE_RISK_LINES_K2_V1.draft.md`（`3fae758b…`）。台账行的 k2_sha256 就是它，所以 K2 绑它。冻结页 FREEZE_1（`c82975b3…`）另绑。
- **K2 附注：** 附注 1–3（`f829092e…`、`f90872a1…`、`2d3012cc…`）与附注 2 的回执（`2a24fc2b…`）。
- **运行日志：** `X07B_ASHARE_RISK_LINES_RESEARCH_RUN_LOG_V1.json`（`d7ba7f89…`，协调会话目录，0444）。见 §4.1。
- **读法：** 同 R8，读 `judged.verdict_zh`，证据强度栏读 `judged.reason_code`。
- **note_zh：** 写 J 的读数与锁的计数，照封存 JSON 原样。

## 2. 五道门

| 门 | D4（K2 冻结 2026-11-10T00:57:00+08:00） | X07b（K2 冻结 2026-11-14T23:39:05+08:00） |
|---|---|---|
| G-TRIAL PRE | 不适用（早于 11-11） | PASS：K2 点名的 3 行在冻结前 53 秒预登记（15:38:12.308Z），不带门的裁定 |
| G-TRIAL SEAL | 不适用 | PASS：3 行结果、运行日志 3 个 run、披露 J 一行（要先写进台账，§4.1） |
| G-MECH | 不适用（早于 RF1112） | 不适用（早于 RF1112） |
| G-CAUSAL | 不适用（N/A: PRE_EFFECTIVE_K2） | 不适用（N/A: PRE_EFFECTIVE_K2） |
| G-COST | 不适用（早于附录 1） | 不适用（早于附录 1） |
| G-PARITY | 不适用 | 不适用 |

锁行只在 X07b 上多出 `trial_gates`；D4 的锁行不带任何门的字段。

## 3. ★ 选项（默认都是 (a)）

- **★A7-1 D4 进几行：**
  - **(a)** 一行，只读 J2（全改动，结果页 §4 的机械判定）；J1（初筛增量，另写）与排序效应只写在 note_zh。
  - (b) J1、J2 各一行。
- **★A7-2 D4 绑哪些 K2 文件：**
  - **(a)** K2 = 冻结页，附注 1–7、NOTE_8 与澄清 1 作 K2_NOTE。
  - (b) 只绑冻结页。

  附注只在 G-PARITY 适用时才被读，所以 (a) 只是把判定所依的文本钉进锁行。
- **★A7-3 D4 的 k2_frozen_at：**
  - **(a)** 取冻结页写的时刻 2026-11-10T00:57:00+08:00，五道门都不适用。附注 4–8 与澄清 1 冻结得晚（11-15、11-16），但它们不重新冻结 K2、不新增预登记行，不挪 k2_frozen_at。
  - (b) 取最后一页附注的时刻。这样 G-TRIAL、G-MECH、G-CAUSAL 都要过门，D4 在台账里没有任何试验行，要一页门的裁定。
- **★A7-4 结果页附注 1 的报表覆盖说明怎么带：**
  - **(a)** 写进 note_zh，附注页作 ALSO 按 sha256 绑定。
  - (b) 锁行加一个披露字段（要改导入器）。
- **★A7-5 X07b 的读法：**
  - **(a)** 读 `judged.verdict_zh` = 不做（同 R8）。
  - (b) 读 `judged.state` = NOT_PASSED，再按 resolve 写成不做。
- **★A7-6 X07b 的 SEAL 前置件：**
  - **(a)** 运行日志由我按封存事实写好放进协调会话目录；3 行结果与披露由协调会话在真导入之前用本页 §4.1 的命令写进台账，输入是我按封存文件抄好的件。已在台账副本上预演。
  - (b) 协调会话自己另写。
- **★A7-7 KLINES 结果行的 changed_entries：**
  - **(a)** 2 = 被挡下或放出的新开仓（读法裁定第 3 条，X07b 的 G1 计数），锁仓会话 1、按股数的改变入场 1 写在 study_verdict。
  - (b) 1（按股数）。
- **★A7-8 NOLOCK 结果行的月度序列：**
  - **(a)** 不给序列，`unknown.sr_monthly_delta` 写 IDENTICAL_TO_BASE。理由：过拟合输入里 NOLOCK 与 C_RS 的日对数收益在 1537 个会话上逐个相同；封存只给了 J 的月度差，不另算。
  - (b) 给全 0 的月度序列。
- **★A7-9 X07b 只绑本题自己的 K2 文件：**
  - **(a)** ACCEPTANCE 另核的 R-STK-1 FREEZE_1（`6eefdcbb…`）与附录 1 FREEZE_1（`dfe264b6…`）只在 note_zh 里按 sha 点名。
  - (b) 也作 ALSO 绑定。

## 4. 真导入

### 4.1 X07b 的 SEAL 前置件（只有 X07b 要）

- **前置件包：** `research-data/x07b_d4_import_v1/`（全部 0444，`kit.SHA256SUMS`）。
  - 生成脚本 `build-x07b-seal-kit.js`。它先按 sha256 复验封存目录（等同 `shasum -c`）、结果页与过拟合输入，再从封存 JSON 与台账的 3 行登记逐字抄值，不重算、不取整。两次生成逐字节相同。
  - 运行日志 `X07B_ASHARE_RISK_LINES_RESEARCH_RUN_LOG_V1.json`：`d7ba7f89…`。
  - 结果行输入 `record-X7B_BASE_K.json`：`cd841736…`。
  - 结果行输入 `record-X7B_KLINES_K.json`：`e3453657…`。
  - 结果行输入 `record-X7B_NOLOCK_K.json`：`6d84f988…`。
  - 披露输入 `disclose-J.json`：`f2d6f7af…`。
- **在 QRP 工作区依次执行**（`QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR`；`K=…/research-data/x07b_d4_import_v1/kit`）：
  1. `node apps/research-cli/trial_ledger.js record --trial-id TRL-95fff46a215c6a57 --result $K/record-X7B_BASE_K.json --registered-by V8_1_COORDINATOR`
  2. `node apps/research-cli/trial_ledger.js record --trial-id TRL-5ef889dfea662bf9 --result $K/record-X7B_KLINES_K.json --registered-by V8_1_COORDINATOR`
  3. `node apps/research-cli/trial_ledger.js record --trial-id TRL-1f8384c03cf967cf --result $K/record-X7B_NOLOCK_K.json --registered-by V8_1_COORDINATOR`
  4. `node apps/research-cli/trial_ledger.js disclose --spec $K/disclose-J.json --registered-by V8_1_COORDINATOR`
- **预演读数（台账副本）：**
  - 结果行：KLINES 的 sr_monthly_delta −0.12027194786099826，t_months 76；BASE、NOLOCK 记 UNKNOWN。
  - 披露 `OVD-3de5192f506536aa`：N 50（下界），DSR 0。PBO 由 overfit.js 记 NOT_APPLICABLE（CONFIGS_LT_4）。证据门对「不做」不起作用。
  - 披露 id 只由族、K2 与判定试验决定，真写时不变；record_hash 随写入时刻变。

### 4.2 导入

合并之后，在 §4.1 之后做，先备份台账：
1. `stage --ashare-v6-root … --artifacts-root … --out <证据目录>`；
2. `QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR import --evidence <证据目录> --registered-by V8_1_COORDINATOR`。

预期：
- 登记表 17 → 19 题，新增两把锁；原有 17 把锁走幂等重放，不改。
- `ASV-CN-R-STK-1-D4-63e91f82312c`：做；不带门的字段；refs 14 个（FILE、3 个 ALSO、K2、9 个 K2_NOTE）。
- `ASV-CN-X07B-4c84761fc7f9`：不做；`trial_gates` pre PASS / seal PASS，run_log_runs 3，disclosure_id OVD-3de5192f506536aa；refs 10 个（FILE、2 个 ALSO、K2、FREEZE、4 个 K2_NOTE、RUN_LOG）。

### 4.3 预演（Mac，真实文件 + 台账副本，真实台账前后 sha256 不变）

- **没写 §4.1 时：** 两题一起导入，整批拒绝 `TRIAL_LEDGER_SEAL_RESULT_MISSING:CN-X07B:TRL-1f8384c03cf967cf`，失败即关。D4 单独导入照常成锁。
- **写了 §4.1 之后：** 两题都成锁，读数同 §4.2；重导是幂等重放。
- **已有各题不变：** 用 main `d99fac5` 与本分支各跑同一个只读比较脚本（`research-data/r_xm_1_v1/import/compare.js`），读真实台账的副本，比较 62 道已有题目的锁投影、17 把 A 股锁的现场复验、result_id、绑定文件与 G-MECH / G-CAUSAL 的范围判断。
  - 两次输出逐字节相同（`6d891b14…`）。
  - 两边都有的 4 个 ERR 是比较脚本对 R-XM-1 两题的门只探范围、不给文件字节（`MECHANISM_RULING_FILE_MISSING`、`COST_MODEL_RUN_LOG_MISSING`），新旧相同，不是回归。
- **note_zh 抄值核对：** `copycheck.js` 核了两题 note_zh 与用途里 37 个带小数的数，都在本题封存 JSON、结果页或附注里原样出现，0 个不符。
