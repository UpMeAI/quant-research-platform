'use strict';
/**
 * RF1116 `r2-day-export` (plan-coord 2026-11-23, deploy/research-lane/r2-day-export/): the V6-side, read-only job that exports ONE trading day of V6's canonical data into the drop directory
 * the lane's arrival program reads (CSV_DAY_DROP), for the R1 catch-up (11-18..12-31) and for R2 (from the first trading day of 2027). Tests: text, arguments and refusals only; a stub
 * `psql` stands in for the database (no Postgres, no docker, no network). Red first.
 *   - the SQL it sends is, byte for byte, the SQL of the arrival program's PG driver (one producer: arrival.js pgQueries) wrapped in COPY (...) TO STDOUT;
 *   - read-only everywhere: PGOPTIONS default_transaction_read_only=on, a session check, no SET / RESET / BEGIN READ WRITE anywhere in the script text, SELECT and COPY (SELECT) only;
 *   - readiness = ops-coord's R2_DAY_EXPORT_READINESS_V1.sql, byte-identical (sha cf8380f0...); a day that is not an SSE open day, or not ready, is refused (never exported);
 *   - one atomic directory per day (temp + rename) with a SHA256SUMS of its files; idempotent; catch-up in calendar order; a day that stays unready for more than 3 days is exit 4 (alert).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'deploy/research-lane/r2-day-export');
const SH = path.join(DIR, 'r2-day-export.sh');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const code = (re) => (e) => { assert.match(e.message, re); return true; };
const A = () => require('../services/mining-sandbox/round-runner/arrival');
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const OPEN = []; for (let d = '2026-11-10'; d <= '2027-04-30'; d = addDays(d, 1)) if (weekday(d) !== 0 && weekday(d) !== 6 && d !== '2027-01-01') OPEN.push(d);
const compact = (d) => d.replace(/-/g, '');

const STUB = `#!/bin/bash
# stub psql: answers from environment lists, records every statement it receives
LOG="\${STUB_LOG:?}"
args=("$@"); sql=""; d=""; lo=""; hi=""
for ((i=0;i<\${#args[@]};i++)); do
  case "\${args[$i]}" in
    -c) sql="\${args[$((i+1))]}";;
    -v) kv="\${args[$((i+1))]}"; case "$kv" in d=*) d="\${kv#d=}";; lo=*) lo="\${kv#lo=}";; hi=*) hi="\${kv#hi=}";; esac;;
    -f) [ "\${args[$((i+1))]}" = "-" ] && sql="$(cat)";;
  esac
done
printf '%s\\t%s\\n' "PGOPTIONS=$PGOPTIONS" "$*" >> "$LOG.args"
printf '%s\\n----\\n' "$sql" >> "$LOG"
case "$sql" in
  *"SHOW default_transaction_read_only"*) echo "\${STUB_READONLY:-on}";;
  *pipeline_completion*) for r in $STUB_READY; do [ "$r" = "$d" ] && echo "$d:POST_CLOSE:$d|DEGRADED|$d""T20:10:00"; done;;
  *"COPY ("*)
    day="$(echo "$sql" | grep -o "'[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}'" | head -1 | tr -d "'")"
    case "$sql" in
      *"FROM prices_daily "*) echo "record_id,security_id,trade_date,open,close"; [ -n "$STUB_NO_PRICES" ] || echo "pd:1,S01.SH,$day,1,2";;
      *"FROM market_daily_basic_observation "*) echo "record_id,raw_record_id,security_id,trade_date,values"; echo "db:1,r,S01.SH,$day,{}";;
      *"FROM adjustment_factor_observation "*) echo "record_id,raw_record_id,security_id,trade_date,adjustment_factor"; echo "af:1,r,S01.SH,$day,1";;
      *"FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL AND business_date"*) echo "record_id,security_id,business_date,ticker"; echo "sm:1,S01.SH,$day,S01";;
      *"FROM security_suspension_observation "*) echo "record_id,security_id,trade_date,suspension_type";;
      *"FROM security_suspension_day_coverage "*) echo "coverage_id,trade_date,provider_row_count"; echo "cv:1,$day,1";;
      *"FROM industry_membership "*) echo "record_id,security_id,industry_standard,industry_level,first_available_at";;
      *"FROM canonical_calendar_observation "*) echo "calendar_date,market,exchange,is_open"; for o in $STUB_OPEN; do echo "$o,A_SHARE,SSE,t"; done;;
    esac;;
  *"is_open"*"calendar_date"*) for o in $STUB_OPEN; do if [[ "$o" > "$lo" || "$o" == "$lo" ]] && [[ "$o" < "$hi" || "$o" == "$hi" ]]; then echo "$o"; fi; done;;
esac
`;

/** A sandbox: stub psql, drop root, env. */
function sandbox({ ready = [], open = OPEN, readonly = 'on', noPrices = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-dayexp-'));
  const stub = path.join(root, 'psql-stub'); fs.writeFileSync(stub, STUB, { mode: 0o755 });
  const drop = path.join(root, 'drop'); fs.mkdirSync(drop);
  const log = path.join(root, 'stub.log');
  const env = { ...process.env, R2EXP_PSQL: stub, R2EXP_DROP_ROOT: drop, R2EXP_ENV_FILE: '/nonexistent', STUB_LOG: log, STUB_READY: ready.join(' '), STUB_OPEN: open.join(' '), STUB_READONLY: readonly, STUB_NO_PRICES: noPrices, R2EXP_TODAY: '2027-04-30' };
  const run = (args, extra = {}) => { const r = spawnSync('bash', [SH, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }); return { status: r.status, out: r.stdout, err: r.stderr }; };
  const statements = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n----\n').filter(Boolean) : []);
  return { root, drop, run, statements, log };
}
const dayDir = (sb, seg, day) => path.join(sb.drop, seg, compact(day));

test('DX0 files: the script, the SQL it sends, ops-coord\'s readiness probe byte-identical (sha cf8380f0...), the unit and the timer, the install notes', () => {
  for (const f of ['r2-day-export.sh', 'R2_DAY_EXPORT_READINESS_V1.sql', 'r2-day-export.service', 'r2-day-export.timer', 'r2-day-export.env.example', 'INSTALL.md', 'sql/trading_calendar.sql', 'sql/open_days.sql',
    ...A().TABLES.map((t) => `sql/${t.stem}.sql`)]) assert.ok(fs.existsSync(path.join(DIR, f)), f);
  assert.equal(sha(fs.readFileSync(path.join(DIR, 'R2_DAY_EXPORT_READINESS_V1.sql'))), 'cf8380f097714bed9d9fb38303ecf9f94864ec28ffb8233d8a3a1f1806871b14');
});

test('DX1 read-only by construction: the script text has no SET / RESET / BEGIN READ WRITE / write verb, sets PGOPTIONS default_transaction_read_only=on, checks the session, and every SQL file is one SELECT', () => {
  const text = fs.readFileSync(SH, 'utf8');
  assert.ok(text.includes("PGOPTIONS='-c default_transaction_read_only=on'"));
  assert.ok(!/default_transaction_read_only\s*=\s*(off|false|0)/i.test(text));
  assert.ok(!/\b(SET|RESET)\s+(SESSION\s+|LOCAL\s+)?(default_transaction_read_only|transaction_read_only|CHARACTERISTICS)/i.test(text));
  assert.ok(!/BEGIN\s+(TRANSACTION\s+)?READ\s+WRITE|START\s+TRANSACTION\s+READ\s+WRITE|SET\s+TRANSACTION\s+READ\s+WRITE/i.test(text));
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|VACUUM)\b/.test(text.replace(/#[^\n]*/g, '')), 'no write verb outside comments');
  assert.match(text, /SHOW default_transaction_read_only/);
  for (const f of fs.readdirSync(path.join(DIR, 'sql'))) {
    const sql = fs.readFileSync(path.join(DIR, 'sql', f), 'utf8').replace(/^--[^\n]*\n/gm, '').trim();
    assert.match(sql, /^SELECT /, f); assert.ok(!/;\s*\S/.test(sql), `${f}: one statement`);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|COPY|SET)\b/i.test(sql), f);
  }
  const probe = fs.readFileSync(path.join(DIR, 'R2_DAY_EXPORT_READINESS_V1.sql'), 'utf8').replace(/^--[^\n]*\n/gm, '');
  assert.match(probe.trim(), /^SELECT /);
});

