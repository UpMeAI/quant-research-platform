#!/usr/bin/env python3
"""AUTONOMOUS_RESEARCH_QUEUE_V1 Q2: rq-deepseek-gateway tests (AQ-10/11/21/31/32/35/48 gateway side).

All upstream traffic is a stub transport; no network, no real key. The keys below are fake.
Run: python3 -m unittest services/rq-deepseek-gateway/test_rq_gateway.py  (or through tests/research_queue_gateway.test.js)
"""
import base64, hashlib, http.client, json, os, socket, sqlite3, stat, sys, tempfile, threading, unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rq_gateway as gw  # noqa: E402

CST = timezone(timedelta(hours=8))
FAKE_KEY = 'sk-' + 'a1b2c3d4e5f6' * 4  # fake, 51 chars
SYSTEM = 'You check evidence. Output only JSON.'
SYSTEM_SHA = hashlib.sha256(SYSTEM.encode()).hexdigest()
OFF_PEAK = datetime(2026, 11, 21, 10, 0, 0, tzinfo=CST)     # Saturday
PEAK = datetime(2026, 11, 23, 15, 0, 0, tzinfo=CST)         # Monday 15:00
PRICE = {
    'id': 'TEST_PRICE_TABLE', 'hit_priced_as_miss_when_null': True,
    'models': {
        'deepseek-flash': {'cny_per_m': {'off_peak': {'hit': 0.2, 'miss': 1.0, 'out': 4.0}, 'peak': {'hit': None, 'miss': None, 'out': None}},
                           'usd_per_m': {'off_peak': {'hit': 0.03, 'miss': 0.14, 'out': 0.56}, 'peak': {'hit': None, 'miss': None, 'out': None}}},
        'deepseek-v4-pro': {'cny_per_m': {'off_peak': {'hit': None, 'miss': 4.5, 'out': 13.5}, 'peak': {'hit': None, 'miss': None, 'out': None}},
                            'usd_per_m': {'off_peak': {'hit': None, 'miss': None, 'out': None}, 'peak': {'hit': None, 'miss': None, 'out': None}}},
    },
}


def make_config(key_id='LINUX_RESEARCH', admissions=None):
    return {
        'schema': 'RQ_DEEPSEEK_GATEWAY_CONFIG_V1',
        'upstream': {'host': 'api.deepseek.com', 'port': 443},
        'purposes': {
            'RQ_AGENT': {'models': ['deepseek-flash'], 'max_tokens': 4000, 'admission': True, 'peak_refused': True, 'requires_quality_gate': False},
            'RQ_AGENT_PRO_FALLBACK': {'models': ['deepseek-v4-pro'], 'max_tokens': 4000, 'admission': True, 'peak_refused': True, 'requires_quality_gate': True},
            'MINING_LLM': {'models': ['deepseek-v4-pro'], 'max_tokens': 16384, 'admission': False, 'peak_refused': False, 'requires_quality_gate': False},
        },
        'keys': {
            'LINUX_RESEARCH': {'purposes': ['RQ_AGENT', 'RQ_AGENT_PRO_FALLBACK', 'MINING_LLM']},
            'HK_REVIEW': {'purposes': ['RQ_AGENT', 'RQ_AGENT_PRO_FALLBACK']},
        },
        'peak': {'weekday_off_peak_cst': [['12:00', '14:00'], ['18:00', '24:00']], 'weekend_all_off_peak': True},
        'price_table': PRICE,
        'admissions': admissions if admissions is not None else [
            {'prompt_id': 'T-CHECK', 'kind': 'AI_CHECK', 'purposes': ['RQ_AGENT', 'RQ_AGENT_PRO_FALLBACK'], 'system_sha256': SYSTEM_SHA, 'state': 'ADMITTED'}],
    }


class Stub:
    """Stub transport: pops queued responses, records every call (host, port, path, headers, body)."""
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, host, port, path, headers, body, timeout):
        self.calls.append({'method': method, 'host': host, 'port': port, 'path': path, 'headers': dict(headers), 'body': body})
        r = self.responses.pop(0) if self.responses else ok_response()
        if isinstance(r, BaseException):
            raise r
        return r


def ok_response(hit=100, miss=900, out=200, reasoning=0, model='deepseek-flash', usage=True):
    d = {'id': 'x', 'model': model, 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': '{"ok":true}'}, 'finish_reason': 'stop'}]}
    if usage:
        d['usage'] = {'prompt_cache_hit_tokens': hit, 'prompt_cache_miss_tokens': miss, 'prompt_tokens': hit + miss,
                      'completion_tokens': out, 'completion_tokens_details': {'reasoning_tokens': reasoning}}
    return 200, {'content-type': 'application/json'}, json.dumps(d).encode()


def err_response(status, message='err', headers=None):
    return status, dict(headers or {}), json.dumps({'error': {'message': message, 'type': 'x'}}).encode()


def body_of(model='deepseek-flash', max_tokens=1000, **extra):
    b = {'model': model, 'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': '{"facts":[]}'}],
         'max_tokens': max_tokens, 'temperature': 0, 'response_format': {'type': 'json_object'}, 'stream': False}
    b.update(extra)
    return {k: v for k, v in b.items() if v is not None}


