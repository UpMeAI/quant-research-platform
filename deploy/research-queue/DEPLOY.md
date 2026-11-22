# Research queue install (AUTONOMOUS_RESEARCH_QUEUE_V1, Q1)

For ops-coord. Nothing here is installed by the PR. Every host starts in DRY_RUN: no template is pinned (`config/research_queue_template_pins.v1.json` is empty), so the queue admits nothing until the coordinator's freeze page adds pins. Contract: `docs/contracts/RESEARCH_QUEUE_V1.md`. Q2 adds the gateway and agent units.

## Linux (user units, kayla, linger)

1. Code: `git archive <sha> services/research-queue config docs/contracts/RESEARCH_QUEUE_V1.md | tar -x -C /srv/research-lane/research-queue/code/<sha>/` and `ln -sfn <sha> /srv/research-lane/research-queue/code/current`.
2. Config `~/.config/research-queue/rq.json` (host `LINUX`, `env_allowlist` must carry `RQ_AGENT_IMAGE`, `XDG_RUNTIME_DIR` and `DOCKER_HOST` for the agent launcher; on both hosts `node_bin` (HK: `/opt/node22/bin/node`) is used by the consumer to stage inputs and to re-validate results, and HK sets `spool_dir` `/var/lib/rq-spool`, `root` `/srv/research-lane/research-queue`, `state_dir` `~/.local/state/research-queue`, `templates_path`, `pins_path`, `blackouts_path` under `code/current/config/`). `python3 -m rq --config <file> env-manifest > install-manifest.json`, then set `install_manifest` in the config: every start refuses on a mismatch (exit 78).
3. `install -m 0644 linux/* ~/.config/systemd/user/`, `systemctl --user daemon-reload`.
4. Pause authority (RQ8): `systemctl --user disable --now rf1116-window-pause.timer`, then `systemctl --user enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
5. Cap proof (AQ-17L, outside V6 windows): `deploy/research-queue/cap-proof.sh LINUX` must print no failures; it also records whether `--cgroup-parent=research.slice` works for rootless containers.

## HK (system units, root, coordinator only; NET tasks only)

1. `install -m 0644 hk/rq.sysusers.conf /etc/sysusers.d/rq.conf; systemd-sysusers; install -m 0644 hk/rq.tmpfiles.conf /etc/tmpfiles.d/rq.conf; systemd-tmpfiles --create`.
2. Code in `/opt/research-queue/<sha>/` with `current` symlink; config `/etc/research-queue/rq.json` (host `HK`, `root` `/var/lib/research-queue`, `process_pause_unit` `rq-consumer.service`); manifest as above.
3. `install -m 0644 hk/*.service hk/*.timer hk/research.slice /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
4. HK agent (Q3c): the agent runs as `rq-agent`, never as `research-queue`; the two meet only in the spool `/var/lib/rq-spool` (`in/` written by the consumer, `out/` written by the agent). Install, in this order:
   - `rq.sysusers.conf` no longer puts `rq-agent` in group `rq` (the queue tree is `2770 research-queue:rq`): after `systemd-sysusers`, run `gpasswd -d rq-agent rq` if the user already exists, and check `id rq-agent` shows no `rq`.
   - `rq.tmpfiles.conf` creates the spool (`0750`/`2750`/`2770`, owner `research-queue`, group `rq-agent`).
   - **`research-queue-ai/hk/rq-deepseek-gateway.service` now has `Group=rq-agent`; this supersedes `Group=rq` of #148** (the socket `/run/rq-gw/rq-gw.sock` is group `rq-agent`, as in the design table). If #148's unit is already installed, replace it, `daemon-reload`, restart the gateway.
   - `install -m 0644 research-queue-ai/hk/rq-agent.service research-queue-ai/hk/rq-agent.timer /etc/systemd/system/`, `systemctl enable --now rq-agent.timer`. `rq-agent.service` is a timer-started oneshot that drains the spool and exits; do not enable it as a long-running service, and do not install a polkit rule or a sudoers entry.
   - Checks (AQ-17H/18/33/34): as `rq-agent`, the queue database and state dir are not readable; `research-queue` and `portfolio-desk` cannot read the key file or `/proc/<gw>/environ`; `rq-agent` can connect to the gateway socket and `portfolio-desk` cannot; an external TCP connect from `rq-agent` fails.
   - Pause: the root `rq-pause` tick freezes `rq-consumer.service` and `rq-agent.service` (an inactive oneshot cannot be frozen, which is fine) and writes `/var/lib/rq-spool/in/.pause`, which stops a drain that starts later.
5. Cap proof (AQ-17L, outside V6 windows): `deploy/research-queue/cap-proof.sh LINUX` must print no failures; it also records whether `--cgroup-parent=research.slice` works for rootless containers.

## HK (system units, root, coordinator only; NET tasks only)

1. `install -m 0644 hk/rq.sysusers.conf /etc/sysusers.d/rq.conf; systemd-sysusers; install -m 0644 hk/rq.tmpfiles.conf /etc/tmpfiles.d/rq.conf; systemd-tmpfiles --create`.
2. Code in `/opt/research-queue/<sha>/` with `current` symlink; config `/etc/research-queue/rq.json` (host `HK`, `root` `/var/lib/research-queue`, `process_pause_unit` `rq-consumer.service`); manifest as above.
3. `install -m 0644 hk/*.service hk/*.timer hk/research.slice /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
4. HK agent templates are not pinned yet (follow-up PR); only the Linux card and check run. Gateway socket group (`research-queue-ai/hk/rq-deepseek-gateway.service`, `Group=rq`): confirm at the HK install that `rq-agent` can connect to `/run/rq-gw/rq-gw.sock` and `portfolio-desk` cannot.
5. Cap proof (AQ-17L, outside V6 windows): `deploy/research-queue/cap-proof.sh LINUX` must print no failures; it also records whether `--cgroup-parent=research.slice` works for rootless containers.

## HK (system units, root, coordinator only; NET tasks only)

1. `install -m 0644 hk/rq.sysusers.conf /etc/sysusers.d/rq.conf; systemd-sysusers; install -m 0644 hk/rq.tmpfiles.conf /etc/tmpfiles.d/rq.conf; systemd-tmpfiles --create`.
2. Code in `/opt/research-queue/<sha>/` with `current` symlink; config `/etc/research-queue/rq.json` (host `HK`, `root` `/var/lib/research-queue`, `process_pause_unit` `rq-consumer.service`); manifest as above.
3. `install -m 0644 hk/*.service hk/*.timer hk/research.slice /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
4. Agent launch (Q3b, no new privilege): the HK templates run `/opt/research-queue/current/deploy/research-queue-ai/hk/run-agent.sh` as a child of `rq-consumer.service`. Do not install a polkit rule or a sudoers entry, and do not start `rq-agent.service` from the queue. The gateway unit (`research-queue-ai/hk/rq-deepseek-gateway.service`, `Group=rq`) gives the consumer group the socket `/run/rq-gw/rq-gw.sock`; check `systemctl show rq-consumer.service -p RestrictAddressFamilies -p IPAddressDeny` and that `research-queue` can connect to the socket while `portfolio-desk` cannot.
5. Cap proof (AQ-17H, 14:00-16:00 CST): `cap-proof.sh HK`. Limits are the ops-coord plan (1 CPU, 512 MB, nice 19) and are confirmed here.

## Mac relay

`mac/com.upmeai.research-queue-relay.plist.template` (every 15 min), config `~/Library/Application Support/research-queue/relay.json` (optional; defaults match the desk outbox and the existing ssh aliases). It ships fact packs from `rq-relay-outbox/{linux,hk}/REVIEW_AI_FACT_PACK_V1/` to each host's `inbox/fact-packs/` and pulls each host's `outbox/*.json` into the QRP `var/research-queue-return/<host>/`, verifying by sha256 both ways. No new keys. W05: before a pack is pushed its SEEN mark is written into the QRP trial ledger by `node apps/research-cli/review_pack_seen.js mark --file -` (needs `QRP_PRODUCT_MILESTONE_AUTHORITY` in the launchd environment; `relay.json` may carry `"seen_mark": {"qrp_root": "...", "node": "..."}`); a pack that cannot be marked is not pushed (`failed ... SEEN_MARK_FAILED:<code>`) and is retried on the next pass. A host that also wants to mark what its producer admits sets `RQ_SEEN_MARK_QRP_ROOT` (and optionally `RQ_SEEN_MARK_NODE`) for `producer-tick`; without it the producer marks nothing.

## File sha256 (must match after install)

| File | sha256 |
|---|---|
| `linux/research.slice` | 1846ee8fa5e0ae744217347f28c2eef779d7e39a8553f1a66c321b5731f97bc3 |
| `linux/rq-consumer.service` | 6f78450206a43c2f33623dd81c1415de046220ec457209269dfaef1b02fc3742 |
| `linux/rq-pause.service` | acf5a4f3b6e1a5b9468d4244bc1704163c78d5d4293c167aabf7abca7e63d21e |
| `linux/rq-pause.timer` | 9eddd695c96522998c6a8d83d9338e67b01f2e8f4750f9f7133e93bff242d419 |
| `linux/rq-producer.service` | 8ba544da1a58fe70e1bb4ad4dca1a61c57619f2644f3154df6037a6e8d7517c7 |
| `linux/rq-producer.timer` | 1721ace6f645e62f1fd4a157f3a4c8336e18901b8f4f095bc09406c4065bed78 |
| `hk/research.slice` | 1252835b86183f80e7770095d06f3a93586bc4ceb4f487377c58489f9d3ed01a |
| `hk/rq-consumer.service` | 341fdd4c3c3de2fe703e11eda24c23f6708c8b7b05d9b61390bd2b96cc70d978 |
| `hk/rq-pause.service` | b30c3a401d34dbff89cda84049159b85b3f6b49c9883b7116da6ecfd5fca5614 |
| `hk/rq-pause.timer` | 9eddd695c96522998c6a8d83d9338e67b01f2e8f4750f9f7133e93bff242d419 |
| `hk/rq-producer.service` | c2693d35901f3694b8cc70f01f2fa4d796131d1147a59894c3682a7eb5d84a51 |
| `hk/rq-producer.timer` | 1721ace6f645e62f1fd4a157f3a4c8336e18901b8f4f095bc09406c4065bed78 |
| `hk/rq.sysusers.conf` | c20a90dad17df053a8d07e19fff55c1d8570e3add7883d6cabdb21db5f8e13f1 |
| `hk/rq.tmpfiles.conf` | c378bd36ea513d30521d8a8c9b48f7e832b170067237cc0ef08d003a04dc5f79 |
| `cap-proof.sh` | 14b2dffb5ed16dd38bd9fd7606c327e52bf63bd66194267d7ed712bc34823701 |
| `mac/com.upmeai.research-queue-relay.plist.template` | 3f420fa09d546c784c8c403f976876c1d72dcda8259a052feb9baa5d105a304b |
