# MINING_ROUNDS_V1 — rounds, cumulative N, holdout vault, AI_MINED_CANDIDATE, mined-lineage promotion (RF1116 §3.3–3.4, P1 part 2)

Source: the signed RF1116 text (`fd22876f…`, signature page `39f8c17c…`), §2.4, §3.3, §3.4, §6 item 2, §8.1 row P1, §8.2, and §8.3 items 8–10. It also covers the coordinator's addition of 2026-11-17 (mined lineage needs the race route).

QRP side only. The sandbox process writes no ledger (see `MINING_SANDBOX_V1`). Round manifests, candidate trial rows and holdout custody all go through these services.

## Trial ledger: `MINED_CANDIDATE`

- **Role rules.** The role is `MINED_CANDIDATE` and the stage is always `SIGNAL`. The role counts in N. The family is `MINE:<market>:H<holding trading days>`, one family per market × holding period.
- **Mining block.** Each row carries a `mining` block: `round_id`, `candidate_id`, `space_sha256`, `formula_sha256` and `generator` (`AI_MINED_LLM` or `AI_MINED_GP`). Other roles cannot carry `mining`.
- **N never resets.** N is the existing `count(family)`: distinct rule configs, accumulated across every round. Dedupe-rejected and orthogonalized versions are written as rows of their own, so they count too.

## Rounds `MINING_ROUND_V1` (`services/mining-rounds`, ledger `research/mining_rounds.jsonl`)

| rule | refusal |
|---|---|
| The manifest is the pre-registration: frozen space (sha + freeze page), holding periods, generator (LLM model and knowledge cutoff, or GP seed), cap ≤ 200, holdout window | `MINE_ROUND_*_INVALID`, `MINE_ROUND_SPACE_NOT_FROZEN` |
| For LLM rounds, the holdout must start after the model's knowledge cutoff | `MINE_ROUND_HOLDOUT_BEFORE_CUTOFF` |
| The holdout is frozen by the market's first round and never moves | `MINE_ROUND_HOLDOUT_MOVED` |
| One open round per market | `MINE_ROUND_ALREADY_OPEN` |
| At most 2 rounds per market per month (Beijing time) | `MINE_ROUND_MONTHLY_CAP` |
| Every scored candidate becomes one trial row. Candidate 201 is not scored and stops the round (`CAP_REACHED`), with no top-up | `MINE_ROUND_CAP_REACHED` |
| 3 consecutive closed rounds without a G-MINE pass pause the market. It reopens only with a frozen space not used in those rounds; N keeps accumulating while paused | `MINE_MARKET_PAUSED` |

Statuses run `OPEN` → `CAP_REACHED` → `SCORING` (holdout opened; no more candidates) → `CLOSED`.

