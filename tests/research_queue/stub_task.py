"""Stub task process for the research-queue tests. Modes: ok, sleep, exit64, fail1, err_<class>_<code>."""
import json, os, sys, time

d = os.environ["RQ_ATTEMPT_DIR"]
with open(os.path.join(d, "argv.txt"), "w") as f:
    f.write(json.dumps(sys.argv[1:]))
mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
ok = {"outputs": [], "validator": {"ok": True, "sha256": "v" * 64}}
if mode == "sleep" or mode.startswith("generate") or mode.startswith("score"):
    time.sleep(float(os.environ.get("STUB_SLEEP", "3")))
    json.dump(ok, open(os.path.join(d, "result.json"), "w"))
elif mode in ("ok", "resume", "rescore"):
    json.dump(ok, open(os.path.join(d, "result.json"), "w"))
elif mode == "exit64":
    json.dump({"class": "D", "code": "MINE_MARKET_PAUSED"}, open(os.path.join(d, "error.json"), "w"))
    sys.exit(64)
elif mode == "fail1":
    sys.exit(1)
elif mode.startswith("err_"):
    _, cls, code, http = (mode.split("_") + ["", ""])[:4]
    code = {"HOLDOUTINCOMPLETE": "HOLDOUT_INCOMPLETE"}.get(code, code)
    json.dump({"class": cls, "code": code, "http_status": int(http) if http else None},
              open(os.path.join(d, "error.json"), "w"))
    sys.exit(2)