test('DX2 the SQL sent for a day is the arrival program\'s PG query set (one producer), wrapped in COPY (...) TO STDOUT WITH (FORMAT csv, HEADER true); psql runs with the read-only PGOPTIONS and ON_ERROR_STOP', () => {
  const sb = sandbox({ ready: ['2026-11-19'] });
  const r = sb.run(['--segment', 'R1', '--day', '2026-11-19']);
  assert.equal(r.status, 0, r.err);
  const sent = sb.statements().filter((s) => s.startsWith('COPY ('));
  const want = A().pgQueries('2026-11-19', { industryFrom: '2026-11-19' }); // previous open day 11-18 + 1 (11-18 is not the first R1 day: D1 is 11-17, so 11-18 is the first)
  // 2026-11-19: the previous open day is 11-18, so the industry window starts 11-19 00:00+08
  assert.equal(sent.length, want.length);
  for (const q of want) assert.ok(sent.includes(`COPY (${q.sql}) TO STDOUT WITH (FORMAT csv, HEADER true)`), q.stem);
  for (const line of fs.readFileSync(`${sb.log}.args`, 'utf8').split('\n').filter(Boolean)) {
    assert.ok(line.startsWith('PGOPTIONS=-c default_transaction_read_only=on\t'), line);
    assert.match(line, /-X -q -v ON_ERROR_STOP=1/);
  }
});

