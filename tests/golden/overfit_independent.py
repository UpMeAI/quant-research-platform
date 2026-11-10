#!/usr/bin/env python3
"""Independent reference values for services/trial-ledger/overfit.js (Python stdlib only, written separately from the JS).

Run: python3 -I tests/golden/overfit_independent.py > tests/golden/overfit_independent.json
Synthetic inputs only. Normal functions come from statistics.NormalDist (CPython's erf / inverse-CDF), not from overfit.js.
"""
import itertools, json, math
from statistics import NormalDist

N01 = NormalDist()
GAMMA, E = 0.5772156649, 2.718281828

def series(T, a, b, c):
    return [a * math.sin(t * 1.7) + b * math.cos(t * 0.3) + c for t in range(T)]

def moments(x):
    T = len(x); m = sum(x) / T
    m2 = sum((v - m) ** 2 for v in x) / T; m3 = sum((v - m) ** 3 for v in x) / T; m4 = sum((v - m) ** 4 for v in x) / T
    sd = math.sqrt(sum((v - m) ** 2 for v in x) / (T - 1))
    return {"T": T, "sr": m / sd, "skew": m3 / m2 ** 1.5, "kurt": m4 / m2 ** 2}

def psr(sr, sr_star, T, skew, kurt):
    return N01.cdf((sr - sr_star) * math.sqrt(T - 1) / math.sqrt(1 - skew * sr + (kurt - 1) / 4 * sr * sr))

def sr0(N, V):
    if N == 1: return 0.0
    return math.sqrt(V) * ((1 - GAMMA) * N01.inv_cdf(1 - 1 / N) + GAMMA * N01.inv_cdf(1 - 1 / (N * E)))

def svar(v):
    m = sum(v) / len(v); return sum((x - m) ** 2 for x in v) / (len(v) - 1)

def pbo(R, S=16):
    T = len(R); n = len(R[0]); start = T % S; size = (T - start) // S
    blocks = [list(range(start + s * size, start + (s + 1) * size)) for s in range(S)]
    hits = 0; total = 0
    for train in itertools.combinations(range(S), S // 2):
        test = [s for s in range(S) if s not in train]
        rows_in = [r for s in train for r in blocks[s]]; rows_out = [r for s in test for r in blocks[s]]
        perf_in = [sum(R[r][c] for r in rows_in) for c in range(n)]
        perf_out = [sum(R[r][c] for r in rows_out) for c in range(n)]
        best = max(range(n), key=lambda c: (perf_in[c], -c))
        v = perf_out[best]
        rank = sum(1 for x in perf_out if x < v) + (sum(1 for x in perf_out if x == v) + 1) / 2
        w = rank / (n + 1)
        total += 1
        if math.log(w / (1 - w)) <= 0: hits += 1
    return hits / total

def bhy(p):
    m = len(p); cm = sum(1 / i for i in range(1, m + 1))
    order = sorted(range(m), key=lambda i: (p[i], i)); out = [0.0] * m
    for rank, i in enumerate(order, start=1):
        out[i] = min(min(1.0, m * cm * p[order[j - 1]] / j) for j in range(rank, m + 1))
    return out

def holm(p):
    m = len(p); order = sorted(range(m), key=lambda i: (p[i], i)); out = [0.0] * m
    for rank, i in enumerate(order, start=1):
        out[i] = max(min(1.0, (m - j + 1) * p[order[j - 1]]) for j in range(1, rank + 1))
    return out

out = {"source": "tests/golden/overfit_independent.py (Python stdlib statistics.NormalDist; independent of overfit.js)"}
out["normal"] = {"cdf": {str(x): N01.cdf(x) for x in [-3, -2.5, -1, -0.25, 0, 0.7, 1.96, 2.9]},
                 "inv": {str(p): N01.inv_cdf(p) for p in [0.001, 0.025, 0.2, 0.5, 0.8, 0.975, 0.99, 0.999]}}
d = series(60, 0.012, 0.005, 0.0035)
mo = moments(d)
fam = [0.05, 0.12, -0.03, 0.2, 0.08, 0.15, mo["sr"]]
V = svar(fam)
out["dsr_case"] = {"series": {"T": 60, "a": 0.012, "b": 0.005, "c": 0.0035}, "N": 12, "family_sharpes": fam, **mo, "V": V,
                   "psr0": psr(mo["sr"], 0, mo["T"], mo["skew"], mo["kurt"]), "sr0": sr0(12, V),
                   "dsr": psr(mo["sr"], sr0(12, V), mo["T"], mo["skew"], mo["kurt"])}
R = [[((t * 7 + c * 13 + (t * c) % 11) % 17 - 8) / 64 for c in range(5)] for t in range(101)]
out["pbo_case"] = {"rows": 101, "configs": 5, "formula": "((t*7 + c*13 + (t*c)%11) % 17 - 8) / 64", "pbo": pbo(R)}
R2 = [[((t * t * 3 + c * 5 * t + c * c * 7 + 4 * t) % 23 - 11 + (0.5 if c == 2 else 0)) / 128 for c in range(6)] for t in range(170)]
out["pbo_case_mid"] = {"rows": 170, "configs": 6, "formula": "((t*t*3 + c*5*t + c*c*7 + 4*t) % 23 - 11 + (c==2 ? 0.5 : 0)) / 128", "pbo": pbo(R2)}
p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216]
out["multiple_testing"] = {"p": p, "bhy": bhy(p), "holm": holm(p)}
print(json.dumps(out, indent=1))