**G-MINE records and closing** (coordinator ruling 3, 2026-11-17):
- **The count is derived, never passed in.** `closeRound` takes no pass count; passing one is refused with `MINE_ROUND_GMINE_PASSES_NOT_A_PARAMETER`. The count comes from the per-candidate records `MINING_GATE_RECORD_V1` (`research/mining_gate_records.jsonl`), and the round row keeps the basis in `gmine_basis`.
- **Records are written by the G-MINE evaluation path.** `services/mining-rounds/gate-records.js` runs G-MINE on the candidate result itself and appends one record per candidate per round, linked to the trial row and the holdout open. A candidate passes only if the gate passes and all nine items pass. A record requires a round in `SCORING` with the candidate in the open log; duplicates are refused.
- **Thresholds come only from the pinned file** (coordinator addition, 2026-11-17).
  - **The file:** `config/mining_gate_thresholds.v1.json` in QRP git. It is committed as `PENDING_FREEZE` with the draft ★e values and `frozen_ref: null`. It turns `FROZEN` only through a coordinator-reviewed PR that also sets `frozen_ref`. G-MINE's own `THRESHOLDS` is read from the same file.
  - **What the writer accepts:** no `ctx` from the caller. Caller thresholds → `MINE_GATE_RECORD_THRESHOLDS_FROM_CALLER`; any other key (`familyTrialCount`, `library`, `registerBytes`, `marks`, `asOf`) → `MINE_GATE_RECORD_CTX_NOT_ACCEPTED`.
  - **What it uses instead:** N is taken from the trial ledger (`count(family).n_raw`) and segment marks from the trial ledger. The factor library and mechanism register are the repo's pinned copies, which are the gate's defaults.
  - **What it records:** the file's sha256 (`thresholds_file`), the six values plus state and `frozen_ref` (`thresholds_used`), and `family_trial_count`.
  - **While unfrozen:** while the file is `PENDING_FREEZE`, every record is `pass: false` (`MINE_THRESHOLDS_UNFROZEN`).
  - **Once FROZEN** (★e freeze PR), the freeze page is checked from the repo itself, never from the coordinator directory.
    - `frozen_ref.path` points to the in-repo copy of the freeze page, `docs/freeze/RF1116_GMINE_THRESHOLDS_FREEZE_1.md`. It must be byte-identical to the coordinator's issued page, which is named in `frozen_ref.coordinator_path`.
    - G-MINE's default thresholds and every per-candidate record (`checkFreeze`) verify that the page exists under `docs/freeze/`, that its sha256 equals `frozen_ref.sha256`, and that it contains `FROZEN` and all six values. Otherwise the result is `MINE_THRESHOLDS_FREEZE_REF_INVALID`, with the reason in `thresholds.freeze_check` (`PATH_INVALID`, `PAGE_MISSING`, `PAGE_SHA_MISMATCH`, `PAGE_NOT_FROZEN` or `PAGE_VALUE_MISSING:<key>`).
    - The check is deterministic on every machine, the research lane included.
    - **Issued pages** (coordinator, 2026-11-17T10:57:06+08:00, after the Owner signed 「挖掘按推荐」). Byte copies live in `docs/freeze/`, and a guard test pins each one to its issued sha256:
      - `RF1116_GMINE_THRESHOLDS_FREEZE_1.md` (`8a36e15b…`, the ★e page that `frozen_ref` points to);
      - `MINING_SPACE_V1_CN_A_R1_FREEZE_1.md` (`4ec642b9…`) plus the frozen space `MINING_SPACE_V1_CN_A_R1.0d3556fa.json` (`0d3556fa…`, the DRAFT_4 bytes), which pass `space.verifyFreeze`;
      - `RF1116_HOLDOUT_CN_A_R1_FREEZE_1.md` (`0fefcd24…`, holdout 2026-10-19 → 2026-12-31).

      With these copies, the P2 runner and the holdout vault can verify on the research lane without the Mac's coordinator folder.
- **Missing results block the close.** Any opened candidate without a record → `MINE_ROUND_GMINE_RESULT_MISSING`. A round closed without opening the holdout records 0.
- **The pause rule counts only these records.**

**Generator view** (`generatorView`): the space, mining-segment scores and the formulas already tried in this market. It exposes nothing from validation folds, the holdout, races or paper trading, and nothing about G-MINE pass or fail.

## Holdout vault (`services/holdout-vault`, ledger `research/holdout_vault.jsonl`)

- **`seal`.** One seal per round. Its window must equal the round's holdout, and only the data reference and its sha256 are recorded.
- **`open`.** One open per round (`MINE_HOLDOUT_ALREADY_OPENED`), after generation ends. Rules:
  - candidates must be unique (each is read once);
  - candidates must be this round's `MINED_CANDIDATE` rows;
  - every open is logged;
  - opening moves the round to `SCORING`.

## `ai_inputs` `AI_MINED_CANDIDATE` (G-MECH gate)

- **New category.** `AI_MINED_CANDIDATE` joins `EXTRACTED_FACT`. An item carries `candidate_id` and `round_id`, and K2 §0 line 4 must state both ids.
- **Mined factors need it.** When `entry.factor_refs` names a factor whose library origin is `AI_MINED_*`, the entry needs a matching `AI_MINED_CANDIDATE` item, with the same candidate and round as the library's `mining`. Otherwise it gets `AI_ROLE_MINED_CANDIDATE_MISSING`.
- **The K2 text is scanned too** (coordinator ruling 2). If the K2 bytes contain a mined factor id (library origin `AI_MINED_*`), or a `MINED_CANDIDATE` candidate or round id (trial ledger), with no matching `AI_MINED_CANDIDATE` item, the result is `AI_ROLE_MINED_CANDIDATE_MISSING`, whether or not `factor_refs` is declared.
  - **Token boundary:** the character before and after a match must not be one of `A–Z a–z 0–9 _ : -`. So `C042` is not found inside `XC042`, `C0421`, `C042-b` or `R:C042`. Backticks, brackets, CJK punctuation and a trailing `.` count as boundaries.
  - **Candidate ids are globally unique,** written as `<round_id>:<id>`.

