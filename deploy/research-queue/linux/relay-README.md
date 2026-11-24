# Linux research-queue relay and TRL registrar

Files-only #137 delivery.  Nothing in this directory installs, enables,
switches, or deploys a unit.

The relay moves Linux fact packs locally, marks them through the QRP W05 front
door first, sends HK packs through the #132 forced-command gate, and returns
Linux/HK queue results to the one authoritative QRP var.  The registrar scans
only `<run>/outbox/trl-requests/<sha>.json`, invokes the pinned QRP CLI, and
publishes the matching sibling `inbox/trl-receipts/<sha>.json` create-only.

Both runners distinguish the migrated var root
`/srv/research-lane/qrp/var` from the ledger front-door data directory
`/srv/research-lane/qrp/var/ledger`.  Before a live pass they require the
authority marker, equal full-var manifests, a Mac-read-only proof, and one
writable Linux var.  Named refusals are `QRP_VAR_DUAL_WRITABLE` and
`QRP_VAR_MANIFEST_MISMATCH`.

Ops-coord installs one names-only env file from `relay-env.example` mode 0600.
The QRP code path must end in the exact pinned 64-hex commit.  No secret is in
the examples.  `RQ_SEEN_MARK_QRP_ROOT` is empty and removed from the marker's
environment; the relay alone calls `review_pack_seen.js`.

Read-only/pre-switch modes:

```text
relay-run.py --dry-run
relay-run.py --shadow-root /srv/research-lane/scratch/q137-shadow/<cycle> --no-upload
```

The first only inventories names/hashes and W05 settings.  The second pulls HK
and copies Linux returns to the stated scratch root; it never marks or uploads.
Compare its JSON with the Mac snapshot using `relay-compare.py`.  Compare direct
Mac and isolated-Linux registrar fixture receipts using
`trl-registrar-compare.py`; bytes must be identical.

Live status files have closed schemas with `lastOkAt`, `rc`, counts and an
error.  Logs are fixed under `/srv/research-lane/ops-logs/`.  `rc != 0` is an
alert and never triggers a permissive fallback.

Deterministic acceptance is described in the task's frozen acceptance and
amendments.  Run it only on Linux/old MBP.  The real-rsync form capture is
`relay-capture-forms.py`; its two captured commands are frozen in
`FORMS_FROM_137.md` for #132.
