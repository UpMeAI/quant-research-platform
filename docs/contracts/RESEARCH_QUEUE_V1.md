# RESEARCH_QUEUE_V1 (queue core, PR Q1)

Implements the queue core of `AUTONOMOUS_RESEARCH_QUEUE_V1` (design rev 4, frozen by `AUTONOMOUS_RESEARCH_QUEUE_V1_FREEZE_1.md`). Python 3 stdlib only, no network, no database server. Code: `services/research-queue/rq/`. Tests: `tests/research_queue/` (run by `tests/research_queue.test.js`). Units: `deploy/research-queue/{linux,hk}`. QRP is public: no desk facts, hosts or secrets here.

## Pinned artifacts

| Artifact | Pin |
|---|---|
| Queue DDL | schema.sql sha256: c7b6376e8d1d31a7a5b692902bb32fdbc1c19ca6f4e06ddadce31b3962a7cfff |
| Template registry | `config/research_queue_templates.v1.json` (Q3b: four NET templates (only the two Linux ones pinned; the HK pair is unpinned until the follow-up PR) `T-AI-REVIEW-CARD-V1-LINUX-CN_A`, `T-AI-CHECK-V1-LINUX-CN_A`, `T-AI-REVIEW-CARD-V1-HK-US-CRYPTO`, `T-AI-CHECK-V1-HK-US-CRYPTO`; `T-AI-PREREG-V1` is an unpinned placeholder) + pins `config/research_queue_template_pins.v1.json` (`template_sha256` = `rq.templates.template_sha256`, the sha256 of the canonical template with no sha field inside; `frozen_page_sha256` is null until the coordinator's freeze page exists) |
| Blackout calendar | `config/rq-blackouts.v1.json` (placeholders; ops-coord fills exact times) |

`migrate` creates the schema in an empty database and refuses any database whose schema differs from `schema.sql`.

## Scope of Q1

In: DDL, atomic claim, lease/fencing/adoption, states, idempotent admission, producer (request files, `REVIEW_AI_FACT_PACK_V1` intake, re-evaluation of waiting tasks), consumer (launch, heartbeat, finalize, outcome classes), pause hooks and blackouts, status and receipts, path/secret guards, install-manifest check, units, cap-proof script, `SELF_VALIDATED` completion.
Out (later PRs): gateway, agent, validators (Q2); K2 freeze program (Q3); `RUN_GATE_V1` and HOLD re-checks (gate-and-check completion); `mining_status` and the MINING/K2 templates; desk work.

## Tasks and states

One row per task (`task`), one per attempt (`attempt`), append-only hash-chained `event`. A state change and its event are written in one `BEGIN IMMEDIATE` transaction.
`PROPOSED -> ADMITTED -> READY -> CLAIMED -> RUNNING <-> PAUSED -> EVIDENCE_WRITTEN -> (GATE_PASS | GATE_FAIL) -> CHECK_PENDING -> (CHECK_CONSISTENT | CHECK_HOLD) -> COMPLETE`, plus `REFUSED_ADMISSION`, `WAITING_FREEZE`, `WAITING_EXTERNAL` (reason = code), `WAITING_QUOTA`, `WAITING_PROVIDER`, `WAITING_CREDENTIAL`, `WAITING_VERDICT_READING`, `BLOCKED_DETERMINISTIC`, `SAFETY_STOP`, `CANCELLED`. There is no cost-cap state (RQ4).

Authority: only actor `rq-complete` writes `COMPLETE`; only `coordinator` cancels, clears `SAFETY_STOP` or resets a circuit. A consumer write to a leased task needs the current lease token (`LeaseTokenStale` otherwise).

## Claim, lease, idempotency

- Claim: one `BEGIN IMMEDIATE` transaction; order `priority, created_at, task_id`; NET tasks are claimed on `agent_host`, others on `host`; HK claims NET only. Slots: Linux one HEAVY (W2 or LANE1_DB), one LIGHT, one NET; HK one NET.
- Lease TTL 10 min, heartbeat 60 s. A consumer that finds an expired lease with a live runtime adopts it (same attempt, new token, event `ADOPTED`); a dead runtime ends the attempt as T1; a claim whose runtime never started goes back to READY without counting an attempt.
- `idem_key` = sha256 of canonical `{template_id, template_sha256, subject, params}`. Same key and same request returns the same task; same key and a different request returns `IDEM_CONFLICT`. A refusal is stored as a `REFUSED_ADMISSION` task under a key that includes the refusal code, so the same request can be admitted once its cause is fixed (for example after the template is pinned).
- Runtime: a detached wrapper per attempt writes `run.pid`, `child.pid`, `exit.json`; liveness and exit are read from those files, so any consumer can adopt. Task environment is an allowlist; secret-looking names never pass.

## Outcome classes (section 3.7)

T1 interruption: back to READY after 10 min, budget `transient_budget`; non-idempotent templates resume through `recovery_argv` (never the original argv), at most `recovery_max` times (`RECOVERY_EXHAUSTED`), none declared means `NO_RECOVERY_PATH`. T2 OOM: BLOCKED. T3 provider: 1 min to 1 h, 6 tries, then `WAITING_PROVIDER`; `Retry-After` is honoured. Q 402: `WAITING_QUOTA`. A 401/403 or absent key: `WAITING_CREDENTIAL` (one P1 alert). D structured refusal, exit 64/65/66, `error.json` class D, any other non-zero exit: BLOCKED at once, never retried. E: `WAITING_EXTERNAL:<code>`. S: `SAFETY_STOP`, host stops claiming. Template circuit: the same D code twice. Host circuit: any `SAFETY_STOP` or three T1 in an hour.
Task protocol: exit 0 plus `result.json`; failures write `error.json` `{class, code, http_status, retry_after_s}`.

## Pause (section 3.5, replaces rf1116-window-pause)

`rq-pause` every minute: Linux windows Mon-Fri 06:30-08:00, 09:15-15:30, 18:10-21:30 (IO tasks also 00:15-01:15); HK tasks only 10:45-21:45; blackout calendar (`FREEZE` or `STOP`); brakes (Linux IO await > 10 ms, MemAvailable < 16 GiB, lane1 free < 200 GiB; HK load5 > 3.0, MemAvailable < 1.5 GiB, pm2 restart in 10 min, disk < 20 GiB, 10 clear minutes to resume). UNKNOWN sensor values close claims but do not freeze. PAUSED is written and the lease extended before any freeze. Only allowlisted names are touched: `rq-task-*`, `rq-agent*`, `rq-consumer.service`, and on Linux `rf1116-generate-*`, `rf1116-resume`, `rf1116-score`, `rf1116-rescore`.

## Status and receipts

`status.json` (`RQ_STATUS_V1`): counts, oldest age per state, SLA breaches, consumer heartbeat, pauses and brakes, circuits, event-chain head, CST-month spend per key read from the gateway ledger if present, alerts (`RQ_STUCK`, `RQ_BLOCKED_DETERMINISTIC`, `RQ_SAFETY_STOP`, `RQ_CONSUMER_DOWN`, `RQ_CREDENTIAL`, `RQ_HOLD`; all `dry_run` for the first 7 days). `RUN_RECEIPT_V1` per attempt (`receipt.json`, sha in `attempt.receipt_sha256`). `guard.scan_secrets` is the AQ-21 scan.

## Acceptance covered by Q1

AQ-01 to 09, 10, 11 (core), 13 (authority and self-validated path), 14, 16, 17H/17L (static plus evaluator; the real proofs run at install with `cap-proof.sh`), 18, 19 (as written; `research_ro` is not built), 20 to 22, 24 to 28, 36 (routing). Not covered: AQ-12, 15, 23, 29 to 35, 37 onward (Q2/Q3, or pending real observation).

## Q3b: templates, launch, card routing

- The producer picks the fact-pack card template by market and host (`producer.card_template`: kind `AI_REVIEW_CARD`, the pack's market, preferring a template that runs on this host); admission still refuses a wrong-host route.
- Agent launch: the template argv is one fixed launcher with no per-task path (`deploy/research-queue-ai/{linux,hk}/run-agent.sh`); it reads `RQ_ATTEMPT_DIR` (set by `child_env`), expects `in/task.json` and `in/bundle.json` there, and publishes `result.json` to the attempt directory. HK: not launched yet (templates unpinned; follow-up PR). The HK gateway socket belongs to group `rq` (research-queue and rq-agent); confirm at the HK install.
- Not implemented here (later PR): staging `in/task.json` and `in/bundle.json` from the admitted task, and mapping the agent's `result.json` status (`DONE|WAITING|RETRY|DEFER|BLOCKED_DETERMINISTIC`, `queue-seam.js transitionFor`) and its `validator` block onto the consumer's `error.json` classes and `complete_self_validated`. Until then the launcher refuses with exit 66 (`RQ_AGENT_INPUT_NOT_STAGED`) and the task is BLOCKED_DETERMINISTIC `EXIT_66`: fail closed.
