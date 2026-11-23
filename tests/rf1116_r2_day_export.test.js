'use strict';
/**
 * RF1116 `r2-day-export` (plan-coord 2026-11-23, deploy/research-lane/r2-day-export/): the V6-side, read-only job that exports ONE trading day of V6's canonical data into the drop directory
 * the lane's arrival program reads (CSV_DAY_DROP), for the R1 catch-up (11-18..12-31) and for R2 (from the first trading day of 2027). Tests: text, arguments and refusals only; a stub
 * `psql` stands in for the database (no Postgres, no docker, no network). Red first.
 *   - the SQL it sends is, byte for byte, the sql/*.sql templates (export spec section 2; the lane has no database driver, so these files are the only place the SQL lives) wrapped in COPY (...) TO STDOUT;
 *   - read-only everywhere: PGOPTIONS default_transaction_read_only=on, a session check, no SET / RESET / BEGIN READ WRITE anywhere in the script text, SELECT and COPY (SELECT) only;
 *   - readiness = ops-coord's R2_DAY_EXPORT_READINESS_V2.sql, byte-identical (sha 57e26c03...); a day that is not an SSE open day, or not ready, is refused (never exported);
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
case "$STUB_FAIL:$sql" in ready:*pipeline_completion*|copy:*"COPY ("*) exit 1;; esac
case "$STUB_SLEEP:$sql" in :*) ;; *:*"COPY ("*) sleep "$STUB_SLEEP";; esac
printf '%s\\t%s\\n' "PGOPTIONS=$PGOPTIONS" "$*" >> "$LOG.args"
printf '%s\\n----\\n' "$sql" >> "$LOG"
case "$sql" in
  *"SHOW default_transaction_read_only"*) echo "\${STUB_READONLY:-on}";;
  *pipeline_completion*) for r in $STUB_READY; do if [ "\${r%%:*}" = "$d" ]; then v="\${r#*:}"; [ "$v" = "$r" ] && v=POST_CLOSE_D; echo "$d|$v|5260|5217|5229|1"; fi; done; true;;
  *"COPY ("*)
    day="$(echo "$sql" | grep -o "'[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}'" | head -1 | tr -d "'")"
    case "$sql" in
      *"FROM prices_daily "*) echo "record_id,security_id,trade_date,open,close"; [ -n "$STUB_NO_PRICES" ] || echo "pd:1,S01.SH,$day,1,2";;
      *"FROM market_daily_basic_observation "*) echo "record_id,raw_record_id,security_id,trade_date,values"; echo "db:1,r,S01.SH,$day,{}";;
      *"FROM adjustment_factor_observation "*) echo "record_id,raw_record_id,security_id,trade_date,adjustment_factor"; echo "af:1,r,S01.SH,$day,1";;
      *"FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL AND business_date"*) echo "record_id,security_id,business_date,ticker"; echo "sm:1,S01.SH,$day,S01";;
      *"FROM security_suspension_observation "*) echo "record_id,security_id,trade_date,suspension_type";;
      *"FROM security_suspension_day_coverage "*) echo "coverage_id,trade_date,provider_row_count"; echo "cv:1,$day,1";;
      *"FROM industry_membership "*)
        echo "record_id,security_id,industry_standard,industry_level,effective_from,first_available_at"
        if [ -n "$STUB_IND_ROWS" ]; then
          lo="$(echo "$sql" | sed -n "s/.*first_available_at >= TIMESTAMPTZ '\\([^']*\\)'.*/\\1/p")"; hi="$(echo "$sql" | sed -n "s/.*first_available_at < TIMESTAMPTZ '\\([^']*\\)'.*/\\1/p")"
          loe=$(date -d "$lo" +%s); hie=$(date -d "$hi" +%s)
          while IFS=, read -r id sec std lvl eff fa; do [ -z "$id" ] && continue; e=$(date -d "$fa" +%s); if [ "$e" -ge "$loe" ] && [ "$e" -lt "$hie" ]; then echo "$id,$sec,$std,$lvl,$eff,$fa"; fi; done < "$STUB_IND_ROWS"
        fi;;
      *"FROM canonical_calendar_observation "*) echo "calendar_date,market,exchange,is_open"; for o in $STUB_OPEN; do echo "$o,A_SHARE,SSE,t"; done;;
    esac;;
  *"is_open"*"calendar_date"*) for o in $STUB_OPEN; do if [[ "$o" > "$lo" || "$o" == "$lo" ]] && [[ "$o" < "$hi" || "$o" == "$hi" ]]; then echo "$o"; fi; done;;
