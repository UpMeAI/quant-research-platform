# Monthly pause re-check V1 contract

Authority: `PAUSE_MONTHLY_RECHECK_V1_FREEZE_1.md`, sha256
`5f880312358be75d0e37dc32c9c39b8725f84aa9bb92c008b992b35936014d6a`.
This document is a projection of that frozen contract; it does not change its
acceptance semantics.

## Purpose and boundaries

暂停 ≠ 不做. Once each month, the existing promotion re-check engine revisits
each currently paused research result using current observed facts. The job
may report `STAY_PAUSED_REASON_REFRESHED`, `STAY_PAUSED_ESCALATED`, or
`REOPEN_CANDIDATE`; it never evaluates a new candidate, converts a result to a
terminal rejection, or writes the research master table or failure library.

The deterministic program remains the sole producer of the monthly result and
state. The AI `AI_CHECK` card is a factual consistency check over a closed
fact pack. It cannot change a promotion state, supply missing observations, or
become the authoritative result.

The existing queue route assigns `US_EQUITY` and `CRYPTO` network agents to
HK, while this package's reviewed agent is Linux-only. Therefore V1 uses the
frozen Q3 fallback: only `CN_A` receives an AI check card. Other markets retain
their deterministic monthly result and record `AI_CHECK_NOT_AVAILABLE_FOR_MARKET`
without raising an alert.

## Distinct states

- `NO_PAUSED_ROWS` means the authoritative promotion-result set was present
  and contained no paused row.
- `SOURCE_ABSENT` means the authoritative promotion-result source itself was
  unavailable.
- `OBSERVED_MISSING` means a paused row exists but its current-month observed
  record, or a required authoritative budget value, is unknown. It is not a
  failed re-check and does not increment consecutive-failure counts.

These states must never be collapsed into zero, success, failure, or one
another.

## Outputs and audit

Under `${QRP_DATA_DIR}/research/pause-recheck/`, the program writes the monthly
`PAUSE_LIST_V1.json`, `AI_CHECKS_V1.json`, the atomic `latest.json`, and the
hash-chained `PAUSE_RECHECK_LEDGER.jsonl`. The frozen three-row evidence matrix
uses `PR-1`, `PR-2`, and `PR-3`, and every request binds candidate, month, fact
pack sha256, and the admitted prompt sha256.

The timer opens the monthly collection window on days 3 through 7 at 22:00
Asia/Shanghai. Re-entry for the same month is idempotent. Runtime behavior is
not certified by this static package; certification requires the reviewed
Package A program, installed user units, and an observed monthly run.
