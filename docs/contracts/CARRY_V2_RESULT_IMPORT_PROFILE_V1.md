# CARRY_V2_RESULT_V1 · QRP 导入档案（资金费基差套利 Carry V2，封存研究结论）· DRAFT

状态：**DRAFT，未冻结，不得实现，不得导入。** 起草：Carry V2 接入执行会话，2026-11-03（K2 §8.2 R-PROFILE ★a）。冻结：协调会话（冻结后只能另出协调说明或增补）。导入由协调会话执行。
Production effect：`NONE`。本文不改任何研究结果、判据、证据、前向设置、影子 worker、生产参数；不写 `config/strategy_profiles.v1.json`，不写台账。
依据：smartflow `research/carry-v2-qrp-onboarding-k2` @ `82753e30` 的 `trading-system-v2/docs/CARRY_V2_QRP_ONBOARDING_K2_DRAFT_V1.md`（`319a055d…`），协调会话 `CARRY_V2_QRP_ONBOARDING_K2_FREEZE_1.md`（全部读法按推荐）。
QRP 基线：`origin/main` `1cf2544`。这不是 Q0 档案：不套 `CRYPTO_Q0_RESULT_V1` 的字段（每笔 R、主数字行、半凯利、普查列对 carry 都不适用，K2 §8.2 (b)）。

## 0. 结论先行

- 导入的是**封存的研究结论**，原样：`CRYPTO_FUNDING_BASIS_CARRY_V2` 判定 **INSUFFICIENT → 前向验证 form (a)**，首次查看 2027-12-31。不是新结果，不重新评价（K2 R-BASE）。
- 身份：`strategy_ref = CARRY_V2_SHADOW_10000USDT`，case `RRC-CARRY-V2-10000USDT-V8-1-M0`；结论只取 form (a)（K2 R-ID ★a）。form (b) 纸面影子标 `PAPER_SHADOW · NO_CAPITAL · NO_VERDICT`，不进 `OVERSEAS_BUCKET_16000USD`，不进任何资金合计。
- 新增一类只读锁「**封存研究结论锁**」（`SEALED_RESEARCH_RESULT_LOCK_V1`），按 sha256 绑定 §1 的全部文件；任何一个文件对不上，拒绝导入。
- 导入前提：A0 回执全部 `BYTE_IDENTICAL`、M1 清单全部通过（K2 §7「做」的条件）。前提不成立时页面保持 A4.4 第 2 条「已列入 M4 范围，尚未接入」。

## 1. 封存研究结论锁绑定的文件

smartflow 文件以钉版 `8d97cbde` 的路径（相对 `trading-system-v2/`）与 sha256 为准；接入回执在 smartflow 研究分支 `research/carry-v2-qrp-onboarding-run` 的 `trading-system-v2/docs/evidence/carry-qrp-v1/`，sha256 在冻结时由协调会话从该分支核对后填入本表（本草稿只写位置）。

| 角色 | 文件 | sha256 |
|---|---|---|
| 判定 | `docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_VERDICT.json` | `25123e19d3f89c424c2bea8e4e87677d2d14c2ba18a0c109db53d3372ea847ac` |
| W1 / W2 / FULL | `docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_{W1,W2,FULL}.json` | `4a6de1e2…` / `ee8cc51e…` / `326a14a4…`（全值见 M1-1 回执） |
| 数据与闸门 | `docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_DATA.json` | `71a76b2b…` |
| 测试 | `docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_TESTS.json` | `fa7ecdcf…` |
| 前向设置 (a) | `docs/evidence/CRYPTO_FUNDING_BASIS_CARRY_V2_FORWARD_SETUP.json` | `6be89f25…` |
| 结果页 | `docs/CRYPTO_FUNDING_BASIS_CARRY_RESEARCH_RESULT_V2.md` | `a43ecd5e…` |
| V1 历史 | V1 的 DATA、DATA_A1、IS_RUN1、IS、OOS、TESTS、VERDICT、FUNDING_REGIME 与 RESULT V1 | 见 M1-1 回执 |
| A0 回执 | `carry-qrp-v1/` 下 A0-2 … A0-5 回执 | 冻结时填入 |
| M1 清单 | `carry-qrp-v1/` 下 M1 回执（两遍） | 冻结时填入 |
| K2 及冻结 | `CARRY_V2_QRP_ONBOARDING_K2_DRAFT_V1.md` / `CARRY_V2_QRP_ONBOARDING_K2_FREEZE_1.md` | `319a055d…` / 冻结时填入 |

全值的权威是 M1 回执的 `M1_1.rows[].sha256`（每个文件同时与 K2、RESULT V1/V2、证据字段、影子清单里的记录值比过）。

## 2. 档案项（冻结后由实现会话写进 `config/strategy_profiles.v1.json`；本草稿不写）

