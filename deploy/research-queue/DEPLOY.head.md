# Research queue install (AUTONOMOUS_RESEARCH_QUEUE_V1, Q1)

For ops-coord. Nothing here is installed by the PR. Template admission remains governed by the SHA-pinned entries in `config/research_queue_template_pins.v1.json`. Contract: `docs/contracts/RESEARCH_QUEUE_V1.md`.

## Linux (user units, kayla, linger)

1. Code: `git archive <sha> | tar -x -C /srv/research-lane/research-queue/code/<sha>/` and `ln -sfn <sha> /srv/research-lane/research-queue/code/current`. The full tree is required because the consumer CLI loads `services/`, `independent-verifier/`, `adapters/`, `packages/`, `schemas/` and `config/` from the same SHA.
2. Config `~/.config/research-queue/rq.json` (host `LINUX`, `env_allowlist` must carry `RQ_AGENT_IMAGE`, `XDG_RUNTIME_DIR` and `DOCKER_HOST` for the agent launcher; on both hosts `node_bin` (HK: `/opt/node22/bin/node`) is used by the consumer to stage inputs and to re-validate results, and HK sets `spool_dir` `/var/lib/rq-spool`, `root` `/srv/research-lane/research-queue`, `state_dir` `~/.local/state/research-queue`, `templates_path`, `pins_path`, `blackouts_path` under `code/current/config/`). `python3 -m rq --config <file> env-manifest > install-manifest.json`, then set `install_manifest` in the config: every start refuses on a mismatch (exit 78).
3. `install -m 0644 linux/* ~/.config/systemd/user/`, `systemctl --user daemon-reload`.
4. Pause authority (RQ8): `systemctl --user disable --now rf1116-window-pause.timer`, then `systemctl --user enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
5. Cap proof (AQ-17L, outside V6 windows): `deploy/research-queue/cap-proof.sh LINUX` must print no failures; it also records whether `--cgroup-parent=research.slice` works for rootless containers.

## HK (system units, root, coordinator only; NET tasks only)

1. `install -m 0644 hk/rq.sysusers.conf /etc/sysusers.d/rq.conf; systemd-sysusers; install -m 0644 hk/rq.tmpfiles.conf /etc/tmpfiles.d/rq.conf; systemd-tmpfiles --create`.
2. Code: `git archive <sha> | tar -x -C /opt/research-queue/<sha>/`, then atomically select it with the `current` symlink. Config `/etc/research-queue/rq.json` has host `HK`, root `/var/lib/research-queue`, `process_pause_unit` `rq-consumer.service`, `spool_dir` `/var/lib/rq-spool`, and the manifest above.
3. `install -m 0644 hk/*.service hk/*.timer hk/research.slice /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
4. HK agent (Q3c): the agent runs as `rq-agent`, never as `research-queue`; the two meet only in the spool `/var/lib/rq-spool` (`in/` written by the consumer, `out/` written by the agent). Install, in this order:
   - `rq.sysusers.conf` no longer puts `rq-agent` in group `rq` (the queue tree is `2770 research-queue:rq`): after `systemd-sysusers`, run `gpasswd -d rq-agent rq` if the user already exists, and check `id rq-agent` shows no `rq`.
   - `rq.tmpfiles.conf` creates the spool (`0750`/`2750`/`2770`, owner `research-queue`, group `rq-agent`) and the gateway ledger directory `/var/lib/rq-gw` (`0700 rq-gw:rq-gw`) outside the non-searchable queue tree.
   - **`research-queue-ai/hk/rq-deepseek-gateway.service` now has `Group=rq-agent`; this supersedes `Group=rq` of #148**. Its ledger is `/var/lib/rq-gw/gateway.sqlite`; its socket `/run/rq-gw/rq-gw.sock` is group `rq-agent`. If #148's unit is already installed, replace it, `daemon-reload`, restart the gateway.
   - `install -m 0644 research-queue-ai/hk/rq-agent.service research-queue-ai/hk/rq-agent.timer /etc/systemd/system/`, `systemctl enable --now rq-agent.timer`. `rq-agent.service` is a timer-started oneshot that drains the spool and exits; do not enable it as a long-running service, and do not install a polkit rule or a sudoers entry.
   - Checks (AQ-17H/18/33/34): gateway starts keyed and keyless and can write `/var/lib/rq-gw/gateway.sqlite`; as `rq-agent`, the queue database and state dir are not readable; `research-queue` and `portfolio-desk` cannot read the key file or `/proc/<gw>/environ`; `rq-agent` can connect to the gateway socket while `research-queue` and `portfolio-desk` cannot; an external TCP connect from `rq-agent` fails.
   - As `research-queue`, run `node /opt/research-queue/current/services/research-queue-agent/cli.js stage` and `validate` against a scratch fixture. Both must resolve the full archived dependency tree before any timer is enabled.
   - Pause: the root `rq-pause` tick freezes `rq-consumer.service` and `rq-agent.service` (an inactive oneshot cannot be frozen, which is fine) and writes `/var/lib/rq-spool/in/.pause`, which stops a drain that starts later.
5. Cap proof (AQ-17H, 14:00-16:00 CST): `deploy/research-queue/cap-proof.sh HK`. Limits are the ops-coord plan (1 CPU, 512 MB, nice 19) and are confirmed here.

## Mac relay

`mac/com.upmeai.research-queue-relay.plist.template` (every 15 min), config `~/Library/Application Support/research-queue/relay.json` (optional; defaults match the desk outbox and the existing ssh aliases). It ships fact packs from `rq-relay-outbox/{linux,hk}/REVIEW_AI_FACT_PACK_V1/` to each host's `inbox/fact-packs/` and pulls each host's `outbox/*.json` into the QRP `var/research-queue-return/<host>/`, verifying by sha256 both ways. No new keys. W05: before a pack is pushed its SEEN mark is written into the QRP trial ledger by `node apps/research-cli/review_pack_seen.js mark --file -` (needs `QRP_PRODUCT_MILESTONE_AUTHORITY` in the launchd environment; `relay.json` may carry `"seen_mark": {"qrp_root": "...", "node": "..."}`); a pack that cannot be marked is not pushed (`failed ... SEEN_MARK_FAILED:<code>`) and is retried on the next pass. A host that also wants to mark what its producer admits sets `RQ_SEEN_MARK_QRP_ROOT` (and optionally `RQ_SEEN_MARK_NODE`) for `producer-tick`; without it the producer marks nothing.

## File sha256 (must match after install)

