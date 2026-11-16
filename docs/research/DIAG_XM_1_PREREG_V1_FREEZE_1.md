# DIAG-XM-1 预登记 V1 · 冻结记录 1

- 冻结时刻（k2_frozen_at）：2026-11-16T23:42:05+08:00
- 冻结对象：`docs/research/DIAG_XM_1_PREREG_V1.md`，sha256 `3e41d91e605a699083b45e9e542b5c469feec921f7283e9be3799300d49fbb70`（首次提交 167f30be，此后未改）。
- 冻结人：海外研究会话，按协调会话 DIAG-XM-1 任务（诊断，只报；Owner 2026-11-16 23:20 CST 同意）。没有 ★ 待裁。
- 试验台账：21 行 PREREGISTERED，study_ref DIAG-XM-1，k2_sha256 = 上面的 sha256，登记于 2026-11-16T15:41:49Z（台账 855 → 876 行），早于本冻结、早于首次计算。
  - specs.json sha256 `7263a4a6f13caefd570690fe3639654aad4486827a4ca6add1c7a7027f57449d`，登记输出 registered.jsonl sha256 `ae5bc843c38c8ab2a34cb7addd411a343d1b8d536e2bd6a15fea4df5d413a838`。
  - 登记前备份：`research-data/diag_xm_1_v1/ledger-backup-20261116T1541Z-xm1-prereg/`（含 SHA256SUMS）。
- 成本门（COST_MODEL_GATE_V1 @805d35a0，EFFECTIVE_FROM 2026-11-17T00:00:00+08:00）：本冻结早于生效时刻；21 行都是 REPRO / DIAGNOSTIC_ARM，本来也不在门内。运行日志仍照 11-17 起的写法带 trial_id 与 verdict_metric_kind = NET_RETURN_SERIES。
- 首次计算在本记录提交之后。
