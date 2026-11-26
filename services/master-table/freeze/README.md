# Master-table freeze proposal

`build_freeze.py` reads the selected final hand-authored table, the research
ledgers except `trials.jsonl`, the mechanism register, the pinned T_start
registry and the coordinator freeze pages. It emits a `PROPOSED` join map,
manifest, row registry, frozen byte copies and proposed pins.

The tool may infer a join by `TEXT_SHA8`, but records the evidence kind and does
not sign or install it. Plan-coord signs only unambiguous `REGISTER_SEAL`,
`SEGMENT_ROW`, `TEXT_RESULT_ID` and declared-producer joins. Ops-coord installs
only that signed revision. Runtime code performs no SHA-prefix inference.

Example:

```sh
python3 -I -B services/master-table/freeze/build_freeze.py \
  --table-json /readonly/RESEARCH_MASTER_TABLE_20261110.json \
  --table-md /readonly/RESEARCH_MASTER_TABLE_20261110.md \
  --ledger-dir /readonly/ledger/research \
  --register config/research_mechanism_register.v1.json \
  --tstart-registry /readonly/FORWARD_SHADOW_TSTART_REGISTRY_20261114.json \
  --coord-dir /readonly/artifacts/coordinator --out /scratch/master-table-freeze
```
