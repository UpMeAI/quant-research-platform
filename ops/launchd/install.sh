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

status() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "$LABEL: not loaded"
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
}

case "${1:-install}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) die "usage: $0 [install|uninstall|status]" ;;
esac
