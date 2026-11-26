# #157 P3 integration remediation V4 acceptance

Frozen on 2026-11-26 after independent review of `a520a8c`. This amendment does not change the original brief, P3-A/P3-B acceptance, or remediation V1-V3. It closes one provenance defect only.

1. The calendar source reader is the sole authority for which base, dated, and four-digit sequence parts were consumed. It returns each consumed file's name and the SHA-256 value already verified against `SHA256SUMS`.
2. `resolve-segment` records that exact consumed-file projection in `HOLDOUT_SEGMENT_RESOLUTION_V1.calendar.files`; it does not enumerate calendar suffixes independently or reopen calendar files to derive a second provenance view.
3. A resolver fixture containing the base file, one dated part, and one four-digit sequence part must record all three verified inputs exactly once. Omitting either suffix class is a failing regression.
4. Dedicated mutations independently omit the dated and sequence provenance entries, and the combined resolver test kills both.

Evidence order is immutable: the combined resolver test fails on `a520a8c`; then the source projection and resolver consumer are repaired, the related Linux suites pass, the final-head mutation run has zero survivors and zero bad mutants, the exact-head CI pair reports `NO_NEW_FULL_SUITE_FAILURES`, and independent rereview reports no P0/P1/P2. No install, deployment, push, merge, or release is authorized by this amendment alone.
