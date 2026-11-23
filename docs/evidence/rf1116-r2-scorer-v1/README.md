# RF1116 R2 scorer, end-resolution record, pending seal: evidence

- Tests: `tests/mining_segment_resolution.test.js` (RS0 to RS9) and `tests/mining_r2_scoring.test.js` (RC1, RC1b, RC2, RC3, RC3b, RC3c, RC4 to RC7). Red on the registry head `0b0d611` (17 of 17 then), green in `c3f8047` and later.
- `MUTATION_RESULTS.json`: `tools/mining-r2-scorer-mutation-check.js`, each mutant must turn at least one test red (the registry test file is in the set too).
- `REAL_CALENDAR_CHECK.json`: the resolver run on the real lane-copy calendar (read-only, throwaway ledger): the format parses, the calendar ends 2026-12-31, so R2 is NOT_READY ("listed 0 open days after 2026-12-31, need 54"). There is no real R2 data and no 2027 calendar yet; the end-to-end scoring test runs the mining fixture's holdout days as if they were R2's window (a window that differs from R1's at both ends, so any fallback to R1's constants is visible).
- Not covered by a test, by design: the resolver counting from a real 2027 calendar (it does not exist), and the export program that delivers R2 data (outside QRP).
