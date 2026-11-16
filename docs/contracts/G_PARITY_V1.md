# G_PARITY_V1 · G-PARITY 研究与实盘一致门（导入）

- 依据：研究与实盘一致性合同 `RESEARCH_LIVE_PARITY_V1`，Owner 2026-11-17 00:23 CST 签字，全部 ★ 取默认。
  - 签的文本 `artifacts/coordinator/RESEARCH_LIVE_PARITY_V1.signed.ceb35505.md`（sha256 `ceb35505…`）；
  - 签字页 `artifacts/coordinator/RESEARCH_LIVE_PARITY_V1_SIGNATURE_1.md`（sha256 `f0fe8e5c…`）；
  - 本门实现 §1 第 2 条（K2「数据输入」）、§2（`AI_LOGIC_PIN_V1`）、§3（G-PARITY）、★3 (a)（只管以后）、★5 (a)（QRP 钉 KG 登记表）。
- 生效：`EFFECTIVE_FROM = 2026-11-17T00:24:00+08:00`，签字页写出的唯一常量，在 `services/research-live-parity-v1`（签字页与签的文本按路径和 sha256 绑定，做法同 `services/research-framework-amendment-20261112-addendum-1`）。此刻及之后冻结的 K2 过门；此前冻结的不追溯，已封存的结论不重判。
- 性质：只改研究导入，不改生产数据源、生产 AI 调用、交易或风控规则。门只会拒绝导入（失败即关，错误码 `PARITY_*`），从不改写结论。
- 位置：海外与 A 股封存结论导入器共用的 `checkEntry`，一处调用，在 G-TRIAL、G-MECH、G-CAUSAL、G-COST 之后。过门的题锁里多一个 `parity_gate` 块；不过门的不加字段，现有锁逐字节不变。

## 1. QRP 钉住 KG 数据集登记表（★5 (a)）

- `config/dataset-registry/`：KG（`wendy926/knowledge-graph`）提交 `322ff69b`（KG #368 的分支头；合并提交 993e713a 字节相同，PIN 跟生产钉同一个提交）的 `data/registry/datasets.v1.json`（sha256 `1e32a26c…`，版本 1.13.0，35 个数据集）与 `scripts/registry/dataset-registry-scan.cjs`（`461611f5…`）原样副本，`PIN.json` 写提交、两份 sha256、`registry_version`，以及生产两端的钉版（smartflow `2e958543` 的 `trading-system-v2/tests/fixtures/dataset-registry/PIN.json`，同一个提交、同一组 sha256；Ashare-V6 仍记 `83ab3af1` 的 `test/fixtures/dataset-registry/PIN.json`（1.11.0），V6 #119 合并后改成它的合并提交）。此前钉的是 `12afd2fc`（1.11.0，`d8a17a3e…`，24 个数据集），留在历史里。
- `services/dataset-registry` 的 `pinned()` 每次读都复验字节：漂移 → `DATASET_REGISTRY_PIN_DRIFT`，缺文件 → `DATASET_REGISTRY_FILE_MISSING`，登记表版本与 PIN 不符 → `DATASET_REGISTRY_VERSION_MISMATCH`。G-PARITY 以它为「生产的 PIN」。
- 守卫测试 `tests/dataset_registry_guard.test.js`（`DRQ-*`，同 smartflow 的 `DRS-*`）：DRQ-0 钉版与 sha256；DRQ-1 登记表有效；DRQ-2 扫描 QRP 仓库（1.13.0 起 QRP 是登记表里的系统，有扫描根；同 smartflow 的 DRS-2，结果必须为空）；DRQ-3 副本漂移即拒。
- 重钉：`tools/dataset-registry-repin/repin.js --kg-root <KG 仓库> --commit <KG 提交> [--production-pin <仓库>=<提交>:<路径>]…`。从 KG 提交拷两个文件、改 `PIN.json`；换下来的那一份原样留进历史，新的那一份也记进历史。生产两端的钉版没给就照旧，并提醒。写入顺序（协调会话 2026-11-17 02:0x）：先读齐不写；新的一份进历史（文件、再 HISTORY.json 一条）→ 核对换下来的那份在历史里 → 两个现行文件 → 最后 `PIN.json`；每个文件先写临时文件再改名。写到现行文件一半时崩掉，读登记表失败即关（PIN 漂移），同一提交再跑一次补完。
- **历史**（协调会话 2026-11-17 01:2x 裁定）：每一份钉过的登记表都按 sha 留在 `config/dataset-registry/history/<版本>-<sha 前 8 位>/`（`datasets.v1.json` 与扫描器），`history/HISTORY.json`（`DATASET_REGISTRY_HISTORY_V1`）列出版本、KG 提交与两份 sha256（扫描器的 sha256 每条必填，缺了读历史即拒）。从 1.11.0 起，历史总包含现在钉的这一份。`services/dataset-registry` 的 `history()` 逐个文件复验，漂移或缺 `HISTORY.json` 即失败即关（DRQ-4）。历史里的条目只加不改、不删。

