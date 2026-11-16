# G_PARITY_V1 · G-PARITY 研究与实盘一致门（导入）

- 依据：研究与实盘一致性合同 `RESEARCH_LIVE_PARITY_V1`，Owner 2026-11-17 00:23 CST 签字，全部 ★ 取默认。
  - 签的文本 `artifacts/coordinator/RESEARCH_LIVE_PARITY_V1.signed.ceb35505.md`（sha256 `ceb35505…`）；
  - 签字页 `artifacts/coordinator/RESEARCH_LIVE_PARITY_V1_SIGNATURE_1.md`（sha256 `f0fe8e5c…`）；
  - 本门实现 §1 第 2 条（K2「数据输入」）、§2（`AI_LOGIC_PIN_V1`）、§3（G-PARITY）、★3 (a)（只管以后）、★5 (a)（QRP 钉 KG 登记表）。
- 生效：`EFFECTIVE_FROM = 2026-11-17T00:24:00+08:00`，签字页写出的唯一常量，在 `services/research-live-parity-v1`（签字页与签的文本按路径和 sha256 绑定，做法同 `services/research-framework-amendment-20261112-addendum-1`）。此刻及之后冻结的 K2 过门；此前冻结的不追溯，已封存的结论不重判。
- 性质：只改研究导入，不改生产数据源、生产 AI 调用、交易或风控规则。门只会拒绝导入（失败即关，错误码 `PARITY_*`），从不改写结论。
- 位置：海外与 A 股封存结论导入器共用的 `checkEntry`，一处调用，在 G-TRIAL、G-MECH、G-CAUSAL、G-COST 之后。过门的题锁里多一个 `parity_gate` 块；不过门的不加字段，现有锁逐字节不变。

## 1. QRP 钉住 KG 数据集登记表（★5 (a)）

- `config/dataset-registry/`：KG（`wendy926/knowledge-graph`）提交 `12afd2fc` 的 `data/registry/datasets.v1.json`（sha256 `d8a17a3e…`，版本 1.11.0，24 个数据集）与 `scripts/registry/dataset-registry-scan.cjs`（`461611f5…`）原样副本，`PIN.json` 写提交、两份 sha256、`registry_version`，以及生产两端的钉版（Ashare-V6 `83ab3af1` 的 `test/fixtures/dataset-registry/PIN.json`、smartflow `3b25fb61` 的 `trading-system-v2/tests/fixtures/dataset-registry/PIN.json`，同一个提交、同一组 sha256）。
- `services/dataset-registry` 的 `pinned()` 每次读都复验字节：漂移 → `DATASET_REGISTRY_PIN_DRIFT`，缺文件 → `DATASET_REGISTRY_FILE_MISSING`，登记表版本与 PIN 不符 → `DATASET_REGISTRY_VERSION_MISMATCH`。G-PARITY 以它为「生产的 PIN」。
- 守卫测试 `tests/dataset_registry_guard.test.js`（`DRQ-*`，同 smartflow 的 `DRS-*`）：DRQ-0 钉版与 sha256；DRQ-1 登记表有效；DRQ-2 QRP 还不是登记表里的系统（KG 消费方登记的 PR 合并、重钉之后改为扫描 QRP 仓库）；DRQ-3 副本漂移即拒。
- 重钉：从 KG 新提交拷两个文件，改 `PIN.json` 的 `commit`、两份 sha256、`registry_version` 与 `production_pins`。

## 2. K2 §0「数据输入」一行（§1 第 2 条）

K2 §0 在 RF1112 §5 的四行之后加一行，每个数据集一个记号，写法同 G-CAUSAL 的 `` `CF:…` ``（门从 K2 全文抽出这些记号）：

```
**数据输入**：`DATA:<登记表 id>@<登记表版本>#<登记表 sha256>|PIT=<PIT 语义>|VENDOR=<供应方>`；`DATA:…`
```

例：`` `DATA:V6_CSI300_INDEX_DAILY@1.11.0#d8a17a3ee6e23e59494176eb818d7dc46fde382da032878eeb729af0855ba687|PIT=BAR_CLOSE|VENDOR=Tushare` ``。

