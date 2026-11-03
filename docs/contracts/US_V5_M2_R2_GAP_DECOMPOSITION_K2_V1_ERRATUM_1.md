# US_V5 M2 R2 差距分解 K2 V1 · 勘误 1（运行前写定）

- 对象：`US_V5_M2_R2_GAP_DECOMPOSITION_K2_V1.md`（sha256 `a161c5234f07d6cef182ccf21837be100a82be8f18b0184d6e393598814437cc`，FREEZE 1 `5501741d…`）。原文件不改。
- 写于 2026-11-03 夜，任何运行之前。只处理两处「照原文无法执行」的地方和一处事实笔误；不改任何门槛、规则、菜单或准入条件。

## 1. 门的精度读法（RECON_D、RECON_B、FEE_CROSSCHECK）

- 事实：封存的日权益（`arms.*.equity.values`、Q3 `reference_arms`）是四位小数（`r4`，Q1 `armBlock`）；逐笔字段是六位小数（`r6`）。原文「|Δ| ≤ 1e-6 USD」若按未取整比较，任何重建都不可能通过（封存值本身就有最多 5e-5 的取整）。
- 读法：与封存数比较时，先把重建值按封存值的同一精度取整（权益 r4、逐笔 r6），再要求 |Δ| ≤ 1e-6；求和项先逐项按封存精度取整再相加。未取整的最大差照报。
- 为了让这个比较不靠运气（避免取整边界翻转），逐笔价格在封存缓存上**精确找回**：入场 = 扫描报价 ×(1+5 bps)；出场 = 分位价位（`computeETFLevels` 取到分）、扫描报价、或持有窗口内某根 K 线的开盘 / 收盘价，×(1−5 bps)；每笔都逐字段核对封存的 `entry_price`、`exit_price`、`slippage_usd`、`regulatory_usd`、`realized_usd`、`risk_usd`。任何一笔找不回或不一致 → RECON_D 不过。
- 不受影响：IDENTITY（全精度：对数 ≤ 1e-12，USD ≤ 1e-6）；IS_RECON 的 RECON_D 对照 R2 重放的全精度账本（≤ 1e-6，不取整）。

## 2. OOS 日区间数：956，不是 955

- 事实：当前 D 的 OOS 账本以 2022-12-30 收盘的 3,000 起算（`start_capital` 3,000），956 个 session 各有一个日区间，共 956 个；Q0–Q5 的 g 也是 252 × 956 个日对数差的均值（Q5 OOS 统计行 g −0.086168）。原文写的 955 少数了一个。
- 读法：年化 g_块 = 252 / 日区间数 × Σ k_t·块_t，按原文的定义「日区间数」取 956（IS 取 756）。SE 用 252 × mean(y) 的 bootstrap，同一尺度。
- 原文的 252 / 955 并列报告（`g_k2_955`），§6 准入在两种尺度下都给出；两者只差 0.1%，若判定因此不同，照报，以 956 为主。

## 3. 输入说明的笔误

- 原文「Q4 signals_q4 即 SCAN_MAIN_NOCD 信号」：Q5 记录里 `signals_q4` 是 SCAN_PHASE_NOCD 一组；SCAN_MAIN_NOCD 在缓存的 `signals_q0r` 里（Q5 `inputs.signals`）。IS 重放两组都载入，逐文件 sha256 分别等于 Q5 `inputs.signals` 与 `inputs.signals_q4`。对结果没有影响。
