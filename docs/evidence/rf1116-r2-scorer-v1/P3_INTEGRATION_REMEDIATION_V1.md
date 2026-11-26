# #157 P3 integration remediation acceptance V1

Frozen 2026-11-26 from the independent integration review of P3-A/P3-B. This is a versioned amendment; it does not rewrite the original P3 brief or its red/green history.

1. Only `trading_calendar_<seq4>.csv` may use a four-digit suffix. Every non-calendar table part remains `<table>_<YYYYMMDD>.csv`.
2. When the torn final chain row was a calendar delta, recovery must ignore the unchained on-disk delta while deriving the prior semantic calendar, then re-append the identical delta as the same sequence row. It must not leave the part unchained.
3. The per-day `SHA256SUMS` and every file it authorizes must be opened non-blocking and without following symlinks, verified as a regular file, and read/hash-checked through that same descriptor. A symlink, FIFO, swap, missing, extra, duplicate or mismatched entry makes the day unavailable.
4. Before truncating a final torn chain fragment, the entire preceding chain prefix, its manifest entries and each named file hash must verify. On failure the torn chain bytes remain unchanged and the arrival refuses.
5. A custom readiness-probe path beginning with `-` is a filename, not a `sha256sum` option. Invoke `sha256sum -- "$READY_SQL"`; a byte-identical dash-prefixed file may proceed, while another hash still fails closed.
6. The P3 test files and the integrated diff pass `git diff --check`.

Verification is red-first in `tests/mining_r2_p3_integration_remediation.test.js`, followed by targeted P3 and regression tests, the complete scorer mutation run with zero survivors, and the declared Linux CI pair. No install, deployment, PR push or merge is authorized by this amendment.
