"""Builds this fixture from the coordinator's read-only -r4 validation-tail export (RF1116 export spec rev 4, 33093147;
SHA256SUMS 758323e8...). Not run by the tests; kept for provenance.
Usage: python3 -I MAKE.py <export dir> <out dir>
Picks about 30 securities deterministically (sorted ids, first k of each kind) and keeps every row of theirs with every field unchanged
(rows are re-written with Python's csv module, minimal quoting); trading_calendar is cut to calendar_date >= 2025-06-01;
security_suspension_day_coverage is kept whole."""
import csv, json, sys, hashlib, os
csv.field_size_limit(10**9)
src, out = sys.argv[1], sys.argv[2]
def read(f):
    with open(os.path.join(src, f), encoding='utf-8', newline='') as fh:
        r = csv.reader(fh); head = next(r); return head, [row for row in r]
H = {}; T = {}
for f in ['security_master_stock.csv', 'prices_daily_stock.csv', 'market_daily_basic_observation_stock.csv', 'adjustment_factor_observation_stock.csv',
          'security_suspension_observation.csv', 'security_suspension_day_coverage.csv', 'trading_calendar.csv', 'industry_membership_sw2021.csv']:
    H[f], T[f] = read(f)
col = lambda f, name: H[f].index(name)
m = T['security_master_stock.csv']; mi = lambda n: col('security_master_stock.csv', n)
ids = sorted({r[mi('security_id')] for r in m})
def kind(pred): return sorted({r[mi('security_id')] for r in m if pred(r)})
st = kind(lambda r: r[mi('risk_warning_status')] == 'ST')
bse = kind(lambda r: r[mi('exchange')] == 'BSE')
recent = kind(lambda r: r[mi('listing_date')] >= '2026-05-01' and r[mi('exchange')] != 'BSE')
delisted = kind(lambda r: r[mi('listing_status')] == 'DELISTED')
star = kind(lambda r: r[mi('board')] == 'STAR'); chinext = kind(lambda r: r[mi('board')] == 'CHINEXT')
susp = sorted({r[col('security_suspension_observation.csv', 'security_id')] for r in T['security_suspension_observation.csv'] if r[col('security_suspension_observation.csv', 'full_session')] == 't'})
ended = sorted({r[col('industry_membership_sw2021.csv', 'security_id')] for r in T['industry_membership_sw2021.csv'] if r[col('industry_membership_sw2021.csv', 'effective_to')]})
bi = lambda n: col('market_daily_basic_observation_stock.csv', n)
missing_pe = sorted({r[bi('security_id')] for r in T['market_daily_basic_observation_stock.csv'] if json.loads(r[bi('values')]).get('pe_ttm', {}).get('state') == 'MISSING'})
main = kind(lambda r: r[mi('board')] == 'MAIN' and r[mi('risk_warning_status')] == 'NORMAL' and r[mi('listing_status')] == 'LISTED' and r[mi('listing_date')] < '2020-01-01')
pick = []
for group, k in [(st, 3), (bse, 1), (recent, 2), (delisted, 2), (susp, 3), (ended, 3), (star, 3), (chinext, 3), (missing_pe, 2), (main, 12)]:
    for s in group:
        if k == 0: break
        if s not in pick: pick.append(s); k -= 1
keep = set(pick)
os.makedirs(out, exist_ok=True)
sums = []
for f in H:
    rows = T[f]
    if f == 'trading_calendar.csv': rows = [r for r in rows if r[col(f, 'calendar_date')] >= '2025-06-01']
    elif f != 'security_suspension_day_coverage.csv': rows = [r for r in rows if r[col(f, 'security_id')] in keep]
    p = os.path.join(out, f)
    with open(p, 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n'); w.writerow(H[f]); w.writerows(rows)
    sums.append((hashlib.sha256(open(p, 'rb').read()).hexdigest(), f, len(rows)))
with open(os.path.join(out, 'SHA256SUMS'), 'w') as fh:
    for h, f, _ in sorted(sums, key=lambda x: x[1]): fh.write(f'{h}  {f}\n')
print(json.dumps({'securities': pick, 'rows': {f: n for _, f, n in sums}}))
