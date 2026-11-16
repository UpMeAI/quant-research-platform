"""DIAG-XM-1 prereg V1 (docs/research/DIAG_XM_1_PREREG_V1.md, sha256 3e41d91e…) §4–§7. Diagnostic, report-only.

python3 -I xm1.py --inputs <research-data/diag_xm_1_v1/inputs> --l1 <l1-readings.json> --registered <registered.jsonl>
                  --out <result.json> --run-log <run-log.json> --run-at <ISO> --host <label>
Standard library only. Every float in the result is rounded to 8 decimals so run A (Mac) and run B (Linux) compare byte for byte.
"""
import argparse, bisect, datetime as dt, hashlib, json, math, os, sys

PREREG_SHA = "3e41d91e605a699083b45e9e542b5c469feec921f7283e9be3799300d49fbb70"
SEED = 20261117
B = 2000
FX = 7.10
EPS = 1e-12

LIVE = [  # id, family, label, file, market, capital0 (own currency), currency
    ("US_V5", "US_V5_ETF_3000USD", "XM1_LIVE", "live/BOOK_NAV_SERIES_US_V5_ETF_3000USD_2026-11-13.json", "US", 3000, "USD"),
    ("US_CORE", "US_CORE_9000USD_3X_GATEOBS", "XM1_LIVE", "live/BOOK_NAV_SERIES_US_CORE_9000USD_3X_GATEOBS_2026-11-13.json", "US", 9000, "USD"),
    ("C17", "C17_V2_4000USDT", "XM1_LIVE", "live/BOOK_NAV_SERIES_C17_V2_4000USDT_2026-11-15.json", "CRYPTO", 4000, "USDT"),
    ("QS", "QUICK_SHOT_V3_1000USDT", "XM1_LIVE", "live/BOOK_NAV_SERIES_QUICK_SHOT_V3_1000USDT_2026-11-15.json", "CRYPTO", 1000, "USDT"),
    ("CN_INDEX", "INDEX_BOOK", "XM1_LIVE", "live/BOOK_NAV_SERIES_ASHARE_V6_PAPER_INDEX_BOOK_2026-11-16.json", "CN", 400000, "CNY"),
    ("CN_STOCK", "ASHARE_V6_PAPER", "XM1_LIVE_STOCK_BOOK", "live/BOOK_NAV_SERIES_ASHARE_V6_PAPER_STOCK_BOOK_2026-11-16.json", "CN", 100000, "CNY"),
]
LIVE_REFERENCE = "live/BOOK_NAV_SERIES_ASHARE_V6_PAPER_2026-11-16.json"
REPLAY = [  # id, family, file, market, segment paths
    ("US_V5", "US_V5_ETF_3000USD", "replay/US_V5_M2_Q0_RESULT_V1.json", "US", [("arms", "D")]),
    ("US_CORE", "US_CORE_9000USD_3X_GATEOBS", "replay/US_CORE_M2_Q0_RESULT_V1.json", "US", [("arms_is", "D"), ("arms", "D")]),
    ("C17", "C17_V2_4000USDT", "replay/C17_V2_M2_Q0_RESULT_V2.json", "CRYPTO", [("arms", "IS", "D"), ("arms", "D")]),
    ("QS", "QUICK_SHOT_V3_1000USDT", "replay/QS_V3_M2_Q0_RESULT_V1.json", "CRYPTO", [("arms", "IS", "D"), ("arms", "D")]),
    ("CN_STOCK", "ASHARE_V6_PAPER", "replay/ASHARE_V6_STOCK_BOOK_M2_Q0_RESULT_V1.json", "CN", [("arms", "D")]),
]
CAPITAL0_CNY = {"US_V5": 3000 * FX, "US_CORE": 9000 * FX, "C17": 4000 * FX, "QS": 1000 * FX, "CN_STOCK": 100000.0, "CN_INDEX": 400000.0}
MARKET_OF = {"US_V5": "US", "US_CORE": "US", "C17": "CRYPTO", "QS": "CRYPTO", "CN_STOCK": "CN", "CN_INDEX": "CN"}
ANNUAL = {"US": 252, "CN": 252, "CRYPTO": 365}


def R(x, nd=8):
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return None
    return round(float(x), nd)


