"""DIAG-XM-1 trial specs (prereg §9). python3 -I make-specs.py <prereg sha256> > specs.json"""
import hashlib, json, sys
PREREG = "docs/research/DIAG_XM_1_PREREG_V1.md"
sha = hashlib.sha256(open(PREREG, "rb").read()).hexdigest()
assert sha == sys.argv[1], sha
I = "/Users/kaylame/KaylaProject/research-data/diag_xm_1_v1/inputs/"
SUMS = dict(reversed(l.split()) for l in open(I + "../INPUTS_SHA256SUMS"))
MK = {"US_V5_ETF_3000USD": "US_EQUITY", "US_CORE_9000USD_3X_GATEOBS": "US_EQUITY", "C17_V2_4000USDT": "CRYPTO_USDM_PERP",
      "QUICK_SHOT_V3_1000USDT": "CRYPTO_USDM_PERP", "INDEX_BOOK": "CN_A", "ASHARE_V6_PAPER": "CN_A"}
LIVE = [("US_V5_ETF_3000USD", "XM1_LIVE", "live/BOOK_NAV_SERIES_US_V5_ETF_3000USD_2026-11-13.json", "2026-10-08", "2026-11-13"),
        ("US_CORE_9000USD_3X_GATEOBS", "XM1_LIVE", "live/BOOK_NAV_SERIES_US_CORE_9000USD_3X_GATEOBS_2026-11-13.json", "2026-10-08", "2026-11-13"),
        ("C17_V2_4000USDT", "XM1_LIVE", "live/BOOK_NAV_SERIES_C17_V2_4000USDT_2026-11-15.json", "2026-10-01", "2026-11-15"),
        ("QUICK_SHOT_V3_1000USDT", "XM1_LIVE", "live/BOOK_NAV_SERIES_QUICK_SHOT_V3_1000USDT_2026-11-15.json", "2026-10-07", "2026-11-15"),
        ("INDEX_BOOK", "XM1_LIVE", "live/BOOK_NAV_SERIES_ASHARE_V6_PAPER_INDEX_BOOK_2026-11-16.json", "2026-10-08", "2026-11-16"),
        ("ASHARE_V6_PAPER", "XM1_LIVE_STOCK_BOOK", "live/BOOK_NAV_SERIES_ASHARE_V6_PAPER_STOCK_BOOK_2026-11-16.json", "2026-10-08", "2026-11-16")]
REPLAY = [("US_V5_ETF_3000USD", "replay/US_V5_M2_Q0_RESULT_V1.json", "2023-01-03", "2026-10-23"),
          ("US_CORE_9000USD_3X_GATEOBS", "replay/US_CORE_M2_Q0_RESULT_V1.json", "2010-02-11", "2026-09-30"),
          ("C17_V2_4000USDT", "replay/C17_V2_M2_Q0_RESULT_V2.json", "2020-01-01", "2026-10-24"),
          ("QUICK_SHOT_V3_1000USDT", "replay/QS_V3_M2_Q0_RESULT_V1.json", "2020-01-01", "2026-10-24"),
          ("ASHARE_V6_PAPER", "replay/ASHARE_V6_STOCK_BOOK_M2_Q0_RESULT_V1.json", "2020-06-01", "2026-09-28")]
KG_REF = {"path": "Knowledge Graph@518d178c617aab7e7fe7af91d499013d1245100d:worker-cf/src/l1-risk-budget/bands.ts", "sha256": None, "git_blob": "44773d8b249ade244ebc46c8a75e8750ba8b7cd9"}
prereg = {"path": "quant-research-platform@research/diag-xm-1:" + PREREG, "sha256": sha}
def src(rel): return {"path": "research-data/diag_xm_1_v1/inputs/" + rel, "sha256": SUMS[rel]}
specs = []
def add(fam, label, role, stage, rel, a, b, rc, notes, extra=()):
    specs.append({"family_id": fam, "market": MK[fam], "study_ref": "DIAG-XM-1", "stage": stage, "k2_sha256": sha,
                  "window": {"from": a, "to": b}, "source_refs": [prereg, src(rel), *extra], "config_label": label, "role": role,
                  "rule_config": rc, "delta_vs_baseline": [], "notes_zh": notes})
for fam, label, rel, a, b in LIVE:
    add(fam, label, "REPRO", "FORWARD", rel, a, b,
        {"diag": "DIAG-XM-1", "series": "BOOK_NAV_SERIES_V1", "source_sha256": SUMS[rel], "l1": "NONE", "alignment": "PREREG_V1_S4"},
        "实盘净值序列原样读入（不改本、不重算），作配对相关、尾部、回撤段的输入。诊断，只报")
for fam, rel, a, b in REPLAY:
    base = {"diag": "DIAG-XM-1", "series": "SEALED_DAILY_EQUITY", "source_sha256": SUMS[rel], "alignment": "PREREG_V1_S4"}
    add(fam, "XM1_REPLAY", "REPRO", "BOOK", rel, a, b, {**base, "l1": "NONE"}, "封存回放逐日权益原样读入。诊断，只报")
    l1 = {"l1_engine": "KG@518d178:bands.ts", "timing": "PREREG_V1_S6_2_S6_3", "application": "R_TIMES_K_FIRST_ORDER_UPPER_BOUND"}
    add(fam, "XM1_REPLAY_L1_BANDS", "DIAGNOSTIC_ARM", "BOOK", rel, a, b, {**base, **l1, "l1": "BANDS"},
        "L1 只按本市场档位 k 缩放日收益（不含联动），一阶上限。诊断，只报", [dict(KG_REF)])
    add(fam, "XM1_REPLAY_L1_LINK", "DIAGNOSTIC_ARM", "BOOK", rel, a, b, {**base, **l1, "l1": "BANDS_LINK"},
        "L1 签字规则（档位 + 两市场压力联动）缩放日收益，一阶上限。诊断，只报", [dict(KG_REF)])
for s in specs:
    for r in s["source_refs"]:
        if "sha256" in r and r["sha256"] is None: r.pop("sha256")
print(json.dumps(specs, ensure_ascii=False, indent=1))
print(len(specs), file=sys.stderr)
