# Q70 daily command slice precheck

Draft continuation; no PR_OPEN/LIVE/release certification.

1. Scope: `daily-command.js` composes existing adapter/runner with complete-daily
   gating and manifest; CLI exposes it; disabled plist example/README document
   the daily schedule; five synthetic tests and additive slice acceptance;
   checkpoint/precheck record exact limits. No weekly business logic added.
2. Base `608fb46992b3fa16b53d25ec12246ea656be9670`; independent worktree
   `wt-qrp-q70-daily-cli`, branch `codex/q70-daily-cli`.
3. Red: `Cannot find module '../services/ai-review/daily-command'`.
   Green: five new CLI/template cases pass. No real fetch or credentials.
4. Related suites: 36 passed, 0 failed, 0 skipped, including frozen vocabulary.
   Synthetic READY slice with enabled flag and configured budget still makes
   zero calls because complete daily coverage is false. Missing budget also
   makes zero calls; off and missing validator deliver deterministic reports.
5. Full suite NOT RUN: queued through heavy-run at 2026-11-13 08:36 CST;
   LOAD_19.0_GE_10 prevented starting. Fresh state at 08:38:51: load1=25.71,
   running=null, own request waiting only. Cancelled own queued process after
   no test progress; no tests terminated. Full regression remains pending.
   Rerun only outside prohibited windows with the command below.
6. `git diff --check`: PASS; `plutil -lint` template: OK.
7. No existing frozen/schema/contract/pinned file changed. Slice acceptance is
   new and does not amend release semantics. Existing core and runner unchanged. Frozen vocabulary contract git blob
   before/after: 34c0b1e3b7d69ec867ecb6cc4d4f77027a930346 (identical).
8. Default off. Existing legacy off test passes; `index.js`/runner are byte-for-byte
   unchanged from base. Template explicitly AI_REVIEW_ENABLED=0 and Disabled=true.
9. No production writes, merge, deploy, install or other-repo changes. Read-only
   inspected local cst-gate interface; never invoked it against real state.
10. No real key, token, cookie or private source data read, printed or committed.
11. Database migrations, config/v6/data, contracts/schemas changes: none.
12. Deployment preconditions: N/A, no installer/deployment; template placeholders
    require separate authorized pinning/review, as README explains.
13. Deployment rollback: N/A, no deployment or launchd state changed.
14. Trial: synthetic CLI subprocess delivers seven off reports, JSON-only stdout,
    empty stderr, exit 0; malformed arguments emit only DAILY_ARGUMENTS_INVALID
    with exit 64. No production dry run or real-input rerun in this slice.
15. Daily schedule 22:40 CST via cst-gate, 60-minute late bound; both LA DST twins
    verified. Template not installed; no weekly scheduling claim.
16. Queue/push omitted per parent instruction; return commit for same draft PR.
17. DEFAULT_A: reuse authoritative adapters, missing coverage blocks fetch, daily
    template only. No upstream data or missing daily semantics invented.

Remaining: complete daily source coverage/temporal rule contract, carry registration,
weekly binding/projection/CLI/schedule, #58 alerts, real model/configuration gates,
crash recovery and deployed three-day/one-week observation. No release validity.

Next exact verification (outside 09:15–15:30, 18:10–20:45, 06:45–07:45 CST):

```sh
~/bin/heavy-run --label q70-daily-cli-full -- node --test --test-concurrency=1 'tests/*.test.js'
```

The local heavy-run implementation currently gates load/lock but does not enforce
clock windows; the operator must monitor queue wait and cancel before a prohibited
window. Do not bypass its load threshold. This is an observed tool constraint, not
a request to modify that external tool in this slice.

## Weekly note delivery slice · 2026-11-14 (not release acceptance)

1. Scope: add weekly-notes-runner.js and its tests; extend the existing report output allowlist. No new metric, threshold, projection, or comparison.
2. Existing isolated codex Q70 worktree / Draft PR77, previous head2662c831; production checkout unchanged.
3. Red: new test file failed MODULE_NOT_FOUND under heavy-run. Green:12/12 passed; intermediate undefined/null persistence mismatch was fixed without weakening the test.
4. Related: weekly notes, daily runner and weekly pending runner; 12/12 pass,0fail,0skip (1.017seconds), under heavy-run with concurrency1.
5. Full regression after this source change: pending on old MBP per01:17 ruling. Earlier595/0/26 result belongs to earlier code only.
6. git diff --check: pass before staging.
7. Existing frozen contracts/word lists unchanged; no config edits.
8. Core budget, key, enabled=0 and checker paths reused unchanged; missing weekly inputs preserved.
9. No merge/deploy/production writes/model calls.
10. Tests synthetic; no credential reads beyond fake test fixtures, no secrets committed.
11. No migration/schema/config contract changes.
12–15. No deployment/installer/CLI/schedule in this slice. Not authorization to run weekly jobs. Receiver paths hashed, output kinds restricted, default-off core retained.
16. Keep Draft; do not mark PR_OPEN or task complete.
17. DEFAULT_A reuse existing run and persistReport; one global directions artifact, maximum3 enforced by existing checker.

Still missing: authoritative complete weekly source assembly and coverage, weekly CLI/schedule, complete daily coverage, binding freeze, real-period acceptance and deployed observation. A successful report writer does not satisfy these.
