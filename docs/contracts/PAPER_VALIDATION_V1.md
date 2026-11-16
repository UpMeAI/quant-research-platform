# PAPER_VALIDATION_V1 — out-of-sample paper validation (RF1116 §5)

Source: `artifacts/coordinator/RESEARCH_FRAMEWORK_AMENDMENT_20261116_FACTOR_LIBRARY_AI_MINING.signed.fd22876f.md`
(sha256 `fd22876f…0c80`, signature page `39f8c17c…`), §5.1–5.4, §8.1 row V1, §8.2, §8.3 item 5.

Code: `services/shadow-control/paper-validation.js`. Ledgers: `shadow/paper_validations.jsonl` (registrations),
`shadow/paper_validation_evaluations.jsonl` (evaluations). It never writes `shadow_runs`, `shadow_observations`
or `virtual_ledger`, so existing shadows (`SHD-…`) behave as before.

## Two kinds of registration

| kind | who | rules |
|---|---|---|
| `NEW` | an entrant promoted by a closed `RACE_V2` race | §5.3 defaults below |
| `EXISTING` | the five forward shadows of §5.4 | copied from each shadow's own seal or freeze page (`existing-shadows.v1.json`): every field is a verbatim quote with source path + sha256, or 「未写」; no defaults are filled in, and §5.3 evaluation does not apply. Recorders keep running; QRP only reads their records. Updates are append-only. A purely additive change appends a row with `supersedes` (the old `record_hash`), `supersede_changes` and `superseded_at`, and leaves the old row byte-identical. Additive means: existing quotes kept byte for byte as a prefix, 未写 filled with a quote, a new source added, or `unverified` changed. Editing or removing an existing quote or source, or changing the shadow's identity, is refused (`EXISTING_REGISTRATION_CHANGED`). A source whose title still says 草稿 can carry `freeze_record`: the `## 冻结` sentence, checked byte for byte, plus the coordinator queue line, checked for presence because the log is append-only. |

## §5.3 defaults (NEW only)

| item | rule | code |
|---|---|---|
| start | next trading day after the race closes (market-local date of `closed_at`, against the given calendar). Pre-registration is read literally: registering on the start day at or after that session's open (A-share 09:30 +08, US 09:30 America/New_York, crypto 00:00 UTC) moves the start to the next trading day and records `start.shift {reason: START_SHIFTED_REGISTERED_AFTER_OPEN, original_date, open_at}`; registering on a later date is refused | `START_NOT_NEXT_TRADING_DAY_AFTER_RACE_CLOSE`, `START_BEFORE_REGISTRATION` |
| minimum sample | sessions ≥ max(60, 20 × holding period in trading days); discrete-trade books also need fills ≥ 30. Below that: `DESCRIBE_ONLY` | `RUNNING_DESCRIBE_ONLY` |
| run fault (lookahead, data contamination, run error) | pause; counted samples are voided; counting restarts on the fix date | `PAUSED_RUN_FAULT` |
| economic falsification | forward max drawdown of the counted sessions > 1.5 × the entrant's backtest max drawdown (from the race outcome), or the registered mechanism is falsified → stop, negative result. A backtest drawdown of 0 is refused at registration | `STOPPED_NEGATIVE`, `BACKTEST_DRAWDOWN_ZERO` |
| expiry | start + 12 months; not enough sample by then (or at any later time) → close, 证据不足, no extension | `CLOSED_INSUFFICIENT` |
| promotion gate | `CLAIM_ELIGIBLE` AND paired forward NAV over the same counted sessions not below the champion AND no guardrail breach since start AND run healthy | blockers `NOT_CLAIM_ELIGIBLE`, `NAV_BELOW_CHAMPION`, `GUARDRAIL_BREACH`, `RUN_NOT_HEALTHY` |

Registration is frozen before the run: one registration per race entrant (`ALREADY_REGISTERED`).
Terminal states are sticky: no evaluation is recorded after `STOPPED_NEGATIVE` or `CLOSED_INSUFFICIENT`.

Evaluation input is read from the recorder's rows: `sessions[{date, challenger_logret, champion_logret, fills}]`,
`faults[{kind, detected_on, fixed_on, ref}]`, `mechanism_falsified`, `guardrail_breaches`, `run_health`, `source{ref, sha256}`.
Within a day the order is fault detection, fix, mechanism, then the session.

## Promotion

`createPromotionCandidate` (strategy-control-plane) takes an optional race route: `race_manifest_ref {race_id, manifest_sha256}`
and `paper_validation_refs`. If either is given, both are required, the race must be a closed `RACE_V2` with that manifest sha
and market, each validation must be a `NEW` registration of that race whose shadow is in `shadow_forward_refs`, and its latest
evaluation must pass the promotion gate. The candidate row then also carries `race_manifest_ref`, `paper_validation_refs` and
`paper_validation_gate`. Without the race route the legacy path and row shape are unchanged.

## Checking the five existing registrations

`verifySources()` reads each cited source (coordinator directory: `QRP_COORDINATOR_DIR`, default `../artifacts/coordinator`;
smartflow git objects: `QRP_SMARTFLOW_REPO`, default `../smartflow`), checks its sha256 and that every quote occurs byte for byte.
Sources it cannot read are reported `ABSENT`, never treated as a pass.
