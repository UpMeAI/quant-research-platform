def record_keys(record):
    keys = []
    for name in ("entry_id", "result_id", "study_ref"):
        value = record.get(name)
        if value:
            keys.append((name, value))
    return keys


def rows_for_record(join_map, record):
    matched = []
    plural = {"entry_id": "entry_ids", "result_id": "result_ids", "study_ref": "study_refs"}
    for row_id, spec in join_map.get("rows", {}).items():
        for name, value in record_keys(record):
            if value in spec.get(plural[name], []):
                matched.append(row_id)
                break
    return matched
