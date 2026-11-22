# RF1116 · G-MINE 门槛 v2 · FREEZE_2 · FROZEN

状态：**FROZEN。** 冻结时刻 2026-11-22T13:08:01+08:00（读钟），由方案推进会话 plan-coord 签发（接替协调会话的研究冻结职责，交接 76686f61 §1）。草稿 `RF1116_GMINE_THRESHOLDS_FREEZE_2.draft.md` sha256 53278367b6606db1a1fc582a4f1f77037d263eb6d1939f0216f1b399f81270ec（只读副本 `.draft.53278367.md`）；除标题与本行外与草稿逐字相同。冻结前核对：七个数与 QRP `config/mining_gate_thresholds.v2.json` 在 PR #133 head c5cc3d3 上逐个相同（该文件 sha256 fb8f60aa…），与依据 1aaf43e0 §1 ★S2 (a) 一致。起草：2026-11-22T12:41:45+08:00（读钟），AQuA 会话（实现会话代起草）。
- **依据：** 修订「评分的市值中性化 V2」FREEZE_1（sha256 `1aaf43e0ce0d04b28bbdbd3dcb72788efe54bad2c3eeab988f9908f94521cccb`）§1 ★S2 (a)：第 8 项加市值暴露检查，上限 0.10。正文 `RF1116_AMENDMENT_SIZE_NEUTRALIZATION_20261118.draft.md`（f67701e9）§1 N3、N4。
- **门槛文件：** QRP 的 `config/mining_gate_thresholds.v2.json`（`MINING_GATE_THRESHOLDS_V2`），随实现 PR 一起提交，冻结前 `state = PENDING_FREEZE`、`frozen_ref = null`。冻结后由一个小 PR 把本页字节一致的副本放进 `docs/freeze/RF1116_GMINE_THRESHOLDS_FREEZE_2.md`，文件里写 `state = FROZEN` 与 `frozen_ref`（与 v1 同一做法）。

## 1. 冻结的是什么

- **适用：** 中性化版本 `RANK_GAUSS_V2` 的轮（轮次清单 `scoring_neutralization`）。第 1、2 轮（`LINEAR_RAW_V1`）读 v1 文件与 FREEZE_1，不变（v1 文件 sha256 `f8c495a942f04a440d780c6d85cb1235f9c0ec073fbcb3fd415c2ec4b5cf5343`，字节不动）。
- **七个数：** 前六个与 FREEZE_1 逐个相同，加一个新的。

| 键 | 值 | 项 |
|---|---|---|
| `ic_mean_min` | 0.02 | 3：留出段平均 rank IC（中性化之后） |
| `icir_min` | 0.3 | 3：ICIR，按不重叠持有期 |
| `monotonicity_min` | 0.9 | 4：五分组 Spearman |
| `decay_ratio_min` | 0.5 | 5：持有期加倍时 IC 不低于原 IC 的一半 |
| `marginal_intercept_t_min` | 2 | 7：对库内 `LIVE_IN_RULE` 因子收益回归的截距 t |
| `marginal_ir_delta_min` | 0 | 7：加入后组合 IR 不降 |
| `size_exposure_abs_max` | 0.10 | 8：留出段市值暴露的绝对值上限（★S2 (a)） |

## 2. 第 8 项的市值暴露检查怎么判

- **读数：** 每个留出段结果带 `size_exposure { statistic: MEAN_DAILY_SPEARMAN_VS_LOG_TOTAL_MV, value, days, neutralization_version }`：留出段各打分日里，中性化后的因子值（与算 IC 的同一份、同一批名字）与 log(`total_mv`) 的 Spearman，再取均值。
- **判定：** |value| > 0.10 → `MINE_SIZE_EXPOSURE_ABOVE_MAX`；值缺失、非有限、`days` 少于 `MIN_IC_DAYS`（20）、统计量或版本对不上、门槛块里没有这个数 → `MINE_SIZE_EXPOSURE_UNKNOWN`（失败即关）。
- **第 1、2 轮的结果：** 照实带读数，不判，`detail.size_exposure_check = NOT_APPLICABLE_ROUND_FROZEN_V1`。

## 3. 必须写明的取舍（FREEZE_1 §1 ★S2）

- **这一项拦不住纯市值替身。** 0.10 只管拦 V1 那种大泄漏（暴露 0.48–0.82）。在 V2(a) 下，纯市值替身（原始总市值、后复权价位、成交额取负）的暴露只有 0.067–0.074（车道真实数据，验证段 668 天，镜像 d99fac50），低于 0.10，**这一项自己放它们过去**。
- **由第 3 项拦：** 这些替身在 V2 下的 IC 落到约 0（−0.006、−0.009），低于 `ic_mean_min` 0.02，被第 3 项（IC ≥ 0.02）拒。两道门叠着防，谁也不单独承担。
- **为什么不把这一项收紧：** 单靠这一项拦替身，门槛得卡在 0.048 与 0.067 之间（例如 0.06），两边余量都太薄，留出段只有几十天，估计的噪声会让它误杀与漏放都发生。
- **后果：** 一个因子要是暴露在 0.10 以下、IC ≥ 0.02，这一项不会再拦它；它仍要过其余八项。

## 4. 冻结之后

- V2 的轮的逐候选 G-MINE 记录读 v2 文件：冻结之前一律 `pass: false`（`MINE_THRESHOLDS_UNFROZEN`），所以第 3 轮要等本页冻结。
- 改任何一个数都要新的冻结页（FREEZE_3）和新的 PR；已写的记录不改（记录里有门槛文件的 sha256 与用到的数）。
