# Cycle × Research × Desk V8.1：US_V5 首案说明的负责人确认（M0，2026-10-25）

证据类型：`USER_TASK`（用户 S 阅读首案说明并确认）
case：`RRC-US-V5-3000-V8-1-M0`
记录人：V8.1 协调会话（completion authority `V8_1_COORDINATOR`）
Production effect：`NONE`

## 用户 S 阅读的首案说明（协调会话报告第 2 节，原文）

- 策略：US_V5_ETF_3000USD，PAPER，`realOrder=0`。
- 版本：生产 smartflow `2382c2d1`。旧的 6000 簿冻结为前身，不回填到当前簿。
- 历史范围：NYSE 2026-10-08 至 10-23，共 12 个 session。
- 已有研究：原研究槽里没有 US_V5 的已选问题。Desk 现有的美股候选（RLC-US-2026W41-1）属于 US_CORE，Owner 的决定是 LATER。
- 阻断和责任方：
  - 样本 12 个 session，最低要求 20 个；第 20 个 session 是 11-04。之后重新导出（工程执行者）。
  - 没有真实账户这一组对照（全部是 PAPER）。
  - 监管费是研究用的模型，不是券商账单。
  - M2 还没有确定要研究的问题，由 Owner 定。
- M1 使用路径：本机 `http://127.0.0.1:4311/#strategy-detail?strategy=US_V5_ETF_3000USD&section=health`
- C17：作为备选，本轮不切换。原因是 C17 的净收益修复验收还没关，QRP 里也还没有 C17 的封存证据包。

## 用户 S 的确认

- 时点：2026-10-25T12:4x+08:00（协调会话内，Owner 本人）
- 原话：「确认首案说明」

## 用户 S 的补充（同一时段，原话）

「记住目前所有真实环境都指"纸面交易" 即使用真实市场行情的paper trading」

由此更正首案说明的一条阻断：「没有真实账户这一组对照（全部是 PAPER）」不再是阻断。用真实行情运行的 PAPER 账本 `US_V5_ETF_3000USD`，就是本案的真实账户和真实运行环境。研究结论的不足只剩样本 12 个 session、少于 20 个这一项。

## 准备证据

- T01 / K1–K4 映射：`docs/evidence/CYCLE_RESEARCH_DESK_V8_1_T01_M0_2026-10-24.md`
- T01 中「扫描记录缺失」一项的来源更正：`docs/evidence/CYCLE_RESEARCH_DESK_US_V5_M1_IMPLEMENTATION_RECEIPT_2026-10-24.md`（实际运行与来源核对一节）
- 协调会话核对：`docs/evidence/CYCLE_RESEARCH_DESK_V8_1_COORDINATOR_ROUND1_CHECK_2026-10-25.md`

## 裁决边界

M0 带阻断通过。上述阻断未解决前，不据此声称 M1 已就绪；M1 仍要求 Owner 在实际入口完成 A2.6 的整条任务。
