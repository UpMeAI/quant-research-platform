#!/bin/bash
# RF1116 generate window pause (coordinator 2026-11-18; ruling ★RF1116_GENERATE_WINDOW (a) 06:30-08:00 + DEPLOY.md V6 windows 09:15-15:30 and post-close 18:10-20:45), Mon-Fri CST.
# Pauses running rf1116-generate-*/rf1116-resume containers inside a window, unpauses them outside. Touches nothing else.
export DOCKER_HOST=unix:///run/user/1000/docker.sock
LOG=/srv/research-lane/rf1116-mining/ops/window-pause.log
t=$(TZ=Asia/Shanghai date +%H%M); dow=$(TZ=Asia/Shanghai date +%u); now=$(TZ=Asia/Shanghai date +%FT%T+08:00)
inwin=0
if [ "$dow" -le 5 ]; then
  if [ "$t" -ge 0630 ] && [ "$t" -lt 0800 ]; then inwin=1; fi
  if [ "$t" -ge 0915 ] && [ "$t" -lt 1530 ]; then inwin=1; fi
  if [ "$t" -ge 1810 ] && [ "$t" -lt 2045 ]; then inwin=1; fi
fi
docker ps --filter name=rf1116-generate- --filter name=rf1116-resume --format "{{.Names}} {{.State}}" | while read -r n s; do
  case "$n" in rf1116-generate-*|rf1116-resume) ;; *) continue ;; esac
  if [ "$inwin" = 1 ] && [ "$s" = running ]; then docker pause "$n" >/dev/null && echo "$now PAUSE $n (window)" >> "$LOG"; fi
  if [ "$inwin" = 0 ] && [ "$s" = paused ]; then docker unpause "$n" >/dev/null && echo "$now UNPAUSE $n" >> "$LOG"; fi
done
