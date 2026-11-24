# RQ_STATUS_V1 task-view producer remediation acceptance V1

Status: frozen for the #149B producer remediation. This document does not
change the frozen Package B acceptance in
`AQ_RF1116_POST_ROUND_TEMPLATES_V1_FREEZE_1.md`.

## Authority

- `services/research-queue/rq/schema.sql` is authoritative for
  `task.task_id`, `task.idem_key`, `task.state`, and `task.attempt_no`.
- `producer.py` defines `idem_key` as the full SHA-256 of canonical
  `{template_id, template_sha256, subject, params}`. A `task_id` contains only
  the first eight hexadecimal characters, so it is not a safe correlation key
  by itself.
- `core.claim` increments `task.attempt_no` when it creates an attempt;
  `core.release_claim` removes that unstarted attempt and decrements the value.
  Therefore `attempt_no` is the current authoritative attempt number, and zero
  means that no attempt exists. Zero must not be changed to null or omission.
- `consumer.py` and `complete.py` bind an attempt result to
  `<cfg.runs_dir>/<task_id>/attempt-<attempt_no>/result.json`.

## Frozen additive projection

`status.build` MUST always add one optional-compatible top-level member:

```json
"tasks": [
  {
    "task_id": "...",
    "idem_key": "...",
    "state": "...",
    "attempt_no": 0
  }
]
```

Acceptance:

1. Each entry has exactly the four keys shown above. Values are copied from a
   single `task` row without state mapping, fallback, or inference.
2. Entries are ordered by `task_id` ascending. An empty queue is `tasks: []`;
   it is not a missing member and not an unknown count.
3. The full `idem_key` is present so a file-only consumer can correlate the
   exact idempotent request without trusting the collision-prone task-id
   prefix.
4. `attempt_no` preserves its database integer. In particular, zero remains
   distinct from a missing or unknown attempt.
5. The view contains no admission JSON, subject, params, state reason, lease,
   host path, attempt path, result path, result bytes, or secret-bearing value.
   `status.build` MUST NOT inspect `cfg.runs_dir` or any `result.json`.
6. The consumer remains responsible for joining the closed row to the existing
   configured runs-directory boundary. This remediation neither constructs nor
   broadens a filesystem path.
7. All pre-existing RQ_STATUS_V1 members retain their existing values and
   meaning. Existing consumers that read named aggregate members remain valid;
   no member is renamed, removed, or retyped.

## Deterministic evidence

- A red-first unit test covers exact keys, full idempotency correlation,
  deterministic ordering, current-attempt semantics including zero, and the
  no-result-read/no-result-copy boundary.
- The existing research-queue status/runtime tests remain green.

