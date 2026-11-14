# Q70 daily inbox availability slice V1

Bound to Q70 BRIEF §§1–5; additive implementation acceptance at c0ff23f.
The frozen release acceptance is unchanged. Read only the explicit inbox root.

- Enumerate the existing registered daily books plus requested carry, for an
  explicit day. Use producer contract delivery paths and byte hashes; no search
  for alternate days, market feeds, producer invocation, or guessed substitutions.
- Reuse the existing adapter and trusted Desk validator. Return independently
  validated three-source packs and a separate complete-daily coverage result.
- Preserve per-source failures, ledger/part identities, source byte AND payload
  hashes, null/unknown values and existing per-book ruleVersion evidence.
- Daily completeness is false until required rule/switch-change time coverage is
  authoritatively bound. RULE_CHANGE_LEDGER_V1 is a cumulative snapshot with no
  sessionDate or daily completeness marker; presence is not absence-of-change
  evidence. Missing rule ledger remains missing; an existing file remains unbound.
- A missing book/source must not suppress other books; carry is not registered in
  the NAV contract and remains explicitly missing. READY is only slice READY.
- Test path binding, missing separation, hash provenance and no fallback with
  synthetic files and validator. Four-day real local dry-run uses actual Desk
  validation and fixed fake responses; private source bytes and reports stay in
  ignored var/. Public evidence includes counts/statuses only, no financial data.
