#!/bin/bash
# AQ-17H / AQ-17L cap proof (run once at install by ops-coord; prints JSON and exits non-zero on any failure).
# usage: cap-proof.sh HK|LINUX    HK: run 14:00-16:00 CST, 120 s burner. LINUX: safe burner in a 1-CPU / 1 GiB child scope of research.slice.
set -u
HOST="${1:?HK|LINUX}"; WIN=120
PYPATH="${PYTHONPATH:-$(dirname "$0")/../../services/research-queue}"
eval_json() { PYTHONPATH="$PYPATH" python3 -c 'import sys,json;from rq import capproof;e=capproof.evaluate(sys.argv[1],json.load(sys.stdin));print(json.dumps({"host":sys.argv[1],"failures":e}));sys.exit(1 if e else 0)' "$HOST"; }
burn='import time,sys
t=time.time()+%d
while time.time()<t: pass'
mem='b=[]
while True: b.append(bytearray(64*2**20))'
if [ "$HOST" = HK ]; then
  SC="systemd-run --scope --quiet --slice=research.slice"; SHOW="systemctl show"
  pm2_restarts() { pm2 jlist 2>/dev/null | python3 -c 'import sys,json;t=sys.stdin.read();print(sum(p["pm2_env"]["restart_time"] for p in json.loads(t[t.index("["):])))' ; }
  errlines() { pm2 jlist 2>/dev/null | python3 -c 'import sys,json;t=sys.stdin.read()
n=0
for p in json.loads(t[t.index("["):]):
  if p["name"] in ("main-app","strategy-worker"):
    try: n+=sum(1 for l in open(p["pm2_env"]["pm_err_log_path"]) if "error" in l.lower())
    except OSError: pass
print(n)'; }
  r0=$(pm2_restarts); e0=$(errlines)
  $SC -p CPUAccounting=yes python3 -c "$(printf "$burn" $WIN)" ; cpu=$(( $($SHOW research.slice -p CPUUsageNSec --value) / 1000000000 ))
  $SC python3 -c "$mem" >/dev/null 2>&1; oom=$(grep -E '^oom_kill ' /sys/fs/cgroup/research.slice/memory.events | cut -d' ' -f2)
  peak=$($SHOW research.slice -p MemoryPeak --value)
  r1=$(pm2_restarts); e1=$(errlines)
  load5=$(cut -d' ' -f2 /proc/loadavg)
  conn='import socket,sys
s=socket.socket()
try: s.connect((sys.argv[1],int(sys.argv[2]))); print("OK")
except PermissionError: print("EPERM")
except OSError as e: print("UNREACHABLE")'
  agent=$(systemd-run --quiet --wait --pipe --uid=rq-agent -p IPAddressDeny=any python3 -c "$conn" 1.1.1.1 443)
  db_port=3306
  rqdb=$(systemd-run --quiet --wait --pipe --uid=research-queue -p IPAddressDeny=any python3 -c "$conn" 127.0.0.1 $db_port)
  [ "$rqdb" = EPERM ] && rqdb=UNREACHABLE
  printf '{"cpu_seconds":%s,"window_s":%s,"oom_kill":%s,"peak_bytes":%s,"pm2_restarts":%s,"new_error_lines":%s,"load5":%s,"agent_tcp_connect":"%s","db_from_rq":"%s"}' \
    "$cpu" "$WIN" "${oom:-0}" "$peak" "$((r1-r0))" "$((e1-e0))" "$load5" "$agent" "$rqdb" | eval_json
else
  SC="systemd-run --user --scope --quiet --slice=research.slice -p CPUQuota=100% -p MemoryMax=1G -p MemorySwapMax=0"
  # four busy processes in a 1-CPU child scope: CPU use must stay near 1 CPU x window (proves cpu controller delegation), then a 2 GiB allocation must be OOM-killed
  $SC python3 -c "
import multiprocessing as m,time
def f():
  t=time.time()+$WIN
  while time.time()<t: pass
ps=[m.Process(target=f) for _ in range(4)]
[p.start() for p in ps];[p.join() for p in ps]"
  cpu=$(cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/research.slice/cpu.stat 2>/dev/null | awk '/usage_usec/{printf "%.1f",$2/1e6}')
  $SC python3 -c "$mem" >/dev/null 2>&1
  oom=$(cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/research.slice/memory.events 2>/dev/null | awk '/^oom_kill /{print $2}')
  cgp=$(DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock" docker run --rm --cgroup-parent=research.slice --network none node:22-bookworm-slim true 2>&1 | head -1)
  [ -z "$cgp" ] && cgp=OK || cgp="REFUSED:$cgp"
  printf '{"cpu_seconds":%s,"window_s":%s,"quota_cpus":1,"burner_cpus":4,"oom_kill":%s,"cgroup_parent_result":"%s"}' "${cpu:-0}" "$WIN" "${oom:-0}" "$cgp" | eval_json
fi