## Promotion: mined lineage needs race and paper validation

- **Refusal.** `createPromotionCandidate` takes an optional `trial_refs` list. Its lineage is those trials plus the TRL ids in their `source_refs`, followed recursively. If the lineage contains a `MINED_CANDIDATE`, the candidate must carry both `race_manifest_ref` and `paper_validation_refs`, otherwise `PROMOTION_MINED_REQUIRES_RACE_AND_PAPER`. When both are present, they then pass through the existing PAPER_VALIDATION_V1 gate.
- **`trial_refs` is required** (coordinator ruling 1). Every new candidate must carry a non-empty `trial_refs`, otherwise `PROMOTION_TRIAL_REFS_REQUIRED`, so the lineage walk always runs. Existing ledger rows are not rewritten.
- **Non-mined candidates.** The record is the legacy record plus `trial_refs`, which non-mined records now carry too. `trial_refs` stays out of the id hash, so `candidate_id` is unchanged.

## P2 requirements (coordinator ruling, 2026-11-17)

- **Container.** The round runner runs only inside the research lane's rootless container, with read-only data mounts and network egress to the model API only.
- **Only producer of holdout results.** The round runner is the only producer of holdout results, and it produces them through `neutralizeForScoring` (`services/mining-sandbox/evaluator`). Its per-candidate G-MINE results go through `recordGateResult`.
- **Built (P2).** The runner is `services/mining-sandbox/round-runner` (see `MINING_SANDBOX_V1`, "Round runner"), and the container is `deploy/research-lane/round-runner/` (`DEPLOY.md`). GP rounds need no egress, so the container runs `--network none`.
- **Every attempt is a trial row (P2).** The runner writes parse-refused and deduplicated attempts through `recordCandidate` as well, with no score. Each carries `rule_config.attempt` and `attempt_id`, so it counts toward the round cap of 200 and toward N. `candidates_scored` therefore counts attempts.
- **`holdout-vault.sealOf(round_id)`** returns the seal row (read-only). The runner checks the mounted holdout directory against it before `open`.
- **Selection is a ledger row (P2 review, 2026-11-17).**
  - `recordSelection(round_id, {selection_sha256, selected, evaluated, rule})` appends one `MINING_SELECTION_V1` row per round (`research/mining_selections.jsonl`): the sha256 of the runner's `selection.json` and the candidates that passed the validation folds.
  - Selected ids must be scored attempts of the round (`MINE_ROUND_SELECTION_CANDIDATE_INVALID`). A second row gives `MINE_ROUND_SELECTION_EXISTS`.
  - After the row exists, `recordCandidate` refuses with `MINE_ROUND_GENERATION_CLOSED`.
  - The holdout opens exactly the ids in this row, and the runner takes each formula from its trial row, never from the output file.

## Coordinator ruling R1 (2026-11-17)

Source: `RF1116_RULING_R1_20261117.md`, revision 4, sha256 `705e2e6aa9a741f94e09f708579ed0270b5220b227081d485e8f4515c8978e36`. Revision 4 states the intent of R1.5 and R1.6 (no new rule) and adds R1.12. Revision 3 (`5f0d0328…`) corrected R1.7 and added R1.9–R1.11. Revisions 3, 2 (`d80ce988…`) and 1 (`ce254328…`) are kept in the coordinator folder.

A byte copy of revision 4 is at `docs/freeze/RF1116_RULING_R1_20261117.md`, and the docs/freeze guard test pins it. Every manifest cites `705e2e6a…`.

