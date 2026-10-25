# Market Adapter 实现规格(市场仓库侧)

> 适用对象:要把一个新市场接入本平台的**市场仓库**实现者。
> 参照实现:`UpMeAI/Ashare-V5` → `research-adapter/`(CN_A,已上线并端到端验证)。
> 已实现但待真实 bundle／部署验收:`wendy926/smartflow` → US_EQUITY（只读原生回放 bundle）。
> 待实现:`wendy926/smartflow` → CRYPTO。

## 0. 为什么适配器写在市场仓库,而不是平台仓库

设计 §5:市场特有的 PIT 数据、回测内核、成本/执行模型**留在各自市场仓库**,平台不搬也不复制。
平台只经 REST 拿到一个满足 §14.1 合同的对象(`adapters/clients/http_market_adapter_client.js`),
核心代码不知道传输层存在,也永远拿不到市场仓库的 DB / broker 凭证(§13/§18 Credential Isolation)。

因此:**不要**把 US/crypto 的策略、信号、回测、持仓或适配器声明写进 Ashare-V5 ——
该仓 `CLAUDE.md` §2.2 永久硬不变量禁止非 A 股内容,并由 `scripts/market_scope_guard.js` +
`tests/market_scope_boundary.test.js` 强制。

## 1. 传输层(§25 已冻结)

`HTTP_JSON_RPC_V1`:

```
POST {baseUrl}/{fn}
Headers: Content-Type: application/json, X-Adapter-Token: <token>
Body:    { "args": [ ... ] }          // 位置参数数组,即使为空也必须是数组
200:     { "result": <任意 JSON> }     // 必须有 result 键,否则平台抛 ADAPTER_MISSING_RESULT_ENVELOPE
非 2xx:  { "error": "<机器可读串>" }   // 平台抛 ADAPTER_REMOTE_ERROR
```

`POST {baseUrl}/manifest` 返回 manifest。平台默认超时 120s(回测/WFO 是长任务,超时**显式失败**,不静默截断)。

骨架见 `docs/templates/market_adapter_server.template.js` —— 复制到市场仓库后只需接上本地内核。

## 2. manifest 必需字段(`packages/contracts/market_adapter_contract.js` `MANIFEST_FIELDS`)

`market_id` · `adapter_version` · `repo_ref` · `supported_asset_types` · `capabilities` ·
`trading_calendar_ref` · `data_contract_version` · `cost_model_version` · `execution_model_version`

另外两个非必需但强烈建议:

- `transport: 'HTTP_JSON_RPC_V1'`
- `optional_capabilities: [...]` —— **不声明就不会被挂载**。平台只挂载
  `OPTIONAL_ADAPTER_FNS ∩ optional_capabilities`,未声明的能力平台显式降级为 UNSUPPORTED,
  而不是调用后才吃 404。声明的语义是"函数存在且可调用",不代表它返回业务可用数据 ——
  没接通的能力应诚实返回 `UNAVAILABLE` 而不是假数据。

`market_id` 必须与平台侧配置槽位一致(`adapters/clients/remote_markets.js`),
否则注册时抛 `REMOTE_MARKET_ID_MISMATCH` —— 这是为了防配错端口:CRYPTO 与 US_EQUITY 的
赛马指标形状完全一样,注册错了事后无法分辨。

## 3. 必需六函数(`ADAPTER_FNS`)

| 函数 | 职责 |
|---|---|
| `snapshot` | 产 DatasetSnapshot(PIT 冻结,`firstAvailableAt <= cutoff`) |
| `run_backtest` | 跑本市场原生回测内核 |
| `run_shadow` | 影子观察(不产生真实动作) |
| `validate_release` | 发布前校验 |
| `runtime_capabilities` | 声明 runtime 能力与交易规则 |
| `normalize_result` | 原生结果 → CanonicalRaceMetrics 八轴 |

可选五函数(`OPTIONAL_ADAPTER_FNS`):`regime_labels`、`runtime_active_release`、
`runtime_positions_readonly`、`runtime_performance_summary`、`runtime_health`。

`evaluate_factor` **不在**任何一张表里 —— 不要实现成远程端点,那会是死代码。

## 4. `normalize_result` 八轴(`packages/contracts/canonical_metrics.js`)

`absolute` · `risk` · `relative` · `trading_quality` · `robustness` · `operational` · `capacity` · `cost_breakdown`

