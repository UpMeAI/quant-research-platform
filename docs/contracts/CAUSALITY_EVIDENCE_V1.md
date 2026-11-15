# CAUSALITY_EVIDENCE_V1 · G-CAUSAL 因果门（工具、证据、导入）

- 依据：研究框架修订 2026-11-12 §3，**已冻结**。
  - 冻结页 `artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261112_FREEZE_1.md`（sha256 `c9742ea0…`，协调会话 2026-11-15T22:47:42+08:00）；
  - 冻结的文本：草稿修订 1（`d7f85a87…`）加上冻结审阅 rev 3（`d943d342…`）。§3 的 G1–G20 全部取 (a)，本合同按此写。
- 生效：`EFFECTIVE_FROM = 2026-11-15T22:47:42+08:00`，与 G-MECH（E13）共用同一个常量，定义在 `services/research-framework-amendment-20261112`。此刻及之后冻结的 K2 过门，此前已冻结的不追溯。
- 代码常量绑定冻结页：共用模块的 `FREEZE` 写冻结页与两份冻结文本的路径和 sha256（E1），`services/causality-gate` 从那里读。证据写出 `contract_ref` = `<冻结页路径>@c9742ea0`，过门时核对。
- 性质：只改研究流程，不改交易、风控、账户规则，不改生产。门只会拒绝导入，从不改写结论，也不会因此判「不做」。
- 实现不造表达式语言（§3.5）：对每个函数做确定性测试，一套工具、两个运行器（Node，Python）。

## 1. 各仓库提交的清单 `CAUSALITY_MANIFEST_V1`

清单由该题的执行会话写，随 K2 运行一并提交。路径相对代码根（默认取清单所在 git 仓库的根）。

```json
{
  "schema": "CAUSALITY_MANIFEST_V1",
  "study_ref": "<K2 名>", "k2_sha256": "<64 位>", "code_repo": "ashare-v6 | smartflow | qrp | …",
  "fixture_dir": "<相对清单的夹具目录>", "label_fields": ["fwd_ret_5d"],
  "functions": [{
    "runner": "node | python", "path": "src/…/f.js", "entry": "导出名（可用点号）",
    "inputs": [{ "name": "bars", "file": "bars.json", "availability": { … }, "intraday": false, "key_fields": [], "keep_fields": [] }],
    "call": { "style": "positional | object", "order": ["bars"], "params": [], "at": { "position": 1, "value": "INDEX | FIELD", "field": "closeTime", "key": "asOf" } },
    // at 也可以是数组，依次注入，例如先把 asOf 写进参数对象、再插入行号：f(bars, i, { asOf })
    "output": { "align": "ALIGNED | KEYED | AT_POINT", "to": "bars", "select": "可选点号路径",
                "time_field": "date", "key_fields": ["code"], "availability": { … } },
    "session": { "open": "09:30", "close": "15:00", "tz": "+08:00" },
    "segment_boundaries": ["2025-01-01T00:00:00+08:00"],
    "static_reads": ["config/…/params.json", "config/…/research"],
    "frames": { "bars": "pandas" }
  }]
}
```

输出形状：

| `align` | 被测函数 | 怎么配对 |
|---|---|---|
| `ALIGNED` | `f(X)`，返回与主输入（`to`）逐行对齐的数组 | 按主输入行号 |
| `KEYED` | `f(panel)`，返回记录数组 | 按 `key_fields` 加输出的可得时点（`output.availability`，规则写在 `time_field` 上） |
| `AT_POINT` | `f(X, t)` 或 `f(X, { asOf })` | 对主输入每一行调用一次；`t` 取行号（`INDEX`）或该行字段（`FIELD`）。`key` 给出时，把值写进第 `position` 个参数对象的这个键。`at` 写成数组时依次注入多个值 |

可得时点规则（§3.3「按可知时点截断，不按业务日期」）：