- **R1.1 Every attempt is a trial row.** Parse-refused and deduplicated attempts are written through `recordCandidate`, unscored. They count toward the round cap of 200 and toward the family's cumulative N (signed §3.3).
- **R1.2 The selection rule lives in the manifest, and every manifest cites its rulings.**
  - `openRound` requires `rulings: [{path, sha256}]` (`MINE_ROUND_RULINGS_REQUIRED`). Each entry needs an in-repo copy `docs/freeze/<basename(path)>` with that sha256 (`MINE_ROUND_RULING_COPY_INVALID`).
  - `openRound` also requires `selection_rule`, a `VALIDATION_SELECTION_V1` object (`MINE_ROUND_SELECTION_RULE_REQUIRED` / `…_INVALID`):
    - folds ascending and non-overlapping;
    - `mean_ic_gt` and `mining_score_gt` numbers;
    - `positive_folds_min` an integer from 1 to the number of folds.
  - The rule is part of the pre-registration (`manifestSha`). The runner reads it from the manifest. Changing it means a new round.
  - Round 1 freezes the R1.2 rule: 6 half-year folds; mean IC > 0; at least 4 positive folds; mining score > 0.
- **R1.6 Concurrent rounds and holdout segments** (`LIMITS.open_rounds_per_market` = 2, `LIMITS.rounds_per_holdout` = 2).
  - At most 2 unclosed rounds per market (`MINE_ROUND_ALREADY_OPEN`), still at most 2 opens per month. Each round opens the holdout once.
  - A holdout segment serves at most 2 rounds (`MINE_ROUND_HOLDOUT_EXHAUSTED`). A round either reuses the latest segment, if it is not used up, or takes a new segment that starts after every earlier segment's end. Anything else gives `MINE_ROUND_HOLDOUT_MOVED`.
  - From round 3, a segment after 2026-12-31 is therefore required.
  - `holdout-vault.open` counts how many times this segment has been opened in the market, including this one. The count goes into the open row (`segment_open_index`) and into the round row (`holdout_opens`), which keeps it through close.
  - **Revision 4 (intent):** sharing a segment is allowed only before its first open. Once any round of the market has opened the segment (its round row has `holdout_opens`, or the vault has an open row), `openRound` refuses new rounds on it (`MINE_ROUND_HOLDOUT_SEGMENT_OPENED`). A round closed without opening the holdout does not count as an open. A round that already shares the segment still opens its own holdout once.
- **R1.5 Mechanisms** (`services/mining-rounds/mechanisms.js`, `MINING_MECHANISM_V1`, `research/mining_mechanisms.jsonl`).
  - **What can be registered.** `registerMechanism(round_id, {candidate_id, mechanism_id, economic_logic_zh, failure_mode_zh, written_at}, {writtenBy})` accepts only candidates in the round's selection row, and only before the holdout opens (`MINE_MECHANISM_AFTER_HOLDOUT_OPEN`).
  - **Checks.** The `mechanism_id` must be registered (`…_ID_NOT_REGISTERED`). Both texts are required (`…_FIELDS`). `written_at` is Beijing time and no later than the registration time `registered_at` (`…_WRITTEN_AT`; revision 4 removed the 5-minute tolerance).
  - **At scoring (revision 4).** G-MINE item 9 requires `written_at` ≤ `registered_at` < the vault open's `opened_at`, not the scoring time. The runner passes `holdout.opened_at` (from the open row) and `mechanism.registered_at`. A registration at or after the open, or a missing time, gives `MINE_MECHANISM_AFTER_HOLDOUT`; `written_at` after `registered_at` gives `MINE_MECHANISM_WRITTEN_AFTER_REGISTRATION`.
  - **G-MECH.** The G-MECH triage route must not be `NOT_DO_SETTLED` (`…_NOT_DO_SETTLED`). The route and the register sha are stored, and other candidates of the round with the same mechanism are listed in `same_mechanism_in_round`.
  - **One per candidate,** append-only (`…_DUPLICATE`).
