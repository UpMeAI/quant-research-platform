NW = "NOT_WRITTEN_NO_AUTHOR_AFTER_1125"

MARKET_BY_STRATEGY = {
    "ASHARE_V6_PAPER": "A股",
    "INDEX_BOOK": "A股",
    "US_V5_ETF_3000USD": "美股",
    "US_CORE_9000USD_3X_GATEOBS": "美股",
    "C17_V2_4000USDT": "加密",
    "QUICK_SHOT_V3_1000USDT": "加密",
    "CARRY_V2_SHADOW_10000USDT": "加密",
}

STATUS_BY_KIND = {
    "RESULT": "已出结论",
    "READING": "已出结论",
    "STATUS": "前向中",
    "DRAFT": "起草中",
}


def market(record):
    return MARKET_BY_STRATEGY.get(record.get("strategy_ref"))


def row_id(record):
    return "L-" + (record.get("entry_id") or record["result_id"])


def build(record, ledger_fed):
    ledger = record["_ledger"]
    result_id = record["result_id"]
    digest = record.get("file_sha256")
    auth = [f"{ledger}.jsonl {result_id} file_sha256 {digest[:16]}"]
    for ref in record.get("refs") or []:
        if ref.get("ref") and ref.get("sha256"):
            auth.append(f"{ref['ref']} {ref['sha256'][:16]}")
    source = {
        "ledger": ledger,
        "result_id": result_id,
        "line_no": record["_line_no"],
        "line_sha256": record["_line_sha256"],
    }
    return {
        "id": row_id(record),
        "market": market(record),
        "group": NW,
        "q": NW,
        "auth": auth,
        "form": NW,
        "owner": "LEDGER",
        "machine": NW,
        "status": STATUS_BY_KIND[record["kind"]],
        "detail": NW,
        "missing": NW,
        "eta": NW,
        "ok": NW,
        "verdict": record.get("decision"),
        "strength": NW,
        "use": NW,
        "prod": f"production_effect {record.get('production_effect')}",
        "next": NW,
        "cutoff": NW,
        "layer": NW,
        "layerTopic": NW,
        "layerNote": NW,
        "owner_name": "QRP 台账（无会话）",
        "ledgerFed": ledger_fed,
        "_registry_source": source,
    }