| `rule` | 写法 | 例 |
|---|---|---|
| `FIELD` | `{ field, add_seconds? }`；字段是带时区的 ISO 时间，或毫秒时间戳 | 分钟线的结束时刻 |
| `DATE_AT` | `{ field, time: "HH:MM", tz: "+08:00", offset_days? }`；字段是日期（`YYYY-MM-DD` 或 `YYYYMMDD`） | 日线 15:00+08:00；报表 `ann_date` 次日 00:00（`offset_days: 1`，`time: "00:00"`） |
| `RULED_LAG` | 上面任一写法，加 `lag_seconds` 与 `ruling_sha256` | 协调会话裁定的滞后规则；导入时要有同一页裁定 |

- 不带时区的时间不认。
- 任何一行算不出可得时点，T-C1、T-C2 判 FAIL（`AVAILABILITY_UNKNOWN`）。
- 输入里出现 `label_fields` 中的列，也判 FAIL（`LABEL_IN_INPUT`）。

## 2. 三项测试怎么跑

**截点（★3 (a)）。**
- 候选是所有输入行的不同可得时点，去掉最后一个。
- 必选：首、尾 ⌈5%⌉ 里各一个；每个段边界两侧各一个；有盘中输入时，每个交易日一个盘中截点（开盘后、收盘前）。
- 其余按 `sha256(种子|function_id|标签|时刻)` 排序补到 20 个；必选超过 20 个时全取。
- 种子 20261112。截点由 Node 编排端选，两个运行器用同一组。
- 有盘中输入却没有盘中候选的，判 FAIL（`NO_INTRADAY_CUT`）。

**T-C1 前缀等价。** 每个截点 c，`f(X[≤c])` 与 `f(X)` 在所有 t ≤ c 的读数逐字节相等。

**T-C2 未来替换。** 可得时点 > c 的行换成扰动数据，t ≤ c 的读数不变。两种扰动都要过：
- `SHUFFLE`：在未来行之间打乱非保护列；
- `WALK`：数值列换成从截点前最后一个值起步的随机游走（每步 ±5%），整数列取整，按 `key_fields` 分组。

保护列是可得时点字段、`key_fields`、`keep_fields`，两种扰动都不动它们。

**T-C3 只读给定输入。** 每次调用都在沙箱里：
- Node：权限模型 `--permission`，外加注入的桩。
- Python：审计钩子；以 `-I -B` 运行，不写 `__pycache__`。

| 阶段 | 可读 | 不许 |
|---|---|---|
| 加载被测模块 | 代码文件；库目录（`node_modules`、`site-packages`、解释器自带）里的文件；夹具目录；`static_reads` | 仓库自己的数据文件（含加载时 `require` 的 `.json`）不声明就不许读；写文件、联网（含 Unix 套接字，即数据库）、子进程、线程 |
| 调用被测函数 | 夹具目录、`static_reads`、按需加载的代码文件 | 同上，另加库目录与代码根下的其他文件 |

- `static_reads` 写代码根下的文件或目录。文件记 sha256；目录逐个文件记 sha256，再对清单取 sha256（`kind: "DIR"`，记文件数）。
- 两个阶段都可以列目录，只得到文件名。
- 加载时读了哪些非代码文件，逐条记进 `load_reads`。
- 为什么加载段也要声明：模块加载时读进全量历史表，前缀与全段都读同一份文件，T-C1、T-C2 都看不出，只有 T-C3 拦得住。
- Node 权限模型的读权限只留最外层路径。Node 23.11 上，子目录排在父目录前面时，父目录本身会被拒（实测）。权限模型只是第二道防线，判 T-C3 的是桩。

每一次越界都先记下再抛错。被测函数吞掉异常、改走别的路，T-C3 照样 FAIL。

**隔离。** 默认 `MODULE_RELOAD`：
- 一个函数一个进程；
- 每次调用前清掉代码根下的模块缓存，删掉新增的全局变量，再重新加载被测模块。
- 严格档 `PROCESS_PER_CALL`：每次调用一个新进程。
- 模块缓存不能把一次调用的未来带进另一次。

