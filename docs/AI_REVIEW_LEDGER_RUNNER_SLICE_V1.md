# Q70 ledger runner slice acceptance V1

Bound to queue #70 BRIEF §§1–5 and base 6c317f3. This additive slice does not
amend frozen release acceptance. No production or model access is authorized.

- Daily packs from the existing adapter run independently at one shared root.
  Namespace paths are derived from ledger identity, never accepted as file paths.
  Only registered daily books can invoke the model. Invalid identities fail closed.
- Persist JSON and Markdown deterministic facts, original input states and slice
  coverage for disabled, missing/stale input, budget and unavailable model states.
  Missing values stay missing/null; no synthetic zero or reconciliation result.
  READY means the three-source slice only; full review/reconciliation is pending.
- Missing budget/off/missing input cause zero fake fetches. Missing synthetic key
  still delivers facts. Blocked preflight can recover without consuming an attempt.
- Same-period books do not overwrite or share model cache. Usage reservations
  remain global to the root. A missing book does not prevent a valid book running.
- Failed checker output is absent from readable reports and delivery JSON. Model
  failures retry once; reruns use the stored result without further requests.
- Preserve legacy run() disabled response and side-effect behavior. The explicit
  runner is the new deterministic delivery entry point, not installed anywhere.

Verification: serial node:test synthetic fixtures, existing ai-review suites,
git diff --check. Full suite only through heavy-run outside prohibited windows.
