# K2_FREEZE_PROGRAM_V1 (K2 freeze by program; RF1118 r2, AUTONOMOUS_RESEARCH_QUEUE_V1 Q3)

- Basis (frozen, bound by path and sha256, outside git):
  - `AUTONOMOUS_RESEARCH_QUEUE_V1.draft.md` rev 4, sha256 `52418471f1b0c6aea58f65b74352fe415defebaeb8045b357104f40b0794570e` (FROZEN by `AUTONOMOUS_RESEARCH_QUEUE_V1_FREEZE_1.md`, `3681e292`); the freeze page wins where they differ.
  - `RF1118_AI_PREREG_AMENDMENT_FREEZE_1.md` sha256 `ae8f24910c62dd0c2a14c52b6d1cb8fc2913297f52cc396fbee0985fb7092309`, text revision 2 `61e7c280…`, effective `2026-11-18T15:48:18+08:00`; stars P1-P6 all (a).
- Rule: freezes are made by this program; an AI only drafts. No model call, no network access and no clock read exist in `services/k2-freeze-program/`. The host clock arrives as `ctx.now` (`+08:00`).
- Code: `services/k2-freeze-program/`, `config/k2_decision_table_templates.v1.json`, `apps/research-cli/{k2_freeze_program,k2_trl_registrar,k2_bundle_builder}.js`. Tests: `tests/k2_freeze_program_*.test.js`. Public repo: no hosts, secrets or desk data.
- Production effect: NONE. The program writes only under `ctx.outDir/<draft_id>/`.

## 1. Flow

1. `prepare(draft, ctx)`: gates (RF1118 bound and effective, mode, class), revision limit, then V1-V8, V10, V11, V14 and the id/clock part of V12 over the draft. It renders the K2 text, builds `TRIAL_REGISTRATION_REQUEST_V1` and returns `WAITING_EXTERNAL:TRL_RECEIPT`, or `REFUSED` with reason codes, or `WAITING_FREEZE` (the draft goes to the coordinator freeze path).
2. The Mac registrar (`k2_trl_registrar.js`) registers every arm through the trial ledger front door as `PREREGISTERED` and returns `TRIAL_REGISTRATION_RECEIPT_V1` (TRL ids, `registered_at`, family N). Idempotent.
3. `finalize(draft, receipts, ctx, prepared)`: re-runs everything, then V9, V12, V13. Fourteen passes: writes the frozen text, its `.sha256`, the prior-conclusion table (+ `.sha256`), the validation report (+ `.sha256`) and the freeze page `<ID>_K2_V1_FREEZE_PROGRAM_1.md` (+ `.sha256`), all 0444, and returns the queue line. Otherwise writes a refusal file (0444) and returns codes only to the agent. A replay of a finished freeze returns what is on disk.
4. The relay appends the returned `K2_PROGRAM_FROZEN <ID> <k2 sha> <page sha> <market> <host>` line to the queue log, idempotent by k2 sha (`queue_line.ensureLine`).

`prepare`'s K2 text includes the prior-table sha, which depends on `as_of` (the prepare-time `ctx.now`); `finalize` takes `prepared.as_of`, so the text, its sha and the TRL rows' `k2_sha256` do not move. A draft that no longer renders to `prepared.k2_sha256` is refused (`PREREG_ARTIFACT_PREPARED_MISMATCH`).

## 2. Validators and reason codes

