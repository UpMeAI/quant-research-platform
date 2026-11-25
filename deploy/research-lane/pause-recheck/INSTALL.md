# QRP monthly pause re-check user timer

This package ships `qrp-pause-recheck.service` and
`qrp-pause-recheck.timer`. Ops-coord installs them only after Packages A and B
are reviewed and merged. The service runs as the existing `kayla` user; it is
not installed or enabled by this change.

## Paths and ownership

- Code: `/srv/research-lane/research-queue/code/current`
- Data root: the reviewed `QRP_DATA_DIR`
- Environment file: `%h/.config/research-queue/pause-recheck.env`
- User units: `qrp-pause-recheck.service` and `qrp-pause-recheck.timer`

Before enabling the timer, ops-coord creates these empty directories below
`QRP_DATA_DIR`, owned by `kayla:kayla` and mode `0750`:

```text
research/promotion/results
research/promotion/terms
research/promotion/observed
research/pause-recheck
```

For example, after independently confirming the reviewed value of
`QRP_DATA_DIR`:

```sh
install -d -m 0750 -o kayla -g kayla "$QRP_DATA_DIR/research/promotion/results"
install -d -m 0750 -o kayla -g kayla "$QRP_DATA_DIR/research/promotion/terms"
install -d -m 0750 -o kayla -g kayla "$QRP_DATA_DIR/research/promotion/observed"
install -d -m 0750 -o kayla -g kayla "$QRP_DATA_DIR/research/pause-recheck"
```

Create `%h/.config/research-queue/pause-recheck.env` as `kayla`, mode `0600`.
It contains reviewed paths only, including `QRP_DATA_DIR`, the queue inbox and
state directories, and the frozen template id and sha256. It contains no
provider credential.

The observed-file producer is intentionally outside this package. When a
paused row has no current-month observed file, the program records
`OBSERVED_MISSING`, does not call the promotion engine for that row, and does
not treat the unknown state as a failed re-check. The per-market monthly
research-budget values are also not frozen here; a budget-dependent row stays
`OBSERVED_MISSING` until an authoritative producer supplies them.

## Install and verify

Run only after the merged code tree, reviewed data directories, and environment
file are present:

```sh
install -m 0644 deploy/research-lane/pause-recheck/qrp-pause-recheck.service ~/.config/systemd/user/
install -m 0644 deploy/research-lane/pause-recheck/qrp-pause-recheck.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemd-analyze --user verify ~/.config/systemd/user/qrp-pause-recheck.service ~/.config/systemd/user/qrp-pause-recheck.timer
systemctl --user enable --now qrp-pause-recheck.timer
systemctl --user status qrp-pause-recheck.timer
```

The PR performs none of these operations. Runtime verification is separate
from static unit acceptance and remains pending until ops-coord installs the
reviewed Package A program and observes a real monthly slot.
