# #157 P3 integration remediation V3 acceptance

Frozen on 2026-11-26 after the exact-head Linux CI pair for `c666214` exposed one head-only compatibility regression. This amendment does not change the original brief, P3-A/P3-B acceptance, or remediation V1/V2.

1. Calendar input keeps both already-supported dated parts (`trading_calendar_YYYYMMDD.csv`) and the new four-digit sequence parts (`trading_calendar_NNNN.csv`). Every consumed part remains bound to `SHA256SUMS` and has its bytes verified before rows are returned.
2. Four-digit sequence parts remain calendar-only. Ordinary tables continue to accept dated parts only.
3. The existing full-suite assertion that an unlisted dated calendar part is refused remains green. A focused regression test also proves that a listed dated calendar part is consumed while a four-digit ordinary-table part is ignored.
4. The mutation guard for suffix classification must remove dated-calendar support without changing ordinary-table behavior, and the focused regression test must kill it.

Evidence order is immutable: the `c666214` Linux CI pair and the focused regression test fail first; then one shared suffix-selection rule is repaired, the focused and related suites pass on Linux, all final-head mutants are killed, the exact-head CI pair reports `NO_NEW_FULL_SUITE_FAILURES`, and independent rereview reports no P0/P1/P2. No install, deployment, push, merge, or release is authorized by this amendment alone.