def sha_file(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def day(s):
    return dt.date.fromisoformat(s)


# ---------- series ----------
class Book:
    """Segments of (date, nav); returns are within a segment only (A4)."""

    def __init__(self, bid, segments, market):
        self.id, self.market = bid, market
        self.segments = [seg for seg in segments if seg]
        self.nav = {}
        self.seg_of = {}
        for k, seg in enumerate(self.segments):
            for d, v in seg:
                self.nav[d] = v
                self.seg_of[d] = k
        self.dates = sorted(self.nav)
        self.first, self.last = self.dates[0], self.dates[-1]

    def own_returns(self):
        out = []
        for seg in self.segments:
            for (d0, v0), (d1, v1) in zip(seg, seg[1:]):
                out.append((d1, v1 / v0 - 1.0, d0))
        return out

    def chained(self):
        """A continuous index across segments: the return across a boundary is dropped (counts as 0)."""
        idx, x = [], 1.0
        for seg in self.segments:
            for i, (d, v) in enumerate(seg):
                if i > 0:
                    x *= v / seg[i - 1][1]
                idx.append((d, x))
        return idx


def load_live(inputs, rel, bid, market):
    d = json.load(open(os.path.join(inputs, rel)))
    pts = [(p["day"], float(p["nav"])) for p in d["points"] if p.get("state") == "MEASURED"]
    return Book(bid, [pts], market), {"valuation": d.get("valuation"), "costBasis": d.get("costBasis"), "clock": d.get("clock"),
                                      "capital0": d.get("capital0"), "points": len(d["points"]), "measured": len(pts)}


def load_replay(inputs, rel, bid, market, seg_paths):
    d = json.load(open(os.path.join(inputs, rel)))
    segs = []
    for p in seg_paths:
        x = d
        for k in p:
            x = x[k]
        e = x["equity"]
        segs.append(list(zip(e["dates"], [float(v) for v in e["values"]])))
    return Book(bid, segs, market)


# ---------- pair grid (A2, A3) ----------
def grid_returns(a, b):
    lo, hi = max(a.first, b.first), min(a.last, b.last)
    g = [d for d in a.dates if lo <= d <= hi and d in b.nav]
    ra, rb, dates = [], [], []
    for d0, d1 in zip(g, g[1:]):
        if a.seg_of[d0] != a.seg_of[d1] or b.seg_of[d0] != b.seg_of[d1]:
            continue  # crosses a GAP (A4)
        ra.append(a.nav[d1] / a.nav[d0] - 1.0)
        rb.append(b.nav[d1] / b.nav[d0] - 1.0)
        dates.append(d1)
    return dates, ra, rb, (lo, hi)


def pearson(x, y):
    n = len(x)
    if n < 3:
        return None
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((v - mx) ** 2 for v in x)
    syy = sum((v - my) ** 2 for v in y)
    if sxx <= 0 or syy <= 0:
        return None
    sxy = sum((u - mx) * (v - my) for u, v in zip(x, y))
    return sxy / math.sqrt(sxx * syy)


def ranks(x):
    order = sorted(range(len(x)), key=lambda i: x[i])
    r = [0.0] * len(x)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and x[order[j + 1]] == x[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            r[order[k]] = avg
        i = j + 1
    return r


def spearman(x, y):
    return pearson(ranks(x), ranks(y))


def mulberry32(seed):
    M = 0xFFFFFFFF
    state = [seed & M]

    def nxt():
        a = (state[0] + 0x6D2B79F5) & M
        state[0] = a
        t = ((a ^ (a >> 15)) * (1 | a)) & M
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & M)) & M) ^ t
        return ((t ^ (t >> 14)) & M) / 4294967296.0
    return nxt


def boot_ci(dates, x, y, seed):
    blocks = {}
    for i, d in enumerate(dates):
        blocks.setdefault(d[:7], []).append(i)
    keys = sorted(blocks)
    rnd = mulberry32(seed)
    pe, sp = [], []
    for _ in range(B):
        idx = []
        for _ in keys:
            idx.extend(blocks[keys[int(rnd() * len(keys))]])
        xs, ys = [x[i] for i in idx], [y[i] for i in idx]
        pe.append(pearson(xs, ys))
        sp.append(spearman(xs, ys))
    out = {}
    for name, v in (("pearson", pe), ("spearman", sp)):
        v = sorted(z for z in v if z is not None)
        out[name] = [R(v[int(0.05 * len(v))]), R(v[int(0.95 * len(v))])] if len(v) == B else None
    out["months"] = len(keys)
    return out