test('DX3 a day that is not an SSE open day, or not ready, is refused: nothing is written; --day on such a day is exit 3', () => {
  const sb = sandbox({ ready: ['2026-11-19'] });
  const sat = sb.run(['--segment', 'R1', '--day', '2026-11-21']);
  assert.equal(sat.status, 3); assert.match(sat.out + sat.err, /REFUSED_NOT_OPEN_DAY:2026-11-21/);
  const notReady = sb.run(['--segment', 'R1', '--day', '2026-11-18']);
  assert.equal(notReady.status, 3); assert.match(notReady.out + notReady.err, /REFUSED_NOT_READY:2026-11-18/);
  const before = sb.run(['--segment', 'R1', '--day', '2026-11-17']);
  assert.equal(before.status, 3, 'D1 and earlier are in the sealed export'); assert.match(before.out + before.err, /REFUSED_NOT_OPEN_DAY|REFUSED_OUTSIDE_WINDOW/);
  const after = sb.run(['--segment', 'R1', '--day', '2027-01-04']);
  assert.equal(after.status, 3); assert.match(after.out + after.err, /REFUSED_OUTSIDE_WINDOW:2027-01-04/);
  assert.ok(!fs.existsSync(path.join(sb.drop, 'R1')) || fs.readdirSync(path.join(sb.drop, 'R1')).length === 0, 'nothing was written');
  assert.equal(sb.statements().filter((s) => s.startsWith('COPY (')).length, 0, 'no data query was sent for a refused day');
  // a session that is not read-only stops everything (exit 2) before any query
  const rw = sandbox({ ready: ['2026-11-19'], readonly: 'off' });
  const r = rw.run(['--segment', 'R1', '--day', '2026-11-19']);
  assert.equal(r.status, 2); assert.match(r.out + r.err, /NOT_READ_ONLY/);
  assert.equal(rw.statements().filter((s) => /pipeline_completion|COPY \(/.test(s)).length, 0);
});

test('DX4 one atomic directory per day: <drop>/<segment>/<YYYYMMDD>/ with the seven tables and a SHA256SUMS of them; no temp directory is left; a second run exports nothing', () => {
  const sb = sandbox({ ready: ['2026-11-18'] });
  const r = sb.run(['--segment', 'R1', '--day', '2026-11-18']);
  assert.equal(r.status, 0, r.err);
  const dir = dayDir(sb, 'R1', '2026-11-18');
  assert.deepEqual(fs.readdirSync(dir).sort(), [...A().TABLES.map((t) => `${t.stem}.csv`), 'SHA256SUMS'].sort());
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  assert.equal(sums.length, 7);
  for (const l of sums) { const [h, n] = l.split('  '); assert.equal(sha(fs.readFileSync(path.join(dir, n))), h, n); }
  assert.deepEqual(fs.readdirSync(path.join(sb.drop, 'R1')).filter((n) => n.startsWith('.tmp')), []);
  const first = fs.readFileSync(path.join(dir, 'prices_daily_stock.csv'), 'utf8');
  const copies = sb.statements().filter((s) => s.startsWith('COPY (')).length;
  const again = sb.run(['--segment', 'R1', '--day', '2026-11-18']);
  assert.equal(again.status, 0); assert.match(again.out, /ALREADY_EXPORTED/);
  assert.equal(sb.statements().filter((s) => s.startsWith('COPY (')).length, copies, 'idempotent: no query for an exported day');
  assert.equal(fs.readFileSync(path.join(dir, 'prices_daily_stock.csv'), 'utf8'), first);
  // a day with no prices rows yet is not exported (the arrival program would refuse it too)
  const np = sandbox({ ready: ['2026-11-18'], noPrices: '1' });
  const r2 = np.run(['--segment', 'R1', '--day', '2026-11-18'], { R2EXP_TODAY: '2026-11-19' });
  assert.equal(r2.status, 0); assert.match(r2.out, /NOT_AVAILABLE:2026-11-18/);
  assert.equal(np.run(['--segment', 'R1', '--day', '2026-11-18'], { R2EXP_TODAY: '2026-11-25' }).status, 4, 'the same day still without prices four days later is the alert exit');
  assert.ok(!fs.existsSync(dayDir(np, 'R1', '2026-11-18')));
});

test('DX5 industry window: the first R1 part reaches back to 2026-10-17, later parts start the day after the previous open day (a weekend belongs to Monday), the first R2 part starts 2027-01-01', () => {
  const sb = sandbox({ ready: ['2026-11-18', '2026-11-19', '2026-11-23'] });
  sb.run(['--segment', 'R1']);
  const ind = sb.statements().filter((s) => s.includes('FROM industry_membership '));
  const lowers = ind.map((s) => /first_available_at >= TIMESTAMPTZ '([^']+)'/.exec(s)[1]);
  assert.deepEqual(lowers, ['2026-10-17 00:00:00+08', '2026-11-19 00:00:00+08', '2026-11-21 00:00:00+08']);
  const uppers = ind.map((s) => /first_available_at < TIMESTAMPTZ '([^']+)'/.exec(s)[1]);
  assert.deepEqual(uppers, ['2026-11-19 00:00:00+08', '2026-11-20 00:00:00+08', '2026-11-24 00:00:00+08']);
  const sb2 = sandbox({ ready: ['2027-01-04'] });
  sb2.run(['--segment', 'R2']);
  const i2 = sb2.statements().filter((s) => s.includes('FROM industry_membership '));
  assert.match(i2[0], /first_available_at >= TIMESTAMPTZ '2027-01-01 00:00:00\+08' AND first_available_at < TIMESTAMPTZ '2027-01-05 00:00:00\+08'/);
});