## 2. K2 §0「数据输入」一行（§1 第 2 条）

K2 §0 在 RF1112 §5 的四行之后加一行，每个数据集一个记号，写法同 G-CAUSAL 的 `` `CF:…` ``（门从 K2 全文抽出这些记号）：

```
**数据输入**：`DATA:<登记表 id>@<登记表版本>#<登记表 sha256>|PIT=<PIT 语义>|VENDOR=<供应方>[|BASIS=<PRICE|TOTAL_RETURN>/<RAW|SPLIT_ADJ|FULL_ADJ>]`；`DATA:…`
```

- 记号里 `|键=值` 的键只有 `PIT`（必填）、`VENDOR`（必填）、`BASIS`（可选），每个键写一次，顺序不限；值不能含 `|` 与反引号。
- `BASIS` 的两段取登记表的 `priceBasisVocabulary`（KG 1.13.0 是对象，`format` 写两组可选值）；登记表没有这项时用默认两组 `PRICE|TOTAL_RETURN` 与 `RAW|SPLIT_ADJ|FULL_ADJ`。写法不合 → `PARITY_DATA_INPUT_INVALID`。
- **冻结附注 `k2_notes`：** K2 冻结在 `DATA:` 写法之前的（例如 R_US_ENTRY_TOUCH_1_K2_V1），记号写在协调会话的冻结附注里，题的登记写 `k2_notes: [{ source, path, sha256, ref }]`（同别的绑定文件，角色 `K2_NOTE`，暂存与锁的 `refs` 都带上）。导入器按 sha256 复验（`readBound`，同 K2）后，把附注字节按列出的顺序交给门；门把 K2 与附注里的记号取并集。同一数据集在不同文件里写得不一样 → `PARITY_DATA_INPUTS_CONFLICT`；列了附注却没读到 → `PARITY_K2_NOTES_UNREAD`。没有 `k2_notes` 的题照旧，锁里不带附注。

例：`` `DATA:V6_CSI300_INDEX_DAILY@1.11.0#d8a17a3ee6e23e59494176eb818d7dc46fde382da032878eeb729af0855ba687|PIT=BAR_CLOSE|VENDOR=Tushare` ``。

