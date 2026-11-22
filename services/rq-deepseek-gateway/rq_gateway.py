#!/usr/bin/env python3
"""rq-deepseek-gateway: the only holder of a host's DeepSeek key (AUTONOMOUS_RESEARCH_QUEUE_V1 section 5.3, 5.4).

Python 3.12 standard library only. Listens on a unix socket; accepts exactly two requests,
  POST /chat/completions   and   GET /user/balance,
and forwards them over TLS to api.deepseek.com:443 only, adding the Authorization header itself.

What it enforces (code, not prompts):
  - path and method allowlist; plain-completion request bodies only (no tools, functions, web, file or URL parts);
  - per purpose: model allowlist, a max_tokens ceiling (runaway protection for one response), prompt admission
    (sha256 of the system message must equal the header and be an ADMITTED entry), the off-peak price schedule,
    and, for the pro fallback, a verified flash quality-gate record that is used at most once per task;
  - the key is read only from its file / unit environment, is never logged or printed, and is redacted from every
    upstream echo; the ledger records only key_id and key_fp12 (first 12 hex of sha256(key));
  - one `call` row per provider response (the frozen DDL of section 3.2) with usage and the price-table cost.

There is NO spend or token total anywhere in the request path (Owner 11-22). A monthly spend view is computed from the
ledger for display only (monthly_spend / `spend` command); nothing reads it to refuse or delay a call.

Never calls anything but the DeepSeek chat API. Tests use a stub transport; no network and no real key.
"""
import argparse
import base64
import binascii
import hashlib
import http.client
import json
import os
import re
import socketserver
import sqlite3
import ssl
import stat
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler

CST = timezone(timedelta(hours=8))
UPSTREAM_HOST = 'api.deepseek.com'
UPSTREAM_PORT = 443
PATH_CHAT = '/chat/completions'
PATH_BALANCE = '/user/balance'
MAX_REQUEST_BYTES = 1 << 20
MAX_RESPONSE_BYTES = 8 << 20
REQUEST_KEYS = ('model', 'messages', 'max_tokens', 'temperature', 'response_format', 'stream')
MESSAGE_ROLES = ('system', 'user', 'assistant')
QUALITY_GATE_SCHEMA = 'RQ_FLASH_QUALITY_GATE_RECORD_V1'
FLASH_MODEL = 'deepseek-flash'
SHA64 = re.compile(r'^[0-9a-f]{64}$')

LEDGER_DDL = (
    'CREATE TABLE IF NOT EXISTS call (call_id TEXT PRIMARY KEY, at TEXT, key_id TEXT, key_fp12 TEXT, purpose TEXT, task_id TEXT, '
    'model TEXT, peak INTEGER, http_status INTEGER, prompt_cache_hit_tokens INTEGER, prompt_cache_miss_tokens INTEGER, '
    'completion_tokens INTEGER, reasoning_tokens INTEGER, price_table TEXT, cny REAL, usd REAL, request_sha256 TEXT)'
)


class GatewayConfigError(Exception):
    pass


class Refusal(Exception):
    """A request the gateway refuses before anything is forwarded."""

    def __init__(self, status, rq_code, rq_class='DETERMINISTIC', message=''):
        super().__init__(rq_code)
        self.status, self.rq_code, self.rq_class, self.message = status, rq_code, rq_class, message


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode('utf-8')
    return hashlib.sha256(data).hexdigest()


def canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def quality_gate_record_id(record):
    body = {k: v for k, v in record.items() if k != 'record_id'}
    return 'QG-' + sha256_hex(canonical_json(body))[:16]


# ---------------------------------------------------------------- key handling

class KeyState:
    """The key (or its absence). repr/str never show the key."""
    __slots__ = ('key', 'fp12', 'reason')

    def __init__(self, key=None, reason=None):
        self.key = key
        self.fp12 = sha256_hex(key)[:12] if key else None
        self.reason = reason

    def __repr__(self):
        return 'KeyState(present=%s, fp12=%s, reason=%s)' % (self.key is not None, self.fp12, self.reason)

    __str__ = __repr__