def tail(x, y):
    n = len(x)
    k = math.ceil(0.10 * n)

    def worst(v):
        thr = sorted(v)[k - 1]
        return {i for i, z in enumerate(v) if z <= thr and z < 0}
    wa, wb = worst(x), worst(y)
    both = len(wa & wb)

    def side(wi, wj):
        if len(wi) < 5:
            return {"state": "NOT_ENOUGH_TAIL_DAYS", "tailDays": len(wi)}
        p = both / len(wi)
        base = len(wj) / n
        return {"p": R(p), "base": R(base), "lift": R(p / base) if base > 0 else None, "tailDays": len(wi)}
    return {"n": n, "k": k, "joint": both, "jGivenI": side(wa, wb), "iGivenJ": side(wb, wa)}


# ---------- drawdown episodes (M4) ----------
def episodes(idx, thr):
    out, peak, peak_d, cur = [], None, None, None
    for d, v in idx:
        if peak is None or v >= peak * (1 - EPS):
            if cur is not None:
                cur["end"], cur["recovered"] = d, True
                if cur["trough"] >= thr:
                    out.append(cur)
                cur = None
            if peak is None or v > peak:
                peak, peak_d = v, d
            continue
        dd = 1 - v / peak
        if cur is None:
            cur = {"peakDate": peak_d, "start": d, "trough": dd, "troughDate": d}
        elif dd > cur["trough"]:
            cur["trough"], cur["troughDate"] = dd, d
    if cur is not None:
        cur["end"], cur["recovered"] = idx[-1][0], False
        if cur["trough"] >= thr:
            out.append(cur)
    return out


def dd_at(idx, date):
    peak, last = None, None
    for d, v in idx:
        if d > date:
            break
        peak = v if peak is None or v > peak else peak
        last = v
    return None if last is None else 1 - last / peak


def day_set(eps, lo, hi):
    s = set()
    for e in eps:
        a, b = max(day(e["start"]), day(lo)), min(day(e["end"]), day(hi))
        while a <= b:
            s.add(a)
            a += dt.timedelta(days=1)
    return s


def overlap(ba, ia, ea, bb, ib, eb):
    lo, hi = max(ba.first, bb.first), min(ba.last, bb.last)
    sa, sb = day_set(ea, lo, hi), day_set(eb, lo, hi)
    union = len(sa | sb)
    pairs = []
    for x in ea:
        for y in eb:
            if x["start"] <= y["end"] and y["start"] <= x["end"] and max(x["start"], y["start"]) <= hi and min(x["end"], y["end"]) >= lo:
                pairs.append({"a": ep_out(x), "b": ep_out(y)})
    deep_a = max(ea, key=lambda e: e["trough"]) if ea else None
    deep_b = max(eb, key=lambda e: e["trough"]) if eb else None
    return {"span": [lo, hi], "bothDays": len(sa & sb), "unionDays": union, "jaccard": R(len(sa & sb) / union) if union else None,
            "overlappingEpisodes": pairs,
            "aDeepestTrough": None if not deep_a or not (lo <= deep_a["troughDate"] <= hi) else {"date": deep_a["troughDate"], "aDD": R(deep_a["trough"]), "bDD": R(dd_at(ib, deep_a["troughDate"]))},
            "bDeepestTrough": None if not deep_b or not (lo <= deep_b["troughDate"] <= hi) else {"date": deep_b["troughDate"], "bDD": R(deep_b["trough"]), "aDD": R(dd_at(ia, deep_b["troughDate"]))}}


def ep_out(e):
    return {"peakDate": e["peakDate"], "start": e["start"], "troughDate": e["troughDate"], "trough": R(e["trough"]), "end": e["end"], "recovered": e["recovered"]}


