# Ops-coord install procedure — PROPOSED

Do not install until plan-coord has signed `JOIN_MAP_V1.proposed.json`, supplied
its exact SHA-256 and accepted the #159 PR. Codex does not run these commands.

The checked-in service is a template. Replace `@QRP_REVIEWED_SHA@` exactly once
with the accepted 40-lower-hex commit; never use a branch, tag, `current`, or a
symlink. The template path
`/srv/research-lane/research-queue/code/@QRP_REVIEWED_SHA@` renders to the
immutable tree for the exact reviewed QRP commit and is used for both
`WorkingDirectory` and `ExecStart`.

Before rendering, refuse unless the code root and every parent are real
directories, the root basename is the exact reviewed QRP commit, every tree
entry matches the independently approved tree manifest, and `sha256sum -c`
reports no missing or extra entry. Verify the reviewed owner and mode for every
entry (no group/world-writable entry), the manifest's executable bits, the
tree-manifest SHA-256, and its binding to the accepted commit. Render in a new
private staging directory; reject any remaining `@QRP_REVIEWED_SHA@` or
`/code/current`. Record the rendered unit's SHA-256, install those exact bytes,
then read back and verify the same SHA-256 before `daemon-reload`.

The runtime prerequisites remain fail-closed: the reviewed deploy commit must
replace every `PINS_NOT_SET`, bind the signed `JOIN_MAP_V1` SHA-256 and rev-F
freeze bytes, and pass rev-F T01 byte identity. The authoritative config must
still refuse before the QRP_VAR switch. A scratch-config `--check` against the
real frozen inputs must return `NO_CHANGE`; no timer is enabled otherwise.

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