def hdrs(purpose='RQ_AGENT', task='RQT-LINUX-20261121-aaaa1111', sha=SYSTEM_SHA, **extra):
    h = {'X-RQ-Purpose': purpose, 'X-RQ-Task-Id': task, 'Content-Type': 'application/json'}
    if sha is not None:
        h['X-RQ-Prompt-Admission'] = sha
    h.update(extra)
    return h


def qg_record(task='RQT-LINUX-20261121-aaaa1111', failures=2, kind='AI_CHECK'):
    rec = {'schema': 'RQ_FLASH_QUALITY_GATE_RECORD_V1', 'task_id': task, 'kind': kind, 'model': 'deepseek-flash',
           'failures': [{'attempt_no': i + 1, 'validator_codes': ['CHECK_NOT_JSON'], 'output_sha256': hashlib.sha256(str(i).encode()).hexdigest()} for i in range(failures)]}
    rec['record_id'] = gw.quality_gate_record_id(rec)
    return rec


def qg_headers(rec):
    raw = json.dumps(rec, sort_keys=True).encode()
    return {'X-RQ-Quality-Gate-Id': rec['record_id'], 'X-RQ-Quality-Gate-Record': base64.urlsafe_b64encode(raw).decode()}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='rq-gw-test-')
        self.db = os.path.join(self.tmp, 'gateway.sqlite')
        self.logs = []
        self.now = OFF_PEAK
        self.seq = 0

    def make(self, transport=None, key=FAKE_KEY, key_id='LINUX_RESEARCH', config=None, provider=None):
        self.stub = transport or Stub()
        prov = provider or gw.StaticKeyProvider(key)
        return gw.Gateway(config or make_config(key_id), key_id=key_id, key_provider=prov, db_path=self.db, transport=self.stub,
                          clock=lambda: self.now, log=self.logs.append, id_gen=self._id)

    def _id(self):
        self.seq += 1
        return 'RQC-TEST-%04d' % self.seq

    def post(self, g, body=None, headers=None, path='/chat/completions', method='POST'):
        raw = json.dumps(body if body is not None else body_of()).encode()
        return g.handle(method, path, headers if headers is not None else hdrs(), raw)

    def rows(self):
        c = sqlite3.connect(self.db)
        c.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in c.execute('SELECT * FROM call ORDER BY at, call_id')]
        finally:
            c.close()

    @staticmethod
    def err(resp):
        return json.loads(resp[2])['error']


class TestAllowlist(Base):  # AQ-35
    def test_only_two_paths_and_methods(self):
        g = self.make()
        for method, path in [('GET', '/chat/completions'), ('POST', '/user/balance'), ('POST', '/v1/models'), ('GET', '/'), ('DELETE', '/chat/completions'),
                             ('POST', '/chat/completions/../x'), ('POST', '//api.example.com/chat/completions')]:
            s, _, b = g.handle(method, path, hdrs(), b'{}')
            self.assertIn(s, (404, 405), (method, path))
            self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_PATH_REFUSED' if s == 404 else 'RQ_METHOD_REFUSED')
        self.assertEqual(self.stub.calls, [])

    def test_forwards_only_to_api_deepseek_com_443(self):
        g = self.make()
        self.post(g)
        c = self.stub.calls[0]
        self.assertEqual((c['host'], c['port'], c['path'], c['method']), ('api.deepseek.com', 443, '/chat/completions', 'POST'))

    def test_upstream_host_in_config_must_be_deepseek(self):
        cfg = make_config()
        cfg['upstream']['host'] = 'api.example.com'
        with self.assertRaises(gw.GatewayConfigError):
            self.make(config=cfg)

    def test_model_outside_purpose_allowlist_refused(self):
        g = self.make()
        s, _, b = self.post(g, body_of(model='deepseek-v4-pro'))
        self.assertEqual((s, json.loads(b)['error']['rq_code']), (403, 'RQ_MODEL_REFUSED'))
        s, _, b = self.post(g, body_of(model='gpt-4o'))
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_MODEL_REFUSED')
        self.assertEqual(self.stub.calls, [])

    def test_unknown_purpose_and_missing_purpose_refused(self):
        g = self.make()
        for h in (hdrs(purpose='SOMETHING'), {k: v for k, v in hdrs().items() if k != 'X-RQ-Purpose'}):
            s, _, b = self.post(g, headers=h)
            self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_PURPOSE_REFUSED')

    def test_purpose_not_in_key_scope(self):  # the HK key's scope excludes mining
        g = self.make(key_id='HK_REVIEW')
        s, _, b = self.post(g, body_of(model='deepseek-v4-pro'), hdrs(purpose='MINING_LLM', sha=None))
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_PURPOSE_REFUSED')

    def test_peak_refused_for_agent_but_not_a_cap(self):
        g = self.make()
        self.now = PEAK
        s, _, b = self.post(g)
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_PEAK_REFUSED')
        self.assertEqual(self.stub.calls, [])
        self.now = datetime(2026, 11, 23, 12, 30, tzinfo=CST)   # weekday 12:00-14:00 off-peak
        self.assertEqual(self.post(g)[0], 200)
        self.now = datetime(2026, 11, 23, 18, 0, tzinfo=CST)
        self.assertEqual(self.post(g)[0], 200)
        self.now = datetime(2026, 11, 23, 14, 0, tzinfo=CST)
        self.assertEqual(json.loads(self.post(g)[2])['error']['rq_code'], 'RQ_PEAK_REFUSED')

    def test_mining_is_not_peak_refused_and_records_peak_flag(self):
        g = self.make()
        self.now = PEAK
        s, _, _ = self.post(g, body_of(model='deepseek-v4-pro', response_format=None), hdrs(purpose='MINING_LLM', sha=None))
        self.assertEqual(s, 200)
        self.assertEqual(self.rows()[0]['peak'], 1)


