# Research queue install (AUTONOMOUS_RESEARCH_QUEUE_V1, Q1)

For ops-coord. Nothing here is installed by the PR. Every host starts in DRY_RUN: no template is pinned (`config/research_queue_template_pins.v1.json` is empty), so the queue admits nothing until the coordinator's freeze page adds pins. Contract: `docs/contracts/RESEARCH_QUEUE_V1.md`. Q2 adds the gateway and agent units.

## Linux (user units, kayla, linger)

1. Code: `git archive <sha> services/research-queue config docs/contracts/RESEARCH_QUEUE_V1.md | tar -x -C /srv/research-lane/research-queue/code/<sha>/` and `ln -sfn <sha> /srv/research-lane/research-queue/code/current`.
2. Config `~/.config/research-queue/rq.json` (host `LINUX`, `env_allowlist` must carry `RQ_AGENT_IMAGE`, `XDG_RUNTIME_DIR` and `DOCKER_HOST` for the agent launcher, `root` `/srv/research-lane/research-queue`, `state_dir` `~/.local/state/research-queue`, `templates_path`, `pins_path`, `blackouts_path` under `code/current/config/`). `python3 -m rq --config <file> env-manifest > install-manifest.json`, then set `install_manifest` in the config: every start refuses on a mismatch (exit 78).
3. `install -m 0644 linux/* ~/.config/systemd/user/`, `systemctl --user daemon-reload`.
4. Pause authority (RQ8): `systemctl --user disable --now rf1116-window-pause.timer`, then `systemctl --user enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
5. Cap proof (AQ-17L, outside V6 windows): `deploy/research-queue/cap-proof.sh LINUX` must print no failures; it also records whether `--cgroup-parent=research.slice` works for rootless containers.

## HK (system units, root, coordinator only; NET tasks only)

1. `install -m 0644 hk/rq.sysusers.conf /etc/sysusers.d/rq.conf; systemd-sysusers; install -m 0644 hk/rq.tmpfiles.conf /etc/tmpfiles.d/rq.conf; systemd-tmpfiles --create`.
2. Code in `/opt/research-queue/<sha>/` with `current` symlink; config `/etc/research-queue/rq.json` (host `HK`, `root` `/var/lib/research-queue`, `process_pause_unit` `rq-consumer.service`); manifest as above.
3. `install -m 0644 hk/*.service hk/*.timer hk/research.slice /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
4. Agent launch (Q3b, no new privilege): the HK templates run `/opt/research-queue/current/deploy/research-queue-ai/hk/run-agent.sh` as a child of `rq-consumer.service`. Do not install a polkit rule or a sudoers entry, and do not start `rq-agent.service` from the queue. The gateway unit (`research-queue-ai/hk/rq-deepseek-gateway.service`, `Group=rq`) gives the consumer group the socket `/run/rq-gw/rq-gw.sock`; check `systemctl show rq-consumer.service -p RestrictAddressFamilies -p IPAddressDeny` and that `research-queue` can connect to the socket while `portfolio-desk` cannot.
5. Cap proof (AQ-17H, 14:00-16:00 CST): `cap-proof.sh HK`. Limits are the ops-coord plan (1 CPU, 512 MB, nice 19) and are confirmed here.

## Mac relay

`mac/com.upmeai.research-queue-relay.plist.template` (every 15 min), config `~/Library/Application Support/research-queue/relay.json` (optional; defaults match the desk outbox and the existing ssh aliases). It ships fact packs from `rq-relay-outbox/{linux,hk}/REVIEW_AI_FACT_PACK_V1/` to each host's `inbox/fact-packs/` and pulls each host's `outbox/*.json` into the QRP `var/research-queue-return/<host>/`, verifying by sha256 both ways. No new keys.

## File sha256 (must match after install)