def _plausible(key):
    # the installer's own acceptance rule: starts with sk-, at least 30 characters, no whitespace
    return isinstance(key, str) and key.startswith('sk-') and len(key) >= 30 and not re.search(r'\s', key)


def _state(key, absent_reason):
    if key is None:
        return KeyState(None, absent_reason)
    if not _plausible(key):
        return KeyState(None, 'KEY_INVALID')
    return KeyState(key)


class StaticKeyProvider:
    def __init__(self, key):
        self._key = key

    def get(self):
        return _state(self._key, 'KEY_ABSENT')


class EnvKeyProvider:
    """Key from the unit environment (systemd EnvironmentFile read by PID 1). A missing file leaves the variable unset."""

    def __init__(self, env, var):
        self._env, self._var = env, var

    def get(self):
        return _state(self._env.get(self._var), 'VAR_ABSENT')


class FileKeyProvider:
    """Key read from an env-style file, read-only, on every call so that a restored or replaced file resumes without a restart.
    Refuses a file that is not a regular file or is open to group or others."""

    def __init__(self, path, var):
        self._path, self._var = path, var

    def get(self):
        try:
            st = os.stat(self._path)
        except OSError:
            return KeyState(None, 'FILE_ABSENT')
        if not stat.S_ISREG(st.st_mode):
            return KeyState(None, 'NOT_A_FILE')
        if st.st_mode & 0o077:
            return KeyState(None, 'MODE_TOO_OPEN')
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                text = f.read(65536)
        except (OSError, UnicodeDecodeError):
            return KeyState(None, 'FILE_UNREADABLE')
        value = None
        for line in text.splitlines():
            m = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$', line)
            if m and m.group(1) == self._var:
                value = m.group(2)
                if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                    value = value[1:-1]
        return _state(value, 'VAR_ABSENT')


def redact(text, key=None):
    """Remove the key and anything shaped like one from text that came from upstream. Used on every error echo."""
    if not isinstance(text, str):
        text = str(text)
    if key:
        text = text.replace(key, '[REDACTED]')
    text = re.sub(r'(?i)bearer\s+\S+', 'Bearer [REDACTED]', text)
    text = re.sub(r'sk-[A-Za-z0-9*._\-]{4,}', '[REDACTED]', text)
    if key:
        for n in range(16, 3, -1):
            text = text.replace(key[-n:], '[REDACTED]')
    return text


# ---------------------------------------------------------------- config

def validate_config(cfg):
    def need(c, msg):
        if not c:
            raise GatewayConfigError(msg)
    need(isinstance(cfg, dict) and cfg.get('schema') == 'RQ_DEEPSEEK_GATEWAY_CONFIG_V1', 'schema')
    up = cfg.get('upstream') or {}
    need(up.get('host') == UPSTREAM_HOST and up.get('port') == UPSTREAM_PORT, 'upstream must be %s:%d' % (UPSTREAM_HOST, UPSTREAM_PORT))
    purposes = cfg.get('purposes') or {}
    need(purposes, 'purposes')
    for name, p in purposes.items():
        need(isinstance(p.get('models'), list) and p['models'], 'purpose %s models' % name)
        need(isinstance(p.get('max_tokens'), int) and not isinstance(p['max_tokens'], bool) and p['max_tokens'] > 0, 'purpose %s max_tokens' % name)
        for k in ('admission', 'peak_refused', 'requires_quality_gate'):
            need(isinstance(p.get(k), bool), 'purpose %s %s' % (name, k))
    keys = cfg.get('keys') or {}
    need(keys, 'keys')
    for kid, k in keys.items():
        need(isinstance(k.get('purposes'), list) and all(x in purposes for x in k['purposes']), 'key %s purposes' % kid)
    need(isinstance(cfg.get('price_table'), dict) and cfg['price_table'].get('id'), 'price_table')
    need(isinstance(cfg.get('peak'), dict), 'peak')
    return cfg