**相等（★4 (a)）。** 读数写成规范串再比较：
- 数值按 IEEE 754 位型，-0 与 +0 不同，NaN 按位型比；
- Python 的 int 与 float 不同；
- 对象键排序；undefined 与缺键不同。

**读数不能只有一种值。** 整段调用的读数只有一种值（全为空、全报错、恒定）时，T-C1 判 FAIL（`DEGENERATE_OUTPUT`）：这种「相等」证明不了什么，夹具要能让读数变化。
- T-C2 照常跑：换掉未来之后读数若变了，说明函数读了未来。单边行情上的前视就是这样看出来的。
- 证据逐函数记 `readings_summary`：读数个数、不同值个数、空或报错的个数。
- 例：防前视的过滤按 `date` 写，行里只有 `trade_date`，过滤后每个点都是空。T-C1 与 T-C2 都「相等」，靠这一条才判不过。

**结果。**
- 只有 PASS / FAIL 两种。工具层面的问题一律记 FAIL，原因写进 `fail_reasons`。这类问题包括：运行器起不来、输出没对齐、可得时点算不出。
- 不一致记前 20 处，每处写测试、扰动、c、t、键、两边的值。

## 3. 证据 `CAUSALITY_EVIDENCE_V1`

一份 K2 一次运行一份 JSON。由 `tools/causality-harness` 写出，写一次不改：目标已存在就拒绝，旁边写 `.sha256`。更正写新文件，并换新绑定。schema 登记在 `schemas/index.js`。

- **顶层：**
  - `contract_ref`（本冻结页，见上）、`study_ref`、`k2_sha256`、`code_repo`；
  - `code_sha`：被测文件都已跟踪、已跟踪文件没有改动时为 HEAD，否则为 null，原因写进 `unknown.code_sha`；
  - `harness_version`、`harness_sha256`（工具源文件的 sha256）、`seed`、`cut_points_per_function`、`manifest_sha256`；
  - `functions[]`、`unknown{}`、`production_effect: "NONE"`、`registered_by`、`registered_at`、`record_hash`。
- **`functions[]`：**
  - 身份：`function_id`（`<code_repo>:<path>#<entry>`）、`path`、`entry`、`runner`、`file_sha256`；
  - 输入：`inputs[]`，每项含 `name`、`file`、`file_sha256`、`rows`、`availability`、`intraday`、`key_fields`、`keep_fields`；
  - 调用：`call`、`output`、`static_reads[]`（`path`、`sha256`）、`session?`、`segment_boundaries`；
  - 运行：`cut_points[]`、`calls`、`isolation`、`sandbox{mode, runtime}`；
  - 结果：`t_c1`、`t_c2`、`t_c3`、`fail_reasons{}`、`readings_summary`、`mismatch_counts`、`mismatches[]`（≤ 20）、`forbidden_attempts[]`（≤ 20）、`load_reads[]`。
- `record_hash` = sha256(规范 JSON（键排序），不含 `record_hash` 本身)，与试验台账同一写法（`services/trial-ledger` 的 `canonicalJson`）。

## 4. K2 怎么写

证据的 `k2_sha256` 必须等于导入登记里 `entry.k2` 绑定的那一份。冻结页逐字收录正文、草稿也在时，以登记绑定的为准。

在 K2 §0 写明范围，二选一：

- 每个新增或重算的函数写成 `` `CF:<code_repo>:<path>#<entry>` ``，例如 `` `CF:ashare-v6:src/research/pvs/volume.js#volumeReading` ``。门从 K2 全文里抽出这些 id，写法同台账 id `TRL-…`。
- 不适用写一行 `G-CAUSAL N/A: <码>`。码只有五个（§3.2）：`RISK_K_OR_ACCOUNT_LAYER`、`ABLATION`、`COST_EXECUTION`、`DEFECT_OR_ENGINEERING`、`DESCRIPTIVE_NO_PERFORMANCE`。

## 5. 导入器（海外与 A 股封存结论，同一套 `checkEntry`）

