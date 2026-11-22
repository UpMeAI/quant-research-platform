# RQ_GATEWAY_AGENT_V1 — DeepSeek gateway, tool-less agent, validators

Q2 of `AUTONOMOUS_RESEARCH_QUEUE_V1` (rev 4, sha256 `52418471…`, DRAFT when this was written; sections 5.1–5.6, 5.8–5.10, 7). The queue core (Q1) is a separate PR; the seam is in "Queue seam" below. `production_effect: NONE`: nothing here is installed or run by the PR.

## Gateway (`services/rq-deepseek-gateway/rq_gateway.py`, Python stdlib)

- One per host, the only holder of that host's key, on a unix socket. Serves exactly `POST /chat/completions` and `GET /user/balance`; anything else is `RQ_PATH_REFUSED` (404) / `RQ_METHOD_REFUSED` (405).
- Forwards over TLS to `api.deepseek.com:443` only (config validation and the transport both refuse any other host or path) and adds `Authorization` itself. A client `Authorization` header is never forwarded.
- Config: `config/rq_deepseek_gateway.v1.json` (purposes, models, `max_tokens` ceilings, keys and their scopes, price table, off-peak schedule) is the single source for the gateway and the agent.
- Request body: only `model, messages, max_tokens, temperature, response_format {type: json_object}, stream false`; messages are `{role, content}` strings with role `system|user|assistant`. No tools, functions, web, file or URL parts.
- Headers from the caller: `X-RQ-Purpose` (required), `X-RQ-Task-Id`, `X-RQ-Prompt-Admission`, and for the pro fallback `X-RQ-Quality-Gate-Id` + `X-RQ-Quality-Gate-Record` (base64url of the canonical JSON record).

| Purpose | Model | `max_tokens` ceiling | Admission | Off-peak only | Quality gate |
|---|---|---|---|---|---|
| `RQ_AGENT` | `deepseek-flash` | 4000 | yes | yes | no |
| `RQ_AGENT_PRO_FALLBACK` | `deepseek-v4-pro` | 4000 | yes | yes | yes, once per task |
| `MINING_LLM` | `deepseek-v4-pro` | 16384 | no | no (peak flag still recorded) | no |

The HK key's scope excludes `MINING_LLM`. There is no spend or token total anywhere in the request path (Owner 11-22).

- **Admission:** the first message must be `system`, its sha256 must equal `X-RQ-Prompt-Admission`, and that sha must be an `ADMITTED` entry of `config/research_queue_prompt_admissions.v1.json` covering the purpose.
- **Quality-gate record** `RQ_FLASH_QUALITY_GATE_RECORD_V1`: `{schema, task_id, kind, model: deepseek-flash, failures[≥2 distinct attempt_no: {attempt_no, validator_codes[≥1], output_sha256}], record_id}`; `record_id = "QG-" + sha256(canonical_json(record without record_id))[:16]`. The gateway verifies shape, hash and task match, and refuses a second pro call for a task whose pro call already got an HTTP 200 answer (`RQ_QUALITY_GATE_USED`). Residual: a compromised agent could forge a record; the deterministic program, not the gateway, is the completion authority.
- **Error classes** (body `{error: {rq_code, rq_class, message, http_status, retry_after_s}}`): 401/403 → `CREDENTIAL`; 402 → `QUOTA`; 429, 5xx, timeouts, unreachable → `PROVIDER`; 400/422 and every gateway refusal → `DETERMINISTIC`; `RQ_PEAK_REFUSED` → `SCHEDULE`; keyless → `RQ_CREDENTIAL_ABSENT` (`CREDENTIAL`, no forward). The gateway never retries.
- **Key:** `FileKeyProvider` (Linux: `~/.config/qrp-research-key/deepseek-research.env`, mode must have no group/other bits, re-read on every call so a restored or replaced file resumes without a restart) or `EnvKeyProvider` (HK: systemd `EnvironmentFile`, `-` prefix). Accepts only `sk-…`, ≥ 30 characters, no whitespace. Never logged or printed; upstream echoes are redacted (exact key, `Bearer …`, `sk-…`, masked echoes, 4–16 character suffixes). Only `key_id` and `key_fp12` are recorded.
- **Ledger** (`gateway.sqlite`, WAL, `synchronous=FULL`): table `call` exactly as section 3.2, one row per provider response, written for error responses too (usage columns NULL). A response without a complete usage block is stored with NULL usage and cost and counted as `unmetered`. Cost = tokens × `DEEPSEEK_PRICE_TABLE_V1` row; an unknown price row gives NULL (counted as `price_unknown`), never 0; a NULL cache-hit price is priced as a miss (stated upper bound). The table values are PROVISIONAL (`price_table.status`) and must be re-read before the first live call.
- **Monthly spend view:** `rq_gateway.py spend --db … --key-id … --month YYYY-MM` / `monthly_spend()`: per key, CST month, per purpose and total (calls, cny, usd, tokens, unmetered, price_unknown, error calls). Display only; nothing blocks on it.