# ---------- one set (live or replay) ----------
def analyse(books, ids, kind, dd_thr, with_ci):
    out = {"pairs": [], "books": {}}
    idx = {b: books[b].chained() for b in ids}
    eps = {b: episodes(idx[b], dd_thr) for b in ids}
    for b in ids:
        rs = books[b].own_returns()
        idle = sum(1 for _, r, _ in rs if abs(r) < EPS)
        out["books"][b] = {"first": books[b].first, "last": books[b].last, "returns": len(rs), "segments": len(books[b].segments),
                           "idleShare": R(idle / len(rs)) if rs else None, "idleSessions": idle,
                           "totalReturn": R(idx[b][-1][1] / idx[b][0][1] - 1), "maxDrawdown": R(max_dd([v for _, v in idx[b]])),
                           "episodes": [ep_out(e) for e in eps[b]]}
    p = 0
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            dates, x, y, span = grid_returns(books[a], books[b])
            row = {"a": a, "b": b, "pairIndex": p, "span": list(span), "n": len(x)}
            pe, spr = pearson(x, y), spearman(x, y)
            row["pearson"] = R(pe)
            row["spearman"] = R(spr)
            if pe is None:
                row["reason"] = "ZERO_VARIANCE" if len(x) >= 3 else "TOO_FEW_RETURNS"
            if with_ci and len(x) >= 60 and pe is not None:
                row["ci90"] = boot_ci(dates, x, y, SEED + p)
            row["tail"] = tail(x, y) if len(x) >= 10 else {"state": "TOO_FEW_RETURNS", "n": len(x)}
            row["drawdownOverlap"] = overlap(books[a], idx[a], eps[a], books[b], idx[b], eps[b])
            ma, mb = MARKET_OF[a], MARKET_OF[b]
            if (ma == "CN") != (mb == "CN") and len(x) >= 4:  # A6
                cn_first = ma == "CN"
                cn, ot = (x, y) if cn_first else (y, x)
                row["lagSensitivity"] = {"cnT_vs_otherTminus1": R(pearson(cn[1:], ot[:-1])), "cnTminus1_vs_otherT": R(pearson(cn[:-1], ot[1:])), "n": len(x) - 1}
            out["pairs"].append(row)
            p += 1
    return out


def max_dd(vals):
    peak, m = None, 0.0
    for v in vals:
        peak = v if peak is None or v > peak else peak
        m = max(m, 1 - v / peak)
    return m


# ---------- combined account (M6) ----------
def combined(books, ids, navs=None):
    navs = navs or {b: books[b].chained() for b in ids}
    lo = max(navs[b][0][0] for b in ids)
    hi = min(navs[b][-1][0] for b in ids)
    cal = sorted({d for b in ids for d, _ in navs[b] if lo <= d <= hi})
    w = {b: CAPITAL0_CNY[b] for b in ids}
    series = {}
    for b in ids:
        ds = [d for d, _ in navs[b]]
        vs = [v for _, v in navs[b]]
        base = vs[bisect.bisect_right(ds, lo) - 1]
        series[b] = [vs[bisect.bisect_right(ds, d) - 1] / base for d in cal]
    acct = [sum(w[b] * series[b][t] for b in ids) for t in range(len(cal))]
    rets = []
    for t in range(1, len(cal)):
        contrib = {b: R(w[b] * (series[b][t] - series[b][t - 1]) / acct[t - 1]) for b in ids}
        rets.append((acct[t] / acct[t - 1] - 1, cal[t], contrib))
    worst = sorted(rets, key=lambda z: (z[0], z[1]))[:10]
    return {"window": [lo, hi], "calendarDays": len(cal), "weightsCNY": {b: R(w[b], 2) for b in ids},
            "totalReturn": R(acct[-1] / acct[0] - 1), "maxDrawdown": R(max_dd(acct)),
            "worst10": [{"date": d, "return": R(r), "contrib": c} for r, d, c in worst]}


# ---------- L1 (§6) ----------
def reading_for(market, d, readings):
    t = day(d)
    key = d if market == "US" else (t - dt.timedelta(days=1)).isoformat()
    return readings.get(key)


def l1_series(book, readings):
    """Own returns with a reading available; k per variant (null -> 1)."""
    rows = []
    for d1, r, d0 in book.own_returns():
        rd = reading_for(book.market, d1, readings)
        if rd is None:
            continue
        m = rd["k"][book.market]
        kb = m["kBand"] if m["kBand"] is not None else 1.0
        kl = m["k"] if m["k"] is not None else 1.0
        rows.append((d1, r, kb, kl, rd["applied"]))
    return rows