缺任一轴,平台 `closeRace` 直接抛 `METRICS_MISSING_AXIS:<axis>`。
未建模的指标必须用 `NOT_IMPLEMENTED_MVP` / `NOT_IMPLEMENTED_P4` / `UNSUPPORTED` 显式标注,
**禁止用 null / 0 / 空对象冒充"已覆盖"**。

### cost_breakdown 是最容易糊弄的一轴

`{ model: <成本模型版本串>, components: { ... } }`。成本必须**逐项交代**,
不允许用一个总费率冒充"手续费/滑点/冲击/funding/FX/流动性"全覆盖。

各市场的诚实做法差异很大,照抄 A 股会写出错的东西:

- **CN_A(参照实现)**:`commission` / `stamp_duty` / `slippage` = `MERGED_INTO_PER_SIDE_RATE`
  (确实合并进了单边费率,如实说明);`market_impact` / `liquidity_constraint` = `NOT_IMPLEMENTED_P4`;
  `funding` / `fx` = `UNSUPPORTED`(现货多头、单一 CNY 计价)。
- **US_EQUITY**:无印花税;做空有 borrow fee,若支持做空则 `borrow_fee` 必须是真实项而非 UNSUPPORTED;
  单一 USD 计价时 `fx` 可 UNSUPPORTED,但若标的含 ADR/跨币种则不可。
- **CRYPTO**:`funding` 对永续合约是**真实的周期性现金流**,不是可以 UNSUPPORTED 的项;
  若用稳定币计价而绩效以法币口径汇报,`fx` 同样是真实项。把这两项并进单边费率会系统性
  低估持仓成本,并在赛马里给长持策略不该有的优势。

## 5. 交易日历与执行模型

- **US_EQUITY**:有假日与半日市(收盘 13:00 ET),`trading_calendar_ref` 必须指向真实日历源;
  做空允许、有 PDT 等账户约束 → 在 `runtime_capabilities.trading_rules` 如实声明。
- **CRYPTO**:7×24 无交易日历,"business_date" 需要显式定义切分口径(UTC 日界?交易所结算时点?)
  并写进 `data_contract_version`,否则跨市场赛马的 per-day 指标不可比。
- 无论哪个市场,`execution_model_version` 必须能唯一确定"信号→成交"的口径
  (入场价取什么、何时成交、如何退出),口径变更即新版本号,不允许原地改语义。

## 6. 安全边界(所有市场一致)

- 适配器**只读**研究数据,不写生产账本、不下单、不碰 broker;
- 服务端鉴权先于路由 —— 未授权者连"哪些 fn 存在"都不该探测到;
- 错误只回 message,不回栈/路径/凭证;
- 非 loopback 绑定且未配置 token 时**拒绝启动**,而不是裸奔;
- 端点用**显式白名单**,不要反射 `Object.keys(adapter)`(适配器模块通常还导出常量与内部件)。

## 7. 平台侧接入(市场仓库无需改平台代码)

```bash
export QRP_ADAPTER_BASE_URL_US_EQUITY=https://smartflow.internal/research-adapter/us
export QRP_ADAPTER_TOKEN_US_EQUITY=...
export QRP_ADAPTER_BASE_URL_CRYPTO=https://smartflow.internal/research-adapter/crypto
export QRP_ADAPTER_TOKEN_CRYPTO=...
```

```js
const { registerConfiguredRemoteMarkets } = require('./adapters/clients/remote_markets');
const { registered, skipped } = await registerConfiguredRemoteMarkets();
```

未配置 baseUrl 的市场 = 未接入(平台查询该市场得到 `MARKET_ADAPTER_NOT_REGISTERED`);
已配置但连不通 / 合同不齐 / market_id 不符 = 抛错,**不降级注册**。

## 8. 接入前自检

```
[ ] POST /manifest 返回 9 个必需字段 + transport + optional_capabilities
[ ] 六个必需 fn 全部可调用
[ ] normalize_result 八轴齐全,未建模项用 NOT_IMPLEMENTED_*/UNSUPPORTED
[ ] cost_breakdown 逐项交代,crypto 的 funding / fx 是真实项
[ ] 错误 token 被 401 拒绝,且拒绝发生在路由之前
[ ] 用平台真实 createHttpMarketAdapterClient 打通(必需 6/6 挂载、validateAdapter 通过)
```
