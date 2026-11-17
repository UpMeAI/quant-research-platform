# RF1116 P2 round runner — research lane deployment (GP only)

The coordinator deploys this. Nothing here is run from the Mac. The runner covers MINING_ROUNDS_V1 "P2 requirements" and P2 spec §1:
- it runs in a rootless container;
- data mounts are read-only;
- the container has no network (GP needs none);
- there is one writable output directory;
- the holdout directory is mounted only in the scoring phase.

## Host, users, paths

- **Host:** the Linux research lane. The user is `kayla` (uid 1000, no sudo), running rootless Docker at `DOCKER_HOST=unix:///run/user/1000/docker.sock`.
- **Container user:** `1000:1000`, the image's `node` user. Under rootless Docker it maps to host subuid **100999**, never root.
- **Never mount `/srv/backup`** or anything under `/srv/v6-prod` into this container.

| path | contents | owner / mode | mount |
|---|---|---|---|
| `/srv/research-lane/rf1116-mining/code/` | QRP checkout at the reviewed merge commit (build context) | kayla, 0755 | not mounted (baked into the image) |
| `/srv/research-lane/rf1116-mining/data/rf1116-cn-a-lane-copy-20200601-20260928/` | the lane copy in export spec rev 2 CSV layout (see below). `HISTORY` source | kayla, dirs 0755 / files 0644 | `/data/lane:ro` |
| `/srv/research-lane/rf1116-mining/data/rf1116-cn-a-daily-20260929-20261016/` | validation tail export (spec §1, first directory), with `SHA256SUMS` and `EXPORT_MANIFEST.json`. `LIVE` source | kayla, 0755 / 0644 | `/data/tail:ro` |
| `/srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019/` | holdout export (spec §1, second directory) plus `SHA256SUMS.sealed` | kayla, **0700** until hand-over | `/data/holdout:ro`, **`score` only** |
| `/srv/research-lane/rf1116-mining/out/` | `qrp-data/` (mining rounds, trials, holdout vault, G-MINE records) and `rounds/<round_id>/` (`attempts.jsonl`, `generate.json`, `selection.json`, `score.json`) | container uid 1000 (host 100999) | `/out:rw`, the only writable mount |

**`out/qrp-data/` persists across rounds and is never deleted.** It holds the cumulative N of family `MINE:CN_A:H5`. Container-written files belong to host uid 100999, so kayla can read them but cannot remove them.

### Lane copy layout

- **Files and columns:** the same file names and columns as export spec rev 2 §2:
  - `prices_daily_stock.csv`
  - `market_daily_basic_observation_stock.csv`
  - `adjustment_factor_observation_stock.csv`
  - `security_master_stock.csv`
  - `security_suspension_observation.csv`
  - `security_suspension_day_coverage.csv`
  - `trading_calendar.csv`
- **Dates:** trade dates 2020-06-01 → 2026-09-28. **`trading_calendar.csv` starts at 2019-06-01**, so the 120-session listing rule works from the first mining day.
- **Integrity:** `SHA256SUMS` comes from `shasum -a 256 *.csv`.
- **Source:** it is exported read-only from the lane's replay copy with the same queries, no vendor re-fetch.
- **Other formats:** a different reader can be plugged in with `--lane-adapter <module>` (a module exporting `createSource(dir, opts)`). No adapter is needed when the layout above is used.

## One-time setup

```sh
mkdir -p /srv/research-lane/rf1116-mining/{code,data,holdout-sealed,out}
git clone https://github.com/UpMeAI/quant-research-platform.git /srv/research-lane/rf1116-mining/code && git -C /srv/research-lane/rf1116-mining/code checkout --detach <merge-commit>
cd /srv/research-lane/rf1116-mining/code && DOCKER_HOST=unix:///run/user/1000/docker.sock \
  docker build -f deploy/research-lane/round-runner/Dockerfile -t qrp-round-runner:<commit12> .
DOCKER_HOST=unix:///run/user/1000/docker.sock docker run --rm --user 0:0 --network none \
  -v /srv/research-lane/rf1116-mining/out:/out --entrypoint chown qrp-round-runner:<commit12> 1000:1000 /out   # out/ writable for container uid 1000
```