```json
{
 "strategy_ref": "CARRY_V2_SHADOW_10000USDT",
 "case_ref": "RRC-CARRY-V2-10000USDT-V8-1-M0",
 "market": "CRYPTO",
 "currency": "USDT",
 "display_name": "资金费率套利 Carry V2",
 "notional": { "value": 10000, "currency": "USDT", "capital_state": "NO_CAPITAL" },
 "baseline_result_schema": "CARRY_V2_SEALED_RESULT_V1",
 "import_profile_id": "docs/contracts/CARRY_V2_RESULT_IMPORT_PROFILE_V1.md",
 "half_kelly": { "mode": "NOT_APPLICABLE", "reason_zh": "封存结论没有每笔风险单位，接入不新增指标" },
 "forward": { "a": { "f_start": "2026-10-02T16:00:00Z", "first_look": "2027-12-31", "last_look": "2030-09-30" }, "b": { "label": "PAPER_SHADOW · NO_CAPITAL · NO_VERDICT" } },
 "comparators": [{ "key": "DTB3", "label_zh": "3 个月美债（DTB3），δ = +1.0 点，事先登记", "role": "BENCHMARK" }]
}
```

## 3. 页面（导入档案冻结并实现之后）

1. **结论句**：「证据不足（历史，已看数据）→ 前向验证，首次查看 2027-12-31」。V1 FAIL 作为历史行（「V1 不通过（P1、P5），按 V1 §9.3 存档」），不改名。
2. **数字**只取 VERDICT 的 `table`，每个都标「已看数据」：W2 决定窗年化、DTB3 年化、X、90% CI。没有别的数字来源。
3. **半凯利**：`NOT_APPLICABLE`（§2）。
4. **复现**：显示 A0 回执的结论行「QRP 作业 70 / 70、5 / 5 个窗口 resultsSha256、判定对象逐字节相同」及回执 sha256。
5. **前向**：只有日历和计数——(a) F-start、下次查看日、已满的前向月数、「未到查看日」；(b) F-start(b)、M1-4 的计数（按类型行数、MISSING / MISSING_FINAL 按种类、HALT 状态）。两次查看之间不显示 X、CI 和 (a)/(b) 对比。
6. **复用标记**（K2 §6.2，导入记录与页面都要有）：`oos_reuse: true`；`seen_data: "§B3: 2020-01 → 2026-09 全部已看"`；`data_uses`：V1 IS、V1 OOS、FUNDING_REGIME 事后表、V2 W1 / W2 / FULL、QRP #48 作业、接入 A0（后两项只是复现）。段标记：V1 IS / OOS `HISTORY_V1`，W1 `SEEN_DATA`，W2 `SEEN_DATA_DECISION`，FULL `REPORT_ONLY`，前向 (a) `FORWARD_OOS`，前向 (b) `FORWARD_EXECUTION_NO_VERDICT`。
7. **回放内核双跑**（K2 R-DUAL）：只并列显示状态，不读其输出，不作接入前提。

## 4. 导入失败关闭（负向测试，实现时逐条写成测试）

1. A0 回执不是全部 `BYTE_IDENTICAL`（A0-2 … A0-5 任一项不过）→ 拒绝导入。
2. 导入载荷含任何前向数值字段（权益、余额、收益、年化、X、CI、资金费或利息金额）→ 拒绝导入；(a) 第 1 次查看的证据封存、并经另一份导入增补之前一直如此。
3. §1 任一文件 sha256 不符 → 拒绝导入。
4. 其他四条策略（US_V5、QUICK_SHOT_V3、C17_V2、US_CORE）的页面与 API 输出逐字节不变（金样测试）。
5. M1 回执里出现前向数值键（M1 自己的 `FORWARD_VALUE_LEAK` 自查之外再查一次）→ 拒绝导入。

## 5. 不由本档案裁定

- M2 / M3 怎么记（封存结论加 A0 回执能否当 M2 的「锁定结果与结果重读证据」；M3 的 Desk → Research → Desk 往返找哪个问题）：K2 §8.1 留给本档案，本草稿**不裁定**，列为冻结时的待选项：
  - ★(a) 本档案只记 M0、M1；M2 / M3 另立题，前向首查（2027-12-31）之后再定；
  - (b) 封存结论 + A0 回执记作 M2 的锁定结果，M3 待定。
- 允许用途（K2 §7「做」）：登记档案与 case；记 M0 / M1；导入封存结论；页面展示；以后 carry 研究的基线引用。**不是**生产采用，不开簿，不给资金，不改 (a) 或 (b)，不提前查看。

## 6. 导入由谁执行

协调会话。冻结后先在台账的**临时副本**上试导入（`QRP_DATA_DIR` 指向副本），回执逐字节核对后再写真实台账。