def load_config(path):
    with open(path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
    fname = cfg.get('prompt_admissions_file')
    if fname and 'admissions' not in cfg:
        with open(os.path.join(os.path.dirname(os.path.abspath(path)), os.path.basename(fname)), 'r', encoding='utf-8') as f:
            cfg['admissions'] = json.load(f).get('entries', [])
    cfg.setdefault('admissions', [])
    return validate_config(cfg)


# ---------------------------------------------------------------- schedule and price

def _minutes(hhmm):
    h, m = hhmm.split(':')
    return int(h) * 60 + int(m)


def is_off_peak(now, peak_cfg):
    now = now.astimezone(CST)
    if now.weekday() >= 5 and peak_cfg.get('weekend_all_off_peak'):
        return True
    cur = now.hour * 60 + now.minute
    return any(_minutes(a) <= cur < _minutes(b) for a, b in peak_cfg.get('weekday_off_peak_cst', []))


def price_cost(table, model, peak, hit, miss, out):
    """(cny, usd). A price row that is not known gives None, never 0. A null cache-hit price is priced as a miss (an upper bound) when the table says so."""
    entry = (table.get('models') or {}).get(model)
    if not entry:
        return None, None
    res = []
    for unit in ('cny_per_m', 'usd_per_m'):
        row = ((entry.get(unit) or {}).get('peak' if peak else 'off_peak')) or {}
        pm, po, ph = row.get('miss'), row.get('out'), row.get('hit')
        if ph is None and table.get('hit_priced_as_miss_when_null'):
            ph = pm
        if pm is None or po is None or ph is None:
            res.append(None)
        else:
            res.append((hit * ph + miss * pm + out * po) / 1e6)
    return res[0], res[1]


# ---------------------------------------------------------------- the gateway

def _error_for_status(status, headers, body_text, key):
    ra = None
    for k, v in (headers or {}).items():
        if k.lower() == 'retry-after':
            try:
                ra = int(str(v).strip())
            except ValueError:
                ra = None
    msg = body_text
    try:
        j = json.loads(body_text)
        if isinstance(j, dict) and isinstance(j.get('error'), dict) and isinstance(j['error'].get('message'), str):
            msg = j['error']['message']
    except ValueError:
        pass
    msg = redact(msg, key)[:300]
    if status in (401, 403):
        code, cls = 'RQ_UPSTREAM_AUTH', 'CREDENTIAL'
    elif status == 402:
        code, cls = 'RQ_UPSTREAM_QUOTA', 'QUOTA'
    elif status == 429:
        code, cls = 'RQ_UPSTREAM_RATE', 'PROVIDER'
    elif status >= 500:
        code, cls = 'RQ_UPSTREAM_5XX', 'PROVIDER'
    else:
        code, cls = 'RQ_UPSTREAM_INVALID', 'DETERMINISTIC'
    return {'rq_code': code, 'rq_class': cls, 'message': msg, 'http_status': status, 'retry_after_s': ra}


class Gateway:
    def __init__(self, config, key_id, key_provider, db_path, transport=None, clock=None, log=None, id_gen=None):
        self.cfg = validate_config(config)
        if key_id not in self.cfg['keys']:
            raise GatewayConfigError('unknown key_id %s' % key_id)
        self.key_id = key_id
        self.key_purposes = set(self.cfg['keys'][key_id]['purposes'])
        self.keys = key_provider
        self.db_path = db_path
        self.transport = transport or https_transport
        self.clock = clock or (lambda: datetime.now(CST))
        self.log = log or (lambda line: sys.stderr.write(json.dumps(line, sort_keys=True) + '\n') if isinstance(line, dict) else sys.stderr.write(str(line) + '\n'))
        self.id_gen = id_gen or (lambda: 'RQC-' + uuid.uuid4().hex)
        self.timeout = float(self.cfg.get('timeout_s', 180))
        self.admitted = {}
        for e in self.cfg.get('admissions', []):
            if e.get('state') == 'ADMITTED' and SHA64.match(e.get('system_sha256', '')):
                self.admitted.setdefault(e['system_sha256'], set()).update(e.get('purposes', []))
        self._lock = threading.Lock()
        with self._conn() as c:
            c.execute(LEDGER_DDL)

    # -- storage
    def _conn(self):
        c = sqlite3.connect(self.db_path, timeout=5.0, isolation_level=None)
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA synchronous=FULL')
        c.execute('PRAGMA busy_timeout=5000')
        return _Closing(c)

    def announce(self):
        st = self.keys.get()
        self.log({'ev': 'gateway_start', 'key_id': self.key_id, 'key_present': st.key is not None, 'key_fp12': st.fp12, 'reason': st.reason})

    # -- replies
    @staticmethod
    def _json(status, obj, extra=None):
        return status, dict({'Content-Type': 'application/json'}, **(extra or {})), json.dumps(obj, sort_keys=True).encode('utf-8')

    def _refuse(self, r, key=None):
        err = {'rq_code': r.rq_code, 'rq_class': r.rq_class, 'message': redact(r.message, key)[:300], 'http_status': None, 'retry_after_s': None}
        self.log({'ev': 'refused', 'rq_code': r.rq_code, 'key_id': self.key_id})
        return self._json(r.status, {'error': err})

    # -- entry
    def handle(self, method, path, headers, body):
        h = {str(k).lower(): v for k, v in (headers or {}).items()}
        try:
            if path not in (PATH_CHAT, PATH_BALANCE):
                raise Refusal(404, 'RQ_PATH_REFUSED')
            if method != ('POST' if path == PATH_CHAT else 'GET'):
                raise Refusal(405, 'RQ_METHOD_REFUSED')
            ks = self.keys.get()
            if ks.key is None:
                raise Refusal(503, 'RQ_CREDENTIAL_ABSENT', 'CREDENTIAL', 'key not available: %s' % ks.reason)
            if path == PATH_BALANCE:
                return self._balance(ks)
            return self._chat(h, body or b'', ks)
        except Refusal as r:
            return self._refuse(r)

    # -- balance probe (no ledger row: no usage)
    def _balance(self, ks):
        resp = self._forward('GET', PATH_BALANCE, {'Authorization': 'Bearer ' + ks.key, 'Accept': 'application/json'}, b'', ks)
        if isinstance(resp, tuple) and len(resp) == 4:
            status, rh, rb, _ = resp
        else:
            return resp
        if status == 200:
            return status, {'Content-Type': 'application/json'}, redact_exact(rb, ks.key)
        return self._json(status, {'error': _error_for_status(status, rh, rb.decode('utf-8', 'replace'), ks.key)})

    def _forward(self, method, path, headers, body, ks):
        try:
            status, rh, rb = self.transport(method, UPSTREAM_HOST, UPSTREAM_PORT, path, headers, body, self.timeout)
        except (OSError, TimeoutError, http.client.HTTPException, ssl.SSLError) as e:
            self.log({'ev': 'upstream_unreachable', 'err': type(e).__name__, 'key_id': self.key_id})
            return self._json(502, {'error': {'rq_code': 'RQ_UPSTREAM_UNREACHABLE', 'rq_class': 'PROVIDER', 'message': type(e).__name__,
                                              'http_status': None, 'retry_after_s': None}})
        return status, rh, rb[:MAX_RESPONSE_BYTES], True

    # -- chat
    def _chat(self, h, raw, ks):
        purpose = h.get('x-rq-purpose')
        pcfg = self.cfg['purposes'].get(purpose) if purpose else None
        if pcfg is None or purpose not in self.key_purposes:
            raise Refusal(403, 'RQ_PURPOSE_REFUSED', message='purpose not available for this key')
        task_id = h.get('x-rq-task-id') or None
        if task_id is not None and not re.match(r'^[A-Za-z0-9._:\-]{1,128}$', task_id):
            raise Refusal(400, 'RQ_REQUEST_REFUSED', message='task id')
        if len(raw) > MAX_REQUEST_BYTES:
            raise Refusal(400, 'RQ_REQUEST_REFUSED', message='request too large')
        try:
            body = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise Refusal(400, 'RQ_REQUEST_REFUSED', message='not json')
        self._check_shape(body)
        if body['model'] not in pcfg['models']:
            raise Refusal(403, 'RQ_MODEL_REFUSED', message='model not allowed for this purpose')
        mt = body['max_tokens']
        if not (isinstance(mt, int) and not isinstance(mt, bool) and 0 < mt <= pcfg['max_tokens']):
            raise Refusal(400, 'RQ_MAX_TOKENS_REFUSED', message='max_tokens above the per-call ceiling or invalid')
        if pcfg['admission']:
            self._check_admission(h, body, purpose)
        if pcfg['requires_quality_gate']:
            self._check_quality_gate(h, task_id, purpose)
        now = self.clock()
        peak = not is_off_peak(now, self.cfg['peak'])
        if pcfg['peak_refused'] and peak:
            raise Refusal(403, 'RQ_PEAK_REFUSED', 'SCHEDULE', 'outside the off-peak schedule')
        fwd = json.dumps(body, sort_keys=False).encode('utf-8')
        resp = self._forward('POST', PATH_CHAT, {'Authorization': 'Bearer ' + ks.key, 'Content-Type': 'application/json', 'Accept': 'application/json'}, fwd, ks)
        if not (isinstance(resp, tuple) and len(resp) == 4):
            return resp
        status, rh, rb, _ = resp
        text = rb.decode('utf-8', 'replace')
        usage = None
        parsed_ok = True
        if status == 200:
            try:
                j = json.loads(text)
                usage = self._usage(j)
            except ValueError:
                parsed_ok = False
        hit = miss = out = reasoning = cny = usd = None
        if usage:
            hit, miss, out, reasoning = usage
            cny, usd = price_cost(self.cfg['price_table'], body['model'], peak, hit, miss, out)
        call_id = self.id_gen()
        self._record(call_id, now, purpose, task_id, body['model'], peak, status, hit, miss, out, reasoning, cny, usd, sha256_hex(raw), ks)
        self.log({'ev': 'call', 'call_id': call_id, 'key_id': self.key_id, 'purpose': purpose, 'http_status': status, 'peak': int(peak)})
        if status == 200 and parsed_ok:
            return 200, {'Content-Type': 'application/json'}, redact_exact(rb, ks.key)
        if status == 200:
            return self._json(502, {'error': {'rq_code': 'RQ_UPSTREAM_BAD_BODY', 'rq_class': 'PROVIDER', 'message': 'unreadable upstream body',
                                              'http_status': 200, 'retry_after_s': None}})
        err = _error_for_status(status, rh, text, ks.key)
        return self._json(status, {'error': err})

    @staticmethod
    def _usage(j):
        u = j.get('usage') if isinstance(j, dict) else None
        if not isinstance(u, dict):
            return None
        vals = [u.get('prompt_cache_hit_tokens'), u.get('prompt_cache_miss_tokens'), u.get('completion_tokens')]
        if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in vals):
            return None
        det = u.get('completion_tokens_details')
        r = det.get('reasoning_tokens') if isinstance(det, dict) else None
        if not (isinstance(r, int) and not isinstance(r, bool) and r >= 0):
            r = None
        return vals[0], vals[1], vals[2], r

    def _record(self, call_id, now, purpose, task_id, model, peak, status, hit, miss, out, reasoning, cny, usd, req_sha, ks):
        with self._lock, self._conn() as c:
            c.execute('INSERT INTO call VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                      (call_id, now.astimezone(CST).isoformat(timespec='seconds'), self.key_id, ks.fp12, purpose, task_id, model, int(peak), status,
                       hit, miss, out, reasoning, self.cfg['price_table']['id'], cny, usd, req_sha))

    # -- request checks
    @staticmethod
    def _check_shape(body):
        def bad(msg):
            raise Refusal(400, 'RQ_REQUEST_REFUSED', message=msg)
        if not isinstance(body, dict):
            bad('body must be an object')
        for k in body:
            if k not in REQUEST_KEYS:
                bad('field not allowed: %s' % str(k)[:40])
        for k in ('model', 'messages', 'max_tokens'):
            if k not in body:
                bad('missing field: %s' % k)
        if not isinstance(body['model'], str):
            bad('model')
        if 'stream' in body and body['stream'] is not False:
            bad('stream must be false')
        if 'response_format' in body and body['response_format'] != {'type': 'json_object'}:
            bad('response_format must be json_object')
        if 'temperature' in body:
            t = body['temperature']
            if isinstance(t, bool) or not isinstance(t, (int, float)) or not 0 <= t <= 2:
                bad('temperature')
        msgs = body['messages']
        if not isinstance(msgs, list) or not msgs:
            bad('messages')
        for m in msgs:
            if not (isinstance(m, dict) and set(m) == {'role', 'content'} and m['role'] in MESSAGE_ROLES and isinstance(m['content'], str)):
                bad('messages must be plain role/content strings')

    def _check_admission(self, h, body, purpose):
        want = h.get('x-rq-prompt-admission')
        first = body['messages'][0]
        if not (want and first['role'] == 'system' and sha256_hex(first['content']) == want and purpose in self.admitted.get(want, set())):
            raise Refusal(403, 'RQ_PROMPT_NOT_ADMITTED', message='system prompt is not an admitted prompt for this purpose')

    def _check_quality_gate(self, h, task_id, purpose):
        gid, raw = h.get('x-rq-quality-gate-id'), h.get('x-rq-quality-gate-record')
        if not gid or not raw:
            raise Refusal(403, 'RQ_QUALITY_GATE_MISSING', message='pro fallback needs a flash quality-gate record')
        invalid = Refusal(403, 'RQ_QUALITY_GATE_INVALID', message='quality-gate record failed verification')
        try:
            rec = json.loads(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)).decode('utf-8'))
        except (ValueError, binascii.Error, UnicodeDecodeError):
            raise invalid
        if not (isinstance(rec, dict) and rec.get('schema') == QUALITY_GATE_SCHEMA and rec.get('model') == FLASH_MODEL and task_id
                and rec.get('task_id') == task_id and isinstance(rec.get('kind'), str) and rec['kind']
                and rec.get('record_id') == gid and quality_gate_record_id(rec) == gid):
            raise invalid
        fails = rec.get('failures')
        if not isinstance(fails, list):
            raise invalid
        seen = set()
        for f in fails:
            ok = (isinstance(f, dict) and isinstance(f.get('attempt_no'), int) and not isinstance(f.get('attempt_no'), bool)
                  and isinstance(f.get('validator_codes'), list) and f['validator_codes'] and all(isinstance(x, str) and x for x in f['validator_codes'])
                  and isinstance(f.get('output_sha256'), str) and SHA64.match(f['output_sha256']))
            if not ok:
                raise invalid
            seen.add(f['attempt_no'])
        if len(seen) < 2:   # two failures on two distinct attempts
            raise invalid
        with self._conn() as c:
            used = c.execute('SELECT COUNT(*) FROM call WHERE purpose=? AND task_id=? AND http_status=200', (purpose, task_id)).fetchone()[0]
        if used:
            raise Refusal(403, 'RQ_QUALITY_GATE_USED', message='the one pro attempt for this task was already answered')