test('DX6 catch-up in calendar order: every open day after D1 up to today that is ready is exported (a day that is not ready is skipped and reported, later ready days still are); R1 stops at 2026-12-31; R2 at its 54th open day; R2 also gets the calendar', () => {
  const ready = OPEN.filter((d) => d > '2026-11-17');
  const sb = sandbox({ ready: ready.filter((d) => d !== '2026-11-18') });
  const r = sb.run(['--segment', 'R1']);
  const days = fs.readdirSync(path.join(sb.drop, 'R1')).filter((n) => /^\d{8}$/.test(n)).sort();
  const want = OPEN.filter((d) => d > '2026-11-18' && d <= '2026-12-31').map(compact);
  assert.deepEqual(days, want, '11-18 is not ready and not exported; every later open day to 12-31 is');
  assert.equal(r.status, 4, 'a day that stayed unready for more than 3 days is the alert exit');
  assert.match(r.out, /WAITING:2026-11-18/);
  assert.ok(!fs.existsSync(path.join(sb.drop, 'R1', 'trading_calendar.csv')), 'the R1 calendar was sealed: not exported');
  // a day that is only a day or two old and not ready yet is the normal evening state: exit 0
  const evening = sandbox({ ready: [], open: OPEN });
  const e = evening.run(['--segment', 'R1'], { R2EXP_TODAY: '2026-11-19' });
  assert.equal(e.status, 0); assert.match(e.out, /WAITING:2026-11-18/);
  // R2: 54 open days after 2026-12-31, plus the calendar file
  const r2 = sandbox({ ready: OPEN.filter((d) => d > '2026-12-31') });
  const x = r2.run(['--segment', 'R2']);
  assert.equal(x.status, 0, x.err);
  const d2 = fs.readdirSync(path.join(r2.drop, 'R2')).filter((n) => /^\d{8}$/.test(n)).sort();
  assert.equal(d2.length, 54);
  assert.equal(d2[0], '20270104');
  assert.equal(d2[53], compact(OPEN.filter((d) => d > '2026-12-31')[53]));
  assert.ok(fs.existsSync(path.join(r2.drop, 'R2', 'trading_calendar.csv')), 'the R2 directory\'s calendar arrives with the days');
  assert.match(fs.readFileSync(path.join(r2.drop, 'R2', 'trading_calendar.csv'), 'utf8'), /^calendar_date,/);
});

