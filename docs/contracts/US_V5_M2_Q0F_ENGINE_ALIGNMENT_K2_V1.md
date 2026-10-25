# US_V5 M2 Q0-F · 引擎补齐与 A0 重跑 · 研究规格 K2 V1

状态：**FROZEN**（2026-10-25，协调会话；研究规格负责人）
草稿来源：smartflow `research/us-v5-m2-q0` 7fbb2476 `trading-system-v2/docs/US_V5_M2_Q0F_ENGINE_ALIGNMENT_K2_DRAFT_V1.md`，sha256 `7b4e293367d2fb42f0efd6df1933b4958a3044c8ca392082c82e34d5519b363c`。正文原样保留；裁定见文末，冲突时以裁定为准。
依据：修订 2 M2.3（QRP main f7e6bd7，sha256 `452aaa28…`）。前序：Q0 结果 `US_V5_M2_Q0_RESULT_V1`（sha256 `591c2d48…`）；A0 `Q0_A0.json`（`6231ed48…`）；规则清单 `Q0_RULE_INVENTORY.json`（`dce485e8…`）。

```yaml
模板身份: US_V5_M2_Q0F_ENGINE_ALIGNMENT_V1
原问题与研究槽引用: 修订 2 M2.3；A0 未通过的差异（Q0 diagnosis_items：D-EXEC-OPEN-SCAN-COOLDOWN、D-EXEC-SCAN-SCHEDULE、D-TIMING-KLINE-V1-NOT-READ、D-INSTRUMENT-ROUTING-DERISK-SCOPE）
研究用途: 引擎对齐（复现生产已有行为）+ 对齐门重跑；不是候选比较，不引入新规则，不调参
目标:
  市场_策略_账本_模式: US_EQUITY / US_V5_ETF_UNIVERSE_V1 / US_V5_ETF_3000USD（A0 另含 US_V5_ETF_6000USD 2026-09-28..10-09）/ PAPER（真实行情）
  当前D有效版本引用: smartflow 2382c2d1；worker sha256 856b8b23…；S17 参数记录 8698f327…
  原实验冻结基线引用: 研究引擎 = us-v5-rsi-band-stage armLine (a) + replay-us-v5-universe-comparison runLine（0853d64b）；Q0 结果 591c2d48…
  代码_参数_开关引用: 新增的研究选项全部「不设即不变」，I1、SEL-4 复现、旧 A0 输出在选项关闭时必须逐字节不变
  选择规则引用: 不变
  择时退出规则引用: F1–F3、F5（下）
  组合风控规则引用: F4、F6（下）
  信号标的与交易载体: 不变（单股行的信号在载体本身）
  工具执行与成本引用: 不变（5 bps / 边 + stand-alone 监管费）
补齐项（每项对照生产代码；实现时优先直接调用生产模块，不重写）:
  F1_SCAN_SCHEDULE:
    生产: us-v5-strategy-worker.js l.697–706 setInterval(US_V5_INTERVAL_MIN=120)，从进程启动起算；扫描记录 startedAt 为实际时点
    A0: 用扫描记录里的实际时点（09-28..10-23）逐次评估
    长历史: 主口径 = 冻结时生效的生产时间表（当前进程：每日 10:04 / 12:04 / 14:04 ET）；压力 = 相差 60 分钟的另一组（11:04 / 13:04 / 15:04 ET）。历史上的重启时点不可知，不推测
  F2_FORMING_BAR:
    生产: 扫描时取的 1h 序列含当前未完成 bar（扫描记录 bars1h 的末尾；另有一个 volume 0 的报价点）；开盘扫描不跳过信号评估
    A0: 直接用扫描记录里的 bars1h 窗口（逐字节是生产输入）
    长历史: 用缓存的 30 分钟线拼出扫描时点的未完成 bar（只含扫描时点前已完成的 30 分钟段）；与生产的差异（Yahoo 实时 vs Alpaca 30 分钟）作为已知近似写明
  F3_EXIT_CHECK_INSTANTS:
    生产: checkExitSince l.3668（每次扫描补查上次检查以来的 bar，SL/TP 在价位）；TIME 在扫描时用最新收盘价；开盘那次 OPEN_SCAN_AWAITING_FIRST_BAR 跳过（staleBarReason）
    研究: 退出只在 F1 的扫描时点检查，规则同上
  F4_KLINE_TIMING_V1:
    生产: kline-timing.js（S17 klineTiming v1，2026-10-14T00:00Z）；us-v5-kline-hooks.js entryVeto l.24（K1）、manage l.64（K3）；worker _klineTrigger l.2939（K2 KP7）；US_V5_KLINE_VOLUME 未设 → 成交量减半路径关闭
    研究: 直接调用上述生产函数（数据库写入替换为内存记录）；长历史全程按当前规则启用
    A0 核对: 只读 HK 数据库 kline_timing_decisions（book US_V5，2026-10-14..10-23）。用 HK 上应用自身的只读查询，不导出凭证，只拷出结果行与其 sha256
  F5_V3_ROUTING:
    生产: us-etf-universe.js pickCarrier l.301（HIGHEST_ABS_LEVERAGE_THEN_ADV，v3 自 2026-10-06T13:30Z）；worker l.2753
    研究: runLine 的载体选择改为调用 pickCarrier（ADV 取 floorsOk 的测量值）
  F6_DERISK_AND_SHRINK_SCOPE:
    生产: worker l.1868 computeDeriskFraction（作用于全部仓位）；l.1884–1894 高波动缩股只在 etfTranslation（route.carrier）时
    研究: 按生产条件；computeDeriskFraction 的权益口径对照代码写明
  F7_PREDECESSOR_SHARED_LIMITS（只用于 A0）:
    生产: us-v5-book.js rowInLine / lineScopeSql l.231–247
    研究: A0 的 3000 簿运行读入 6000 簿在 10-08..10-09 的未平仓（线内占用）；长历史不适用（修订 2 M2.1）
输入:
  冻结数据及内容身份: 修订 1 缓存（INPUTS_MANIFEST_A1 665cc2a9…）；HK 扫描记录与 M1 封存包（已核对逐字节相同）；HK kline_timing_decisions 只读导出（新增，记 sha256）
  历史可知假设与覆盖: 同 Q0
  扫描相位与业务日历: F1
  初始现金_持仓_风险状态: 同 A0（6000：09-28 空仓；3000：T 锚空仓）
  共享预算或其他账本依赖: F7（只在 A0）
比较:
  问题与机制: 补齐后的研究引擎能否逐项复现生产在 A0 窗口的决策
  唯一比较对象或唯一改动: 对象 = 生产扫描记录与纸面账本；改动 = F1–F7
  共同规则与不可避免差异: 长历史的 K 线来源（Alpaca 30 分钟）与生产（Yahoo 1h 实时）不同，A0 不受影响（用记录窗口）
  数据既往用途与全部尝试: A0 窗口已用于第一次 A0；本次是同一窗口的复核，不产生新的经济结论；全部运行都记录
  开发_确认_前向范围: A0 = 2026-09-28..10-23；之后的长历史同 Q0
判据:
  主目标与最低改善量: A0 判据不变：每笔开平仓的标的、方向、session、股数、出场原因一致；成交价落在生产 bar 区间内；被拒信号的闸门代码一致；没有引擎独有交易和信号日
  待冻结的一处读法: 10-01（生产以 ETF_UNIVERSE_VERSION_NOT_YET_EFFECTIVE 拒绝全部扫描）是部署事故，不是规则。提议：A0 排除「当天全部扫描都拒绝标的池」的 session，并单列；或者引擎读入记录里的 universeState 照样拒绝。由协调会话二选一
  风险上限及允许收益代价: 不适用
  样本单位_依赖处理_区间方法: 逐项一致，无统计推断
  适用压力_条件_评价时点: A0 通过后重跑 Q0 长历史全部 §5.2 压力
  缺项与不足处理: 任一 F 项不能对照生产代码实现 → 不实现，写明原因，A0 照判；A0 仍不过 → 每个剩余差异进诊断清单，Q1–Q4 在近似引擎上继续（修订 2 M2.3）
采用边界:
  原流程或决定引用: A0 通过 → 重跑 Q0，新结果以 --supersedes 旧 result id 锁定，此后标「当前 D」；A0 不过 → 维持近似标签
  允许输出: 研究引擎选项、A0 对照表、重跑的 Q0 结果文件
  生产或交易写入: 不允许；HK 只读
```