| V | Check (service reused) | Codes |
|---|---|---|
| V1 | `K2_DRAFT_V1` structure: sections, types, enums, no unknown keys, no forged tokens in free text, the 8 desk items, no deviation codes | `PREREG_SCHEMA_{MISSING,TYPE,ENUM,EXTRA_KEY,DUPLICATE,REFERENCE,TEXT_FORBIDDEN,DESK_ITEM_MISSING,DEVIATION_NOT_ALLOWED}` |
| V2 | decision table only from `K2_DECISION_TABLE_TEMPLATES_V1`; the drafter picks the template only: `alpha` 0.05, `ci_level` 0.95, `power_target` 0.8 are fixed values (no ranges); `margin_sd` (non-inferiority) must equal the registered risk rule the question cites (`ctx.riskRules[rule_ref]`), no registered margin refuses | `PREREG_DECISION_TABLE_{UNKNOWN_TEMPLATE,FREE_TEXT,PARAM_MISSING,PARAM_TYPE,PARAM_FIXED,PARAM_UNKNOWN,MARGIN_NOT_REGISTERED,MARGIN_MISMATCH}` |
| V3 | `ctx.powerOutputs` (the bundle's POWER_OUTPUTS) must be the power tool's own output at the fixed rates; the draft's power block and the table's `min_sample_n` / `min_effect_sd` are exact copies; numbers in the criteria text are tool numbers or the fixed rates | `PREREG_POWER_MISMATCH`, `PREREG_POWER_OUTPUTS_MISSING`, `PREREG_POWER_INPUT_INVALID` |
| V4 | `research-mechanism-register` `query()` routing (refuse `NOT_DO_SETTLED`, `ATTACH_TO_SHADOW`, `QUARTERLY_ABLATION`), then `gate.js` `check()` on the rendered K2 | `PREREG_ROUTED_*`, `MECHANISM_*`, `AI_ROLE_*`, `K2_SECTION0_*` |
| V5 | G-CAUSAL scope (`CF:` or `N/A` code, Addendum 1 fill rule) and function-level evidence (`causality-gate` parse and constants) | `CAUSAL_*` |
| V6 | `parity-gate` `check()` on the rendered K2 | `PARITY_*` |
| V7 | no new formula (RF1116): components only by id from the factor library, registered readings and rule parts; scalar or identifier parameters only | `PREREG_FORMULA_FORBIDDEN:*` |
| V8 | data scope: local inventory, no fetch, no unseal, no production config, no first read of an `UNSEEN` segment (P3), labels recomputed from the ledger | `PREREG_DATA_*` |
| V9 | every arm has a `PREREGISTERED` row, `k2_sha256` equal, `registered_at` strictly before `k2_frozen_at` (`trial-ledger/gates` `checkPre` plus the strict check), receipt matches the ledger snapshot | `TRIAL_LEDGER_*` |
| V10 | isolation proof from the run receipt: read-only bundle mount, no network, model only via the gateway socket, canaries unreadable, bundle from the deterministic builder | `PREREG_ISOLATION_{RECEIPT_MISSING,RECEIPT_INVALID,HOST,MOUNT,NETWORK,MODEL_PATH,CANARY,CANARY_UNKNOWN,BUNDLE,UNKNOWN}` |
| V11 | market and host agree (CN_A on Linux, US_EQUITY and CRYPTO on HK), live-signature topics are research-only, caps (2 per market per CST week, 6 per CST month, 20 counted arms) | `PREREG_SCOPE_*`, `PREREG_CAP_{WEEK,MONTH,ARMS}` |
| V12 | artifact id and clock format, no different freeze already on disk, 0444 after writing | `PREREG_ARTIFACT_{ID,CLOCK,EXISTS,MODE,PREPARED_MISMATCH,NO_OUTDIR}` |
| V13 | no other `K2_PROGRAM_FROZEN` line already exists for this k2 sha | `PREREG_QUEUE_LINE_DUPLICATE` |
| V14 | `(prompt sha, schema sha, model)` is an `AI_PREREG` admission | `PREREG_PROMPT_NOT_ADMITTED` |

Human-authored drafts: V10 and V14 are `NOT_APPLICABLE` with the frozen reason `HUMAN_AUTHORED` (never a silent PASS). States are `PASS`, `REFUSED`, `NOT_APPLICABLE`, `PENDING` (needs the receipt), `NOT_RUN` (an earlier structural failure; not a pass). Pre-checks outside the validators: `PREREG_RF1118_NOT_FROZEN`, `PREREG_RF1118_NOT_EFFECTIVE`, `PREREG_MODE_DRAFT_ONLY`, `PREREG_CLASS_DOWNGRADED` (all `WAITING_FREEZE`), `PREREG_REVISION_LIMIT` (revision above 3).

A thrown error inside a validator is a refusal with its code, never a pass.

Named constants a later RF1118 note may change in one place: `rf1118.CAPS` (stars P4), `rf1118.DOWNGRADE_CLASS_RULE` / `rf1118.classOf` (the downgrade "class" is `<market>:<mechanism-layer-prefix>`, plan-coord ruling 11-22; `*` in `ctx.downgradedClasses` means every class), `validators.REFUSED_ROUTES`.

V9 clock rule (plan-coord ruling 11-22): fail closed. A TRL row not strictly before `k2_frozen_at` is refused with `TRIAL_LEDGER_PRE_REGISTERED_AFTER_FREEZE:<id>:registered_at=<t>:k2_frozen_at=<t>:diff_ms=<n>:<kind>`, `<kind>` = `SKEW_POSSIBLE` (difference within the two hosts' NTP offsets plus tolerance), `ORDERING_ERROR` (larger) or `CLOCK_OFFSET_UNKNOWN` (no preflight). The preflight (`k2_clock_preflight.js`, `clock_preflight.js`) parses saved NTP status text of both hosts (`chronyc tracking`, `timedatectl`, macOS `sntp`) into `ctx.clockOffsets`; unparseable status is an error, never zero.

Authors: a human-authored draft must carry a real `session_ref` (not empty or a placeholder, `PREREG_SCHEMA_AUTHOR_IDENTITY_MISSING`); the author is recorded in the freeze page. V5 (plan-coord ruling 11-22): function-level evidence from a pre-freeze harness run at the pinned code sha is checked with the gate's own rules; the K2-bound re-run is still checked by the existing gate at seal import.

Seams with the merged queue (#139, #140): `ctx.receipt` is the core `RUN_RECEIPT_V1` (key `receipt`, top-level `mounts`) plus an `isolation` block the agent runtime must add (host, bundle sha, network, model calls, canary probes); without it V10 refuses `PREREG_ISOLATION_UNKNOWN:isolation`. `ctx.admissions` uses the `RQ_PROMPT_ADMISSIONS_V1` entry shape; the AI_PREREG system text and its proposed entry are in `prompt.js` (the coordinator moves the entry into `config/research_queue_prompt_admissions.v1.json` as ADMITTED; that file is not edited here because the Q2 test counts its entries).

## 3. Revisions and the agent's view

The agent gets reason codes only (`agent_view.codes`). Revisions 0-3 are allowed; a refusal at revision 3 gives `next = WAITING_EXTERNAL:PREREG_REFUSED`, otherwise `REVISE`. Refusal files: `<ID>_K2_V1_PREREG_REFUSAL_<attempt>.<draft sha8>.json`, canonical JSON, 0444, never rewritten.

## 4. Importer acceptance (RF1118 C3, AQ-39)

`program_freeze_gate.js` runs inside `overseas-sealed-verdicts` `checkEntry` (the A-share importer shares it) after G-PARITY. A K2 whose section 0 line `**作者与冻结者**：` says `冻结者 K2_FREEZE_PROGRAM_V1` needs `entry.freeze_program = { page, report }` (bound files) and:

- page sha equals the binding; page `k2_sha256` equals the K2; report sha equals the page's and the binding; 14 results all `PASS` (or `NOT_APPLICABLE:HUMAN_AUTHORED` for V10/V14);
- `entry.k2_frozen_at` equals the page's and is not before RF1118 took effect; the page names the RF1118 freeze sha;
- exactly one `K2_PROGRAM_FROZEN` queue line for the k2 sha, naming this page, draft id and market (`--queue-log <file>` on the importer CLIs; no queue log is `QUEUE_LOG_UNAVAILABLE`, not "no line").

Codes `K2_FREEZE_PROGRAM_{PAGE_MISSING,PAGE_SHA256_MISMATCH,PAGE_INVALID,K2_SHA256_MISMATCH,REPORT_MISSING,REPORT_MISMATCH,REPORT_INVALID,REPORT_NOT_ALL_PASS,FROZEN_AT_MISMATCH,RF1118_NOT_BOUND,BEFORE_RF1118,QUEUE_LOG_UNAVAILABLE,QUEUE_LINE_MISSING,QUEUE_LINE_DUPLICATE,BINDING_ON_UNGATED,FROZEN_BY_INVALID}`. Coordinator-frozen K2s (`冻结者 COORDINATOR`) and K2s without the line are untouched: the lock row gains no field. A passing program freeze adds `program_freeze_gate` to the lock row. The `authored_by` / `frozen_by` fields are provenance only; no AI-input category is added (the draft author is not a research arm's input).

## 5. Revocation, audit (RF1118 section 3, AQ-41)

`revocation.write` (coordinator tool, not used by the agent) writes `<ID>_K2_V1_FREEZE_PROGRAM_1_REVOCATION_1.md` (0444). The freeze page, text, report, sidecars and queue line stay byte-identical; `statusOfRuns` reads finished runs as `REVOKED_AFTER_RUN`; the ledger is untouched, N does not move. A second revocation page is refused.

## 6. Other pieces

- `templates.js` + `config/k2_decision_table_templates.v1.json`: three templates (`DT-DELTA-VS-BASELINE-V1`, `DT-NON-INFERIORITY-V1`, `DT-SIGNAL-HIT-RATE-V1`); outcome rules in words (INSUFFICIENT is not a rejection; the mapping to do / not-do stays in the verdict program); every number is fixed, copied from the power outputs or from the registered risk rule (plan-coord review of #142); the library sha256 is pinned both in the file and in the code.
- `power.js`: `n = ceil(((z(1-alpha/2) + z(power)) / effect_size_sd)^2)`, z rounded to 6 decimals.
- `bundle.js`: `K2_BUNDLE_V1` builder; whitelist of kinds; forbidden path segments (`sealed*`, `holdout*`, `vault`, `race*`, `paper*`, `production*`, `restore_*`, `out`, `.git`, `.env*`), DB-dump extensions, symlinks resolved before the check, canary content refused; bytes depend only on inputs and the injected `built_at`.
- `canary.js`: planted canaries in sealed-like directories; the start self-test passes only if every read is refused; a missing canary is UNKNOWN (AQ-38).
- `registrar.js`: the Mac-side TRL registration (V9 hand-off).

## 7. Interfaces with other pieces (file contracts, no code coupling)

- Queue (Q1) / agent (Q2): `ctx.admissions`, `ctx.receipt` (`RUN_RECEIPT_V1` of the agent run: mounts, network, model calls, canary probes, bundle sha), `ctx.bundle`, `K2_DRAFT_V1` in, reason codes out, `TRIAL_REGISTRATION_REQUEST_V1` out and its receipt in, the queue line out. The program is run by the queue on Linux for every market.
- Template pins (`config/research_queue_template_pins.v1.json`) and the `T-AI-PREREG-V1` evidence matrix belong to the queue core and its freeze page, not to this contract.