def redact_exact(raw, key):
    if key:
        return raw.replace(key.encode('utf-8'), b'[REDACTED]')
    return raw


class _Closing:
    def __init__(self, c):
        self.c = c

    def __enter__(self):
        return self.c

    def __exit__(self, *a):
        self.c.close()
        return False


# ---------------------------------------------------------------- transport (production)

def https_transport(method, host, port, path, headers, body, timeout):
    if host != UPSTREAM_HOST or port != UPSTREAM_PORT or path not in (PATH_CHAT, PATH_BALANCE):
        raise OSError('refused: not the DeepSeek chat API')
    conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ssl.create_default_context())
    try:
        conn.request(method, path, body=body if body else None, headers=headers)
        r = conn.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read(MAX_RESPONSE_BYTES + 1)
    finally:
        conn.close()


# ---------------------------------------------------------------- monthly spend view (display only)

def monthly_spend(db_path, key_id, month):
    """Per-key CST-month spend from the ledger, per purpose and in total. Nothing blocks on it."""
    if not re.match(r'^\d{4}-(0[1-9]|1[0-2])$', month):
        raise ValueError('month must be YYYY-MM')
    c = sqlite3.connect('file:%s?mode=ro' % db_path, uri=True, timeout=5.0)
    try:
        rows = c.execute(
            'SELECT purpose, COUNT(*), COALESCE(SUM(cny),0.0), COALESCE(SUM(usd),0.0), COALESCE(SUM(prompt_cache_hit_tokens),0), '
            'COALESCE(SUM(prompt_cache_miss_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(reasoning_tokens),0), '
            'SUM(CASE WHEN http_status=200 AND completion_tokens IS NULL THEN 1 ELSE 0 END), '
            'SUM(CASE WHEN completion_tokens IS NOT NULL AND cny IS NULL THEN 1 ELSE 0 END), '
            'SUM(CASE WHEN http_status<>200 THEN 1 ELSE 0 END) '
            'FROM call WHERE key_id=? AND substr(at,1,7)=? GROUP BY purpose ORDER BY purpose', (key_id, month)).fetchall()
    finally:
        c.close()
    names = ('calls', 'cny', 'usd', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'completion_tokens', 'reasoning_tokens',
             'unmetered_calls', 'price_unknown_calls', 'error_calls')
    by = {}
    total = {n: 0 for n in names}
    total['cny'] = total['usd'] = 0.0
    for r in rows:
        d = dict(zip(names, r[1:]))
        d = {k: (v or 0) for k, v in d.items()}
        by[r[0]] = d
        for n in names:
            total[n] += d[n]
    return {'schema': 'RQ_GATEWAY_MONTHLY_SPEND_V1', 'key_id': key_id, 'month': month, 'by_purpose': by, 'total': total}