- **选 K2 正文，不选 `entry.data_inputs`：** K2 由协调会话冻结、按 sha256 绑定，是研究判定的冻结来源；登记表字段由导入规格写，不在冻结的文本里。
- PIT 语义的枚举：`OBSERVED_AT`、`ANNOUNCEMENT_NEXT_OPEN`、`ACCEPTANCE_TIME`、`BAR_CLOSE`、`NEXT_OPEN_SESSION_CLOSE`。新的语义只能先进登记表（登记表级字段 `pitSemantics` 的清单），门才认。
- 供应方写原名（Tushare、Yahoo、Alpaca、SEC EDGAR、东财、Binance 等）；登记表还没有供应方字段，门只记不核。

## 3. `AI_LOGIC_PIN_V1`（§2）

```json
{ "schema": "AI_LOGIC_PIN_V1", "provider": "…", "model": "…", "model_version": "…",
  "prompt_sha256": "<64 位>", "code_sha256": "<64 位>", "output_schema_version": "…", "call_params": { "json_mode": true, "thinking": false } }
```

- `prompt_sha256`、`code_sha256` 至少写一个；写了的必须是 64 位 sha256。
- `ai_inputs`（RF1112 §2.4，G-MECH 照旧核类别与 K2 第 4 行）的每一项加两个字段：
  - `ai_logic_pin`：研究用的钉值；
  - `production_archive`：`{ ref, sha256, ai_logic_pin }`，实盘存档输出及其钉值。研究要么读这份存档，要么用一模一样的钉值重新调用（§2 第 3 条）。

## 4. 门

**过门的题**：封存导入 `RESULT` / `READING`，`k2_frozen_at ≥ EFFECTIVE_FROM`。封存日期在生效日（CST）及以后却没写 `k2_frozen_at` → `PARITY_K2_FROZEN_AT_MISSING`。

| 拒绝 | 条件 |
|---|---|
| `PARITY_DATA_INPUTS_MISSING` | K2 一个 `DATA:` 都没有 |
| `PARITY_DATA_INPUT_INVALID` | `DATA:` 写法不对，或同一数据集写了两次 |
| `PARITY_DATASET_UNREGISTERED` | 数据集不在 QRP 钉住的 KG 登记表里 |
| `PARITY_PIN_MISMATCH` | 写的登记表版本或 sha256 与 QRP 钉的不同（QRP 钉的 = 生产两端钉的） |
| `PARITY_PIT_SEMANTICS_MISMATCH` | PIT 语义不在枚举里、也不是登记表登记过的新语义；或登记表的数据集写了 `pitSemantics` 而与它不同 |
| `PARITY_AI_LOGIC_MISMATCH` | AI 输入没带或带了不完整的 `AI_LOGIC_PIN_V1`；没有 `production_archive` 可核；与存档的钉值不同 |

- **PIT 语义的核对待登记表字段：** KG 登记表 1.11.0 的数据集还没有 PIT 语义字段。数据集写了 `pitSemantics` 时门按它核（`pit_check: CHECKED`）；还没写时只核枚举，记 `pit_check: PENDING_REGISTRY_FIELD`。字段名 `pitSemantics` 是本合同的假设，KG 加字段时如用别的名字，改一处常量（`REGISTRY_PIT_FIELD`、`REGISTRY_PIT_LIST_FIELD`）。
- 锁里记：`parity_gate{ applies, state: PASS, effective_from, signature{path, sha256}, registry{commit, registry_version, registry_sha256}, data_inputs[{dataset_id, registry_version, registry_sha256, pit_semantics, vendor, pit_check}], ai_inputs[{ref, archive_ref, archive_sha256, ai_logic_pin_sha256}] }`。

**不过门的题**：照原样导入，锁行不加字段。现行海外与 A 股登记表的每一题都在生效之前冻结或封存，没有一题过门。

## 5. 范围之外与已知限制

- 存档输出本身（`production_archive.ref` 指的文件）不按字节复验，只核写出的 sha256 格式与钉值；绑定存档字节要另加导入规格的绑定文件角色。
- 「研究与实盘读同一个生产者」（§1 第 1 条）靠登记表的所有者与消费方登记；QRP 登记为消费方的 KG PR 合并、重钉之后，DRQ-2 扫描 QRP 仓库。
- 价格序列是价格还是全收益、是否复权（§1 第 4 条）：登记表还没有这类字段，本门不核。
