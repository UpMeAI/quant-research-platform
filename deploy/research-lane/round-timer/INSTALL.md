# RF1116 round timer — ops-coord install packet

This packet is inert source. Codex does not install, enable, merge, deploy, fetch
the real pages, start Docker, or write production data.

## Authority and safety

- The runner remains the only authority for round/month/segment admission. This
  supervisor calls the existing `run.sh`; it does not reproduce that decision.
- `QRP_VAR_ROOT=/srv/research-lane/qrp/var` and
  `QRP_DATA_DIR=/srv/research-lane/qrp/var/ledger` are distinct. Authority and
  migration manifests bind the former; QRP ledgers bind the latter.
- The #157 runner-local outcome projection is separately read-only at
  `<RF1116_LANE_DIR>/out/qrp-data/research/mining_llm_calls.jsonl`. It is used
  only to identify a paid-call crash occurrence; it is not another QRP var
  authority. A missing, unreadable, non-regular, or ambiguous projection stops
  the slot and alerts instead of merging crashes under an unknown identity.
- A missing or byte-mismatched frozen R2 page, missing R2 segment, active
  blackout, less than 150 GiB free, model-page fetch failure, or model-string
  difference prevents a start.
- `alert_status.json` is the file consumed by the existing alert-checks path.
  The companion #126/#122 work owns the alert-checks rule and Feishu delivery.
- The monthly service serially completes slot `YYYY-MM:1` before it can start
  slot `YYYY-MM:2`. Each persisted slot is terminal exactly once.

## Environment file

Ops-coord creates `/home/kayla/.config/qrp/rf1116-round-timer.env` mode `0600`.
The file contains names and paths, never the DeepSeek secret itself:

```text
QRP_VAR_ROOT=/srv/research-lane/qrp/var
QRP_DATA_DIR=/srv/research-lane/qrp/var/ledger
QRP_VAR_CANDIDATES=/srv/research-lane/qrp/var:<read-only-Mac-backup-path>
QRP_VAR_MANIFESTS=<Linux-manifest>:<Mac-backup-manifest>
RF1116_LANE_DIR=/srv/research-lane/rf1116-mining
RF1116_ROUND_TIMER_STATE_DIR=/srv/research-lane/rf1116-mining/round-timer
RF1116_RUNNER_IMAGE=qrp-round-runner:<reviewed-commit12>
RF1116_RUN_SH=/srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh
RF1116_BLACKOUTS_FILE=/srv/research-lane/rf1116-mining/code/config/rq-blackouts.v1.json
RF1116_MODEL_EXPECTATIONS_FILE=/srv/research-lane/rf1116-mining/code/config/rq_deepseek_gateway.v1.json
RF1116_R2_HOLDOUT_DIR=/srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-r2
RF1116_R2_HOLDOUT_SUMS=/srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-r2/SHA256SUMS
RF1116_R2_FREEZE_FILE=/srv/research-lane/rf1116-mining/contracts/RF1116_HOLDOUT_CN_A_R2_FREEZE_1.md
RF1116_R2_FREEZE_SHA256=<exact-frozen-page-sha256>
RF1116_DISK_FLOOR_GIB=150
RF1116_FIRST_MONTH=2026-12
```

The existing runner reads its research key only from the separate kayla-owned
`0600` file `/home/kayla/.config/qrp-research-key/deepseek-research.env`.

## Ops-coord steps after REVIEW_ACCEPTED

1. Refuse install until the R2 page is genuinely frozen and its exact SHA is in
   the environment file. The current task input is still a draft. Also refuse
   until reviewed #157 is merged: its `run.sh` is the R2 segment interface.
2. Copy the reviewed code tree and four unit files; create the fixed log and
   state directories owned by kayla.
3. On scratch copies, run `systemd-analyze --user verify` and
   `systemd-analyze calendar` for both `OnCalendar` expressions.
4. Run `round_timer.py --check-only`; inspect `model_gate_last.json`, its
   `.prev`, and `alert_status.json`. This mode never starts a round.
5. Enable the two timers only after plan-coord `REVIEW_ACCEPTED` and ops-coord's
   runtime window check. Rollback is disable both timers; preserve ledgers and
   alerts for audit.

`Persistent=true` is intentional: the daily gate must refresh after downtime.
The five-minute supervisor tick is a no-op before 20:50 on the first day and
before `RF1116_FIRST_MONTH`; afterwards it drives bounded waits and catches up
after downtime. The persisted slot guard prevents duplicate starts.
