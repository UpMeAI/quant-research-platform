#!/usr/bin/python3
"""Networkless real-rsync capture of the two exact #137 HK gate forms."""
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile


HERE = pathlib.Path(__file__).resolve().parent
PUSH_FORM = "rsync --server -logDtprce.iLsfxCIvu --delay-updates . fact-packs/"
PULL_FORM = "rsync --server --sender -logDtprce.iLsfxCIvu . /var/lib/research-queue/outbox/"
spec = importlib.util.spec_from_file_location("q137_relay", HERE / "relay-run.py")
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


def main():
    with tempfile.TemporaryDirectory(prefix="q137-rsync-capture-") as temp:
        root = pathlib.Path(temp)
        fake = root / "ssh"
        log = root / "capture.jsonl"
        fake.write_text("#!/usr/bin/python3\nimport json,os,pathlib,sys\np=pathlib.Path(os.environ['Q137_CAPTURE'])\nwith p.open('a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\nraise SystemExit(126)\n")
        fake.chmod(0o755)
        stage = root / "stage"; stage.mkdir(); (stage / "pack.json").write_text("{}\n")
        pull = root / "pull"
        env = dict(os.environ); env["PATH"] = str(root) + os.pathsep + env.get("PATH", ""); env["Q137_CAPTURE"] = str(log)

        def run(argv, **kwargs):
            return subprocess.run(argv, env=env, **kwargs)

        transport = relay.GateRsyncTransport("root@smartflow-hk", run=run)
        for operation in (lambda: transport.push_fact_packs(stage), lambda: transport.pull_returns(pull)):
            try:
                operation()
            except relay.RelayError as error:
                if str(error) != "HK_GATE_RSYNC_FAILED":
                    raise
        rows = [json.loads(line) for line in log.read_text().splitlines()]
        if len(rows) != 2:
            raise SystemExit("CAPTURE_COUNT_INVALID")
        commands = []
        for row in rows:
            try:
                host = row.index("smartflow-hk")
            except ValueError:
                raise SystemExit("CAPTURE_HOST_MISSING")
            commands.append(" ".join(row[host + 1:]))
        if commands != [PUSH_FORM, PULL_FORM]:
            raise SystemExit("CAPTURE_FORM_DRIFT:%r" % (commands,))
        print(json.dumps({"schema": "Q137_RSYNC_FORMS_V1", "rsync": subprocess.check_output(["/usr/bin/rsync", "--version"], text=True).splitlines()[0],
                          "push": commands[0], "pull": commands[1]}, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
