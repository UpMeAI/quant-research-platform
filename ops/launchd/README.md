# QRP Research 页面：Mac launchd 服务

V8.1 的受控交付环境：Mac 上 `http://127.0.0.1:4311`，从 QRP 主检出（`main`）运行，不另建运行检出。
Owner 2026-10-25 决定：只有磁盘或内存不够时才迁到 VPS。

| 项 | 值 |
|---|---|
| Label | `com.upmeai.qrp-research-web`（用户级 LaunchAgent，登录后常驻，崩溃自动重启，重启间隔 30 秒） |
| 命令 | `/usr/local/bin/node /Users/kaylame/KaylaProject/quant-research-platform/apps/research-api/index.js` |
| 监听 | `127.0.0.1:4311`；无 token 时只接受 `127.0.0.1` / `localhost` / `[::1]` 作 Host 头 |
| 日志 | `var/log/research-web.out.log`、`var/log/research-web.err.log`（`var/` 已被 git 忽略） |
| 显示用 | `QRP_PRODUCT_MILESTONE_AUTHORITY=V8_1_COORDINATOR`：页面显示“完成权威已配置”。Web 没有任何入口调用里程碑记录函数 |
| 刻意没有设置 | `QRP_RUNTIME_TOKEN`（Runtime pull/ack 一律 403）、`QRP_RESEARCH_TOKEN`、`QRP_ADAPTER_*`（不连远程市场）、`QRP_DATA_DIR`（台账读 `var/ledger`） |
| Desk 目录 | 固定读 `/Users/kaylame/KaylaProject/portfolio-desk` 工作树（`QRP_DESK_ROOT`），看到的是它当前所在分支的内容 |

## 安装（协调者合并 PR #2 之后）

前提：QRP 主检出在干净的 `main`，且包含 PR #2。

```bash
cd /Users/kaylame/KaylaProject/quant-research-platform && git switch main && git pull --ff-only
```

```bash
ops/launchd/install.sh install
```

安装器依次做：检查在 `main`、工作区干净、`/usr/local/bin/node` 存在、plist 语法；现场校验 M1 诊断输入包必须是 `VERIFIED`；
如果 4311 上是手动启动的 `node apps/research-api/index.js`（现为 pid 3552）就先停掉它，被其他进程占用则中止；
复制 plist 到 `~/Library/LaunchAgents/`，`launchctl bootstrap` + `kickstart`；等 `GET /api/workspace` 返回 200 后打印状态
（并确认 `POST /api/workspace` 为 405）。

## 查看、卸载

```bash
ops/launchd/install.sh status
```

```bash
ops/launchd/install.sh uninstall
```

卸载只移除 LaunchAgent 和 plist，不动日志、台账、证据。

## 升级代码

服务从 `main` 检出直接运行，Node 模块在进程启动时加载。协调者 `git pull --ff-only` 之后重启一次：

```bash
launchctl kickstart -k gui/$(id -u)/com.upmeai.qrp-research-web
```

## 安装前已验证（未安装）

用与 plist 相同的最小环境（`env -i`，同样的变量）在备用端口 4399 启动同一入口：`/api/workspace` 返回诊断 `VERIFIED`、
完成权威 `CONFIGURED`、M0 `CONTROLLED_VERIFIED`；`POST /api/workspace` 405；伪造 Host 头 403；`/api/runtime/*` 403；`GET /` 200。
launchd 本身未安装。
