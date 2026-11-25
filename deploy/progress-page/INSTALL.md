# Private progress page install

This is an ops-coord runbook. Codex does not install, enable, publish, merge, or handle credentials. The implementation is bound to `PROGRESS_PAGE_V1_FREEZE_1` (`c95f91a6`) and Note 1 (`b4c214e8`). Upload stays disabled until the Owner has created the Pages-only token and the Owner-only Access application.

1. Outside all migration and production blackout windows, archive the accepted merge commit's `services/progress-page` and `deploy/progress-page` into `/srv/research-lane/progress-page/code/<sha>/`; atomically point `code/current` at it. Create `out`, `state`, `plan-snapshot`, and `/srv/research-lane/ops-logs/progress-page` as `kayla`, mode 0755.
2. Copy `progress-config.example.json` to `/home/kayla/.config/progress-page/progress.json`, mode 0644. Replace the commit and plan-snapshot pins and the accepted #148/#151 ledger globs. Keep `upload.enabled=false`.
3. Install the frozen `PLAN_SNAPSHOT_20261125.json` as 0444. Run `PYTHONPATH=.../services/progress-page python3 -m progress run --config .../progress.json`; require exit 0 and inspect every registry section. S4 is OK or ZERO after cutover, S5 is NOT_YET_DUE before its dates, and no source is PATH_FORBIDDEN.
4. The Owner creates a new token limited to Cloudflare Pages Edit and an Access application covering the production and preview `pages.dev` domains for the Owner email only. Ops-coord writes `pages-progress.env` as `kayla`, mode 0600, without printing it.
5. Create the separate `kayla-progress` Pages project. Enable upload and run once. Anonymous requests to both production and preview URLs must redirect to `cloudflareaccess.com` or return 401/403, never return the progress marker with 200. Then verify one Owner-authenticated browser journey.
6. Copy the two user units, run `systemd-analyze --user verify`, reload, and enable the timer. Read back the timer schedule and next trigger.
7. Add the accepted alert rule: status older than two hours, or three consecutive FAILED / ACCESS_NOT_ENFORCED / DISABLED_LOCKED upload states, is P2.

Rollback order: first disable and stop the timer and read it back inactive. Then revert the code symlink or configuration. Pages keeps the last accepted deployment. Removing the Pages project is an Owner decision. If S9 was cut, the master table remains directly readable on Linux at its two frozen #159 output paths.