**工作量与风险（执行者估计）：** F4（K 线择时）牵涉三个生产模块和日线 / 小时线两套输入，是主要工作量。F2 在长历史里只能近似（30 分钟线拼未完成 bar）。如果 F4 的生产函数依赖实时数据库或网络，改为调用同一套纯函数，并在对照表里逐项写明。


## 协调会话裁定（冻结时）

1. **10-01 事故的读法：选「排除并单列」。**
   - A0 排除「当天全部生产扫描都以部署原因（如 `ETF_UNIVERSE_VERSION_NOT_YET_EFFECTIVE`）拒绝标的池」的 session，在对照表里单列为「生产事故，不参与对齐判定」。
   - 理由：A0 检验的是引擎能否复现生产的**规则**，不是复现部署事故。长历史也不模拟事故。
   - 引擎不读入 `universeState` 来照样拒绝。
2. **前序 Q0 结果引用**：已导入的锁是 `Q0-24fb86c3609f7ef3`（文件 sha256 `24fb86c3…`，替代了草稿中引用的 `591c2d48…`，数字相同）。A0 通过后重跑的 Q0 用 `--supersedes Q0-24fb86c3609f7ef3` 锁定，`--defect-ref` 写本 K2 与 A0 结果的引用。
3. **惰性证明是硬门**：所有新研究选项关闭时，I1、SEL-4 复现和旧 A0 输出必须逐字节不变，否则停下，不进入 A0 重跑。
4. **人话文本用中文**：重跑的 Q0 结果文件里，所有给人看的字符串一律写中文，包括 `diagnosis_items[].facts`、`missing_reason`、`no_topic_reason`、压力行 `label`、`verdict.label`；代码、ID、原因码可保留英文。
   - 原因：现有页面上缺场景的原因和问题清单事实显示为英文，研究员读不懂。
5. **停止点**：A0 重跑完成即停，报告并等协调会话自查。
   - A0 通过：报告后由协调会话发「重跑 Q0」的指令。
   - A0 不过：按修订 2 M2.3，剩余差异进诊断清单，报告后等协调会话发 Q1 的指令。