class TestRequestShape(Base):  # tool-less at the gateway too
    def test_body_keys_are_plain_completion_only(self):
        g = self.make()
        for extra in ({'tools': []}, {'tool_choice': 'auto'}, {'functions': []}, {'web_search': True}, {'files': ['x']}, {'url': 'http://x'},
                      {'stream': True}, {'top_k': 3}, {'n': 2}):
            s, _, b = self.post(g, body_of(**extra))
            self.assertEqual(s, 400, extra)
            self.assertIn(json.loads(b)['error']['rq_code'], ('RQ_REQUEST_REFUSED',), extra)
        self.assertEqual(self.stub.calls, [])

    def test_response_format_only_json_object(self):
        g = self.make()
        s, _, b = self.post(g, body_of(response_format={'type': 'json_schema'}))
        self.assertEqual(s, 400)

    def test_messages_plain_strings_only(self):
        g = self.make()
        bad = [[{'role': 'tool', 'content': 'x'}], [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': 'x'}]}],
               [{'role': 'user', 'content': 'x', 'tool_calls': []}], []]
        for m in bad:
            b = body_of()
            b['messages'] = m
            s, _, r = self.post(g, b)
            self.assertEqual(s, 400, m)

    def test_malformed_json_refused(self):
        g = self.make()
        s, _, b = g.handle('POST', '/chat/completions', hdrs(), b'{not json')
        self.assertEqual((s, json.loads(b)['error']['rq_code']), (400, 'RQ_REQUEST_REFUSED'))

    def test_client_authorization_header_never_forwarded(self):  # the gateway adds Authorization itself
        g = self.make()
        self.post(g, headers=hdrs(Authorization='Bearer sk-clientsupplied0000000000000000'))
        sent = {k.lower(): v for k, v in self.stub.calls[0]['headers'].items()}
        self.assertEqual(sent['authorization'], 'Bearer ' + FAKE_KEY)
        self.assertNotIn('x-rq-purpose', sent)
        self.assertNotIn('x-rq-prompt-admission', sent)


class TestRunawayGuardNoCostCap(Base):  # AQ-11
    def test_max_tokens_above_ceiling_refused(self):
        g = self.make()
        s, _, b = self.post(g, body_of(max_tokens=4001))
        self.assertEqual((s, json.loads(b)['error']['rq_code']), (400, 'RQ_MAX_TOKENS_REFUSED'))
        self.assertEqual(self.post(g, body_of(max_tokens=4000))[0], 200)
        s, _, b = self.post(g, body_of(model='deepseek-v4-pro', max_tokens=16385, response_format=None), hdrs(purpose='MINING_LLM', sha=None))
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_MAX_TOKENS_REFUSED')
        for bad in (0, -1, 'x', None, 1.5, True):
            b2 = body_of()
            b2['max_tokens'] = bad
            self.assertEqual(self.post(g, b2)[0], 400, bad)

    def test_no_spend_or_token_total_ever_refuses_or_waits(self):
        g = self.make(Stub(*[ok_response(hit=0, miss=10_000_000, out=5_000_000) for _ in range(6)]))
        for _ in range(6):
            self.assertEqual(self.post(g)[0], 200)
        total = sum(r['completion_tokens'] for r in self.rows())
        self.assertEqual(total, 30_000_000)

    def test_source_has_no_budget_state(self):
        src = open(os.path.join(HERE, 'rq_gateway.py'), encoding='utf-8').read()
        for needle in ('WAITING_BUDGET', 'MONTHLY_CAP', 'monthly_cap', 'spend_cap', 'token_cap', 'daily_cap'):
            self.assertNotIn(needle, src)


class TestPromptAdmission(Base):
    def test_header_missing_refused(self):
        g = self.make()
        s, _, b = self.post(g, headers=hdrs(sha=None))
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_PROMPT_NOT_ADMITTED')

    def test_header_must_equal_system_message_sha(self):
        g = self.make()
        s, _, b = self.post(g, headers=hdrs(sha='0' * 64))
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_PROMPT_NOT_ADMITTED')

    def test_changed_system_text_not_admitted(self):
        g = self.make()
        b = body_of()
        b['messages'][0]['content'] = SYSTEM + ' Also predict prices.'
        s, _, r = self.post(g, b, hdrs(sha=hashlib.sha256(b['messages'][0]['content'].encode()).hexdigest()))
        self.assertEqual(json.loads(r)['error']['rq_code'], 'RQ_PROMPT_NOT_ADMITTED')

    def test_admission_must_cover_the_purpose_and_be_admitted(self):
        adm = [{'prompt_id': 'T', 'kind': 'AI_CHECK', 'purposes': ['MINING_LLM'], 'system_sha256': SYSTEM_SHA, 'state': 'ADMITTED'}]
        g = self.make(config=make_config(admissions=adm))
        self.assertEqual(json.loads(self.post(g)[2])['error']['rq_code'], 'RQ_PROMPT_NOT_ADMITTED')
        adm = [{'prompt_id': 'T', 'kind': 'AI_CHECK', 'purposes': ['RQ_AGENT'], 'system_sha256': SYSTEM_SHA, 'state': 'PROPOSED'}]
        g = self.make(config=make_config(admissions=adm))
        self.assertEqual(json.loads(self.post(g)[2])['error']['rq_code'], 'RQ_PROMPT_NOT_ADMITTED')

    def test_first_message_must_be_system(self):
        g = self.make()
        b = body_of()
        b['messages'] = b['messages'][1:]
        self.assertEqual(json.loads(self.post(g, b)[2])['error']['rq_code'], 'RQ_PROMPT_NOT_ADMITTED')


class TestQualityGateGateway(Base):  # AQ-48 gateway side
    PRO = dict(model='deepseek-v4-pro')

    def pro(self, g, rec=None, task='RQT-LINUX-20261121-aaaa1111', with_headers=True):
        h = hdrs(purpose='RQ_AGENT_PRO_FALLBACK', task=task)
        if rec is not None and with_headers:
            h.update(qg_headers(rec))
        return self.post(g, body_of(**self.PRO), h)

    def test_pro_for_rq_agent_purpose_refused(self):
        g = self.make()
        s, _, b = self.post(g, body_of(**self.PRO))
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_MODEL_REFUSED')

    def test_pro_without_record_refused(self):
        g = self.make()
        s, _, b = self.pro(g)
        self.assertEqual((s, json.loads(b)['error']['rq_code']), (403, 'RQ_QUALITY_GATE_MISSING'))
        self.assertEqual(self.stub.calls, [])

    def test_pro_with_valid_record_forwarded_exactly_once(self):
        g = self.make()
        rec = qg_record()
        self.assertEqual(self.pro(g, rec)[0], 200)
        self.assertEqual(len(self.stub.calls), 1)
        self.assertEqual(json.loads(self.stub.calls[0]['body'])['model'], 'deepseek-v4-pro')
        s, _, b = self.pro(g, rec)
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_QUALITY_GATE_USED')
        self.assertEqual(len(self.stub.calls), 1)

    def test_failed_pro_call_without_answer_may_be_retried_but_answered_one_may_not(self):
        g = self.make(Stub(err_response(503), ok_response(model='deepseek-v4-pro')))
        rec = qg_record()
        self.assertEqual(self.pro(g, rec)[0], 503)
        self.assertEqual(self.pro(g, rec)[0], 200)
        self.assertEqual(self.pro(g, rec)[0], 403)

    def test_invalid_records_refused(self):
        g = self.make()
        one = qg_record(failures=1)
        dup = qg_record()
        dup['failures'][1]['attempt_no'] = 1
        dup['record_id'] = gw.quality_gate_record_id(dup)
        nocodes = qg_record()
        nocodes['failures'][0]['validator_codes'] = []
        nocodes['record_id'] = gw.quality_gate_record_id(nocodes)
        other = qg_record(task='RQT-LINUX-20261121-bbbb2222')
        forged = qg_record()
        forged['failures'][0]['output_sha256'] = 'f' * 64      # content changed, id kept
        wrongmodel = qg_record()
        wrongmodel['model'] = 'deepseek-v4-pro'
        wrongmodel['record_id'] = gw.quality_gate_record_id(wrongmodel)
        for name, rec in (('one', one), ('dup', dup), ('nocodes', nocodes), ('other-task', other), ('forged', forged), ('wrongmodel', wrongmodel)):
            s, _, b = self.pro(g, rec)
            self.assertEqual((s, json.loads(b)['error']['rq_code']), (403, 'RQ_QUALITY_GATE_INVALID'), name)
        bad_hdr = qg_headers(qg_record())
        bad_hdr['X-RQ-Quality-Gate-Id'] = 'QG-0000'
        h = hdrs(purpose='RQ_AGENT_PRO_FALLBACK')
        h.update(bad_hdr)
        self.assertEqual(json.loads(self.post(g, body_of(**self.PRO), h)[2])['error']['rq_code'], 'RQ_QUALITY_GATE_INVALID')
        self.assertEqual(self.stub.calls, [])

    def test_mining_llm_carries_pro_only(self):
        g = self.make()
        h = hdrs(purpose='MINING_LLM', sha=None)
        s, _, b = self.post(g, body_of(model='deepseek-flash', response_format=None), h)
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_MODEL_REFUSED')
        self.assertEqual(self.post(g, body_of(model='deepseek-v4-pro', response_format=None), h)[0], 200)


class TestLedger(Base):  # AQ-31
    def test_ddl_matches_frozen_call_table(self):
        self.make()
        c = sqlite3.connect(self.db)
        cols = [r[1] for r in c.execute('PRAGMA table_info(call)')]
        self.assertEqual(cols, ['call_id', 'at', 'key_id', 'key_fp12', 'purpose', 'task_id', 'model', 'peak', 'http_status', 'prompt_cache_hit_tokens',
                                'prompt_cache_miss_tokens', 'completion_tokens', 'reasoning_tokens', 'price_table', 'cny', 'usd', 'request_sha256'])
        self.assertEqual(c.execute('PRAGMA journal_mode').fetchone()[0].lower(), 'wal')
        self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual(c.execute("SELECT type FROM pragma_table_info('call') WHERE name='call_id'").fetchone()[0], 'TEXT')
        c.close()

    def test_one_row_per_forwarded_call_with_all_fields(self):
        resp = [ok_response(hit=100, miss=900, out=200, reasoning=30), ok_response(hit=0, miss=2000, out=500)]
        g = self.make(Stub(*resp))
        b1 = body_of()
        self.post(g, b1)
        self.now = OFF_PEAK + timedelta(minutes=5)
        self.post(g, body_of(max_tokens=900), hdrs(task='RQT-LINUX-20261121-cccc3333'))
        rows = self.rows()
        self.assertEqual(len(rows), 2)
        r = rows[0]
        self.assertEqual((r['key_id'], r['purpose'], r['task_id'], r['model'], r['peak'], r['http_status']),
                         ('LINUX_RESEARCH', 'RQ_AGENT', 'RQT-LINUX-20261121-aaaa1111', 'deepseek-flash', 0, 200))
        self.assertEqual((r['prompt_cache_hit_tokens'], r['prompt_cache_miss_tokens'], r['completion_tokens'], r['reasoning_tokens']), (100, 900, 200, 30))
        self.assertEqual(r['key_fp12'], hashlib.sha256(FAKE_KEY.encode()).hexdigest()[:12])
        self.assertEqual(r['price_table'], 'TEST_PRICE_TABLE')
        self.assertEqual(r['request_sha256'], hashlib.sha256(json.dumps(b1).encode()).hexdigest())
        self.assertTrue(r['at'].endswith('+08:00'))
        self.assertAlmostEqual(r['cny'], (100 * 0.2 + 900 * 1.0 + 200 * 4.0) / 1e6, places=9)
        self.assertAlmostEqual(r['usd'], (100 * 0.03 + 900 * 0.14 + 200 * 0.56) / 1e6, places=9)
        self.assertEqual(rows[1]['prompt_cache_miss_tokens'], 2000)

    def test_sums_and_month_view_match_the_stub_responses(self):
        specs = [(100, 900, 200), (0, 500, 100), (50, 50, 50)]
        g = self.make(Stub(*[ok_response(hit=h, miss=m, out=o) for h, m, o in specs]))
        for i in range(3):
            self.now = OFF_PEAK + timedelta(hours=i)
            self.post(g)
        expect = sum((h * 0.2 + m * 1.0 + o * 4.0) / 1e6 for h, m, o in specs)
        v = gw.monthly_spend(self.db, 'LINUX_RESEARCH', '2026-11')
        self.assertAlmostEqual(v['total']['cny'], expect, places=9)
        self.assertEqual(v['total']['calls'], 3)
        self.assertEqual(v['total']['completion_tokens'], 350)
        self.assertAlmostEqual(v['by_purpose']['RQ_AGENT']['cny'], expect, places=9)
        self.assertEqual(v['key_id'], 'LINUX_RESEARCH')
        self.assertEqual(v['month'], '2026-11')
        self.assertEqual(gw.monthly_spend(self.db, 'LINUX_RESEARCH', '2026-12')['total']['calls'], 0)
        self.assertEqual(gw.monthly_spend(self.db, 'HK_REVIEW', '2026-11')['total']['calls'], 0)

    def test_month_boundary_is_cst(self):
        g = self.make(Stub(ok_response(), ok_response()))
        self.now = datetime(2026, 11, 30, 23, 59, tzinfo=CST)
        self.post(g)
        self.now = datetime(2026, 12, 1, 0, 1, tzinfo=CST)
        self.post(g)
        self.assertEqual(gw.monthly_spend(self.db, 'LINUX_RESEARCH', '2026-11')['total']['calls'], 1)
        self.assertEqual(gw.monthly_spend(self.db, 'LINUX_RESEARCH', '2026-12')['total']['calls'], 1)

    def test_spend_by_purpose_includes_pro_fallback_and_mining(self):
        g = self.make(Stub(ok_response(), ok_response(model='deepseek-v4-pro'), ok_response(model='deepseek-v4-pro')))
        self.post(g)
        self.post(g, body_of(model='deepseek-v4-pro'), {**hdrs(purpose='RQ_AGENT_PRO_FALLBACK'), **qg_headers(qg_record())})
        self.post(g, body_of(model='deepseek-v4-pro', response_format=None), hdrs(purpose='MINING_LLM', sha=None))
        v = gw.monthly_spend(self.db, 'LINUX_RESEARCH', '2026-11')
        self.assertEqual(sorted(v['by_purpose']), ['MINING_LLM', 'RQ_AGENT', 'RQ_AGENT_PRO_FALLBACK'])
        self.assertAlmostEqual(v['total']['cny'], sum(p['cny'] for p in v['by_purpose'].values()), places=12)

    def test_missing_usage_is_unmetered_not_zero(self):
        g = self.make(Stub(ok_response(usage=False)))
        self.assertEqual(self.post(g)[0], 200)
        r = self.rows()[0]
        for k in ('prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'completion_tokens', 'reasoning_tokens', 'cny', 'usd'):
            self.assertIsNone(r[k], k)
        v = gw.monthly_spend(self.db, 'LINUX_RESEARCH', '2026-11')
        self.assertEqual((v['total']['calls'], v['total']['unmetered_calls']), (1, 1))

    def test_unknown_price_row_gives_null_cost_and_is_counted(self):
        g = self.make(Stub(ok_response(model='deepseek-v4-pro')))
        self.now = PEAK
        self.post(g, body_of(model='deepseek-v4-pro', response_format=None), hdrs(purpose='MINING_LLM', sha=None))
        r = self.rows()[0]
        self.assertIsNone(r['cny'])
        self.assertEqual(gw.monthly_spend(self.db, 'LINUX_RESEARCH', '2026-11')['total']['price_unknown_calls'], 1)

    def test_hit_tokens_priced_as_miss_only_when_hit_price_is_null(self):
        g = self.make(Stub(ok_response(hit=1000, miss=0, out=0, model='deepseek-v4-pro')))
        self.post(g, body_of(model='deepseek-v4-pro', response_format=None), hdrs(purpose='MINING_LLM', sha=None))
        self.assertAlmostEqual(self.rows()[0]['cny'], 1000 * 4.5 / 1e6, places=12)

    def test_refused_requests_write_no_row(self):
        g = self.make()
        self.post(g, body_of(max_tokens=99999))
        self.post(g, body_of(model='x'))
        self.assertEqual(self.rows(), [])


class TestErrorClasses(Base):  # AQ-10 gateway side
    def check(self, resp, status, rq_class, rq_code):
        g = self.make(Stub(resp))
        s, h, b = self.post(g)
        e = json.loads(b)['error']
        self.assertEqual((s, e['rq_class'], e['rq_code']), (status, rq_class, rq_code))
        return g, e

    def test_401_credential(self):
        self.check(err_response(401, 'Authentication Fails'), 401, 'CREDENTIAL', 'RQ_UPSTREAM_AUTH')

    def test_403_credential(self):
        self.check(err_response(403), 403, 'CREDENTIAL', 'RQ_UPSTREAM_AUTH')

    def test_402_quota(self):
        self.check(err_response(402, 'Insufficient Balance'), 402, 'QUOTA', 'RQ_UPSTREAM_QUOTA')

    def test_429_provider_with_retry_after(self):
        g, e = self.check(err_response(429, 'rate', {'Retry-After': '17'}), 429, 'PROVIDER', 'RQ_UPSTREAM_RATE')
        self.assertEqual(e['retry_after_s'], 17)

    def test_5xx_provider(self):
        for st in (500, 502, 503, 504):
            self.check(err_response(st), st, 'PROVIDER', 'RQ_UPSTREAM_5XX')

    def test_400_422_deterministic(self):
        for st in (400, 422):
            self.check(err_response(st), st, 'DETERMINISTIC', 'RQ_UPSTREAM_INVALID')

    def test_timeout_and_network_error_are_provider(self):
        for exc in (TimeoutError('t'), ConnectionResetError('r'), OSError('o')):
            g = self.make(Stub(exc))
            s, _, b = self.post(g)
            e = json.loads(b)['error']
            self.assertEqual((e['rq_class'], e['rq_code']), ('PROVIDER', 'RQ_UPSTREAM_UNREACHABLE'))
            self.assertEqual(self.rows(), [])   # no response, no usage: no row

    def test_error_responses_write_a_row_with_status_and_null_usage(self):
        g = self.make(Stub(err_response(402)))
        self.post(g)
        r = self.rows()[0]
        self.assertEqual(r['http_status'], 402)
        self.assertIsNone(r['completion_tokens'])

    def test_no_blind_retry(self):
        g = self.make(Stub(err_response(500), ok_response()))
        self.post(g)
        self.assertEqual(len(self.stub.calls), 1)

    def test_every_gateway_refusal_is_a_deterministic_class(self):
        g = self.make()
        s, _, b = self.post(g, body_of(model='x'))
        self.assertEqual(json.loads(b)['error']['rq_class'], 'DETERMINISTIC')


class TestKeyHandling(Base):  # AQ-21, AQ-32, AQ-33 (code side)
    def write_key_file(self, text, mode=0o600, name='deepseek-research.env'):
        p = os.path.join(self.tmp, name)
        with open(p, 'w') as f:
            f.write(text)
        os.chmod(p, mode)
        return p

    def test_keyless_gateway_answers_credential_absent_without_forwarding(self):
        g = self.make(provider=gw.StaticKeyProvider(None))
        s, _, b = self.post(g)
        e = json.loads(b)['error']
        self.assertEqual((e['rq_code'], e['rq_class']), ('RQ_CREDENTIAL_ABSENT', 'CREDENTIAL'))
        self.assertEqual(self.stub.calls, [])
        self.assertEqual(self.rows(), [])
        s, _, b = self.post(g, path='/user/balance', method='GET', body={})
        self.assertEqual(json.loads(b)['error']['rq_code'], 'RQ_CREDENTIAL_ABSENT')

    def test_file_provider_missing_then_restored_resumes_without_restart(self):
        p = os.path.join(self.tmp, 'k.env')
        g = self.make(provider=gw.FileKeyProvider(p, 'DEEPSEEK_RESEARCH_API_KEY'))
        self.assertEqual(json.loads(self.post(g)[2])['error']['rq_code'], 'RQ_CREDENTIAL_ABSENT')
        self.write_key_file('DEEPSEEK_RESEARCH_API_KEY=%s\n' % FAKE_KEY, name='k.env')
        self.assertEqual(self.post(g)[0], 200)
        self.assertEqual(self.stub.calls[0]['headers']['Authorization'], 'Bearer ' + FAKE_KEY)

    def test_file_provider_refuses_open_modes_and_wrong_var_and_directories(self):
        for mode in (0o644, 0o640, 0o604):
            p = self.write_key_file('DEEPSEEK_RESEARCH_API_KEY=%s\n' % FAKE_KEY, mode=mode, name='m%o' % mode)
            self.assertIsNone(gw.FileKeyProvider(p, 'DEEPSEEK_RESEARCH_API_KEY').get().key, mode)
        p = self.write_key_file('OTHER=%s\n' % FAKE_KEY, name='wrongvar')
        self.assertIsNone(gw.FileKeyProvider(p, 'DEEPSEEK_RESEARCH_API_KEY').get().key)
        self.assertIsNone(gw.FileKeyProvider(self.tmp, 'DEEPSEEK_RESEARCH_API_KEY').get().key)
        p = self.write_key_file('DEEPSEEK_RESEARCH_API_KEY=notakey\n', name='short')
        self.assertIsNone(gw.FileKeyProvider(p, 'DEEPSEEK_RESEARCH_API_KEY').get().key)

    def test_file_provider_reads_a_0400_file_and_changed_sha_is_noticed(self):
        p = self.write_key_file('DEEPSEEK_RESEARCH_API_KEY=%s\n' % FAKE_KEY, mode=0o400)
        prov = gw.FileKeyProvider(p, 'DEEPSEEK_RESEARCH_API_KEY')
        st = prov.get()
        self.assertEqual(st.key, FAKE_KEY)
        self.assertEqual(st.fp12, hashlib.sha256(FAKE_KEY.encode()).hexdigest()[:12])
        os.chmod(p, 0o600)
        key2 = 'sk-' + 'z9y8x7w6v5u4' * 4
        with open(p, 'w') as f:
            f.write('DEEPSEEK_RESEARCH_API_KEY="%s"\n' % key2)
        self.assertEqual(prov.get().key, key2)

    def test_env_provider(self):
        self.assertEqual(gw.EnvKeyProvider({'DEEPSEEK_REVIEW_API_KEY': FAKE_KEY}, 'DEEPSEEK_REVIEW_API_KEY').get().key, FAKE_KEY)
        self.assertIsNone(gw.EnvKeyProvider({}, 'DEEPSEEK_REVIEW_API_KEY').get().key)
        self.assertIsNone(gw.EnvKeyProvider({'DEEPSEEK_REVIEW_API_KEY': 'short'}, 'DEEPSEEK_REVIEW_API_KEY').get().key)

    def test_key_never_in_log_response_or_ledger_even_when_upstream_echoes_it(self):
        echo = 'bad key %s / Bearer %s / sk-****%s / tail %s' % (FAKE_KEY, FAKE_KEY, FAKE_KEY[-8:], FAKE_KEY[-6:])
        g = self.make(Stub(err_response(401, echo), ok_response()))
        s, _, b = self.post(g)
        self.assertNotIn(FAKE_KEY.encode(), b)
        self.assertNotIn(FAKE_KEY[-6:].encode(), b)
        self.assertNotIn(b'sk-****', b)
        self.post(g)
        for line in self.logs:
            self.assertNotIn(FAKE_KEY, str(line))
            self.assertNotIn(FAKE_KEY[-6:], str(line))
        with open(self.db, 'rb') as f:
            self.assertNotIn(FAKE_KEY.encode(), f.read())
        for ext in ('-wal', '-shm'):
            if os.path.exists(self.db + ext):
                with open(self.db + ext, 'rb') as f:
                    self.assertNotIn(FAKE_KEY.encode(), f.read())

    def test_startup_log_names_the_fingerprint_only(self):
        g = self.make()
        g.announce()
        text = ' '.join(str(x) for x in self.logs)
        self.assertIn(hashlib.sha256(FAKE_KEY.encode()).hexdigest()[:12], text)
        self.assertNotIn(FAKE_KEY, text)

    def test_balance_probe_forwards_get_and_writes_no_row(self):
        bal = (200, {}, json.dumps({'is_available': True, 'balance_infos': []}).encode())
        g = self.make(Stub(bal))
        s, _, b = g.handle('GET', '/user/balance', {}, b'')
        self.assertEqual((s, json.loads(b)['is_available']), (200, True))
        c = self.stub.calls[0]
        self.assertEqual((c['method'], c['host'], c['port'], c['path']), ('GET', 'api.deepseek.com', 443, '/user/balance'))
        self.assertEqual(self.rows(), [])

    def test_repr_of_provider_state_hides_the_key(self):
        st = gw.StaticKeyProvider(FAKE_KEY).get()
        self.assertNotIn(FAKE_KEY, repr(st))
        self.assertNotIn(FAKE_KEY, str(st))

    def test_source_never_prints_or_logs_the_key_variable(self):
        src = open(os.path.join(HERE, 'rq_gateway.py'), encoding='utf-8').read()
        self.assertNotIn('print(', src)


class TestShippedConfig(Base):
    def test_shipped_config_loads_and_matches_spec(self):
        path = os.path.join(HERE, '..', '..', 'config', 'rq_deepseek_gateway.v1.json')
        cfg = gw.load_config(path)
        self.assertEqual(cfg['upstream']['host'], 'api.deepseek.com')
        self.assertEqual(cfg['purposes']['RQ_AGENT']['models'], ['deepseek-flash'])
        self.assertEqual(cfg['purposes']['RQ_AGENT_PRO_FALLBACK']['models'], ['deepseek-v4-pro'])
        self.assertEqual(cfg['purposes']['MINING_LLM']['models'], ['deepseek-v4-pro'])
        self.assertEqual(cfg['purposes']['RQ_AGENT']['max_tokens'], 4000)
        self.assertEqual(sorted(cfg['keys']), ['HK_REVIEW', 'LINUX_RESEARCH'])
        self.assertNotIn('MINING_LLM', cfg['keys']['HK_REVIEW']['purposes'])
        self.assertEqual(cfg['price_table']['id'], 'DEEPSEEK_PRICE_TABLE_V1')


class TestSocketServer(Base):
    def test_roundtrip_over_unix_socket(self):
        g = self.make(Stub(ok_response()))
        sock = os.path.join(self.tmp, 'rq-gw.sock')
        srv = gw.make_server(g, sock)
        self.assertEqual(stat.S_IMODE(os.stat(sock).st_mode), 0o600)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            class UConn(http.client.HTTPConnection):
                def connect(self_inner):
                    self_inner.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    self_inner.sock.connect(sock)
            c = UConn('localhost')
            c.request('POST', '/chat/completions', body=json.dumps(body_of()), headers=hdrs())
            r = c.getresponse()
            self.assertEqual(r.status, 200)
            self.assertEqual(json.loads(r.read())['usage']['completion_tokens'], 200)
            c2 = UConn('localhost')
            c2.request('GET', '/etc/passwd')
            self.assertEqual(c2.getresponse().status, 404)
        finally:
            srv.shutdown()
            srv.server_close()
        self.assertEqual(len(self.rows()), 1)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--list':
        loader = unittest.TestLoader()
        def walk(s):
            for t in s:
                if isinstance(t, unittest.TestSuite):
                    yield from walk(t)
                else:
                    yield t.id()
        for tid in walk(loader.loadTestsFromModule(sys.modules[__name__])):
            print('test_rq_gateway.' + tid.replace('__main__.', ''))
        sys.exit(0)
    unittest.main()