- **R1.8 Recovery after a crash past the open.**
  - **The rescore.** `holdout-vault.recordRescore` allows exactly one `RESCORE_SAME_SELECTION` per round (`MINE_HOLDOUT_RESCORE_ONCE`), as a second vault event (`HOLDOUT_RESCORE_V1`, `research/holdout_vault.jsonl`, with the reason and the log's sha256 and excerpt).
  - **Its conditions.**
    - The round is `SCORING`.
    - The selection row is byte-unchanged: its `record_hash` recomputes and equals the hash the open row recorded (`…_SELECTION_CHANGED`).
    - The runner's `inputs_sha256` equals the open row's (`…_INPUTS_CHANGED`).
    - No G-MINE record exists for the round (`…_RECORDS_EXIST`). With any record written, R1.12 applies instead.
  - **Determinism.** Scoring is deterministic on the same inputs and code; a test pins that a crash plus a rescore gives the same records as a clean run.
  - **Failed rescore.** `failRescore` closes a round whose rescore also crashed as `FAILED_RESCORE`: `gmine_passes` 0, no records counted, the attempts staying in N. Any record the rescore wrote before dying is marked VOID, as in R1.12.
  - **Pause rule and open count.** The pause rule counts a `FAILED_RESCORE` round as a failure; it no longer counts as open.
- **R1.12 A crash after some G-MINE records were written (revision 4).**
  - **State.** `failPartial(round_id, {reason, logSha256})` closes the round as the terminal state `FAILED_PARTIAL`. It is reachable only from `SCORING` (`MINE_ROUND_NOT_SCORING`) and needs a reason (`MINE_ROUND_FAILED_PARTIAL_REASON`).
  - **When.** At least one record and not all of them: with none, the R1.8 rescore applies (`MINE_ROUND_FAILED_PARTIAL_NO_RECORDS`); with all, the round closes normally (`MINE_ROUND_FAILED_PARTIAL_COMPLETE`). The runner's `rescore` closes the round this way when any record exists and no rescore event does (`MINE_RUNNER_RESCORE_RECORDS_EXIST`).
  - **Effects.**
    - The round counts as 0 passes (`gmine_passes` 0; `gmine_basis.failed_partial` lists the reason, the log sha256, the counts and the voided record hashes).
    - The written records keep their rows. Each gets a `MINING_GATE_RECORD_VOID_V1` row (`gate-records.voidRecords`). `recordsOf` never returns VOID records or any record of a `FAILED_*` round; `{ includeVoid: true }` returns the original rows for audit.
    - The attempts stay in N.
    - The open-round slot is released.
    - The holdout use stays counted: the open row and `holdout_opens` are kept, and R1.6 refuses new rounds on that segment.
  - **Pause rule.** It counts `FAILED_PARTIAL` as a failed round with 0 passes; VOID records, passing or not, are never counted.
- **Resume record.** `recordResumeCheck` appends the floor used on a `--resume` run to the round row's `data_checks.resumes`.
- **R1.9 The comparison set for G-MINE items 7–8.** Items 7–8 compare only against same-market `LIVE_IN_RULE` factors that cover the full stock cross-section.
  - **Single source:** `factor-library` `COMPARISON_EXCLUSIONS` / `comparisonFactorIds`.
  - **Excluded:**
    - #14 `CN_A_ETF.MOM.SECTOR_ETF_REALIZED_MOM20`, which is ETF-level;
    - #2 `CN_A.MOM.RS20_UNIT_PCT` and #7 `CN_A.COMPOSITE.STOCK_BOOK_V4`, which V6 stores for the top ten only.
  - **Effect:** the gate's item-8 `want` set and its item-7 book both use this set, and so does the runner's comparison. Every `MINING_GATE_RECORD_V1` carries `excluded_factors: [{factor_id, reason, ruling}]`.
  - **Also dropped:** because the set is `LIVE_IN_RULE` only, the retired `CN_A.MOM.RS20_REALIZED_CORE_POOL` no longer enters item 8 either.
- **R1.10 Mechanisms.** GP candidates may cite only mechanisms already in the register (`MINE_MECHANISM_ID_NOT_REGISTERED`). A new mechanism needs a register PR first.
- **R1.11 Factor series from the live window only.**
  - Items 7–8 read V6's live tables only. They start 2026-08-26 to 2026-10-08, and the holdout 2026-10-19 → 2026-12-31 lies inside.
  - History from 2020-06 → 2026-09-28 is only in the Q0 replay, a different producer. Using it is an open parity question.
  - The analyst-revision factor has no history before 2025-11 anywhere.
- **R1.7, as corrected in revision 3.** Main-board ST is 5% before 2026-07-06 and 10% from 2026-07-06 (V6 `price_limit_history_v1.json`). That is what `price-limits.js` implements.
