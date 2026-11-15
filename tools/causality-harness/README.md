# tools/causality-harness

G-CAUSAL 公用工具（研究框架修订 2026-11-12 草稿 §3.5）：读清单 `CAUSALITY_MANIFEST_V1`，跑 T-C1 前缀等价、T-C2 未来替换、T-C3 只读给定输入，写证据 `CAUSALITY_EVIDENCE_V1`。

- 合同、清单写法、证据字段、K2 写法、导入器绑定：`docs/contracts/CAUSALITY_EVIDENCE_V1.md`。
- 编排与判定：`lib/core.js`；Node 运行器：`lib/node-runner.js`（沙箱 `lib/sandbox.js`）；Python 运行器：`python/causality_runner.py`。
- 自测夹具（合成数据，红绿成对）：`fixtures/`；测试：`tests/causality_harness.test.js`、`tests/causality_gate.test.js`。
