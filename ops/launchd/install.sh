#!/bin/bash
# QRP Research 页面 launchd 安装器（Mac，用户级 LaunchAgent）。用法：install.sh [install|uninstall|status]
# 只在 QRP 主检出处于干净的 main 时安装；不创建独立运行检出。
set -euo pipefail

ROOT=/Users/kaylame/KaylaProject/quant-research-platform
LABEL=com.upmeai.qrp-research-web
PORT=4311
NODE=/usr/local/bin/node
SRC="$ROOT/ops/launchd/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

die() { echo "ERROR: $*" >&2; exit 1; }
listener_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }

service_pid() { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid =/{print $3; exit}'; }

status() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "$LABEL: not loaded"
  pid=$(service_pid || true)
  if [ -n "${pid:-}" ]; then ps -o rss=,etime= -p "$pid" | awk '{printf "RSS %.0f MB, up %s\n", $1/1024, $2}'; fi
  du -sk "$ROOT/var/evidence" "$ROOT/var/ledger" "$ROOT/var/log" 2>/dev/null | awk '{printf "disk %s: %.1f MB\n", $2, $1/1024}' || true
  curl -fsS -o /dev/null -w "GET /api/workspace -> %{http_code}\n" "http://127.0.0.1:$PORT/api/workspace?strategy_ref=US_V5_ETF_3000USD" || true
  curl -sS -o /dev/null -w "POST /api/workspace -> %{http_code} (expect 405)\n" -X POST "http://127.0.0.1:$PORT/api/workspace" || true
}

uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$DEST"
  echo "uninstalled $LABEL (plist removed; var/log kept)"
}

install() {
  cd "$ROOT"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "QRP 检出不在 main（先等协调者合并 PR #2 并 git switch main && git pull --ff-only）"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "QRP 主检出有未提交改动"
  [ -x "$NODE" ] || die "找不到 $NODE"
  git ls-files --error-unmatch services/strategy-diagnostics/index.js >/dev/null 2>&1 || die "main 上没有 V8.1 代码（PR #2 未合并？）"
  plutil -lint "$SRC" >/dev/null || die "plist 语法错误"

  state=$("$NODE" -e "console.log(require('./services/strategy-diagnostics').readFreshDiagnostic().state)")
  [ "$state" = "VERIFIED" ] || die "M1 诊断输入包不是 VERIFIED（$state），先修复再安装"

  pid=$(listener_pid)
  if [ -n "$pid" ] && ! launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q "pid = $pid"; then
    cmd=$(ps -o command= -p "$pid")
    case "$cmd" in
      *apps/research-api/index.js*) echo "停止手动进程 pid $pid: $cmd"; kill "$pid"; sleep 2 ;;
      *) die "端口 $PORT 被其他进程占用: pid $pid $cmd" ;;
    esac
  fi

  mkdir -p "$ROOT/var/log" "$HOME/Library/LaunchAgents"
  cp "$SRC" "$DEST"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$DEST"
  launchctl kickstart -k "$DOMAIN/$LABEL"

  for _ in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/workspace?strategy_ref=US_V5_ETF_3000USD" || true)
    [ "$code" = "200" ] && break
    sleep 1
  done
  [ "$code" = "200" ] || die "服务 20 秒内没有返回 200（看 var/log/research-web.err.log）"
  status
  write_receipt
}

# 安装回执：一次一个新文件，内容不再变化；可作为 DELIVERY_RELEASE 类型的产品证据登记（登记与晋级由协调者做）。
write_receipt() {
  mkdir -p "$ROOT/var/release"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file="$ROOT/var/release/research-web-install-$stamp.json"
  "$NODE" -e '
    const [label, head, plist, port, pid, file, ws, post] = process.argv.slice(1);
    const crypto = require("crypto"), fs = require("fs");
    fs.writeFileSync(file, JSON.stringify({
      schema: "RESEARCH_WEB_INSTALL_RECEIPT_V1", label, installed_at: new Date().toISOString(), git_head: head,
      plist_sha256: crypto.createHash("sha256").update(fs.readFileSync(plist)).digest("hex"),
      listen: `127.0.0.1:${port}`, pid: Number(pid), node: process.version,
      probes: { "GET /api/workspace": Number(ws), "POST /api/workspace": Number(post) }, production_effect: "NONE",
    }, null, 2) + "\n");' "$LABEL" "$(git -C "$ROOT" rev-parse HEAD)" "$DEST" "$PORT" "$(service_pid)" "$file" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/workspace?strategy_ref=US_V5_ETF_3000USD")" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/workspace")"
  echo "install receipt: $file"
}

case "${1:-install}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) die "usage: $0 [install|uninstall|status]" ;;
esac
