# Linux AQ agent image

This image is the keyless, network-isolated runtime used by `run-agent.sh`. It copies the exact `git archive` of one commit. The agent uses only Node built-ins and repository files, so no `node_modules`, package download, or build-time network is needed.

On the Linux lane, after the merge commit has been archived into the production code tree, build from that same commit (the expected tag is `rq-agent:<12-hex>`):

```sh
export DOCKER_HOST=unix:///run/user/1000/docker.sock
export TMPDIR=/srv/research-lane/scratch
deploy/research-queue-ai/linux/build-image.sh \
  <40-hex-merged-commit> \
  "$HOME/.config/research-queue/rq-agent-image.env" \
  "$HOME/.local/state/research-queue/rq-agent-image-build.json"
```

The build refuses to pull, uses `--network none`, and prints and records both `RQ_AGENT_IMAGE` and `RQ_AGENT_IMAGE_ID`. Check that the receipt commit equals the installed code commit and the tag equals its first 12 hex characters. Then regenerate and install the research-queue environment manifest, install the updated consumer unit, and run:

```sh
systemctl --user daemon-reload
systemctl --user restart rq-consumer.service
```

Do not set `MODE=LIVE` until the Linux scratch fixture has completed stage → agent → `result.json`, the missing-input check has returned 66 without starting Docker, and the ci-linux pair is green. This PR builds no image, installs no unit, and changes no mode.
