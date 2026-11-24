# RF1116 score timer installation

Install only after the reviewed QRP merge containing #157 and this change. The
unit is a user unit for `kayla`; do not add `User=` and do not run it with sudo.
It never invokes Docker directly: it calls the reviewed `run.sh`, whose pinned
image performs arrival, completeness checking, score and rescore.

1. Verify `/srv/research-lane/rf1116-mining/code/.QRP_COMMIT` is the reviewed
   merge commit and its `qrp-round-runner:<commit12>` image is installed.
2. Create `%h/.config/rf1116-score-timer/env` mode 0600:

   ```text
   QRP_VAR_ROOT=/srv/research-lane/qrp/var
   QRP_DATA_DIR=/srv/research-lane/qrp/var/ledger
   RF1116_LANE=/srv/research-lane/rf1116-mining
   RF1116_SCORE_TIMER_STATE_DIR=/srv/research-lane/rf1116-mining/score-timer
   RQ_BLACKOUTS_FILE=/srv/research-lane/rf1116-mining/code/config/rq-blackouts.v1.json
   RF1116_DISK_FLOOR_GIB=150
   ```

   `QRP_VAR_ROOT` is the migrated-copy authority; ledger front doors receive
   its `ledger/` child so they read `/srv/research-lane/qrp/var/ledger/research`
   and never create a parallel `/srv/research-lane/qrp/var/research`.
   During the QRP-var switch, ops-coord may additionally set colon-separated
   var-root `QRP_VAR_CANDIDATES` and `QRP_VAR_MANIFESTS`. More than one writable
   candidate is `QRP_VAR_DUAL_WRITABLE`; unequal manifests are
   `QRP_VAR_MANIFEST_MISMATCH`. Both fail closed before `run.sh` starts.
3. Copy the two unit files into `~/.config/systemd/user/`, run
   `systemctl --user daemon-reload`, then first run the service by hand and
   inspect `score-timer/ledger.jsonl`, `alert_status.json`, and per-attempt
   hashes under `score-timer/rounds/`.
4. After review, enable with
   `systemctl --user enable --now rf1116-score-timer.timer`.

The append-only supervisor ledger is hash-chained. A corrupt line stops the
tick and writes `LEDGER_TAMPER` to `alert_status.json`. Other alerts are one per
round and code in the same status file for the external alert-checks reader.
The supervisor never passes field exclusions and never kills a score container.