esac
`;

// stub docker: the ONLY accepted form is `docker exec -i -e PGOPTIONS=<v> <container> sh -c <script> sh <args...>` (ops-coord's closed exception); anything else exits 99 and is logged.
// It runs the script with sh, so the real wrapper text of the script is what the stub psql sees.
const DOCKER_STUB = `#!/bin/bash
echo "$*" >> "$DOCKER_LOG"
if [ "$1" != exec ] || [ "$2" != -i ] || [ "$3" != -e ] || [[ "$4" != PGOPTIONS=* ]] || [ "$6" != sh ] || [ "$7" != -c ]; then echo "unexpected docker form: $*" >&2; exit 99; fi
export PGOPTIONS="\${4#PGOPTIONS=}"
script="$8"; shift 8
exec sh -c "$script" "$@"
`;

/** A sandbox: stub psql and docker on PATH, drop root, env. */
function sandbox({ ready = [], open = OPEN, readonly = 'on', noPrices = '', fail = '', sleep = '', indRows = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-dayexp-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'psql'), STUB, { mode: 0o755 }); fs.writeFileSync(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  const drop = path.join(root, 'drop'); fs.mkdirSync(drop);
  const log = path.join(root, 'stub.log');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, R2EXP_PG_CONTAINER: 'pgc', R2EXP_PG_USER: 'u', R2EXP_PG_DB: 'd', DOCKER_LOG: path.join(root, 'docker.log'), STUB_FAIL: fail, STUB_SLEEP: sleep, R2EXP_DROP_ROOT: drop, R2EXP_ENV_FILE: '/nonexistent', STUB_LOG: log, STUB_READY: ready.join(' '), STUB_OPEN: open.join(' '), STUB_READONLY: readonly, STUB_NO_PRICES: noPrices, STUB_IND_ROWS: indRows, R2EXP_NOW: '2027-04-30T16:00:00+08:00' };
  const run = (args, extra = {}) => { const r = spawnSync('bash', [SH, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }); return { status: r.status, out: r.stdout, err: r.stderr }; };
  const statements = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n----\n').filter(Boolean) : []);
  return { root, drop, run, statements, log, dockerLog: path.join(root, 'docker.log') };
}
/** A sql/<stem>.sql template with its placeholders filled in (comment lines dropped): the same rendering the script does, written separately. */
const renderSql = (stem, day, lower, upper) => fs.readFileSync(path.join(DIR, 'sql', `${stem}.sql`), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('').trim().replace(/@DAY@/g, day).replace(/@LOWER@/g, lower).replace(/@UPPER@/g, upper);
const dayDir = (sb, seg, day) => path.join(sb.drop, seg, compact(day));

test('DX0 files: the script, the SQL it sends, ops-coord\'s readiness probe byte-identical (sha 57e26c03...), the unit and the timer, the install notes', () => {
  for (const f of ['r2-day-export.sh', 'R2_DAY_EXPORT_READINESS_V2.sql', 'r2-day-export.service', 'r2-day-export.timer', 'r2-day-export.env.example', 'INSTALL.md', 'sql/trading_calendar.sql', 'sql/open_days.sql',
    ...A().TABLES.map((t) => `sql/${t.stem}.sql`)]) assert.ok(fs.existsSync(path.join(DIR, f)), f);
  assert.equal(sha(fs.readFileSync(path.join(DIR, 'R2_DAY_EXPORT_READINESS_V2.sql'))), '57e26c0379ad86008fdea0f035108104761434dfc009dc80d358987a6fddb582');
});

test('DX1 read-only by construction: the script text has no SET / RESET / BEGIN READ WRITE / write verb, sets PGOPTIONS default_transaction_read_only=on, checks the session, and every SQL file is one SELECT', () => {
  const text = fs.readFileSync(SH, 'utf8');
  assert.ok(text.includes('-c default_transaction_read_only=on -c statement_timeout='), 'the read-only session setting and a server-side statement timeout travel in the same PGOPTIONS string');
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
  const probe = fs.readFileSync(path.join(DIR, 'R2_DAY_EXPORT_READINESS_V2.sql'), 'utf8').replace(/^--[^\n]*\n/gm, '');
  assert.match(probe.trim(), /^SELECT /);
});

test('DX2 the SQL sent for a day is the arrival program\'s PG query set (one producer), wrapped in COPY (...) TO STDOUT WITH (FORMAT csv, HEADER true); psql runs with the read-only PGOPTIONS and ON_ERROR_STOP', () => {
  const sb = sandbox({ ready: ['2026-11-19'] });
  const r = sb.run(['--segment', 'R1', '--day', '2026-11-19']);
  assert.equal(r.status, 0, r.err);
  const sent = sb.statements().filter((s) => s.startsWith('COPY ('));
  // the sql/*.sql templates rendered independently here: the window of 11-19 is [11-19 09:00, next open day 11-20 09:00)
  const want = A().TABLES.map((t) => ({ stem: t.stem, sql: renderSql(t.stem, '2026-11-19', '2026-11-19 09:00:00+08', '2026-11-20 09:00:00+08') }));
  assert.equal(sent.length, want.length);
  for (const q of want) assert.ok(sent.includes(`COPY (${q.sql}) TO STDOUT WITH (FORMAT csv, HEADER true);`), q.stem);
  for (const line of fs.readFileSync(`${sb.log}.args`, 'utf8').split('\n').filter(Boolean)) {
    assert.match(line, /^PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=\d+\t/, line);
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
  assert.deepEqual(fs.readdirSync(dir).sort(), [...A().TABLES.map((t) => `${t.stem}.csv`), 'READINESS.json', 'SHA256SUMS'].sort());
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  assert.equal(sums.length, 8, 'seven tables and the readiness record');
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
  const r2 = np.run(['--segment', 'R1', '--day', '2026-11-18'], { R2EXP_NOW: '2026-11-19T16:00:00+08:00' });
  assert.equal(r2.status, 0); assert.match(r2.out, /NOT_AVAILABLE:2026-11-18/);
  assert.equal(np.run(['--segment', 'R1', '--day', '2026-11-18'], { R2EXP_NOW: '2026-11-25T16:00:00+08:00' }).status, 4, 'the same day still without prices four days later is the alert exit');
  assert.ok(!fs.existsSync(dayDir(np, 'R1', '2026-11-18')));
});

test('DX5 industry window: the first R1 part reaches back to 2026-10-17, later parts start the day after the previous open day (a weekend belongs to Monday), the first R2 part starts 2027-01-01', () => {
  const sb = sandbox({ ready: ['2026-11-18', '2026-11-19', '2026-11-23'] });
  sb.run(['--segment', 'R1']);
  const ind = sb.statements().filter((s) => s.includes('FROM industry_membership '));
  const lowers = ind.map((s) => /first_available_at >= TIMESTAMPTZ '([^']+)'/.exec(s)[1]);
  assert.deepEqual(lowers, ['2026-10-17 00:00:00+08', '2026-11-19 09:00:00+08', '2026-11-23 09:00:00+08']);
  const uppers = ind.map((s) => /first_available_at < TIMESTAMPTZ '([^']+)'/.exec(s)[1]);
  assert.deepEqual(uppers, ['2026-11-19 09:00:00+08', '2026-11-20 09:00:00+08', '2026-11-24 09:00:00+08']);
  const sb2 = sandbox({ ready: ['2027-01-04'] });
  sb2.run(['--segment', 'R2']);
  const i2 = sb2.statements().filter((s) => s.includes('FROM industry_membership '));
  assert.match(i2[0], /first_available_at >= TIMESTAMPTZ '2027-01-01 00:00:00\+08' AND first_available_at < TIMESTAMPTZ '2027-01-05 09:00:00\+08'/);
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
  const e = evening.run(['--segment', 'R1'], { R2EXP_NOW: '2026-11-19T16:00:00+08:00' });
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
  assert.match(text, new RegExp(`R1\\) START_AFTER=${P.R1.startAfter}; FIRST_LOWER=${P.R1.industryFrom.slice(0, 10)}; END=2026-12-31; MAXDAYS=0`));
  assert.match(text, new RegExp(`R2\\) START_AFTER=${P.R2.startAfter}; FIRST_LOWER=${P.R2.industryFrom.slice(0, 10)}; END=; MAXDAYS=54`));
  const reg = require('../services/mining-rounds/holdout-segments').REGISTRY.find((e) => e.id === 'R2');
  assert.equal(reg.length_trading_days, 54);
  assert.equal(require('../services/mining-sandbox/segments').SEGMENTS.HOLDOUT.to, '2026-12-31');
});

test('DX8 unit and timer: a oneshot user unit running the script for both segments, a daily timer after POST_CLOSE with a retry, Persistent; no docker, no network setting that widens anything; the env file only names the connection', () => {
  const svc = fs.readFileSync(path.join(DIR, 'r2-day-export.service'), 'utf8');
  const tim = fs.readFileSync(path.join(DIR, 'r2-day-export.timer'), 'utf8');
  assert.match(svc, /^Type=oneshot$/m);
  assert.match(svc, /^TimeoutStartSec=\d+$/m, 'a hard limit for the whole run (ops-coord: hard timeout before the end of the slot)');
  assert.ok(Number(/^TimeoutStartSec=(\d+)$/m.exec(svc)[1]) <= 2700, 'shorter than the shortest slot (45 minutes)');
  assert.match(svc, /^ExecStart=.*r2-day-export\.sh --segment all$/m);
  assert.match(svc, /^EnvironmentFile=.*r2-day-export\.env$/m);
  assert.match(svc, /^Environment=DOCKER_HOST=unix:\/\/\/run\/user\/%U\/docker\.sock$/m);
  assert.deepEqual(tim.match(/^OnCalendar=.*$/gm), ['OnCalendar=Mon..Fri 08:20:00 Asia/Shanghai', 'OnCalendar=Mon..Fri 16:00:00 Asia/Shanghai', 'OnCalendar=Mon..Fri 21:40:00 Asia/Shanghai'], 'open days, in the allowed V6-window slots only (ops-coord)');
  assert.match(tim, /^Persistent=false$/m); assert.match(tim, /^RandomizedDelaySec=0$/m);
  const env = fs.readFileSync(path.join(DIR, 'r2-day-export.env.example'), 'utf8');
  for (const k of ['R2EXP_PG_CONTAINER', 'R2EXP_PG_USER', 'R2EXP_PG_DB', 'R2EXP_DROP_ROOT']) assert.ok(env.includes(k), k);
  assert.ok(!/PASSWORD|PGPASSWORD|secret|token/i.test(env), 'no credential in the example');
  const inst = fs.readFileSync(path.join(DIR, 'INSTALL.md'), 'utf8');
  for (const s of ['25006', 'default_transaction_read_only', 'systemctl --user', 'SHA256SUMS', '57e26c03']) assert.ok(inst.includes(s), s);
});

test('DX9 SHA256SUMS (installed with the script) lists the script, the readiness probe and every sql file, and each line is the file\'s sha256; any edit has to regenerate it', { skip: process.env.QRP_MUTATION_RUN ? 'a mutation run edits the script on purpose' : false }, () => {
  const lines = fs.readFileSync(path.join(DIR, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  const want = ['r2-day-export.sh', 'R2_DAY_EXPORT_READINESS_V2.sql', ...fs.readdirSync(path.join(DIR, 'sql')).map((f) => `sql/${f}`)].sort();
  assert.deepEqual(lines.map((l) => l.split('  ')[1]).sort(), want);
  for (const l of lines) { const [h, n] = l.split('  '); assert.equal(sha(fs.readFileSync(path.join(DIR, n))), h, n); }
});

test('DX10 docker is a closed exception (ops-coord, same as #122 RULING_1 D3): exactly one docker invocation in the script, `docker exec -i -e PGOPTIONS=... <container> sh -c ...`, every call under `timeout`, SQL on stdin; every call the stub saw has that form', () => {
  const code0 = fs.readFileSync(SH, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const uses = code0.match(/\bdocker\b/g) || [];
  assert.equal(uses.length, 1, 'one docker word in the code');
  assert.match(code0, /local t="\$\{R2EXP_TIMEOUT:-600\}"/, 'a time limit per call, clamped to the end of the slot');
  assert.match(code0, /timeout -k 10 "\$t" docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=\$\(\(t \* 1000\)\)" "\$R2EXP_PG_CONTAINER" sh -c '[^']*exec psql -X -q -v ON_ERROR_STOP=1 -U "\$u" -d "\$d" "\$@"' sh "\$R2EXP_PG_USER" "\$R2EXP_PG_DB" "\$@"/);
  for (const verb of ['run', 'cp', 'rm', 'kill', 'stop', 'restart', 'pause', 'unpause', 'start', 'build', 'compose', 'volume', 'network', 'commit', 'exec -u 0', 'exec --privileged']) assert.ok(!new RegExp(`docker ${verb}\\b`).test(code0), verb);
  assert.ok(!/\bpsql\b[^\n]*\s-c\s/.test(code0.replace(/sh -c '[^']*'/g, '')), 'psql -c is not used: the SQL comes on stdin');
  assert.ok(!/DOCKER_HOST|sudo/.test(code0), 'no daemon switch, no sudo (the unit names the daemon)');
  const sb = sandbox({ ready: ['2026-11-19'] });
  assert.equal(sb.run(['--segment', 'R1', '--day', '2026-11-19']).status, 0);
  const calls = fs.readFileSync(sb.dockerLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.length >= 10);
  for (const c of calls) assert.match(c, /^exec -i -e PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=\d+ pgc sh -c /, c.slice(0, 80));
  const svc = fs.readFileSync(path.join(DIR, 'r2-day-export.service'), 'utf8');
  assert.match(svc, /^Environment=DOCKER_HOST=unix:\/\/\/run\/user\/%U\/docker\.sock$/m, 'the unit names the rootless daemon');
});

test('DX11 fail closed: a failing readiness probe, a failing data query, or a psql call that runs past the time limit stops the run with exit 2 and exports nothing (a failed probe is not "not ready yet")', () => {
  const probe = sandbox({ ready: ['2026-11-19'], fail: 'ready' });
  const p = probe.run(['--segment', 'R1', '--day', '2026-11-19']);
  assert.equal(p.status, 2); assert.match(p.err, /PROBE_FAILED:2026-11-19/);
  assert.ok(!fs.existsSync(dayDir(probe, 'R1', '2026-11-19')));
  const copy = sandbox({ ready: ['2026-11-19'], fail: 'copy' });
  const c = copy.run(['--segment', 'R1', '--day', '2026-11-19']);
  assert.equal(c.status, 2); assert.match(c.err, /EXPORT_FAILED:2026-11-19:prices_daily_stock/);
  assert.deepEqual(fs.readdirSync(path.join(copy.drop, 'R1')), [], 'no day directory and no temp directory is left');
  const slow = sandbox({ ready: ['2026-11-19'], sleep: '5' });
  const s = slow.run(['--segment', 'R1', '--day', '2026-11-19'], { R2EXP_TIMEOUT: '1' });
  assert.equal(s.status, 2);
  assert.deepEqual(fs.readdirSync(path.join(slow.drop, 'R1')), []);
  // the session check also fails closed when psql itself fails
  const nopsql = sandbox({ ready: ['2026-11-19'] }); fs.rmSync(path.join(nopsql.root, 'bin', 'psql'));
  assert.equal(nopsql.run(['--segment', 'R1', '--day', '2026-11-19']).status, 2);
});

test('DX12 readiness V2: the probe row is written to READINESS.json in the day directory (ready_via, counts, the probe\'s sha256) for the arrival program to record; NEXT_PREMARKET days are exported; a malformed probe row is a failed probe (exit 2), not "not ready"; the probe is re-run on every tick (never cached)', () => {
  const sb = sandbox({ ready: ['2026-11-18:NEXT_PREMARKET', '2026-11-19'] });
  assert.equal(sb.run(['--segment', 'R1']).status, 4, 'the other days are not ready for ages: alert exit; the two ready days are exported');
  const rec = (d) => JSON.parse(fs.readFileSync(path.join(dayDir(sb, 'R1', d), 'READINESS.json'), 'utf8'));
  assert.deepEqual([rec('2026-11-18').ready_via, rec('2026-11-19').ready_via], ['NEXT_PREMARKET', 'POST_CLOSE_D']);
  const r = rec('2026-11-18');
  assert.deepEqual([r.schema, r.trade_date, r.n_prices, r.n_basic, r.n_adj, r.n_cov, r.probe_sha256], ['R2_DAY_EXPORT_READINESS_RECORD_V1', '2026-11-18', 5260, 5217, 5229, 1, '57e26c0379ad86008fdea0f035108104761434dfc009dc80d358987a6fddb582']);
  assert.deepEqual([r.window_from, r.window_to], ['2026-10-17T00:00:00+08:00', '2026-11-19T09:00:00+08:00'], 'the industry window is recorded for the arrival chain');
  assert.match(r.probed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  // the probe ran for every open day not yet exported, on this tick (a second run asks again for the days still waiting, and not for the exported ones)
  const before = sb.statements().filter((s) => s.includes('pipeline_completion')).length;
  sb.run(['--segment', 'R1']);
  const after = sb.statements().filter((s) => s.includes('pipeline_completion')).length;
  assert.ok(after > before, 'the waiting days are probed again');
  // a malformed row (wrong day, unknown ready_via, non-numeric count) fails closed
  for (const bad of ['2026-11-19|SOMETHING|5260|5217|5229|1', '2026-11-20|POST_CLOSE_D|5260|5217|5229|1', '2026-11-19|POST_CLOSE_D|x|5217|5229|1']) {
    const b = sandbox({ ready: [] });
    const stubPath = path.join(b.root, 'bin', 'psql');
    fs.writeFileSync(stubPath, fs.readFileSync(stubPath, 'utf8').replace(/\*pipeline_completion\*\)[^\n]*\n/, `*pipeline_completion*) echo '${bad}';;\n`), { mode: 0o755 });
    const x = b.run(['--segment', 'R1', '--day', '2026-11-19']);
    assert.equal(x.status, 2, bad); assert.match(x.err, /PROBE_BAD_ROW:2026-11-19/);
    assert.deepEqual(fs.readdirSync(path.join(b.drop, 'R1')), []);
  }
});

test('DX13 point-in-time cutoff: a day is exported only when the next SSE open day after it has reached 09:00+08 (the panel counts only rows in by then); before that it waits (WAITING_CUTOFF) and --day refuses (exit 3); the next open day after 2026-12-31 is 2027-01-04; R2EXP_PIT_CUTOFF=0 switches the rule off', () => {
  const at = (iso, o = {}) => { const sb = sandbox({ ready: ['2026-11-19'], ...o }); return { sb, run: (args, extra = {}) => sb.run(args, { R2EXP_NOW: iso, ...extra }) }; };
  const early = at('2026-11-20T08:30:00+08:00');
  const w = early.run(['--segment', 'R1']);
  assert.match(w.out, /WAITING_CUTOFF:2026-11-19/); assert.ok(!fs.existsSync(dayDir(early.sb, 'R1', '2026-11-19')));
  const refused = early.run(['--segment', 'R1', '--day', '2026-11-19']);
  assert.equal(refused.status, 3); assert.match(refused.out, /REFUSED_BEFORE_CUTOFF:2026-11-19/);
  assert.equal(early.sb.statements().filter((s) => s.startsWith('COPY (')).length, 0, 'no data query before the cutoff');
  // the same time with the rule off: exported
  const off = at('2026-11-20T08:30:00+08:00'); assert.match(off.run(['--segment', 'R1'], { R2EXP_PIT_CUTOFF: '0' }).out, /EXPORTED:2026-11-19/);
  // after 09:00 of the next open day (here in the 15:40 slot) it is exported
  const late = at('2026-11-20T16:00:00+08:00'); assert.match(late.run(['--segment', 'R1']).out, /EXPORTED:2026-11-19/);
  // Friday's day waits for Monday 09:00
  const fri = sandbox({ ready: ['2026-11-20'] });
  assert.match(fri.run(['--segment', 'R1'], { R2EXP_NOW: '2026-11-23T08:30:00+08:00' }).out, /WAITING_CUTOFF:2026-11-20/);
  assert.match(fri.run(['--segment', 'R1'], { R2EXP_NOW: '2026-11-23T16:00:00+08:00' }).out, /EXPORTED:2026-11-20/);
  // the last day of R1: its next open day is 2027-01-04
  const last = sandbox({ ready: ['2026-12-31'] });
  assert.match(last.run(['--segment', 'R1'], { R2EXP_NOW: '2027-01-04T08:30:00+08:00' }).out, /WAITING_CUTOFF:2026-12-31/);
  assert.match(last.run(['--segment', 'R1'], { R2EXP_NOW: '2027-01-04T16:00:00+08:00' }).out, /EXPORTED:2026-12-31/);
  const sat = sandbox({ ready: ['2026-12-31'] });
  assert.match(sat.run(['--segment', 'R1'], { R2EXP_NOW: '2027-01-02T10:00:00+08:00' }).out, /WAITING_CUTOFF:2026-12-31/, 'a Saturday run before Monday 09:00 does not export it (its window end, 2027-01-04, is still ahead)');
});

test('DX14 V6-window slots (ops-coord): on weekdays the job runs only in 08:20-09:05, 15:40-18:05 and 21:35-00:10 CST and otherwise does nothing (exit 0, OUTSIDE_SLOT, no docker call); weekends any time; every psql call is clamped to the end of the slot, and no day starts after it', () => {
  const tryAt = (iso) => { const sb = sandbox({ ready: ['2026-11-18'] }); const r = sb.run(['--segment', 'R1'], { R2EXP_NOW: iso }); return { r, called: fs.existsSync(sb.dockerLog) }; };
  // 2026-11-23 is a Monday, 2026-11-28 a Saturday, 2026-11-29 a Sunday
  const deny = ['2026-11-23T00:15:00+08:00', '2026-11-23T01:00:00+08:00', '2026-11-23T01:14:00+08:00', '2026-11-23T05:00:00+08:00', '2026-11-23T06:30:00+08:00', '2026-11-23T07:59:00+08:00', '2026-11-23T08:10:00+08:00',
    '2026-11-23T09:06:00+08:00', '2026-11-23T09:15:00+08:00', '2026-11-23T12:00:00+08:00', '2026-11-23T15:30:00+08:00', '2026-11-23T15:39:00+08:00', '2026-11-23T18:06:00+08:00', '2026-11-23T18:10:00+08:00',
    '2026-11-23T19:00:00+08:00', '2026-11-23T21:30:00+08:00', '2026-11-23T21:34:00+08:00', '2026-11-25T00:11:00+08:00', '2026-11-27T01:00:00+08:00'];
  for (const t of deny) { const x = tryAt(t); assert.equal(x.r.status, 0, t); assert.match(x.r.out, /OUTSIDE_SLOT/, t); assert.equal(x.called, false, `${t}: no docker call`); }
  const allow = ['2026-11-23T00:00:00+08:00', '2026-11-23T00:10:00+08:00', '2026-11-23T08:20:00+08:00', '2026-11-23T09:05:00+08:00', '2026-11-23T15:40:00+08:00', '2026-11-23T16:00:00+08:00', '2026-11-23T18:05:00+08:00',
    '2026-11-23T21:35:00+08:00', '2026-11-23T23:59:00+08:00', '2026-11-28T00:30:00+08:00', '2026-11-28T12:00:00+08:00', '2026-11-29T01:00:00+08:00', '2026-11-29T09:20:00+08:00', '2026-11-29T23:30:00+08:00'];
  for (const t of allow) { const x = tryAt(t); assert.doesNotMatch(x.r.out, /OUTSIDE_SLOT/, t); assert.equal(x.called, true, `${t}: the job ran`); }
  // the end of the slot: a psql call is clamped to the time left (1 second here), so a slow call is cut and the run fails closed instead of running into the V6 window
  const slow = sandbox({ ready: ['2026-11-18'], sleep: '3' });
  const cut = slow.run(['--segment', 'R1', '--day', '2026-11-18'], { R2EXP_NOW: '2026-11-23T09:04:59+08:00' });
  assert.equal(cut.status, 2, cut.err + cut.out);
  // at or past the end of the slot no day is started (the next slot resumes)
  const end = sandbox({ ready: ['2026-11-18'] });
  const e = end.run(['--segment', 'R1'], { R2EXP_NOW: '2026-11-23T09:05:30+08:00' });
  assert.equal(e.status, 0); assert.match(e.out, /SLOT_ENDED:2026-11-18/);
  assert.ok(!fs.existsSync(dayDir(end, 'R1', '2026-11-18')));
  assert.equal(end.statements().filter((s) => s.startsWith('COPY (')).length, 0);
});

test('DX15 industry windows partition the rows (plan-coord condition): the concatenation of the per-day parts equals ONE export under the first_available_at rule over [2026-10-17 00:00+08, 2027-01-04 09:00+08) on a synthetic ledger that has rows whose effective_from is after their first_available_at; every row exactly once, effective_from untouched', () => {
  const rows = [
    ['i01,S01.SH,SW2021,L1,2020-01-01,2026-10-16 23:59:59+08', false],   // before the first window
    ['i02,S01.SH,SW2021,L1,2020-01-01,2026-10-17 00:00:00+08', true],    // first bound, inclusive
    ['i03,S02.SH,SW2021,L1,2026-12-01,2026-10-20 10:00:00+08', true],    // effective_from AFTER first_available_at
    ['i04,S03.SH,SW2021,L1,2026-11-18,2026-11-19 08:59:59+08', true],    // 11-18 window (ends 11-19 09:00)
    ['i05,S03.SH,SW2021,L1,2026-11-19,2026-11-19 09:00:00+08', true],    // 11-19 window (starts 11-19 09:00)
    ['i06,S04.SH,SW2021,L1,2026-11-30,2026-11-21 12:00:00+08', true],    // a Saturday, effective in the future: the Friday 11-20 window [11-20 09:00, 11-23 09:00)
    ['i07,S05.SH,SW2021,L1,2027-02-01,2026-12-31 10:00:00+08', true],    // the last R1 day
    ['i08,S06.SH,SW2021,L1,2027-01-05,2027-01-04 08:00:00+08', true],    // after 12-31, before 2027-01-04 09:00: still the 12-31 part
    ['i09,S06.SH,SW2021,L1,2027-01-05,2027-01-04 09:00:00+08', false],   // after R1's last window
    ['i10,S07.SH,SW2021,L1,2026-11-02,2026-11-02 10:00:00+08', true],
    ['i11,S07.SH,SW2021,L1,2026-11-02,2026-11-02 10:00:00+08', true],    // a revision with the same timestamp: both rows
  ];
  const sb0 = sandbox({ ready: [] }); const file = path.join(sb0.root, 'ind.csv'); fs.writeFileSync(file, `${rows.map((r) => r[0]).join('\n')}\n`);
  const sb = sandbox({ ready: OPEN.filter((d) => d > '2026-11-17' && d <= '2026-12-31'), indRows: file });
  const r = sb.run(['--segment', 'R1'], { R2EXP_NOW: '2027-01-05T16:00:00+08:00' });
  assert.equal(r.status, 0, r.err + r.out);
  const got = [];
  for (const d of OPEN.filter((x) => x > '2026-11-17' && x <= '2026-12-31')) {
    const lines = fs.readFileSync(path.join(dayDir(sb, 'R1', d), 'industry_membership_sw2021.csv'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines[0], 'record_id,security_id,industry_standard,industry_level,effective_from,first_available_at');
    got.push(...lines.slice(1));
  }
  const oneExport = rows.filter((x) => x[1]).map((x) => x[0]);
  assert.deepEqual([...got].sort(), [...oneExport].sort(), 'the parts together are the one export, nothing lost, nothing twice');
  assert.equal(got.length, 9, 'nine rows are inside the window (i11 is a second row with the same timestamp as i10)');
  assert.equal(new Set(got.map((l) => l.split(',')[0])).size, 9);
  assert.ok(got.includes('i03,S02.SH,SW2021,L1,2026-12-01,2026-10-20 10:00:00+08'), 'a row effective after it became available is exported on the day it became available, effective_from as it is');
  // the windows the exporter wrote are contiguous
  const recs = OPEN.filter((x) => x > '2026-11-17' && x <= '2026-12-31').map((d) => JSON.parse(fs.readFileSync(path.join(dayDir(sb, 'R1', d), 'READINESS.json'), 'utf8')));
  assert.equal(recs[0].window_from, '2026-10-17T00:00:00+08:00');
  for (let i = 1; i < recs.length; i += 1) assert.equal(recs[i].window_from, recs[i - 1].window_to, recs[i].trade_date);
  assert.equal(recs[recs.length - 1].window_to, '2027-01-04T09:00:00+08:00');
});

test('DX16 the readiness probe is ONE variable (R2EXP_READY_SQL, default the V2 file next to the script): the file it names is the one run and its sha goes into the record; a missing file stops the run (exit 2)', () => {
  const sb = sandbox({ ready: ['2026-11-18'] });
  const other = path.join(sb.root, 'probe.sql'); fs.writeFileSync(other, `${fs.readFileSync(path.join(DIR, 'R2_DAY_EXPORT_READINESS_V2.sql'), 'utf8')}-- a different file\n`);
  assert.equal(sb.run(['--segment', 'R1', '--day', '2026-11-18'], { R2EXP_READY_SQL: other }).status, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(dayDir(sb, 'R1', '2026-11-18'), 'READINESS.json'), 'utf8'));
  assert.equal(rec.probe_sha256, sha(fs.readFileSync(other)));
  assert.ok(sb.statements().some((s) => s.includes('-- a different file') || s.includes('pipeline_completion')), 'the probe ran');
  const none = sandbox({ ready: ['2026-11-18'] }).run(['--segment', 'R1', '--day', '2026-11-18'], { R2EXP_READY_SQL: '/nonexistent/probe.sql' });
  assert.equal(none.status, 2); assert.match(none.err, /PROBE_SQL_MISSING/);
});

test('DX17 the export SQL (export spec section 2, rev 5 change 2): one day per query, stocks only, the spec\'s column lists untouched incl. effective_from, the industry window on first_available_at with no effective_from cut, the calendar query to the end of 2027', () => {
  const sql = (stem) => renderSql(stem, '2027-01-04', '2027-01-01 00:00:00+08', '2027-01-05 09:00:00+08');
  const STOCKS = "security_id IN (SELECT DISTINCT security_id FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL)";
  assert.match(sql('prices_daily_stock'), new RegExp(`^SELECT record_id, security_id, trade_date, open, high, low, close, .* FROM prices_daily WHERE trade_date = '2027-01-04' AND ${STOCKS.replace(/[()]/g, '\\$&')} ORDER BY security_id, trade_date, source_record_id, revision$`));
  for (const [stem, table] of [['market_daily_basic_observation_stock', 'market_daily_basic_observation'], ['adjustment_factor_observation_stock', 'adjustment_factor_observation']]) assert.match(sql(stem), new RegExp(`FROM ${table} WHERE trade_date = '2027-01-04' AND `));
  assert.match(sql('security_master_stock'), /FROM canonical_security_observation WHERE asset_class = 'STOCK' AND security_id IS NOT NULL AND business_date = '2027-01-04' ORDER BY security_id, business_date, revision$/);
  assert.match(sql('security_suspension_observation'), /FROM security_suspension_observation WHERE trade_date = '2027-01-04' ORDER BY/);
  assert.match(sql('security_suspension_day_coverage'), /FROM security_suspension_day_coverage WHERE trade_date = '2027-01-04' ORDER BY trade_date, coverage_id$/);
  const ind = sql('industry_membership_sw2021');
  assert.match(ind, /^SELECT record_id, security_id, industry_standard, industry_level, industry_code, industry_name, effective_from, effective_to, first_available_at, ingested_at, source_record_id, revision, schema_version, quality_state FROM industry_membership WHERE first_available_at >= TIMESTAMPTZ '2027-01-01 00:00:00\+08' AND first_available_at < TIMESTAMPTZ '2027-01-05 09:00:00\+08' ORDER BY security_id, industry_standard, industry_level, effective_from, revision$/);
  assert.ok(!/effective_from <=|effective_from >=|WHERE effective_from/.test(ind), 'no per-day effective_from cut');
  assert.match(renderSql('trading_calendar', '', '', ''), /FROM canonical_calendar_observation WHERE calendar_date >= '2019-06-01' AND calendar_date <= '2027-12-31' ORDER BY calendar_date, exchange, revision DESC, first_available_at DESC$/);
  for (const t of A().TABLES) assert.ok(!/@[A-Z]+@/.test(sql(t.stem)), `${t.stem}: every placeholder is filled`);
});

test('DX18 the "waiting more than 3 days" alert counts from the day\'s cutoff instant (09:00+08 of the next open day), never from the day itself: no exit 4 before the cutoff (R1\'s last day on 2027-01-04 08:30, a ten-day closure), and a day that is not ready 3 days after its cutoff is exit 4', () => {
  // R1's last day: everything else exported, 2026-12-31 waits for 2027-01-04 09:00
  const ready = OPEN.filter((d) => d > '2026-11-17' && d <= '2026-12-31');
  const last = sandbox({ ready });
  const early = last.run(['--segment', 'R1'], { R2EXP_NOW: '2027-01-04T08:30:00+08:00' });
  assert.equal(early.status, 0, early.out); assert.match(early.out, /WAITING_CUTOFF:2026-12-31/);
  // a ten-day closure inside R2 (no open days 2027-02-08..02-19): the day before it waits for 02-22 09:00 without alerting, every run
  const closure = OPEN.filter((d) => d < '2027-02-08' || d > '2027-02-19');
  const rdy = closure.filter((d) => d > '2026-12-31' && d <= '2027-02-05');
  const clo = sandbox({ ready: rdy, open: closure });
  for (const now of ['2027-02-09T16:00:00+08:00', '2027-02-12T16:00:00+08:00', '2027-02-17T16:00:00+08:00', '2027-02-22T08:30:00+08:00']) {
    const r = clo.run(['--segment', 'R2'], { R2EXP_NOW: now });
    assert.equal(r.status, 0, `${now}: ${r.out}`);
  }
  assert.match(clo.run(['--segment', 'R2'], { R2EXP_NOW: '2027-02-17T16:00:00+08:00' }).out, /WAITING_CUTOFF:2027-02-05/);
  // after the cutoff, a day that is still not ready: alert only more than 3 days (72 h) after the cutoff instant
  const nr = sandbox({ ready: [] });
  assert.equal(nr.run(['--segment', 'R1'], { R2EXP_NOW: '2026-11-22T08:00:00+08:00' }).status, 0, '2 days 23 hours after the cutoff of 2026-11-18: not yet');
  assert.equal(nr.run(['--segment', 'R1'], { R2EXP_NOW: '2026-11-22T10:00:00+08:00' }).status, 4, '3 days 1 hour after the cutoff of 2026-11-18: the alert');
  assert.equal(nr.run(['--segment', 'R1'], { R2EXP_NOW: '2026-11-19T16:00:00+08:00' }).status, 0);
});

test('DX19 modes at rest: dropped day directories 0750 and files 0640 (umask 027; group of the exporting account, kayla), the R2 calendar 0640; INSTALL.md says 0750 for the drop directories', () => {
  const mode = (p) => (fs.statSync(p).mode & 0o777);
  const sb = sandbox({ ready: ['2026-11-18'] });
  assert.equal(sb.run(['--segment', 'R1', '--day', '2026-11-18'], { R2EXP_ENV_FILE: '/nonexistent' }).status, 0);
  const dir = dayDir(sb, 'R1', '2026-11-18');
  assert.equal(mode(dir), 0o750);
  for (const n of fs.readdirSync(dir)) assert.equal(mode(path.join(dir, n)), 0o640, n);
  const r2 = sandbox({ ready: ['2027-01-04'] });
  r2.run(['--segment', 'R2'], { R2EXP_NOW: '2027-01-05T16:00:00+08:00' });
  assert.equal(mode(path.join(r2.drop, 'R2', 'trading_calendar.csv')), 0o640);
  const inst = fs.readFileSync(path.join(DIR, 'INSTALL.md'), 'utf8');
  assert.match(inst, /install -d -m 0750 [^\n]*holdout-daydrop\/R1[^\n]*holdout-daydrop\/R2/);
  assert.ok(!/install -d -m 0755 [^\n]*holdout-daydrop/.test(inst));
});
