# Q70 daily command slice acceptance V1

Bound to Q70 BRIEF §§3–5, base 608fb46992b3fa16b53d25ec12246ea656be9670.
Additive slice only; existing frozen release acceptance remains unchanged.

- Explicit daily CLI consumes the existing inbox adapter and runner, with trusted
  Desk validator loaded only from operator-supplied --desk-root. No new business
  calculations, producer execution, source substitution or weekly logic.
- Required absolute inbox/Desk roots; optional absolute output root and strict
  calendar date. Default date is Asia/Shanghai, independent of host timezone.
- Model defaults off. Budget defaults unconfigured. Incomplete full daily coverage
  prevents model calls even if three-source slices are READY. Facts and source
  blockers still persist; missing validator is explicit and fails closed.
- Output a compact machine-readable summary, plus durable per-ledger JSON/Markdown
  and coverage manifest. Do not print raw facts, credentials or exception bodies.
- Uninstalled daily launchd template targets 22:40 CST using existing cst-gate and
  both Los Angeles DST twins. Keep disabled, no key/budget, no RunAtLoad/KeepAlive,
  no installer/launchctl, and no weekly schedule pretending weekly support exists.
  Set gate late window to 60 minutes so a delayed daily run cannot cross midnight.
- Prove malformed arguments fail before I/O; CST day rollover; off and incomplete
  coverage zero fake fetches; validator absence delivery; CLI subprocess output;
  template parsing and intended DST twins. Legacy run off output remains unchanged.

Verification uses synthetic temporary inputs/keys, serial node:test and plist
syntax checks. Full regression via heavy-run outside forbidden CST windows.