登记一题时可加三个字段，都按 sha256 绑定：
- `causality_evidence`：证据文件；
- `causality_ruling`：`{ spec, deviations?: [{ function_id, test }], lag_rules?: [{ function_id, input }] }`；
- 现有的 `run_log`（`RESEARCH_RUN_LOG_V1`）。

门在原有校验与 G-TRIAL 之后运行。

**过门的题**（封存导入 RESULT / READING，`k2_frozen_at ≥ EFFECTIVE_FROM`）：
1. K2 声明范围：
   - 两样都没有 → `CAUSALITY_SCOPE_MISSING`；
   - 两样都有，或写了不适用却又绑了证据 → `CAUSALITY_SCOPE_CONFLICT`；
   - 只写不适用 → 锁里记 `NOT_APPLICABLE`。
2. 证据完整：
   - 结构与 `record_hash` 复算一致；
   - `k2_sha256` 等于这份 K2；
   - `unknown` 为空；
   - 种子、截点数是冻结值，`contract_ref` 是本冻结页；
   - 工具版本在认可列表里。
3. `code_sha` 等于运行日志的 `<code_repo 的 - 换成 _>_run_commit`，例如 `ashare_v6_run_commit`、`smartflow_run_commit`：
   - 日志缺失 → `CAUSALITY_RUN_LOG_MISSING`；
   - 没有这个键 → `CAUSALITY_RUN_LOG_CODE_SHA_MISSING`；
   - 不等 → `CAUSALITY_CODE_SHA_MISMATCH`。
4. K2 的函数集合等于证据的函数集合（`FUNCTION_NOT_IN_EVIDENCE` / `FUNCTION_NOT_IN_K2`），每个函数三项全 PASS（`FUNCTION_NOT_PASS`）。
5. 偏差只能出自 `causality_ruling`：
   - 裁定原文写出 `DEVIATION_ACCEPTED`、函数 id 和测试名（T-C1/T-C2/T-C3）；
   - 放行的测试在证据里确实是 FAIL，否则 `RULING_FACT_NOT_HOLD`；
   - 通过时锁里记 `DEVIATION_ACCEPTED`，不记 PASS。
   - `RULED_LAG` 的输入要在同一页裁定的 `lag_rules` 里，裁定原文写出 `RULED_LAG`。

**不过门的题：**
- 照原样导入，锁行逐字节不变。
- 绑了证据的（§3.6 补跑、§3.7 上线前核对）：只核完整性，结果原样记进锁的 `causality_gate`，标 `report_only: true`；FAIL 不拒绝。
- 带 `causality_ruling` 的拒绝（`RULING_ON_UNGATED_ENTRY`）。

## 6. 命令行

```bash
node tools/causality-harness/run.js --manifest <清单> --registered-by <会话> --out <证据.json> [--code-root <目录>] [--extra-code-root <目录>] [--python python3] [--isolation MODULE_RELOAD|PROCESS_PER_CALL]
```

- 退出码：0 = 全 PASS 且 `unknown` 为空；2 = 有 FAIL 或 `unknown`（证据照写）；1 = 清单或运行错误。
- 自测夹具：`tools/causality-harness/fixtures/`（合成数据，先红后绿，见 `tests/causality_harness.test.js`）。

## 7. 范围之外与已知限制

- 只读末根的函数（例如只看最后一根 K 线、要求末根等于业务日的读数）：因果性靠调用方切片。对它跑 T-C1、T-C2，要么必然相等，要么因末根对不上而全报「缺当日」（形状不符，不是前视）。清单应写它的调用方。
- 前复权：对已经复权的数组做切片，看不出复权本身的前视。复权这一步应作为被测函数，喂原始价加带可得时点的复权因子。
- `call.params` 不截断，原样记进证据。参数不得是时间序列（例如带未来日期的交易日历之外的数据），由清单作者负责。
- 一份证据只对应一个代码仓库。函数跨仓库的题，需要协调会话的裁定。
- ★4 (b) 浮点容差没有实现。
