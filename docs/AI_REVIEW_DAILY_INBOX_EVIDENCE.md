# Q70 daily inbox slice evidence — not release acceptance

Base c0ff23f4a5c6de335f19ef859ad86bc3261eef6a; isolated worktree/branch
`wt-qrp-q70-ledger-runner` / `codex/q70-ledger-runner`. Additive acceptance:
`AI_REVIEW_DAILY_INBOX_SLICE_V1.md`, bound to Q70 BRIEF. Existing frozen files,
release acceptance and previous evidence remain unchanged.

## Changes and verification

- `daily-inbox.js`: exact delivered producer paths, explicit date, per-book
  availability; no date fallback or producer execution. Rule snapshot presence
  is not a complete daily changes stream.
- `desk-input.js`: reuse its book registration for discovery and retain the
  producer payload hash alongside raw byte hash.
- `runner.js`: retain producer rejection reasons when adding a scope rejection.
- Two inbox tests and one runner regression; checkpoint and this evidence.

Red 1: `Cannot find module '../services/ai-review/daily-inbox'`.
Red 2: runner replaced `NAV_CONTRACT_NOT_REGISTERED` with `DAILY_SCOPE_INVALID`.
Green: 31 related/checker/report/runner/vocabulary tests pass, zero fail or skip.
The latter was an escaped diagnostic defect from c0ff23f: specific producer
failure was lost in delivery, although fetch remained blocked. Original evidence
is preserved; the new regression and fix do not alter frozen acceptance.

Full regression runs serially through heavy-run, launched outside prohibited CST
windows at 23:43, waited for the shared lock, then completed: 605 total,
579 pass, 0 fail, 26 skip, 188701 ms. Existing external-input/optional-fixture skips
remain; none were introduced by this slice.

## Real local evidence (fake model only)

Read-only Desk HEAD: `602365c393fd1622abd012c25e68b07c898d15a0`.
Validator SHA256:
`eb351cf251967b52d915e53f7ef941498fcef1ce9dd7e01296b3cef4f1966011`.
Rule schema SHA256:
`19f6c8ae5648033958c7286eae1b17767e2f6940a733e678384f4ec9cf0b7411`.
The actual validator was injected; no simplified validator certified real inputs.

| Date | Requested books | Three-source READY / fake checker pass | INPUT_MISSING | Complete daily |
|---|---:|---:|---:|---|
| 2026-11-09 | 7 | 2 | 5 | false |
| 2026-11-10 | 7 | 2 | 5 | false |
| 2026-11-11 | 7 | 2 | 5 | false |
| 2026-11-12 | 7 | 0 | 7 | false |

The six passing slices are US_V5 and US_CORE on the first three days. Six fixed
fake fetches, no real fetch; all six checkers passed. Synthetic key was deleted.
The six READY canonical input packs measure 11,036–11,658 UTF-8 bytes before
the prompt; no production budget is configured or approved by this measurement.
28 JSON+Markdown report pairs persisted privately. Only supplied facts rendered;
no derived reconciliation or missing-value substitution. 22 missing packs made
zero fetches. Packs, hashes, checker details and reports are under ignored
`var/ai-review-daily-evidence/`; original first-run evidence is retained too.
Private source contents and Markdown are intentionally not in this public commit.

Observed availability: A-share trades and separate INDEX/STOCK NAV on all four
days, no CN V2 decomposition; US trades all four days, NAV/V2 only first three;
no requested CRYPTO sources or rule-change ledger in this local inbox. Carry is
not registered in the NAV contract. These are local delivery observations, not
claims that remote producers have no artifacts.

Rule-change schema is a cumulative COORDINATOR snapshot: it contains generatedAt,
ledgerIds, effectiveAt and deployment/confirmation times, but no sessionDate or
daily completeness attestation. Daily time coverage and empty-ledgerIds semantics
are not defined for this consumer. No adapter may infer a day had no switch/rule
changes from an empty or absent snapshot. Complete daily readiness remains false.

## Pre-review checklist mapping

1–2 Scope and base above. 3–5 red/green and regression above. 6 diff-check passes.
7 Frozen contracts unchanged; authoritative sources read-only and hashes above.
8 Default disabled; legacy off behavior retained, new reader performs no model
calls. 9 No production write/merge/deploy/install/other-repo edit. 10 No real key,
credentials or personal input committed. 11 No migration/schema/config changes.
12–15 N/A: no deployment script or deployment. 16 Queue/push not performed per
parent instruction; commit is for parent cherry-pick. 17 DEFAULT_A: reuse existing
producer contracts and preserve missing evidence instead of guessing.

Next exact action: obtain delivered CN V2/CRYPTO/missing US artifacts and an
addressable daily rule-change temporal coverage contract, then re-run the same
explicit inbox adapter. Carry needs producer NAV registration before coverage can
be claimed. Weekly logic, installation, real calls and longitudinal observation
remain outside this slice. No PR_OPEN/LIVE/release-valid claim.