- **Network at build time only:** the build pulls `node:22.12.0-bookworm-slim` once. `npm ci` installs nothing, because QRP has no dependencies and the lockfile pins that.
- **Pin by digest:** record the pulled image digest (`docker image inspect node:22.12.0-bookworm-slim --format '{{index .RepoDigests 0}}'`) in the deploy log.

## Seal, then generate (steps 1–5)

**Before the first round**, put the holdout export in `holdout-sealed/…`, then record what is being sealed:

```sh
cd /srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019
cp SHA256SUMS SHA256SUMS.sealed && chmod 0700 . && sha256sum SHA256SUMS.sealed    # -> <holdout_sha256>
```

**Run** (one line; the seed is any integer, and it is written into the round manifest):

```sh
RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh generate <gp_seed> <holdout_sha256>
```

The run does the following:
- opens a CN_A GP round with the frozen space `0d3556fa…`, freeze page `4ec642b9…`, holding period 5, cap 200 and holdout 2026-10-19 → 2026-12-31;
- seals the holdout (data_ref + `<holdout_sha256>`);
- generates and scores on the mining segment. **Every attempt is a trial row** (parse-refused and deduplicated included), and the run stops at 200;
- runs the validation-fold selection into `out/rounds/<round_id>/selection.json`.

It prints one JSON line with the `round_id`.

**Crashed mid-generation?**

```sh
run.sh resume <round_id>
```

The GP continues deterministically from the ledger. After `selection.json` exists, generation for that round is closed.

## Hand-over and scoring (steps 6–9), only after the 2026-12-31 data is in

The completion export goes into **the same holdout directory**:
- new files are named `<table>_<YYYYMMDD>.csv`;
- `SHA256SUMS` is recomputed;
- `SHA256SUMS.sealed` is left untouched.

**Hand-over** is the only point where the runner gets the holdout:

```sh
chmod -R a+rX /srv/research-lane/rf1116-mining/holdout-sealed/rf1116-cn-a-daily-holdout-from-20261019   # readable by container uid 1000
RF1116_RUNNER_IMAGE=qrp-round-runner:<commit12> /srv/research-lane/rf1116-mining/code/deploy/research-lane/round-runner/run.sh score <round_id>
```

**Checks before `holdout-vault.open`.** Before opening the vault, the runner checks two things without reading any market file:
1. The holdout files are intact:
   - either `sha256(SHA256SUMS)` equals the sealed sha;
   - or `sha256(SHA256SUMS.sealed)` equals it and every sealed line is still in `SHA256SUMS` (append-only).
2. The holdout trading calendar reaches 2026-12-31.

Otherwise it refuses with `MINE_RUNNER_HOLDOUT_SHA_MISMATCH`, `…_SEALED_FILES_CHANGED` or `…_HOLDOUT_INCOMPLETE`, and the single open is not spent.

**After the checks** it does the following:
- opens the vault once;
- scores only through `neutralizeForScoring`;
- writes one `MINING_GATE_RECORD_V1` per candidate;
- closes the round.

## Limits and timing

| item | value |
|---|---|
| `--cpus` | 6 |
| `--memory` / `--memory-swap` | 24g / 24g (no swap) |
| `--pids-limit` | 256 |
| Node heap | 20 GiB (`--max-old-space-size=20480`) |
| root fs | read-only; `/tmp` is a 256 MiB tmpfs |
| network | `--network none` (GP). The LLM step is not built: `MINE_LLM_NOT_ENABLED` |

- **Shared host:** this host also carries V6 production. Run outside the V6 windows: 09:15–15:30 CST, the post-close chain, and the 06:30 PREMARKET.
- **Run time:** a full round is roughly 200 mining evaluations plus one validation pass. That takes hours, not minutes.
- **Monthly limit:** at most 2 rounds per market per month (Beijing time).
- **One open round per market:** a round stays open (`CAP_REACHED`) until it is scored in early 2027, so a second CN_A round cannot open before then.
