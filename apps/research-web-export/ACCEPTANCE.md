# #133 frozen acceptance

Frozen before implementation on 2026-11-24. Sources: #133 `BRIEF.md`,
`ADDENDUM_1.md`, `ADDENDUM_2.md`, migration common and its addendum,
parallel rules, inventory rows 22/23, and plan rows X-01..X-16, X-44..X-47,
X-60..X-64. This artifact authorizes no installation or external change.

## Design and authority

1. Option B preserves the existing dynamic, read-only Research API. The Node
   origin runs only on Linux loopback; a remotely managed Cloudflare Tunnel is
   the edge. Cloudflare Access is Owner-only. No QRP business projection is
   duplicated into an exporter.
2. Post-switch data authority is exactly `/srv/research-lane/qrp/var`, with
   ledger data at `/srv/research-lane/qrp/var/ledger`. The runtime delegates
   the authority decision to #137's guard. It preserves
   `QRP_VAR_DUAL_WRITABLE` and `QRP_VAR_MANIFEST_MISMATCH` unchanged.
3. Pre-switch comparison may read only the read-only Mac mirror. Missing,
   writable, ambiguous, unmanifested, or unpinned inputs refuse. Desk data and
   the review-loop mirror must exist below `/srv/research-lane`; #134 and #131
   remain runtime dependencies.

## Edge and credentials

1. Edge is OFF by default. The tunnel runner accepts only the pinned
   cloudflared binary root and the names-only token path
   `/home/kayla/.config/cloudflared/qrp-research-web.token`. It checks metadata
   but never reads, creates, prints, or copies the token.
2. The origin keeps `QRP_RUNTIME_TOKEN` and `QRP_RESEARCH_TOKEN` unset. Runtime
   writes remain 403; the research origin remains loopback-only. The tunnel's
   origin request Host header is set to `127.0.0.1:4311` by the Owner/ops edge
   setup, and Access must be proven Owner-only before retirement.
3. The Mac OAuth is never copied. There is no R2/Pages upload in option B.

## Deterministic checks

1. QRP parity captures exactly five frozen routes: `/`, `/api/workspace`,
   `/api/strategies`, `/api/runtime-status`, and
   `/api/runtime-research-loop`. Status, content type, and normalized SHA-256
   must match. Only `/api/runtime-status` JSON pointer `/health/generatedAt`
   may differ.
2. Desk retirement requires the Mac and HK snapshots to have one explicit,
   equal expected commit, the exact same route set, and final HTTP 200 for
   every route. No retirement happens in code.
3. Units are loopback/pinned, use fixed logs/status, `OnFailure=`, CPU affinity,
   memory limit and restart semantics. The runbook contains the X-11 rollback
   order, X-46 dependencies, X-47 mirror removal, the 150 GiB floor, and the
   Owner-only Access journey.
4. Tests are networkless and prove guard delegation/refusals, edge-default OFF,
   token non-read, parity pass/fail, unit shape, and runbook safety wording.

PR_READY means implementation only. Cloudflare token/app/policy, cloudflared
download, installation, enablement, parity against live hosts, Owner browser
proof, Mac launchd retirement, merge, and deployment remain unverified ops or
Owner actions.