- **选 K2 正文，不选 `entry.data_inputs`：** K2 由协调会话冻结、按 sha256 绑定，是研究判定的冻结来源；登记表字段由导入规格写，不在冻结的文本里。
- PIT 语义的枚举：`OBSERVED_AT`、`ANNOUNCEMENT_NEXT_OPEN`、`ACCEPTANCE_TIME`、`BAR_CLOSE`、`NEXT_OPEN_SESSION_CLOSE`。新的语义只能先进登记表（登记表级字段 `pitSemantics` 的清单），门才认。
- 供应方写登记表 `vendor` 里的原名（Tushare、Yahoo、Alpaca、SEC EDGAR、东财、Binance 等），逐字对上；登记表没写供应方时门只记不核。

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
| `PARITY_PIN_MISMATCH` | 写的登记表版本或 sha256 不是 QRP 现在钉的（= 生产两端钉的），而且：不在历史里（`VERSION_NOT_IN_HISTORY`）；或这个数据集在那一版里没有（`DATASET_NOT_IN_PINNED_VERSION`）；或它的一致性字段从那一版到现在变了（`DATASET_CHANGED:<字段,…>`） |
| `PARITY_DATA_INPUTS_CONFLICT` | 同一数据集在 K2 与冻结附注（或两份附注）里写得不一样 |
| `PARITY_K2_NOTES_UNREAD` | 登记了 `k2_notes`，门却没读到附注字节 |
| `PARITY_PIT_SEMANTICS_MISMATCH` | PIT 语义不在枚举里、也不是登记表登记过的新语义；或登记表的数据集写了 `pitSemantics`（字符串或列表）而记号不是其中之一 |
| `PARITY_PRICE_BASIS_MISSING` | 登记表的数据集写了 `priceBasis`，记号没带 `BASIS` |
| `PARITY_PRICE_BASIS_MISMATCH` | 记号的 `BASIS` 不是数据集 `priceBasis`（字符串或列表）里的一项 |
| （`PARITY_VENDOR_MISMATCH`） | 现在不拒（`VENDOR_ENFORCED = false`）：只记 `vendor_check: MATCH / MISMATCH`，不符时另记 `registry_vendor`。等 KG 加上规范的 `vendorIds` 再改（协调会话 01:2x 裁定第 3 条） |
| `PARITY_AI_LOGIC_MISMATCH` | AI 输入没带或带了不完整的 `AI_LOGIC_PIN_V1`；没有 `production_archive` 可核；与存档的钉值不同 |

- **按旧版本写的记号**（裁定第 1 条）：记号的 `@版本#sha` 是现在钉的 → 照旧（`pin_check: CURRENT`）；是更早的一版 → 那一版要在历史里，且这个数据集的一致性字段 `id`、`owner`、`producedBy`（没有时取 `producer`）、`pitSemantics`、`vendor`、`priceBasis` 从那一版到现在没变（那一版没写或为 null 的字段不算变），记 `pin_check: HISTORY_UNCHANGED`。
- **登记表字段的核对**（裁定第 2、3 条）：
  - `pitSemantics`：数据集（按现在钉的登记表）写了就核（`pit_check: CHECKED`），没写或为 `null` 记 `PENDING_REGISTRY_FIELD`。
  - `priceBasis`（BASIS）与 `vendor`：只对钉在有这两个字段的版本上的记号核（那一版的数据集带 `priceBasis` / `vendor` 键，KG 1.13.0 起）。钉在更早版本上的记号只核登记与 PIT，两项记 `NOT_APPLICABLE_PRE_FIELD`。版本有字段而这个数据集没写或为 `null`，记 `PENDING_REGISTRY_FIELD`。
  - BASIS 写了就核（`basis_check: CHECKED`，缺 → `PARITY_PRICE_BASIS_MISSING`，不符 → `PARITY_PRICE_BASIS_MISMATCH`）；VENDOR 只记（`MATCH` / `MISMATCH`）。
  - QRP 现在钉的是 1.13.0（KG 322ff69b）。钉在 1.11.0 的记号（例如 R_US_ENTRY_TOUCH_1 的冻结附注）照样能过：历史里有 1.11.0，一致性字段没变（`pin_check: HISTORY_UNCHANGED`），BASIS、VENDOR 不适用。
- 锁里记：`parity_gate{ applies, state: PASS, effective_from, signature{path, sha256}, registry{commit, registry_version, registry_sha256}, data_inputs[{dataset_id, registry_version, registry_sha256, pit_semantics, vendor, price_basis?, pin_check, pit_check, basis_check, vendor_check, registry_vendor?}], ai_inputs[{ref, archive_ref, archive_sha256, ai_logic_pin_sha256}], k2_notes?[{path, sha256}] }`。

**不过门的题**：照原样导入，锁行不加字段。现行海外与 A 股登记表的每一题都在生效之前冻结或封存，没有一题过门。

## 5. 范围之外与已知限制

- 存档输出本身（`production_archive.ref` 指的文件）不按字节复验，只核写出的 sha256 格式与钉值；绑定存档字节要另加导入规格的绑定文件角色。
- 「研究与实盘读同一个生产者」（§1 第 1 条）靠登记表的所有者与消费方登记；QRP 登记为消费方的 KG PR 合并、重钉之后，DRQ-2 扫描 QRP 仓库。
- 价格序列是价格还是全收益、是否复权（§1 第 4 条）：登记表还没有这类字段，本门不核。
