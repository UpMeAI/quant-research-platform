"""Legacy master-table counts, kept separate from ledger projections."""


STATUSES = {
    "已出结论", "复用已有结果", "在跑", "未跑", "缺输入", "代码未完成", "前向中",
    "前向未启动", "DECISION_GAP", "工程闸门", "起草中", "结论待出",
}
MKT_COLS = (
    ("已完成", "done", ("已出结论", "复用已有结果")),
    ("前向", "forward", ("前向中",)),
    ("在跑", "running", ("在跑",)),
    ("待做", "todo", ("未跑", "起草中", "代码未完成", "前向未启动", "结论待出")),
    ("受阻", "blocked", ("缺输入", "DECISION_GAP", "工程闸门")),
)
MARKETS = ("A股", "美股", "加密", "跨市场")
FED_FIELDS = (
    "verdict", "verdictToken", "status", "sealedOn", "sealSha256", "k2State",
    "tStart", "tStartRegistryStatus", "nextCheck",
)


def _no_owner(row):
    if row.get("status") == "DECISION_GAP":
        return False
    return (row.get("owner") == "NONE" or str(row.get("machine", "")).startswith("未定")
            or "失效" in str(row.get("machine", "")))


def compute(items):
    status_counts = {}
    layer_counts = {}
    for row in items:
        status = row.get("status")
        status_counts[status] = status_counts.get(status, 0) + 1
        layer = row.get("layer")
        layer_counts[layer] = layer_counts.get(layer, 0) + 1

    market_counts = {}
    for market in MARKETS:
        values = {}
        for _zh, name, states in MKT_COLS:
            values[name] = sum(1 for row in items if row.get("market") == market and row.get("status") in states)
        values["total"] = sum(1 for row in items if row.get("market") == market)
        market_counts[market] = values

    fed_counts = {}
    for field in FED_FIELDS:
        values = {}
        for row in items:
            fed = row.get("ledgerFed") or {}
            state = (fed.get(field) or {}).get("state")
            if state is not None:
                values[state] = values.get(state, 0) + 1
        fed_counts[field] = values

    lists = {
        "未跑": [row["id"] for row in items if row.get("status") == "未跑"],
        "缺输入（含代码未完成、前向未启动、起草中）": [
            row["id"] for row in items if row.get("status") in ("缺输入", "代码未完成", "前向未启动", "起草中")
        ],
        "DECISION_GAP": [row["id"] for row in items if row.get("status") == "DECISION_GAP"],
        "无负责会话或机器": [row["id"] for row in items if _no_owner(row)],
        "赶不上本行截止线": [row["id"] for row in items if str(row.get("ok", "")).startswith("否")],
        "无法确认本行截止线": [row["id"] for row in items if str(row.get("ok", "")).startswith("未知")],
        "层待定": [row["id"] for row in items if row.get("layer") == "待定"],
    }
    return {
        "statusCounts": status_counts,
        "marketCounts": {
            "columns": [{"zh": zh, "en": name, "statuses": list(states)}
                        for zh, name, states in MKT_COLS],
            "byMarket": market_counts,
        },
        "layerCounts": layer_counts,
        "lists": lists,
        "layerPending": list(lists["层待定"]),
        "fedStatusCounts": fed_counts,
    }