test('DX7 constants agree with the code they feed: the segments D1 / window end / 54 days / first industry bound are the arrival program\'s PROFILES and the registry\'s R2 rule', () => {
  const text = fs.readFileSync(SH, 'utf8');
  const P = A().PROFILES;
  assert.match(text, new RegExp(`R1\\) START_AFTER=${P.R1.startAfter}; FIRST_LOWER=${P.R1.industryFrom}; END=2026-12-31; MAXDAYS=0`));
  assert.match(text, new RegExp(`R2\\) START_AFTER=${P.R2.startAfter}; FIRST_LOWER=${P.R2.industryFrom}; END=; MAXDAYS=54`));
  const reg = require('../services/mining-rounds/holdout-segments').REGISTRY.find((e) => e.id === 'R2');
  assert.equal(reg.length_trading_days, 54);
  assert.equal(require('../services/mining-sandbox/segments').SEGMENTS.HOLDOUT.to, '2026-12-31');
});

test('DX8 unit and timer: a oneshot user unit running the script for both segments, a daily timer after POST_CLOSE with a retry, Persistent; no docker, no network setting that widens anything; the env file only names the connection', () => {
  const svc = fs.readFileSync(path.join(DIR, 'r2-day-export.service'), 'utf8');
  const tim = fs.readFileSync(path.join(DIR, 'r2-day-export.timer'), 'utf8');
  assert.match(svc, /^Type=oneshot$/m);
  assert.match(svc, /^ExecStart=.*r2-day-export\.sh --segment all$/m);
  assert.match(svc, /^EnvironmentFile=.*r2-day-export\.env$/m);
  assert.ok(!/docker/.test(svc.replace(/#[^\n]*/g, '')));
  assert.match(tim, /^OnCalendar=\*-\*-\* 21:15:00 Asia\/Shanghai$/m);
  assert.ok((tim.match(/^OnCalendar=/gm) || []).length >= 2, 'a retry slot');
  assert.match(tim, /^Persistent=true$/m);
  const env = fs.readFileSync(path.join(DIR, 'r2-day-export.env.example'), 'utf8');
  for (const k of ['R2EXP_PSQL', 'R2EXP_DROP_ROOT']) assert.ok(env.includes(k), k);
  assert.ok(!/PASSWORD|PGPASSWORD|secret|token/i.test(env), 'no credential in the example');
  const inst = fs.readFileSync(path.join(DIR, 'INSTALL.md'), 'utf8');
  for (const s of ['25006', 'default_transaction_read_only', 'systemctl --user', 'SHA256SUMS', 'cf8380f0']) assert.ok(inst.includes(s), s);
});

test('DX9 SHA256SUMS (installed with the script) lists the script, the readiness probe and every sql file, and each line is the file\'s sha256; any edit has to regenerate it', () => {
  const lines = fs.readFileSync(path.join(DIR, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  const want = ['r2-day-export.sh', 'R2_DAY_EXPORT_READINESS_V1.sql', ...fs.readdirSync(path.join(DIR, 'sql')).map((f) => `sql/${f}`)].sort();
  assert.deepEqual(lines.map((l) => l.split('  ')[1]).sort(), want);
  for (const l of lines) { const [h, n] = l.split('  '); assert.equal(sha(fs.readFileSync(path.join(DIR, n))), h, n); }
});
