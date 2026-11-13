# Daily AI review delivery — uninstalled

Run the command against an explicitly trusted Desk checkout and its delivered
inbox. This writes QRP report artifacts only; it neither invokes producers nor
changes research/trading decisions.

```sh
AI_REVIEW_ENABLED=0 node apps/research-cli/ai_review_daily.js \
  --inbox /absolute/delivered/inbox \
  --desk-root /absolute/trusted/portfolio-desk \
  --date 2026-11-12 \
  --output-root /absolute/qrp/var/ai-review
```

`--date` defaults to today's **Asia/Shanghai** date, independently of the host
zone. `--output-root` defaults to this checkout's `var/ai-review`. Unknown or
repeated options, relative roots and invalid calendar dates are rejected before
input loading or report writes. `--desk-root` loads `src/validate.js`: this is
trusted operator startup configuration, not a path accepted from source data.
If the validator cannot load, reports retain explicit unavailable/missing states.

Exit 0 means report delivery completed, **not** that inputs or review are complete.
Stdout is one JSON summary with each ledger's three-source state and delivered
status; it includes no raw financial facts. Exit 64 means invalid arguments;
exit 1 means delivery failed. Errors never print source exception bodies.

Output remains `<root>/<date>/ledger-<identity hash>/DAILY.report.json/.md`.
`DAILY.coverage.json` records the same summary plus rule-source coverage. Each
file replaces atomically; the entire set is not transactional. This command does
not certify crash recovery or automatically repair an interrupted core lock.

`AI_REVIEW_ENABLED` defaults to off. An enabled command still blocks model calls
until the inbox projection attests complete daily coverage. Current coverage is
false: three-source READY is insufficient. No budget is supplied by default.
Future owner configuration uses all three positive integer environment values:
`AI_REVIEW_TOKENS_PER_CALL`, `AI_REVIEW_TOKENS_PER_DAY`, and
`AI_REVIEW_TOKENS_PER_MONTH`. Missing/invalid values produce an unconfigured
budget. These names are configuration plumbing, not budget approval. Credentials
retain the existing `AI_REVIEW_DEEPSEEK_API_KEY_FILE` contract; no key is included
here. All tests use fake fetches; no real call has been made.

## Daily template (not installed)

`com.upmeai.qrp-ai-review-daily.plist.example` is a disabled, placeholder-only
review artifact. It is deliberately outside the existing research-web installer.
No installation, bootstrap, kickstart or schedule modification is performed.

The intended host is America/Los_Angeles. StartCalendarInterval lists 06:40 and
07:40; the existing trusted `cst-gate --at 22:40` selects the correct CST occurrence
across PST/PDT and prevents the other twin repeating it. `--late 60` limits catch-up
to before 23:40 CST so the CLI's current CST date cannot advance to the next day.
Longer sleep delays are skipped by the gate and require explicit owner handling.
The gate stamps before command execution; failure retry/recovery is not certified.

Before any separately authorized installation, the owner/coordinator must replace
all absolute-path placeholders, pin reviewed QRP/Desk/cst-gate versions, create
private output/log directories, and review complete-input and budget gates. The
template has no RunAtLoad, KeepAlive, key, budget or notification configuration;
AI review remains disabled. This is a light scheduled task, not a heavy-run job.

Weekly Monday 09:05 CST now has an uninstalled template and partial-input CLI
(described below). Complete weekly coverage, alert delivery, installation and
deployed observation remain pending.

## Weekly comparison pending delivery (coordinator 2026-11-14)

```sh
node apps/research-cli/ai_review_weekly_pending.js \
  --requests /absolute/requests.json --date 2026-11-14 \
  --output-root /absolute/qrp/var/ai-review
```

The request file is an array of `{entryId,resultId,strategyRef}` identities. The
canonical current-lock registry verifies sources. This entry point always emits
`WEEKLY_BINDING_PENDING`, preserves source failure separately, and never calls a
model, reads a key, or computes a comparison. It works independently of the AI
switch because it only delivers deterministic pending reports. `comparisonReady`
is always false. Missing or superseded sources remain missing, never replaced.

Each identity gets JSON/Markdown under `<date>/ledger-<identity hash>/`; input
order does not change that identity's path. The existing daily atomic per-file
writer is reused. A report pair is not a transactional write and no crash-recovery
certification is claimed. Exit 0 means pending reports written, not completed
weekly review, research directions, or comparison. Invalid CLI arguments exit64;
read/delivery failures exit1 without dumping source exception bodies. No weekly
schedule is installed by this command.

## Weekly facts command (coverage incomplete; no model invocation)

`node apps/research-cli/ai_review_weekly.js --manifest /absolute/weekly.json --desk-root /absolute/trusted-desk --date 2026-11-09 --output-root /absolute/output`

The source manifest has exactly `period`, `sources`, `requests`. Sources explicitly
name `{file,fileName,producer,sha256}` for the weekly review and its bound daily/
trade dependencies; requests name `{ledger,market,from,to,sourceFile}`. The trusted
Desk intake is loaded only from the startup `--desk-root`, never from the manifest.
No scanning, producer execution, alternate week selection or recomputation occurs.
Missing requested books get their own missing report. The command produces seven
book reports and one global directions report using the existing writer.

Only operation facts are connected. Attribution/rule changes and CN part-specific
facts remain incomplete; `completeWeeklyReady=false` and model calls stay blocked
regardless of a manifest's claims. An invalid/stale manifest stays visibly invalid/
stale. Exit 0 means reports were written, not that their evidence is complete.
Reconciliation uses the separate pending command; its binding table is unchanged.

The weekly plist is disabled and uninstalled. For a Los Angeles host it schedules
Sunday 16:05/17:05, with the existing CST gate selecting Monday 09:05 across DST.
Replace all placeholders only after review. It requires an independently delivered
manifest for the exact current CST report date; it does not manufacture one. No
KeepAlive, RunAtLoad, key, budget or notification is enabled. The template does not
certify end-to-end scheduling or complete weekly production.
