# Q70 weekly sealed-input binding slice V1

Bound to Q70 BRIEF §1.2 and base 3735066871ba4f7066062ce3553ef1e626b3c01c.
Additive engineering acceptance; no existing frozen contract is amended.
Authoritative producer contracts: OVERSEAS_SEALED_VERDICTS_IMPORT_PROFILE_V1
§§1–4 and amendments; ASHARE_SEALED_VERDICTS_IMPORT_PROFILE_V1 §§0–2.
Use their existing registry, current locks, boundFiles and sealedRows verifier.

- Read-only per-request selection by entryId, exact current resultId and exact
  registered strategyRef. No source paths, JSON metric paths, alternate locks or
  replacement strategy mappings are accepted from review request documents.
- Only RESULT is eligible. STATUS/DRAFT/READING are not measured forward results.
  A missing, superseded, cross-strategy, post-period or invalid source yields an
  explicit isolated missing state; it must not suppress another valid request.
- Require the lock's bound-reference set to equal the registry producer's set;
  the result file path must be the FILE reference. Delegate actual file/sidecar
  SHA checks and verdict projection to the existing sealedRows implementation.
- Preserve verified source identifiers/hash/references separately from the
  producer's projected verdict text. Never expose another unit's source document.
- This binds sealed inputs only. inputState remains INPUT_MISSING, comparison
  value null, and weekly readiness false until an authoritative metric/window/
  sample-size binding contract and delivered forward inputs exist. No arithmetic,
  prediction, adoption, defect creation, model call or production claim occurs.
- Serial synthetic tests: valid binding, stale/current selection, wrong strategy,
  non-result kinds, missing or drifted source/sidecar/K2 binding, isolation and
  no mutation. Full suite explicitly excluded during the current CST heavy window.
