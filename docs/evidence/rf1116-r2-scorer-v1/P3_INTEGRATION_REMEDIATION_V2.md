# #157 P3 integration remediation V2 acceptance

Frozen on 2026-11-26 after independent review of `ac177aa`. This amendment does not change the original brief, P3-A/P3-B acceptance, or remediation V1. It covers four review escapes only.

1. The R2 resolver consumes and records the same base plus four-digit sequence calendar parts as the adapter and arrival program. Four-digit parts remain calendar-only.
2. A torn final chain row is truncated only after the entire preceding state passes the ordinary chain semantics: schema, segment, kind, source, readiness, industry windows, exact file names, hashes, ordering, and the permitted crash-healing unchained set. Refusal preserves the forensic torn bytes.
3. A day drop is listed and every child is opened relative to the already-held no-follow directory descriptor. Renaming the directory away, substituting another directory at the same path, and restoring it cannot make the reader consume substituted bytes. Linux may use `/proc/self/fd/<dirfd>`; a platform without an equivalent descriptor-relative path fails closed and never falls back to pathname child reads.
4. A real rescore whose first verified arrival head is `head1` and second verified arrival head is `head2` refuses exactly `MINE_HOLDOUT_RESCORE_INPUTS_CHANGED`, writes no rescore event/result, and does not weaken chain or anchor verification. The dedicated mutation that removes the arrival head from the immutable input must survive before this exact test exists and be killed after it is added.

Evidence order is immutable: a red commit and Linux failures (items 1-3) plus the item-4 mutation survivor; then a green commit, targeted tests on Linux and old MBP where portable, zero-survivor mutation, CI pair, and independent rereview. No install, deployment, push, merge, or release is authorized by this amendment.
