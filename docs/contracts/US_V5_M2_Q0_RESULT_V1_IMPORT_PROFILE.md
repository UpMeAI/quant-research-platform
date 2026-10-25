# US_V5_M2_Q0_RESULT_V1 · QRP 导入规格（K3）

状态：**提议，随 PR 合并；由协调会话决定是否冻结。** 实现者起草，2026-10-25。
上游：`docs/contracts/US_V5_M2_RESEARCH_PROGRAM_V1.md` 与修订 1（M1.4 判定词汇、M1.5 结果文件顶层字段，均已冻结，本文不改动）；
`CYCLE_RESEARCH_DESK_HUMAN_WORKSPACE_UX_ACCEPTANCE_AMENDMENT_3.md`（回测结论卡六块）。
实现：`services/baseline-evaluation/index.js`；测试夹具 `tests/_q0_fixture.js`（合成数字，只用于测试）。

M1.5 只固定了顶层字段名。下面是 QRP 导入器对**子字段**的读法，目的是让研究会话产出的文件一次导入通过。
缺子字段不会让整个文件失败：只让对应的卡片区块写「尚未回测：结果文件缺 <路径>」。整文件失败关闭的条件见第 3 节。

## 1. 文件与封存

- 一个 JSON 加旁边的 `<文件名>.sha256`（内容为 64 位十六进制，可跟空格和文件名）。路径必须是绝对路径；路径里带 `fixture / demo / mock / synthetic` 的文件不当作实际来源。
- 导入命令（完成权威执行，读文件、追加一条 `BASELINE_EVALUATION_LOCK_V1`，不写别处）：
  `QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR node apps/research-cli/import_baseline_evaluation.js --file <绝对路径> --registered-by V8_1_COORDINATOR`
- `result_id = Q0-<文件 sha256 前 16 位>`。一个 case 只锁一次；改锁必须 `--supersedes <result_id> --defect-ref <引用> --reason <原因>`，旧锁保留。Q1–Q4 引用 `result_id`。
- 页面每次现场复验文件 sha256 与锁里记录的一致；文件被改、被删、旁证丢失，整卡写「尚未回测：<原因>」。

## 2. 子字段（`*` 为导入器必须读到的）

| 顶层 | 子字段 |
|---|---|
| `identity` | `schema`* = `US_V5_M2_Q0_RESULT_V1`；`smartflow_commit`*（40 位）；`engine_files`*（路径 → blob sha）；`plan_sha256`、`amendment_sha256`、`config`、`command`、`seed` |
| `inputs` | `series`*：每条 `{symbol, role, source_host, source_ref, range:{from,to}, rows, sha256*}`；`census`：`[{year, tradable_carriers}]`；`segments`：`[{id:'IS-a'｜'IS-b'｜'OOS', start, end, sessions, tradable_carriers, pool_overlap_ratio(0–1)}]` |
| `gates` | `I1:{state}`；`A0:{state:'PASSED'｜其他, rows}`；`rules`：`[{rule, status:'IMPLEMENTED'｜'NOT_IMPLEMENTED'｜'NOT_APPLICABLE', code_ref}]` |
| `arms` | `D`、`SPY_BUY_HOLD`、`CASH`，每臂：`equity:{dates:[…], values:[…]}`（三臂日期序列相同，值为正数），`summary:{end_capital, cagr, max_drawdown, longest_underwater_sessions, recovered:boolean}`；`D.trades` 逐笔数组 |
| `stats` | `rows`：`[{segment, cost_bps, phase:'PRODUCTION'｜'PLUS_60MIN'｜'MINUS_60MIN', n, win_rate(0–1), payoff(无亏损笔为 null), mean_R, mean_R_ci:[lo,hi], g, cagr, max_drawdown, longest_underwater_sessions, recovered, end_capital}]` |
| `stress` | `rows`：`[{scenario, label, max_loss_usd, longest_underwater_sessions, recovered, end_capital, simulated:boolean}]` |
| `half_kelly` | `p, p_ci, b, b_ci, f_star, f_half`；`floor_usd`（须为 1800）；`replay:{half_kelly:{end_capital_ci, max_drawdown, p_below_floor}, fixed_60:{同左}}`。`f_half = 0` 时页面写「不支持按凯利加仓」 |
| `formula_table` | `kind:'FORMULA_NOT_BACKTEST'`；`cells:[{win_rate, payoff, expected_growth}]` |
| `verdict` | `class:'BASELINE_EVALUATION_V1'`；`state:'SUPPORTED'｜'NOT_PASSED'｜'INSUFFICIENT'`；`comparators:['SPY_BUY_HOLD','CASH']`；`ci_method:'MONTHLY_BLOCK_BOOTSTRAP_95'`；`delta_R:0.10`；`delta_g:0`；`L_R, U_R, L_g, U_g, n_trades, reason_codes:[…]`；`engine_approximation:{flag:boolean, missing:[…]}` |
| `diagnosis_items` | `[{id, source:'DATA'｜'SELECTION'｜'ENTRY_EXIT'｜'RISK'｜'INSTRUMENT'｜'EXECUTION', facts:[…], proposed_experiment:'Q1'…'Q4'｜null, no_topic_reason:string｜null}]`，每条二选一 |
| `reproducibility` | `command`；`runs:[{sha256},{sha256}]`（两次运行的输出 sha256，相等）；`identical:true` |

页面主数字取 `stats.rows` 里 `segment='OOS'`、`cost_bps=5`、`phase='PRODUCTION'` 的 `mean_R` 与 `mean_R_ci`；缺这一行时写「主数字：尚无」。
`reason_codes` 里导入器认识 `ENGINE_APPROXIMATION`、`A0_NOT_PASSED`、`SAMPLE_LT_30`、`CI_STRADDLES_DELTA`、`COVERAGE_INSUFFICIENT`；别的代码照原样显示为「原因码 X」。

## 3. 整文件失败关闭（拒绝导入，已导入的页面整卡不显示数字）

1. sha256 旁证缺失或不符、不是 JSON、缺任一顶层字段。
2. `reproducibility` 不是「两次运行输出相同」。
3. `identity.schema` 不是 `US_V5_M2_Q0_RESULT_V1`；`verdict.class` 不是 `BASELINE_EVALUATION_V1`。
4. δ、比较对象、区间方法与计划冻结值不同（`delta_R=0.10`、`delta_g=0`、两个比较对象、按月分块 bootstrap 95%）。
5. 判定越过算术证据：`SUPPORTED` 要求 `L_R > 0.10` 且 `L_g > 0`、`n_trades ≥ 30`、引擎不是近似、A0 通过且规则清单无「NOT_IMPLEMENTED」；
   `NOT_PASSED` 要求 `U_R ≤ 0.10` 或 `U_g ≤ 0`；`INSUFFICIENT` 任何时候允许。
6. A0 未通过或规则清单有「NOT_IMPLEMENTED」，却没有把 `engine_approximation.flag` 标为 `true`（M1.2）。
7. 名称里带 bear／熊／synthetic／模拟 的压力场景没有标 `simulated: true`。
8. 缺输入序列的 sha256、缺 `engine_files` 或 `smartflow_commit`（结果锁要记输入与引擎摘要）。

导入器不重算任何业务数字，也不替研究会话定结论；它只拒绝「标签比证据强」和「证据链断了」。
