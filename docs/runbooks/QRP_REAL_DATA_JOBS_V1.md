# QRP 真实数据作业运行说明

本说明对应 #49。作业只读已有副本，不联网取数、不写生产台账；输出写到新的证据目录，
同名 manifest 或结果已存在即失败关闭。

## 1. 权威运行环境

- 主机：Linux 研究机（x86_64）
- Node：18.20.8，V8 10.2.154.26-node.39
- smartflow：`4d9558e58aa4b94526879c8dcdb2a7ab4ff509d4`
- replay core：`81f3042858ef90f423f3c671950a5ee0f7ea31ef5ba0af323990636c8fce544f`
- 调度：`nice -n 19 ionice -c 3`

先设置路径；`QRP_SMARTFLOW_ROOT` 必须指向上述钉版树，不能指向随 main 漂移的工作目录：

```bash
export PATH=/srv/research-lane/rc-hist/bin:/srv/research-lane/overseas/node/bin:$PATH
export QRP_SMARTFLOW_ROOT=/path/to/smartflow-4d9558e5-root
cd /path/to/quant-research-platform
```

## 2. 美股与加密

每个来源先 `write` 再 `run`；`ARGS.json` 只写已有只读路径和冻结参数：

```bash
nice -n 19 ionice -c 3 node apps/research-cli/replay_core_cache_jobs.js write \
  --source SOURCE --out /new/evidence/jobs/SOURCE --args /read-only/ARGS.json
nice -n 19 ionice -c 3 node apps/research-cli/replay_core_cache_jobs.js run \
  --source SOURCE --out /new/evidence/jobs/SOURCE --receipt /new/evidence/receipts/SOURCE.json
```

本批成功来源：`C17_AGENT_LIVE`、`C17_V2_LIVE`、`CARRY`、`US_V5_RECORDS`。
`C17_CACHE` 的指定副本不能运行：manifest 引用的 `exchangeInfo.safe.json` 和 28 个
`derived/*` 投影全部缺失；目录只有 manifest 与 raw 归档。不要从外网补拉，也不要把 raw
归档当成已生成投影。获得经 SHA 校验的完整副本后，才以新证据目录运行。

信号登记按市场分别生成，因为美股与加密的周末日期不同：

```bash
node apps/research-cli/build_signal_registry.js --inbox /read-only/desk/inbox \
  --books C17_V2_4000USDT,QUICK_SHOT_V3_1000USDT --period-to 2026-11-08 \
  --out /new/evidence/crypto/SIGNAL_REGISTRY_V1.json \
  --conformance-out /new/evidence/crypto/SIGNAL_REGISTRY_V1.conformance.json
node apps/research-cli/build_signal_registry.js --inbox /read-only/desk/inbox \
  --books US_V5_ETF_3000USD,US_CORE_9000USD_3X_GATEOBS --period-to 2026-11-06 \
  --out /new/evidence/us/SIGNAL_REGISTRY_V1.json \
  --conformance-out /new/evidence/us/SIGNAL_REGISTRY_V1.conformance.json
```

验收要求：命令退出 0，回执 `BYTE_IDENTICAL`，conformance `differences: 0`。来源核对里的
毛值/净值重述、复盘缺行等 divergence 必须保留，不能通过调参消除。

## 3. A 股 Q0 账户日适配

只对协调方复制并校验过的未封存账户子集运行：

```bash
node apps/research-cli/adapt_ashare_q0_export.js \
  --input /read-only/A/c000.jsonl \
  --out /new/evidence/ASHARE_Q0_ACCOUNT_RESULT_V1.json \
  --registry-out /new/evidence/ASHARE_Q0_SIGNAL_REGISTRY_V1.json \
  --expect-sha256 <source-sha256> \
  --generated-at <UTC-ISO-time>
```

验收直接比较 `fillCount` 与源事件计数、`endingEquity` 与源末行权益。不得读取 V6 数据库，
不得把封存账户复制进输入目录。

最后把三市场登记合并成一张 V2 表：

```bash
node apps/research-cli/merge_signal_registries.js \
  --us /new/evidence/us/SIGNAL_REGISTRY_V1.json \
  --crypto /new/evidence/crypto/SIGNAL_REGISTRY_V1.json \
  --ashare /new/evidence/ASHARE_Q0_SIGNAL_REGISTRY_V1.json \
  --out /new/evidence/SIGNAL_REGISTRY_V2.json \
  --generated-at <UTC-ISO-time>
```

三个来源的内容哈希、市场集合或 schema 任一不符即拒绝；A 股无成交时只写来源状态，不补
信号行或绩效。