# ---------------------------------------------------------------- unix socket server

def make_server(gateway, socket_path, mode=0o600):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *a):  # request lines carry no secrets, but the gateway logs through its own structured lines only
            pass

        def address_string(self):
            return 'unix'

        def _serve(self):
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                n = 0
            if n > MAX_REQUEST_BYTES:
                status, hdrs, body = gateway._refuse(Refusal(413, 'RQ_REQUEST_REFUSED', message='too large'))
                self.close_connection = True
            else:
                data = self.rfile.read(n) if n > 0 else b''
                status, hdrs, body = gateway.handle(self.command, self.path, dict(self.headers.items()), data)
            self.send_response(status)
            for k, v in hdrs.items():
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _serve

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    if os.path.exists(socket_path):
        if stat.S_ISSOCK(os.stat(socket_path).st_mode):
            os.unlink(socket_path)
        else:
            raise GatewayConfigError('socket path exists and is not a socket')
    old = os.umask(0o177)
    try:
        srv = Server(socket_path, Handler)
    finally:
        os.umask(old)
    os.chmod(socket_path, mode)
    return srv


# ---------------------------------------------------------------- command line

def _provider_from_config(cfg, key_id):
    k = cfg['keys'][key_id]
    src = k.get('source')
    if src == 'FILE':
        return FileKeyProvider(os.path.expanduser(k['path']), k['env_var'])
    if src == 'ENV':
        return EnvKeyProvider(os.environ, k['env_var'])
    raise GatewayConfigError('key %s has no source' % key_id)


def main(argv=None):
    ap = argparse.ArgumentParser(prog='rq_gateway.py')
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('serve')
    s.add_argument('--config', required=True)
    s.add_argument('--key-id', required=True)
    s.add_argument('--db', required=True)
    s.add_argument('--socket', required=True)
    s.add_argument('--socket-mode', default='0600')
    sp = sub.add_parser('spend')
    sp.add_argument('--db', required=True)
    sp.add_argument('--key-id', required=True)
    sp.add_argument('--month', required=True)
    c = sub.add_parser('check-config')
    c.add_argument('--config', required=True)
    a = ap.parse_args(argv)
    if a.cmd == 'spend':
        sys.stdout.write(json.dumps(monthly_spend(a.db, a.key_id, a.month), sort_keys=True) + '\n')
        return 0
    cfg = load_config(a.config)
    if a.cmd == 'check-config':
        sys.stdout.write('ok\n')
        return 0
    gw = Gateway(cfg, a.key_id, _provider_from_config(cfg, a.key_id), a.db)
    gw.announce()
    srv = make_server(gw, a.socket, int(a.socket_mode, 8))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
