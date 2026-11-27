# Legacy round rows (rounds 1 and 2 have no `scoring_neutralization` key): evidence

- Finding 2026-11-23 (LLM_GEN session, on a copy of the lane ledger): `beginScoring(round 2)` gave `MINE_ROUND_SCHEMA_INVALID:MISSING:scoring_neutralization`; plan-coord approved fix (a) with the constraint that the key may be absent only for the frozen legacy list.
- Tests: `tests/mining_legacy_round_rows.test.js` (L0 to L5). Red on `4a8726a` (L0, L1, L2, L4; L3 is the counter-test that passes before and after).
- `MUTATION_RESULTS.json`: 7 mutants, all killed; one equivalent mutant is documented in `tools/mining-legacy-key-mutation-check.js` and not made.
- `LEDGER_CHECK.json`: `ledger_check.js` on a read-only copy of the lane's `mining_rounds.jsonl` (read 2026-11-23 12:40 CST): beginScoring works for round 2 (row still without the key, version LINEAR_RAW_V1) and for round 3.