def path_stats(rets, annual):
    x, peak, mdd = 1.0, 1.0, 0.0
    for r in rets:
        x *= 1 + r
        peak = max(peak, x)
        mdd = max(mdd, 1 - x / peak)
    T = len(rets)
    return {"totalReturn": R(x - 1), "cagr": R(x ** (annual / T) - 1) if T and x > 0 else None, "maxDrawdown": R(mdd), "marks": T}


def l1_effect(book, readings):
    rows = l1_series(book, readings)
    A = ANNUAL[book.market]
    none = [r for _, r, _, _, _ in rows]
    bands = [r * kb for _, r, kb, _, _ in rows]
    link = [r * kl for _, r, _, kl, _ in rows]
    lg = lambda v: math.log1p(v)
    cut_b = [(d, r, kb) for d, r, kb, _, _ in rows if kb < 1]
    cut_l = [(d, r, kb, kl) for d, r, kb, kl, _ in rows if kl < kb]
    return {"window": [rows[0][0], rows[-1][0]] if rows else None, "returnsWithReading": len(rows),
            "NONE": path_stats(none, A), "BANDS": path_stats(bands, A), "LINK": path_stats(link, A),
            "bandsDaysKBelow1": len(cut_b), "bandsLogReturnDelta": R(sum(lg(r * kb) - lg(r) for _, r, kb in cut_b)),
            "linkOnlyDays": len(cut_l), "linkLogReturnDelta": R(sum(lg(r * kl) - lg(r * kb) for _, r, kb, kl in cut_l)),
            "linkOnlyDates": [d for d, _, _, _ in cut_l]}


def l1_navs(book, readings, variant):
    rows = l1_series(book, readings)
    idx, x = [], 1.0
    for d, r, kb, kl, _ in rows:
        k = 1.0 if variant == "NONE" else (kb if variant == "BANDS" else kl)
        x *= 1 + k * r
        idx.append((d, x))
    return idx


