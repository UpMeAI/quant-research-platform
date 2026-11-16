"""DIAG-XM-1 supplement 1 (computed after run A = run B, NOT in the prereg; context only, the §7 criteria are unchanged).
Drawdown-episode Jaccard expected if the two books' kept episodes were independent: with a = share of span days book a is in a
kept episode and b the same for book b, E[J] = ab / (a + b - ab).
python3 -I supplement1.py <DIAG_XM_1_RESULT_V1.json>"""
import datetime as dt, json, sys
r = json.load(open(sys.argv[1]))
day = dt.date.fromisoformat
def cover(eps, lo, hi):
    s = set()
    for e in eps:
        a, b = max(day(e["start"]), day(lo)), min(day(e["end"]), day(hi))
        while a <= b:
            s.add(a); a += dt.timedelta(days=1)
    return s
out = {"schema": "DIAG_XM_1_SUPPLEMENT_1_V1", "result_sha256": None, "note_zh": "封存后补算，不在预登记里，只作背景，不改 §7 判据", "pairs": []}
import hashlib; out["result_sha256"] = hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()
for part in ("replay", "live"):
    for p in r[part]["pairs"]:
        lo, hi = p["drawdownOverlap"]["span"]
        n = (day(hi) - day(lo)).days + 1
        A, Bs = cover(r[part]["books"][p["a"]]["episodes"], lo, hi), cover(r[part]["books"][p["b"]]["episodes"], lo, hi)
        a, b = len(A) / n, len(Bs) / n
        e = a * b / (a + b - a * b) if (a + b - a * b) > 0 else None
        out["pairs"].append({"set": part, "a": p["a"], "b": p["b"], "spanDays": n, "aShare": round(a, 6), "bShare": round(b, 6),
                             "jaccard": p["drawdownOverlap"]["jaccard"], "jaccardIfIndependent": None if e is None else round(e, 6)})
print(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=1))
