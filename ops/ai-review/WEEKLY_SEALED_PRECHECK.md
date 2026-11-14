# Q70 weekly sealed-input binding precheck

Implementation slice only; full weekly review/reconciliation remains unavailable.

1. Scope: new `services/ai-review/weekly-sealed-input.js` reads verified sealed
   inputs; existing `sealed.js` only exposes its already-authoritative STORES
   registry; six synthetic tests; additive slice acceptance and checkpoint.
2. Base `3735066871ba4f7066062ce3553ef1e626b3c01c`, isolated
   `wt-qrp-q70-daily-cli` / `codex/q70-daily-cli`, per parent continuation.
3. Red: `Cannot find module '../services/ai-review/weekly-sealed-input'`.
   Green: six new cases pass, including enabled core run with fake fetch staying
   INPUT_MISSING, zero calls and no credential/file access from the model path.
4. Serial related suite: 19 pass, 0 fail, 0 skip (new binding, canonical sealed
   return, frozen reconciliation vocabulary), 8239 ms rounded.
5. Full suite/heavy build NOT RUN or retried: explicit CST 09:15–15:30 restriction.
   Previous daily CLI full-regression gap is not promoted to verified by this run.
6. `git diff --check`: PASS.
7. Frozen contracts untouched. Before/after git blob IDs match:
   OVERSEAS_SEALED_VERDICTS_IMPORT_PROFILE_V1.md:
   `2e23186428fb0ad5eb2c0f795cca165dc36a08be`;
   ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1.md:
   `8e4962856c9d1d5645e84452c3c64cf7a8f2f111`.
8. Existing core/runner/CLI defaults unchanged; new binding has no fetch/key path
   or scheduled caller. Its output always has inputState INPUT_MISSING until a
   separate authorized comparison contract is provided.
9. No production write, merge, deploy, install, upstream mutation or other-repo edit.
10. Synthetic temporary sources only; no real key, raw personal input or secrets.
11. No schema/contract/migration/config changes. New task-scoped acceptance only.
12. Deployment preconditions: N/A; no deployment artifact changed.
13. Rollback: N/A; no installation or deployment performed.
14. Production trial: N/A; deterministic synthetic read-only tests only.
15. No scheduler/build/full suite invoked; current heavy-task window honored.
16. Queue/push not performed; commit returned to parent for same Draft PR #77.
17. DEFAULT_A: reuse canonical sealedRows, boundFiles and current-lock sources;
   preserve missing comparison instead of inventing metric meanings or thresholds.

## What this evidence proves

Each request identifies entryId, current resultId and exact registered strategyRef.
The reader snapshots each lock store once, uses only RESULT, checks source
reference completeness against the producer registry and delegates byte/sidecar
verification and verdict projection to the existing canonical code. Wrong, stale,
post-period, missing or drifted sources fail independently. No full shared source
document leaks into a single-unit fact. Source hashes/references remain separate
from verdict data. Existing sealed-return semantics and special cases remain owned
by the canonical service, not duplicated in this adapter.

## Precise missing authority / next action

The import profiles define sealed verdict text and SHA bindings; they explicitly
exclude measured forward values for STATUS entries. HK_FORWARD_OBSERVATIONS_V1
registers location/output references, not a delivered, validated measurement.
Neither establishes a general AI-review metric binding for:

- exact sealed unit ↔ adopted/live/forward module identity (a “做” verdict is not
  deployment evidence);
- expected metric field/units ↔ observed metric field/units, measurement window,
  denominator and annualization/calendar rules;
- the applicable sample threshold and classification rule for each sealed unit;
- delivered forward-byte provenance and applicable trial-gate evidence.

Next exact action: have the completion authority persist/version a task-bound
binding for one supported unit using its existing sealed acceptance and delivered
forward contract, then implement only that deterministic comparison. Until then
`weeklyReady=false`, `comparison=null`, and `WEEKLY_COMPARISON_CONTRACT_MISSING`
remain explicit even when `sealedSourceState=VERIFIED`.

Daily missing inputs, weekly CLI/scheduling, #58 alerts, interruption recovery and
real deployed observation remain pending. This slice does not certify recovery;
no stale-lock ownership rule or retry authority was invented.

## Coordinator amendment 2026-11-14 00:40
The binding reader and core reconciliation path now explicitly emit WEEKLY_BINDING_PENDING. The core refuses the model path even when a caller labels the weekly pack READY; comparison remains null and source state/reason are retained separately. Disabled behavior remains unchanged. Test first failed INPUT_MISSING != WEEKLY_BINDING_PENDING, then 15 core/binding tests passed, zero model calls. No frozen metric, threshold, source file, production config or scheduling changed. Current draft table remains outside the repository in task #70 for coordinator review; no executable mapping is inferred. Prior full-regression evidence is not represented as a rerun for this amendment.
