# #137 ops-coord switch and rollback runbook

This runbook is for ops-coord in the Wed 11-25 11:35–12:30 CST serialized QRP
writer window.  Codex does not execute it.  Do not run in a migration common
X-14/X-15 blocked window.

## Preconditions

1. Reviewed QRP commit, this delivery's SHA256SUMS, Linux tests, real node
   v23.11.0 mark/through, relay shadow comparison, registrar byte comparison,
   and #132 R-17A/R-17B independent review are all PASS.
2. The two services/timers and 0600 env are staged but disabled.  Their paths
   and pinned SHA read back exactly.  HK write R-17A is disabled; R-17B may be
   enabled only for the reviewed shadow pull.
3. Pause every QRP writer named by ADDENDUM_1: research web, review-loop import,
   relay, registrar, and RF1116/AQ writers.  Verify quiescence before copying.

## Copy and prove the single var

1. Refuse any symlink or non-regular object in the Mac var.  Copy the complete
   Mac `quant-research-platform/var/` to a new Linux staging directory without
   deleting or overwriting the current authoritative candidate.
2. At each root, with `LC_ALL=C`, generate a relative-path manifest over every
   regular file: `find . -type f -print0 | sort -z`, then SHA-256 each NUL-safe
   path.  Store the Mac and Linux byte forms separately.  Refuse on a missing,
   extra, or unequal line; never choose one copy silently.
3. Atomically select the verified Linux candidate as
   `/srv/research-lane/qrp/var`.  Re-generate the Linux manifest there and
   byte-compare it again with the Mac manifest.
4. Make the Mac `quant-research-platform/var/ledger` recursively read-only as
   the `kayla` user.  Read back that a create probe is refused; delete only the
   probe's never-published temporary name if one exists.  Write
   `mac-var-mode.json` with schema `QRP_MAC_VAR_MODE_PROOF_V1`, the checked
   absolute Mac path, and JSON boolean `writable:false`.  Copy this proof and
   both manifests to the fixed Linux migration paths.
5. Run each runner's authority guard.  Only after all checks pass, create
   `/srv/research-lane/qrp/AUTHORITATIVE` atomically.  Creation of this marker is
   the switch flag; never create it before the Mac read-only and manifest
   evidence exists.

## Switch and read back

1. Stop/bootout the Mac relay and every other Mac QRP writer; move plists to the
   reversible disabled directory.  Read back absent/inactive.
2. Select the reviewed #132 phase: R-17B read enabled; R-17A enabled only now,
   with fixed rrsync root `/var/lib/research-queue/inbox`.  Decode and hash the
   first audit command bytes before using them as phase evidence.
3. Enable/start the Linux registrar and relay timers in the same serialized
   step as #131/#133/#134 and the AQ/RF1116 writers.  Read back enabled timers,
   inactive completed oneshots, success status JSON, fixed QRP root/data paths,
   and no `RQ_SEEN_MARK_QRP_ROOT` value.
4. Send one reviewed fixture through each direction.  Verify SHA-256, W05 mark
   then `through`, receipt schema/request SHA, mode 0444, no unexpected gate
   command, and no second writable ledger.

## Rollback

1. `disable --now` both Linux timers/services and every other switched Linux
   QRP writer; read back inactive.  Do this before touching the Mac.
2. Atomically restore the prior #132 allowlist/phase, with R-17A disabled.
   Remove the Linux authority marker only after all Linux writers are inactive.
3. Restore Mac write permission and read it back, move each plist back, then
   bootstrap the Mac writers.  Verify one writer only and compare manifests;
   do not merge divergent copies.  Preserve Linux var read-only for diagnosis.
