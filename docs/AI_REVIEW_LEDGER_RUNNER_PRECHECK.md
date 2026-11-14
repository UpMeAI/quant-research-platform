# Q70 ledger runner slice pre-review

Draft continuation for PR #77; not PR_OPEN or release certification.

1. Scope: `index.js` isolates claims/cache and labels shared usage; `runner.js`
   delivers deterministic daily snapshots; `desk-input.js` exposes existing book
   registration; `report.js` shows coverage/states. One new synthetic test file,
   one additive slice acceptance, checkpoint and this precheck document.
2. Base `6c317f3a355ab4797505fe4e11218e2c46623f1a`; independent worktree
   `wt-qrp-q70-ledger-runner`, branch `codex/q70-ledger-runner`.
3. Red: `Cannot find module '../services/ai-review/runner'`. Green: original four
   runner cases plus 18 existing related tests passed; shared-budget/recovery
   case subsequently passed too. No real credentials or fetch used.
4. Related suite: 23/23 plus frozen vocabulary suite 5/5, total 28 passed,
   zero failed/skipped. Full regression caught an unregistered reconciliationState
   name; removed it in favor of nullable weeklyComparison and feature availability.
   Frozen vocabulary tests first failed then passed, without contract/test edits.
5. Full suite: heavy-run serial launch at 2026-11-12 23:16 CST (outside prohibited
   windows). First run: 602 tests, 575 pass, 1 fail, 26 skip; the sole failure was
   the vocabulary conflict above, now repaired. Final run: 602 tests, 576 pass, 0 fail, 26 skip, 133359 ms.
   Skips require external pinned SMARTFLOW inputs; no skip newly introduced.
6. `git diff --check`: PASS.
7. No existing frozen/schema/contract file modified. BRIEF read-only SHA256:
   `10f866defb3714929a22499f1b20bdb0e404a97c9028c946305178c1366a56eb`.
   New slice acceptance adds only this task's verification; frozen release
   acceptance and prior evidence remain unchanged.
8. Default remains off. Existing run disabled test passes; legacy branch returns
   exactly `{ status: 'DISABLED' }` before validation, files or credential reads.
   Explicit new runner additionally delivers deterministic off reports, as BRIEF
   requires; it is not imported into any existing product path.
9. No production writes, merge, deployment, installation or other-repo edits.
10. Only temporary synthetic key fixture; no secrets/private artifacts committed.
11. Database migrations/config/v6/data/contracts/schemas changes: none.
12. Deployment preflight: N/A, no deployment.
13. Deployment rollback: N/A, no deployment.
14. Deployment dry run: N/A, no deployment script.
15. Deployment window script: N/A; full test launch honored requested windows.
16. Queue not written, per parent instruction; commit returns to parent for
    cherry-pick into existing draft PR. Release validity remains false.
17. DEFAULT_A: isolated slice, sequential fixtures, shared existing budget ledger.

Remaining: complete producer coverage, deterministic weekly comparison, interrupted
lock/partial-write recovery, real complete-input fake-model dry-run, deployment and
longitudinal observation. Report JSON/Markdown individually replace atomically;
the pair is not a transactional unit and this is not crash-recovery certification.
