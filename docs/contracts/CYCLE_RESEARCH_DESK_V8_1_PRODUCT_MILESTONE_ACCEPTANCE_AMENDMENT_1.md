# Cycle × Research × Desk：V8.1 产品里程碑验收修订 1

状态：FROZEN  
冻结日期：2026-10-24  
修订原因：`DEFECT-V8.1-PRODUCT-MILESTONE-DOWNSTREAM-RESURRECTION`  
原验收：`docs/contracts/CYCLE_RESEARCH_DESK_V8_1_PRODUCT_MILESTONE_ACCEPTANCE_V1.md`  
原验收 SHA-256：`32682ab08a03c168b1cb3648bd72133682785f573076b22ae026b1fabc1f717e`

本修订不重写原冻结验收，只补充 P5 撤销后的再验收语义。缺陷在目标发布和任何真实产品阶段 PASS 之前发现，
所以不撤销真实用户证据或发布；原冻结验收的 M0–M3 仍全部 `NOT_VERIFIED`。

## A1. 逃逸场景

若 M1 已 PASS，M2/M3 随后 PASS；之后 M1 被 REVOKED，再以新证据重新 PASS，仅读取每阶段最后一条记录会
让旧 M2/M3 自动恢复有效。旧下游证据只验证过旧 M1，不能证明新 M1 下的产品任务仍成立。

## A2. 冻结补充验收

1. M1–M3 的每条 PASS 必须保存记录时直接上游的当前有效 `evidence_id`。
2. 读模型只有在该引用等于直接上游当前有效证据时，才允许阶段为
   `CONTROLLED_VERIFIED` 或 `TARGET_DELIVERED`。
3. 上游 REVOKED 后，下游为 `INVALIDATED_BY_UPSTREAM`；上游用新证据重新 PASS 时，旧下游 PASS
   仍保持 `INVALIDATED_BY_UPSTREAM`，直到各下游按顺序重新验收。
4. 修订只影响产品证据裁决，不改变运行、研究、Desk 采用、发布、交易或资金权限。

## A3. 确定性证据

- 测试必须覆盖 M0→M3 PASS、M1 REVOKED、M1 新 evidence 再 PASS 的完整序列。
- 最终 M1 为有效，旧 M2/M3 仍须为 `INVALIDATED_BY_UPSTREAM`。
- 所有里程碑证据必须同时绑定原验收与本修订引用。
