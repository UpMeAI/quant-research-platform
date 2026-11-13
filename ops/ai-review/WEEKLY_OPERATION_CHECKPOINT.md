# Weekly operation input checkpoint — incomplete weekly integration

Authority: Q70 BRIEF §§1/2/4 and Desk OPERATION_REVIEW_V1. The adapter reads explicitly selected SHA-bound files and delegates the complete listing to trusted startup-injected Desk planIntake, including canonical freshness and day/trade cross-file checks. It projects only the exact week's selected book, preserves nulls and provenance, and never substitutes another week.

Only operation facts are covered. CN aggregate cannot stand in for INDEX/STOCK. Complete attribution, rule changes, weekly CLI/schedule and directions assembly remain pending. Weekly reconciliation remains WEEKLY_BINDING_PENDING. Do not promote slice READY to complete weekly coverage.

Pre-review checkpoint:
1. Scope: one new read-only adapter, one new boundary test, this note.
2. Existing isolated codex/q70-ai-review; prior head 0574dcacc8217ac85167d61362321d48c750c551.
3. Missing-module red; 6 new tests green. Stale fixture report date corrected to follow its requested period; production date guard retained.
4. Related tests16/16, no skips/failures; heavy-run light and concurrency1.
5. New-head full regression not run; old-MBP-only rule retained. Prior results do not certify this diff.
6. git diff --check passed.
7. No frozen/source/sealed files modified; all changes additive new files.
8. Existing switch/core/runner untouched; adapter not wired to schedules yet.
9. No production write, merge, deploy or producer change.
10. No secrets or environment files read/copied/printed.
11. No migrations/config/contracts/schemas changed.
12–15. Not a deploy script; no runtime/install certification.
16. Partial checkpoint, not PR_OPEN or complete acceptance.
17. DEFAULT_A: canonical intake reused, no duplicate business validation.

Next: trusted weekly source-list/CLI wiring, complete coverage, real intake dry-run, then old-MBP regression and PR update. Tests use a fake intake at the adapter boundary, not proof abbreviated fixtures satisfy the producer schema.

## Weekly command checkpoint

The weekly command now consumes an explicit period-bound SHA manifest and loads
Desk planIntake only from the trusted startup root. It emits all seven required
book reports plus one global directions artifact. Missing/stale remain distinct;
completeWeeklyReady remains false until missing attribution/rule-change and CN
part facts are connected. Carry stale handling was corrected in the runner after
the new CLI test exposed a scope rejection; no READY carry model input is enabled.

Checklist delta: (1) added weekly command, CLI, four tests and disabled plist;
updated existing runner to preserve carry INPUT_STALE and README. (3) missing
module red and stale-carry integration failure preserved. (4) related13/13 pass,
0 skip; heavy-run light serial. (5) new-head full not run, old-MBP requirement
unchanged. (6) diff-check and plutil lint pass. (7–11) no frozen, producer, schema,
config, production or credential changes. (12–15) plist is placeholder-only,
disabled, uninstalled; no live scheduling claim, no deployment script. (16) local
checkpoint only, not PR_OPEN. (17) reuse canonical intake, writer and CST gate.
The remaining completeness work in the prior checkpoint is still outstanding.

## Real-source dry-run and producer-readiness correction

A real SMARTFLOW_US week (2026-11-02..06) plus 34 explicitly bound source files
was read through the actual Desk planIntake, using historical as-of
2026-11-09T01:05Z. No input was rewritten; no model called. Both US books retained
one accepted operation fact. Their own readiness says DEGRADED and weekState says
INCOMPLETE: the 11-02 day file was not delivered. The adapter previously projected
accepted-but-incomplete facts as slice READY; a red test reproduced this and it now
preserves the producer's readiness in fact data and returns INPUT_MISSING.

New related run14/14 passes (heavy-run light, serial). Real dry-run emits7 book
reports plus1 directions report, all incomplete, zero fetches. Full new-head
regression and complete-input integration remain outstanding. Evidence retained
in Owner queue70/evidence/weekly-us-dryrun-result.json and weekly-incomplete-*.log.
This historical replay is not production observation or a complete weekly report.

## Weekly attribution integration

Weekly attribution now reuses readDeskDailyPacks' canonical per-book/hash/schema
validation and selects only the exact producer WEEK from/to. SINCE_OPEN and other
books cannot substitute. The producer's PARTIAL/UNKNOWN/null and reason codes are
retained, not converted to zero or inferred values. CLI manifests may explicitly
select attributionSourceFile and attributionDate per request; trusted validator
still loads only from startup deskRoot. Evidence provenance is kept in each fact.

Red: new module missing and CLI missing attribution fact. Green:19/19 related,
HEAVY_RUN_NO_CACHE=1, light serial. Real historical US dry-run now consumes35
selected source files and gives each US book2 facts (operation + attribution),
zero model calls. It remains incomplete because the source week lacks11-02 and
rule-change coverage is unbound. No new-head full run claimed.

Required rule-change producer spec exists at Desk
 docs/rule-changes/RULE_CHANGE_LEDGER_COMPILER_SPEC.md, but its documented
RULE_CHANGE_LEDGER.json was not found in the inspected docs or local inbox.
The compiler spec is not the delivered ledger; do not invent an empty ledger or
infer that no rule changed. Complete weekly coverage remains false.

Checklist delta: only QRP adapter/CLI/test/doc changes; no source/schema/frozen
files changed; no production/model calls. No schedule installation. Full regression
from f513a21 does not cover this diff. Partial checkpoint, not release approval.
