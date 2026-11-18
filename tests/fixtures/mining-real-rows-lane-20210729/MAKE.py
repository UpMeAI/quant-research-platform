"""Builds the 2021-07-29 slice of this fixture from the RF1116 lane copy (rf1116-cn-a-lane-copy-20200601-20260928, SHA256SUMS sha 7f3ae26a...;
BASE replay database). Not run by the tests; kept for provenance. Read-only.
Usage: python3 -I MAKE_LANE_SLICE.py <lane copy dir> <out dir>
Securities: the first 8 (sorted) whose SW2021 L1 membership ends on 2021-07-29 and restarts on 2021-07-30, plus the first 16 main-board
securities listed before 2019 with an L1 row in force on 2021-07-29. Rows kept: trade dates 2021-07-19..2021-08-06 for prices, adjustment
factor, daily_basic and suspension; every master and industry row of those securities; calendar 2020-06-01..2021-12-31; coverage rows in range.
Every field is unchanged; rows are re-written with Python's csv module (minimal quoting)."""
import csv, sys, os, hashlib, json
csv.field_size_limit(10**9)
src, out = sys.argv[1], sys.argv[2]
LO, HI = '2021-07-19', '2021-08-06'
def stream(f):
    fh = open(os.path.join(src, f), encoding='utf-8', newline=''); r = csv.reader(fh); return next(r), r
h, rows = stream('industry_membership_sw2021.csv'); ix = {k: i for i, k in enumerate(h)}
ind = [r for r in rows if r[ix['industry_level']] == 'L1']
by = {}
for r in ind: by.setdefault(r[ix['security_id']], []).append(r)
ended = sorted(s for s, rs in by.items() if any(r[ix['effective_to']] == '2021-07-29' for r in rs) and any(r[ix['effective_from']] == '2021-07-30' for r in rs))[:8]
hm, mrows = stream('security_master_stock.csv'); mx = {k: i for i, k in enumerate(hm)}
mrows = list(mrows)
inforce = lambda s: any(r[ix['effective_from']] <= '2021-07-29' and (not r[ix['effective_to']] or '2021-07-29' <= r[ix['effective_to']]) for r in by.get(s, []))
main = sorted({r[mx['security_id']] for r in mrows if r[mx['board']] == 'MAIN' and r[mx['listing_date']] < '2019-01-01' and r[mx['listing_status']] == 'LISTED' and r[mx['risk_warning_status']] == 'NORMAL'})
fill = [s for s in main if s not in ended and inforce(s)][:16]
keep = set(ended + fill)
os.makedirs(out, exist_ok=True); sums = []; counts = {}
def write(f, head, rows):
    p = os.path.join(out, f)
    with open(p, 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n'); w.writerow(head); n = 0
        for r in rows: w.writerow(r); n += 1
    counts[f] = n; sums.append((hashlib.sha256(open(p, 'rb').read()).hexdigest(), f))
for f in ['prices_daily_stock.csv', 'adjustment_factor_observation_stock.csv', 'market_daily_basic_observation_stock.csv', 'security_suspension_observation.csv']:
    head, rows = stream(f); i = {k: n for n, k in enumerate(head)}
    write(f, head, (r for r in rows if r[i['security_id']] in keep and LO <= r[i['trade_date']][:10] <= HI))
write('security_master_stock.csv', hm, (r for r in mrows if r[mx['security_id']] in keep))
h2, rows2 = stream('industry_membership_sw2021.csv'); write('industry_membership_sw2021.csv', h2, (r for r in rows2 if r[ix['security_id']] in keep))
hc, rc = stream('trading_calendar.csv'); ci = {k: n for n, k in enumerate(hc)}
write('trading_calendar.csv', hc, (r for r in rc if '2020-06-01' <= r[ci['calendar_date']] <= '2021-12-31'))
hv, rv = stream('security_suspension_day_coverage.csv'); vi = {k: n for n, k in enumerate(hv)}
write('security_suspension_day_coverage.csv', hv, (r for r in rv if LO <= r[vi['trade_date']][:10] <= HI))
with open(os.path.join(out, 'SHA256SUMS'), 'w') as fh:
    for hsh, f in sorted(sums, key=lambda x: x[1]): fh.write(f'{hsh}  {f}\n')
print(json.dumps({'ended': ended, 'fill': fill, 'rows': counts}))