## Agent (`services/research-queue-agent/`, Node, no tools)

- Builds the bundle message, calls the gateway socket, validates, re-asks only with validator error codes. Non-thinking, `temperature 0`, JSON mode, `max_tokens` 4000. Sources import no `child_process`, `net`, `https`, `dns`, `vm` or `worker_threads`; `fs` only in `cli.js` and `registries.js`; `http` only in `gateway-client.js`, over a `socketPath`. It refuses to start if its environment has any `DEEPSEEK*`, `*API_KEY`, `*SECRET*`, `*TOKEN*` variable or a key-shaped value.
- **Flash quality gate:** an attempt is the first answer plus 1 revision. Two failed attempts on one task → one `RQ_AGENT_PRO_FALLBACK` call (fresh, no revision) carrying the record. Pro fails → `BLOCKED_DETERMINISTIC` (`RQ_PRO_FALLBACK_FAILED`) + remediation (and `defect_code: CHECKER_DEFECT` for a check). A split check has at most one pro call per task.
- **Kinds:** `AI_REVIEW_CARD` (market's agent host) and `AI_CHECK`. `AI_PREREG` is Q3.
- **Validators:** `validateCheckReport` (`CHECK_*`), `validateCard` (`CARD_*`), `validateIdeaDraft` / `validateIdeaRecord` (`FACTOR_IDEA_*`), `checkPack` (`PACK_*`, firewall, author ≠ checker, ≤ 40k tokens per call, `splitPackByRow`). Word lists: `lexicon.js`.
- **Routing:** TRIAGE_QUERY reading first (not-do-settled closes the idea with the sealed sha; no reading = `TRIAGE_PENDING`); NEW mechanism → `WAITING_EXTERNAL:MECHANISM_ADMISSION`; only registered factors → `AI_PREREG` proposal; else generator view; crypto generator path held. `buildIdeasInView` produces `ideas_in_view[]` with provenance shas and refuses ideas whose pack touches the firewall. `MECHANISM_ADMISSION_PROGRAM_V1` (RF1118 C4) is NOT here: only the stub that queues proposals as WAITING.

## Queue seam (Q1)

File contract, no database access from the task process. In: `task.json` (the section 3.2 `task` columns `task_id, host, agent_host, kind, market, template_id, template_sha256, attempt_no`) and `bundle.json` (`RQ_AGENT_BUNDLE_V1 {market, week_id, pack, registry?, existing_idea_count?, author_required?}`). Out: `result.json` (`RQ_AGENT_RESULT_V1`: `status DONE|WAITING|RETRY|DEFER|BLOCKED_DETERMINISTIC`, `wait_state`, `reason_code`, `retry_after_s`, `alert`, `calls[]` without content, `quality_gate`, `outputs`) plus `card.json`, `factor_ideas.jsonl`, `idea_routes.jsonl`, `proposals.jsonl` or `check_report.json`. `queue-seam.js` `transitionFor()` maps a result to the section 3.3 / 3.7 state change for Q1's consumer (6 provider tries with backoff 60 s … 3600 s then `WAITING_PROVIDER`; never FAILED).
