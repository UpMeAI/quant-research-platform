# Ops-coord install procedure — PROPOSED

Do not install until plan-coord has signed `JOIN_MAP_V1.proposed.json`, supplied
its exact SHA-256 and accepted the #159 PR. Codex does not run these commands.

The unit runs from the installed QRP tree at
`/srv/research-lane/research-queue/code/current`. Installation must refuse if
that path is missing or if it does not resolve to the exact reviewed QRP commit.

1. Copy the signed config bundle into a new staging directory under
   `/srv/research-lane/master-table/config.next`. Verify it there with
   `sha256sum -c SHA256SUMS`; abort on any mismatch. Atomically rename it to the
   reviewed config directory only after all hashes pass.
2. Copy `master-table.service` and `master-table.timer` to
   `~/.config/systemd/user/`, then run `systemctl --user daemon-reload`.
3. Keep `qrp_var_authoritative` false before the 2026-11-25 12:30 CST QRP_VAR
   switch. A pre-switch invocation must refuse `QRP_VAR_NOT_AUTHORITATIVE`.
4. From a scratch root, run `run_master_table.py --check --config <staged>`.
   Against the real frozen inputs it must report `NO_CHANGE`; inspect the
   proposed `run_status.json` and do not publish any file on failure.
5. After the 12:30 switch and all checks, set only
   `qrp_var_authoritative: true` in the reviewed install config, re-hash it,
   start one service run, and verify the live/rev bytes and `run_status.json`.
6. Only then run `systemctl --user enable master-table.timer` followed by
   `systemctl --user start master-table.timer`. Verify the next trigger is at
   `:17`; verify the service has no secret environment and enforces offline
   operation with `RestrictAddressFamilies=AF_UNIX` and `IPAddressDeny=any`.

Rollback disables and stops the timer, restores the prior immutable config
directory, and leaves already-written 0444 revisions untouched for audit.
