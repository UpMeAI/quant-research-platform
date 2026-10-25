# Cycle × Research × Desk V8.1：手机宽度整页横向滚动的修复回执（2026-10-25）

依据：协调会话 10-25 的指示；UX 验收 V1 §43 与修订 1 A5.4（360 CSS px 无整页水平滚动）。实施者：Claude（QRP 工程）；合并闸和部署由协调者做。Production effect：`NONE`。

## 原因（更正我在 PR #14 里的说法）

PR #14 里我把 423 px 的整页宽度归因于顶部导航条，**这是错的**。顶部导航条在手机宽度下自带 `overflow-x:auto`，被它裁住，不撑页面。

真正的来源是策略详情页「待验证问题清单」：真实 Q0 文件的诊断事实里有不带空格的长代码（`US_V5_TIME_STOP_VS_TREND_EXIT_RESULT_V1`、`ETF_UNIVERSE_VERSION_NOT_YET_EFFECTIVE`），所在 `li` 的 `overflow-wrap` 是默认值，不会断，把整页撑到 423 px。总览、研究队列、前向观察、复盘与采用、数据与运行状态五页本来就是 360 px，只有策略详情（五章在同一页）超宽。

## 改了什么

`apps/research-web/index.html` 只加一条规则，放在已有的 `@media(max-width:520px)` 块里（桌面不受影响）：

`main :where(p,li,dd,dt,h2,h3,h4,h5,summary,code){overflow-wrap:anywhere}`

用 `anywhere` 而不是 `break-word`，因为 `dl` 在手机下是单列网格，`dd` 是网格项，只有 `anywhere` 才会降低它的最小内容宽度。表格单元格不在选择器里：宽表仍在各自的 `table-wrap` 里内部横向滚动。

新增 `tests/mobile_layout.test.js`：起真实的 Research 服务（临时台账导入了 Q0 与 Q1 的封存结果，问题、候选、诊断事实、原因、前向文本里都故意放了 100 多个字符的不带空格的代码），用无头 Chrome 加载同源探针页，探针页把八条路由（总览、策略详情的 runtime／research／forward、研究队列、前向观察、复盘与采用、数据与运行状态）放进 **360 px 和 390 px** 宽的 iframe，断言每条路由 `documentElement.scrollWidth <= clientWidth`，并且页面真的渲染了。没有 Chrome（可用 `QRP_TEST_CHROME` 指定）时测试跳过，跳过说明写明「浏览器布局未验证，不算通过」。

## 验证

- 修复前，新测试在未改的 `main` 上失败：策略详情 runtime @360px：整页横向宽度 1140 > 360。修复后 360 与 390 全部通过（耗时约 8 秒）。
- 在内置浏览器窗格里对**真实台账**（`var/ledger` 的拷贝，不是运行中服务的台账；服务由本工作树起在临时端口，验证后已杀掉并删除拷贝）：360 px 与 390 px 各扫十条路由（总览、策略详情五章、研究队列、前向观察、复盘与采用、数据与运行状态）。修复前策略详情五章都是 `scrollWidth = 423`；修复后全部等于视口宽度（360／390）。
- 全量（临时工作树，设 `QRP_DESK_ROOT`，`npm test`）：154 项，153 过，0 失败，1 跳过（本机无 Ashare-V5 检出，不算通过；新增的浏览器布局测试这次真的跑了，没有跳过）。

## 没有做的

只加了这一条 CSS 规则和一个测试，没有改页面结构、文案、数据或其他样式；桌面布局不变（规则只在 520 px 以下生效）。
