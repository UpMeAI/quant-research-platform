# schemas/ —— 域对象 JSON Schema(§5.2 拓扑 · §8 Domain Model)

平台全部 append-only 台账记录的产品级 Contract。每个文件对应一个 `schema` 字段值,
文件名 = schema 值小写。这些是**产品合同**,数据库/存储实现可另行落地(§8 原话)。

约定:
- `schema` 字段是记录类型判别式,值即版本(`..._V1`);改字段语义 = 新版本,不改旧版本;
- 台账 append-only:同一 id 的后续行是修正/状态推进,读取按「最后一行为准」(head);
- 时间字段一律 ISO-8601 UTC 字符串;哈希一律 sha256 前 16 位十六进制;
- `*_status` / `*_state` 未实现能力显式用 `NOT_IMPLEMENTED_*` / `UNSUPPORTED` / `UNAVAILABLE` 标注,
  禁止用 `null` 或空对象冒充「已覆盖」(§18 Fail Closed)。

校验:`node schemas/validate.js`(零依赖,按必填字段与类型做结构校验;
CI 与 `npm test` 中的 `schemas_contract.test.js` 会跑同一套校验)。
