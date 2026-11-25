# RF1116 post-round user timer

This package only ships the two user units. Ops-coord installs them after
Packages A, B, and C are reviewed and merged in the required order. The
service runs as the existing `kayla` user; there is no system-level unit.

## Paths and ownership

- Code: `/srv/research-lane/research-queue/code/current`
- Per-round state: `/srv/research-lane/rf1116-mining/post-round`
- Environment file: `%h/.config/research-queue/rf1116-post-round.env`
- User units: `rf1116-post-round.service` and `rf1116-post-round.timer`

Before enabling the timer, ops-coord creates the per-round state directory as
`kayla:kayla`, mode `0750`. The program creates one child directory per round.
It never uses the lane `out/` tree for its own state.

## Environment file

Create the environment file as `kayla`, mode `0600`. `RQ_INBOX`,
`RQ_STATE_DIR`, and `RQ_RUNS_DIR` must be copied from the same authoritative
paths used by `%h/.config/research-queue/rq.json`; do not infer parallel queue
directories. The current Linux layout is shown below and must be checked
against that file during installation.

```ini
QRP_DATA_DIR=/srv/research-lane/qrp/var/ledger
RF1116_LANE_OUT=/srv/research-lane/rf1116-mining/out
RF1116_POST_ROOT=/srv/research-lane/rf1116-mining/post-round
RQ_INBOX=/srv/research-lane/research-queue/inbox
RQ_STATE_DIR=/home/kayla/.local/state/research-queue
RQ_RUNS_DIR=/srv/research-lane/research-queue/runs
RF1116_MODEL_GATE_FILE=/srv/research-lane/rf1116-mining/state/model_gate_last.json
RF1116_REGISTER_FILE=/srv/research-lane/research-queue/code/current/config/research_mechanism_register.v1.json
RF1116_SPACE_FILE=/srv/research-lane/research-queue/code/current/docs/freeze/MINING_SPACE_V1_CN_A_R1.0d3556fa.json
RF1116_COMMIT_FILE=/srv/research-lane/rf1116-mining/code/.QRP_COMMIT
RQ_BLACKOUTS_FILE=/srv/research-lane/research-queue/code/current/config/rq-blackouts.v1.json
RF1116_RUNNER=/srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh
RF1116_RUNNER_IMAGE=qrp-round-runner:<reviewed-commit12>
RF1116_SPACE_SHA256=0d3556fa97f17d3a67b350e7f74c12fb521ca1fb60c293121601f7eb95f96637
RF1116_NOTE_TEMPLATE_ID=T-AI-MECH-NOTE-V1-LINUX-CN_A
RF1116_NOTE_TEMPLATE_SHA256=c8c75ceb592bd91dbaab3f04f82a6f464a6a92335a0507800fe4369fdf1a2ee8
RF1116_REVIEW_TEMPLATE_ID=T-AI-MECH-REVIEW-V1-LINUX-CN_A
RF1116_REVIEW_TEMPLATE_SHA256=ea9822c596a491f19aec50f3c04c11b20d149e2e65bcbecf95c1d8b01d6f97b1
```

The `<...>` image value is an install-time pin. Enabling is refused until
ops-coord replaces it with the reviewed image commit. The frozen selection
space path and hash above are shipped authority, not install-time choices.
The file contains paths and hashes only, never provider keys.

## Install and verify

Run only after the merged code tree and environment file are present:

```sh
install -d -m 0750 -o kayla -g kayla /srv/research-lane/rf1116-mining/post-round
install -m 0644 deploy/research-lane/post-round/rf1116-post-round.service ~/.config/systemd/user/
install -m 0644 deploy/research-lane/post-round/rf1116-post-round.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemd-analyze --user verify ~/.config/systemd/user/rf1116-post-round.service ~/.config/systemd/user/rf1116-post-round.timer
systemctl --user enable --now rf1116-post-round.timer
systemctl --user status rf1116-post-round.timer
```

The PR does not perform these steps. Runtime certification remains separate
from the static unit acceptance and requires the reviewed Package B program
and task-level queue status authority.
