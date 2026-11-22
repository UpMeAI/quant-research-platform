# Research queue install (AUTONOMOUS_RESEARCH_QUEUE_V1, Q1)

For ops-coord. Nothing here is installed by the PR. Every host starts in DRY_RUN: no template is pinned (`config/research_queue_template_pins.v1.json` is empty), so the queue admits nothing until the coordinator's freeze page adds pins. Contract: `docs/contracts/RESEARCH_QUEUE_V1.md`. Q2 adds the gateway and agent units.

## Linux (user units, kayla, linger)

1. Code: `git archive <sha> services/research-queue config docs/contracts/RESEARCH_QUEUE_V1.md | tar -x -C /srv/research-lane/research-queue/code/<sha>/` and `ln -sfn <sha> /srv/research-lane/research-queue/code/current`.
2. Config `~/.config/research-queue/rq.json` (host `LINUX`, `root` `/srv/research-lane/research-queue`, `state_dir` `~/.local/state/research-queue`, `templates_path`, `pins_path`, `blackouts_path` under `code/current/config/`). `python3 -m rq --config <file> env-manifest > install-manifest.json`, then set `install_manifest` in the config: every start refuses on a mismatch (exit 78).
3. `install -m 0644 linux/* ~/.config/systemd/user/`, `systemctl --user daemon-reload`.
4. Pause authority (RQ8): `systemctl --user disable --now rf1116-window-pause.timer`, then `systemctl --user enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
5. Cap proof (AQ-17L, outside V6 windows): `deploy/research-queue/cap-proof.sh LINUX` must print no failures; it also records whether `--cgroup-parent=research.slice` works for rootless containers.

## HK (system units, root, coordinator only; NET tasks only)

1. `install -m 0644 hk/rq.sysusers.conf /etc/sysusers.d/rq.conf; systemd-sysusers; install -m 0644 hk/rq.tmpfiles.conf /etc/tmpfiles.d/rq.conf; systemd-tmpfiles --create`.
2. Code in `/opt/research-queue/<sha>/` with `current` symlink; config `/etc/research-queue/rq.json` (host `HK`, `root` `/var/lib/research-queue`, `process_pause_unit` `rq-consumer.service`); manifest as above.
3. `install -m 0644 hk/*.service hk/*.timer hk/research.slice /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now rq-pause.timer rq-producer.timer rq-consumer.service`.
4. Cap proof (AQ-17H, 14:00-16:00 CST): `cap-proof.sh HK`. Limits are the ops-coord plan (1 CPU, 512 MB, nice 19) and are confirmed here.

## Mac relay

`mac/com.upmeai.research-queue-relay.plist.template` (every 15 min), config `~/Library/Application Support/research-queue/relay.json` (optional; defaults match the desk outbox and the existing ssh aliases). It ships fact packs from `rq-relay-outbox/{linux,hk}/REVIEW_AI_FACT_PACK_V1/` to each host's `inbox/fact-packs/` and pulls each host's `outbox/*.json` into the QRP `var/research-queue-return/<host>/`, verifying by sha256 both ways. No new keys.

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
| `hk/rq-consumer.service` | 995af93ecb41f2b2fee0a64fa1278e59a6ad23e6c5fdabefd432b84a3a50baca |
| `hk/rq-pause.service` | 4273d034d3539412fcae4f55447671ea3fa41b464e4961896c544ba4ad3be733 |
| `hk/rq-pause.timer` | 9eddd695c96522998c6a8d83d9338e67b01f2e8f4750f9f7133e93bff242d419 |
| `hk/rq-producer.service` | c2693d35901f3694b8cc70f01f2fa4d796131d1147a59894c3682a7eb5d84a51 |
| `hk/rq-producer.timer` | 1721ace6f645e62f1fd4a157f3a4c8336e18901b8f4f095bc09406c4065bed78 |
| `hk/rq.sysusers.conf` | 2c6aa95066b8cdec1eea20cb9fdf5e78541fb4c4a7b90ff808de130ebcd38775 |
| `hk/rq.tmpfiles.conf` | 245a513937a00d4cb448207e6bc14130cb9a02661a1ac03a76189997fef63bb8 |
| `cap-proof.sh` | 14b2dffb5ed16dd38bd9fd7606c327e52bf63bd66194267d7ed712bc34823701 |
| `mac/com.upmeai.research-queue-relay.plist.template` | 3f420fa09d546c784c8c403f976876c1d72dcda8259a052feb9baa5d105a304b |