def l1_triggers(doc):
    rs = doc["readings"]
    applied = [r for r in rs if r["applied"]]
    eps, cur = [], None
    for r in rs:
        if r["applied"]:
            if cur and day(r["d"]) - day(cur["end"]) == dt.timedelta(days=1):
                cur["end"] = r["d"]
                cur["days"] += 1
            else:
                cur = {"start": r["d"], "end": r["d"], "days": 1, "stress": set(), "capped": {}}
                eps.append(cur)
            cur["stress"].update(r["stress"])
            for m, v in r["k"].items():
                if v["capped"]:
                    cur["capped"][m] = cur["capped"].get(m, 0) + 1
    band_days = {}
    for m in ("CN", "US", "CRYPTO"):
        c = {}
        for r in rs:
            b = r["bands"][m] or "L9"
            c[b] = c.get(b, 0) + 1
        band_days[m] = c
    return {"span": [rs[0]["d"], rs[-1]["d"]], "readingDays": len(rs), "appliedDays": len(applied),
            "cappedDays": {m: sum(1 for r in applied if r["k"][m]["capped"]) for m in ("CN", "US", "CRYPTO")},
            "episodes": [{"start": e["start"], "end": e["end"], "days": e["days"], "stress": sorted(e["stress"]), "cappedDays": e["capped"]} for e in eps],
            "bandReadingDays": band_days}


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    for f in ("inputs", "l1", "registered", "out", "run-log", "run-at", "host"):
        ap.add_argument("--" + f, required=True)
    a = ap.parse_args()
    sums = {}
    for line in open(os.path.join(a.inputs, "..", "INPUTS_SHA256SUMS")):
        h, rel = line.split()
        sums[rel] = h
        got = sha_file(os.path.join(a.inputs, rel))
        if got != h:
            sys.exit(f"INPUT_SHA256_MISMATCH:{rel}:{got}")

    live, live_meta = {}, {}
    for bid, fam, lab, rel, mk, cap, cur in LIVE:
        live[bid], live_meta[bid] = load_live(a.inputs, rel, bid, mk)
    ref_book, ref_meta = load_live(a.inputs, LIVE_REFERENCE, "CN_COMBINED", "CN")
    replay = {bid: load_replay(a.inputs, rel, bid, mk, sp) for bid, fam, rel, mk, sp in REPLAY}

    l1doc = json.load(open(a.l1))
    readings = {r["d"]: r for r in l1doc["readings"]}

    live_ids = [b[0] for b in LIVE]
    rep_ids = [b[0] for b in REPLAY]
    res = {"schema": "DIAG_XM_1_RESULT_V1", "prereg_sha256": PREREG_SHA, "inputs": sums, "l1Readings": sha_file(a.l1),
           "live": analyse(live, live_ids, "live", 0.03, False), "replay": analyse(replay, rep_ids, "replay", 0.10, True)}
    for b in live_ids:
        res["live"]["books"][b]["file"] = live_meta[b]
    res["live"]["reference"] = {"CN_COMBINED": {"file": ref_meta, "totalReturn": R(ref_book.chained()[-1][1] - 1)}}
    res["live"]["combined"] = combined(live, live_ids)
    res["replay"]["combined"] = combined(replay, rep_ids)
    res["replay"]["notAvailable"] = {"CN_INDEX": "NOT_AVAILABLE:NO_SEALED_DAILY_EQUITY"}

    # L1
    eff = {b: l1_effect(replay[b], readings) for b in rep_ids}
    comb = {}
    for v in ("NONE", "BANDS", "LINK"):
        navs = {b: l1_navs(replay[b], readings, v) for b in rep_ids}
        comb[v] = combined(replay, rep_ids, navs)
    res["l1"] = {"triggers": l1_triggers(l1doc), "effect": eff,
                 "combined": {v: {k: comb[v][k] for k in ("window", "totalReturn", "maxDrawdown")} for v in comb},
                 "bandRows": l1doc["bandRows"]}

    # §7 follow-up criteria
    rp = {(p["a"], p["b"]): p for p in res["replay"]["pairs"]}
    uc = rp[("US_V5", "C17")]
    t = uc["tail"]
    lifts = [s.get("lift") for s in (t.get("jGivenI", {}), t.get("iGivenJ", {})) if isinstance(s, dict)]
    ci = (uc.get("ci90") or {}).get("pearson")
    c1 = uc["pearson"] is not None and uc["pearson"] >= 0.30 and ci is not None and ci[0] is not None and ci[0] > 0
    c2 = any(l is not None and l >= 2.0 for l in lifts) and t.get("joint", 0) >= 5
    jac = uc["drawdownOverlap"]["jaccard"]
    c3 = jac is not None and jac >= 0.30
    idle_rep = res["replay"]["books"]["CN_STOCK"]["idleShare"]
    idle_live = res["live"]["books"]["CN_STOCK"]["idleShare"]
    res["followUps"] = {
        "R-XM-1": {"supported": bool((idle_rep or 0) >= 0.30 or (idle_live or 0) >= 0.50),
                   "replayIdleShare": idle_rep, "liveIdleShare": idle_live,
                   "replayIdleCNY": R(100000 * (idle_rep or 0), 2), "liveIdleCNY": R(100000 * (idle_live or 0), 2),
                   "liveIndexIdleShare": res["live"]["books"]["CN_INDEX"]["idleShare"]},
        "R-XM-2": {"supported": bool(c1 or c2 or c3), "i_pearson": bool(c1), "ii_tail": bool(c2), "iii_jaccard": bool(c3),
                   "pearson": uc["pearson"], "ci90": ci, "lifts": lifts, "joint": t.get("joint"), "jaccard": jac}}

    text = json.dumps(res, ensure_ascii=False, sort_keys=True, indent=1) + "\n"
    open(a.out, "w").write(text)
    rsha = hashlib.sha256(text.encode()).hexdigest()

    reg = [json.loads(l) for l in open(a.registered)]
    runs = []
    for r in reg:
        runs.append({"family_id": r["family_id"], "config_label": r["config_label"], "trial_id": r["trial_id"], "rule_config_hash": r["rule_config_hash"],
                     "role": r["role"], "verdict_metric_kind": "NET_RETURN_SERIES", "kind": "DIAGNOSTIC_READING", "output_sha256": rsha})
    log = {"schema": "RESEARCH_RUN_LOG_V1", "study_ref": "DIAG-XM-1", "k2_sha256": PREREG_SHA, "first_run_at": a.run_at, "host": a.host,
           "python": sys.version.split()[0], "result_sha256": rsha, "runs": runs}
    open(a.run_log, "w").write(json.dumps(log, ensure_ascii=False, sort_keys=True, indent=1) + "\n")
    print(json.dumps({"ok": True, "result_sha256": rsha, "runs": len(runs)}))


if __name__ == "__main__":
    main()
