# RF1116 holdout segment registry (R1, R2): evidence

- `RF1116_HOLDOUT_CN_A_R2_FREEZE_1.draft.md`: byte copy of plan-coord's draft page (sha256 `b97f9916b20ba5a6ba8c8db8e5a6e5e750578a02c6635c812d4bbd2b01993dab`), cited by the registry (`holdout-segments.js`, R2 `freeze`) until the page is frozen. At the freeze the cited page, its sha256 and the repo copy (`docs/freeze/`) are swapped in the same way as for the extra-round amendment, and the `FROZEN_COPIES` guard in `tests/mining_gate_freeze.test.js` gets the entry.
- Signature: `artifacts/coordinator/RF1116_HOLDOUT_CN_A_R2_SIGNATURE_20261123.md` (sha256 prefix `93b573a0`), Owner 2026-11-23 11:56 CST in the ops-coord session, relayed; the page is frozen only after the Owner confirms to plan-coord.
- Tests: `tests/mining_holdout_segment_registry.test.js` (S0 to S16). Red on `4a8726a` (18 of 18), green on the implementation commit.
- `MUTATION_RESULTS.json`: the guard mutants of `tools/mining-holdout-segments-mutation-check.js` (each mutant must make at least one test fail).
