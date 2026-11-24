# QRP research web private-edge handoff

This is an ops-coord/Owner runbook. The PR installs, enables, deploys and retires
nothing. Its implementation state can become ready without any external
credential; runtime remains `NOT_VERIFIED` until every check below has evidence.

## Chosen design

Option B keeps the canonical dynamic, read-only `apps/research-api` process on
Linux loopback (`127.0.0.1:4311`). A remotely managed Cloudflare Tunnel exposes
it only through a Cloudflare Access application whose policy allows the Owner-only.
This avoids a second implementation of QRP decisions and preserves the dynamic
strategy selector. There is no Pages/R2 upload, so the Mac wrangler OAuth and
the X-01 R2 token are not used or copied by this job.

The persistent origin and tunnel deliberately have services, not timers. Their
`Restart=on-failure`/`RestartSec=30` semantics replace launchd KeepAlive. Both
write fixed logs, use `OnFailure=ops-notify@%n.service`, CPU affinity, bounded
memory, Nice 10 and best-effort IO priority 7.

## External prerequisites — never performed by Codex

1. Merge/review #137 so the pinned QRP tree contains its single authority
   producer `deploy/research-queue/linux/relay-run.py::guard_qrp_var`.
2. Finish #134's desk switch and make its pinned checkout path the
   `QRP_DESK_ROOT`. Finish #131 or seed its Mac mirror read-only at
   `QRP_DESK_REVIEW_LOOP_ROOT`. Generate and compare only after #134.
3. Ops downloads an official pinned cloudflared binary, verifies the publisher
   checksum, and records the version/path. The Owner creates a dedicated tunnel
   and writes its token, without logging it, to
   `/home/kayla/.config/cloudflared/qrp-research-web.token` (kayla, mode 0600,
   nonsymlink). Codex never reads, creates, prints or copies it.
4. In the Cloudflare dashboard the Owner creates an Access application for the
   QRP hostname, an Owner-only allow policy, and a default deny. The tunnel
   service points to `http://127.0.0.1:4311`; Origin Request `HTTP Host Header`
   must be `127.0.0.1:4311`, preserving the origin's loopback Host check.
5. Keep `QRP_RUNTIME_TOKEN` and `QRP_RESEARCH_TOKEN` unset. Runtime pull/receipt
   stays 403 and research access is enforced by loopback plus Access.

## Files-only installation preparation

Ops pins one reviewed QRP commit under `/srv/research-lane/qrp/code/<sha>` and
copies `authority.py`, `web_run.py`, `tunnel.py`, and `parity.py` to
`/srv/research-lane/ops/qrp-research-web/`. It creates
`/srv/research-lane/ops-logs/qrp-research-web/` and the two names-only env files
mode 0600. The example starts with `QRP_WEB_EDGE=OFF`; no upload or edge action
can occur. Run `web_run.py --check` and `tunnel.py --check` only after filling
the paths; the latter must still refuse `QRP_EDGE_DISABLED` until the Owner gate.

Before the switch, use `PRE_SWITCH_COMPARE` only with the read-only mirror
`/srv/research-lane/mirror/mac/qrp-var`. The wrapper refuses a writable mirror,
an active authority marker, or unequal manifests as `QRP_VAR_DUAL_WRITABLE` or
`QRP_VAR_MANIFEST_MISMATCH`.

## Parallel evidence and switch

1. With edge OFF, start only the loopback origin for one compare cycle. Capture
   the frozen five routes from the live Mac and Linux (Linux through an SSH
   local forward), then run `parity.py compare-qrp`. PASS is 5/5 equal statuses,
   content types and normalized SHA-256; only runtime health `generatedAt` is
   masked. Keep the two snapshots and result.
2. Enforce the 150 GiB research-disk floor. The full migration footprint must
   stay within the common 3 GiB plus recorded daily growth.
3. In the joint Wed 11:35–12:30 authority switch, copy and compare the Mac/Linux
   var manifests, make the Mac ledger read-only, write its mode proof, and
   create `/srv/research-lane/qrp/AUTHORITATIVE` last. Change the env atomically
   to `POST_SWITCH`, `/srv/research-lane/qrp/var`, and its `ledger/`. Move all
   QRP writers in the same step; do not silently select a copy.
4. As X-47 requires, remove only the `qrp-var` pair from
   `mac-mirror-to-linux.sh` at the switch and preserve a pre-edit copy. Do not
   keep overwriting the Linux authority from the Mac.
5. Ops may now enable the origin. Only after the Owner's Access/tunnel setup is
   recorded does ops change `QRP_WEB_EDGE=ON` and enable the tunnel. Prove an
   unauthenticated browser is denied and the Owner session can open the page,
   select a strategy, read the result/reason/evidence/uncertainty/actions, and
   make no research or runtime write. This is product evidence, not a 200-only
   check.

## Mac desk panel retirement

After #134, create the authoritative desk route JSON from each pinned desk
checkout's exported `ROUTES`, capture Mac and HK snapshots with `parity.py
capture-desk`, and compare them against the exact switch-manifest commit. PASS
requires: both commits equal that expected commit, the route sets are equal,
and every route follows redirects to final HTTP 200. Only then may ops run:

```text
launchctl bootout gui/501/com.upmeai.portfolio-desk-panel
launchctl print gui/501/com.upmeai.portfolio-desk-panel  # must say not found
move the plist to ~/Library/LaunchAgents.disabled-20261123/
```

HK `portfolio-desk-panel.service` and `desk-pages-publish.service` remain the
serving authority. Save the parity result and launchctl readback.

## Rollback — mandatory X-11 order

Stop Linux first: `systemctl --user disable --now` both the tunnel and origin,
then read back inactive for both. Remove the authority marker only as directed
by the joint #137 switch runbook, restore the Mac var mode and the preserved
mirror pair, and verify the Mac authority. Only after that readback may ops move
the saved plist back and run `launchctl bootstrap gui/501 <plist>`. Never start
the Mac while Linux is still serving or writing. Reversing a V6/desk switch also
reverses this desk retirement dependency.

Pending evidence remains: independent review, cloudflared checksum/install,
Owner token and Access policy, live route parity, Owner browser journey,
authority switch, desk parity, install/enable, Mac retirement, and rollback
rehearsal. Until recorded, runtime and product delivery are `NOT_VERIFIED`.
