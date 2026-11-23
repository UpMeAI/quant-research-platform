#!/usr/bin/env node
'use strict';

/**
 * AUTONOMOUS_RESEARCH_QUEUE_V1 Q2 的变异检查：对网关与代理的每一道护栏各做一个小改动（让它失效），核对测试一定变红。变红 = 杀死；仍然全绿 = 幸存（护栏没人测，要补测试，或说明它是等价变异）。
 *   node tools/rq-gateway-agent-mutation-check.js [--only G01,K03] [--write docs/evidence/rq-gateway-agent-mutation-v1/MUTATION_RESULTS.json [--merge]]
 * 先跑一遍没改动的基线（必须全绿），再逐个变异：改文件 → 跑对应的测试（Python 的直接 python3 -B，Node 的 node --test；第一个变红就停）→ 无论如何都还原文件。
 * 在 Mac 上用 ~/bin/heavy-run --light --label aq-q2 -- node tools/rq-gateway-agent-mutation-check.js 跑。
 * 只改仓库里的源文件与配置，不连网络、不读密钥；被改的文件有未提交的改动时拒绝跑（还原用的是内存里的原文，不是 git）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PY = 'services/rq-deepseek-gateway/test_rq_gateway.py';
const VAL = 'tests/research_queue_validators.test.js';
const W21 = 'tests/factor_idea_mining_space.test.js';
const AGT = 'tests/research_queue_agent.test.js';
const GW = 'services/rq-deepseek-gateway/rq_gateway.py';
const D = 'services/research-queue-agent';
const CHK = `${D}/check-report.js`, CARD = `${D}/card.js`, FI = `${D}/factor-idea.js`, FACTS = `${D}/facts.js`, TR = `${D}/text-rules.js`, LEX = `${D}/lexicon.js`;
const ROUT = `${D}/routing.js`, AG = `${D}/agent.js`, SEAM = `${D}/queue-seam.js`, GC = `${D}/gateway-client.js`, CLI = `${D}/cli.js`, STUB = `${D}/mechanism-admission-stub.js`;
const CFG = 'config/rq_deepseek_gateway.v1.json';
const HKAG = 'deploy/research-queue-ai/hk/rq-agent.service';
const RUN = 'deploy/research-queue-ai/linux/run-agent.sh';

const m = (id, guard, file, find, replace, tests) => ({ id, guard, file, find, replace, tests });
const MUTANTS = [
  // ---- gateway
  m('G01', 'only the two paths are served', GW, "if path not in (PATH_CHAT, PATH_BALANCE):", 'if False:', [PY]),
  m('G02', 'method must match the path', GW, "if method != ('POST' if path == PATH_CHAT else 'GET'):", 'if False:', [PY]),
  m('G03', 'a keyless gateway answers RQ_CREDENTIAL_ABSENT', GW, "            if ks.key is None:\n                raise Refusal(503, 'RQ_CREDENTIAL_ABSENT', 'CREDENTIAL', 'key not available: %s' % ks.reason)\n", '', [PY]),
  m('G04', 'purpose must be in the key scope', GW, 'if pcfg is None or purpose not in self.key_purposes:', 'if pcfg is None:', [PY]),
  m('G05', 'request body keys are whitelisted', GW, "            if k not in REQUEST_KEYS:\n                bad('field not allowed: %s' % str(k)[:40])", '            pass', [PY]),
  m('G06', 'stream must be false', GW, "if 'stream' in body and body['stream'] is not False:", 'if False:', [PY]),
  m('G07', 'response_format only json_object', GW, "if 'response_format' in body and body['response_format'] != {'type': 'json_object'}:", 'if False:', [PY]),
  m('G08', 'messages are plain role/content strings', GW, "if not (isinstance(m, dict) and set(m) == {'role', 'content'} and m['role'] in MESSAGE_ROLES and isinstance(m['content'], str)):", 'if False:', [PY]),
  m('G09', 'model allowlist per purpose', GW, "if body['model'] not in pcfg['models']:", 'if False:', [PY]),
  m('G10', 'max_tokens ceiling per purpose', GW, "0 < mt <= pcfg['max_tokens']", '0 < mt', [PY]),
  m('G11', 'admission: header equals the system message sha', GW, "sha256_hex(first['content']) == want and ", '', [PY]),
  m('G12', 'admission: the entry covers the purpose', GW, ' and purpose in self.admitted.get(want, set())):', '):', [PY]),
  m('G13', 'admission: only ADMITTED entries count', GW, "if e.get('state') == 'ADMITTED' and SHA64.match", 'if SHA64.match', [PY]),
  m('G14', 'admission: first message is the system message', GW, "first['role'] == 'system' and ", '', [PY]),
  m('G15', 'the pro purpose needs a quality-gate record', GW, "if pcfg['requires_quality_gate']:", 'if False:', [PY]),
  m('G16', 'quality gate: record id is the hash of the record', GW, ' and quality_gate_record_id(rec) == gid):', '):', [PY]),
  m('G17', 'quality gate: record belongs to this task', GW, "and rec.get('task_id') == task_id and isinstance(rec.get('kind'), str)", "and isinstance(rec.get('kind'), str)", [PY]),
  m('G19', 'quality gate: two failures on two distinct attempts', GW, '        if len(seen) < 2:', '        if False:', [PY]),
  m('G20', 'quality gate: each failure carries validator codes', GW, "f['validator_codes'] and all(", 'all(', [PY]),
  m('G21', 'quality gate: the failed model is flash', GW, "rec.get('model') == FLASH_MODEL and task_id", 'task_id', [PY]),
  m('G22', 'quality gate: used at most once per task', GW, '        if used:', '        if False:', [PY]),
  m('G23', 'quality gate: only an answered pro call counts as used', GW, " AND http_status=200', (purpose, task_id))", "', (purpose, task_id))", [PY]),
  m('G24', 'peak refusal for agent purposes', GW, "if pcfg['peak_refused'] and peak:", 'if False:', [PY]),
  m('G25', 'weekends are off-peak', GW, "if now.weekday() >= 5 and peak_cfg.get('weekend_all_off_peak'):", 'if False:', [PY]),
  m('G26', 'config: upstream must be api.deepseek.com:443', GW, "need(up.get('host') == UPSTREAM_HOST and up.get('port') == UPSTREAM_PORT,", 'need(True,', [PY]),
  m('G27', 'production transport refuses other hosts and paths', GW, "if host != UPSTREAM_HOST or port != UPSTREAM_PORT or path not in (PATH_CHAT, PATH_BALANCE):", 'if False:', [PY]),
  m('G28', 'key file must not be open to group or others', GW, 'if st.st_mode & 0o077:', 'if False:', [PY]),
  m('G29', 'a key must look like a key (sk-, length, no whitespace)', GW, "return isinstance(key, str) and key.startswith('sk-') and len(key) >= 30 and not re.search(r'\\s', key)", 'return isinstance(key, str)', [PY]),
  m('G30', 'redaction: masked sk- echoes', GW, "    text = re.sub(r'sk-[A-Za-z0-9*._\\-]{4,}', '[REDACTED]', text)\n", '', [PY]),
  m('G31', 'redaction: key suffix echoes', GW, "        for n in range(16, 3, -1):\n            text = text.replace(key[-n:], '[REDACTED]')\n", '', [PY]),
  m('G32', 'redaction: other bearer tokens', GW, "    text = re.sub(r'(?i)bearer\\s+\\S+', 'Bearer [REDACTED]', text)\n", '', [PY]),
  m('G33', 'upstream error messages are redacted', GW, 'msg = redact(msg, key)[:300]', 'msg = msg[:300]', [PY]),
  m('G34', 'success bodies are scrubbed of the exact key', GW, "return 200, {'Content-Type': 'application/json'}, redact_exact(rb, ks.key)\n        if status == 200:", "return 200, {'Content-Type': 'application/json'}, rb\n        if status == 200:", [PY]),
  m('G35', 'the start-up log never carries the key', GW, "'key_fp12': st.fp12, 'reason': st.reason", "'key_fp12': st.fp12, 'key': st.key, 'reason': st.reason", [PY]),
  m('G36', 'call log lines never carry the key', GW, "'http_status': status, 'peak': int(peak)})", "'http_status': status, 'peak': int(peak), 'key': ks.key})", [PY]),
  m('G37', 'the ledger records key_fp12', GW, 'self.key_id, ks.fp12, purpose, task_id, model', 'self.key_id, None, purpose, task_id, model', [PY]),
  m('G38', 'one row per provider response, errors included', GW, "        self._record(call_id, now, purpose, task_id, body['model'], peak, status, hit, miss, out, reasoning, cny, usd, sha256_hex(raw), ks)",
    "        if status == 200:\n            self._record(call_id, now, purpose, task_id, body['model'], peak, status, hit, miss, out, reasoning, cny, usd, sha256_hex(raw), ks)", [PY]),
  m('G39', 'usage must be complete or the call is unmetered', GW, 'if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in vals):', 'if False:', [PY]),
  m('G40', 'a null cache-hit price is priced as a miss (upper bound)', GW, "if ph is None and table.get('hit_priced_as_miss_when_null'):", 'if False:', [PY]),
  m('G41', 'an unknown price row gives a null cost, never zero', GW, 'if pm is None or po is None or ph is None:', 'if False:', [PY]),
  m('G42', 'month view: CST month filter', GW, 'substr(at,1,7)=?', 'substr(at,1,7)>=?', [PY]),
  m('G43', 'month view: per key', GW, 'WHERE key_id=? AND', 'WHERE ?<>"" AND', [PY]),
  m('G44', 'month view: unmetered calls are counted', GW, 'SUM(CASE WHEN http_status=200 AND completion_tokens IS NULL THEN 1 ELSE 0 END)', '0', [PY]),
  m('G45', 'transport failures map to the provider class', GW, 'except (OSError, TimeoutError, http.client.HTTPException, ssl.SSLError) as e:', 'except ZeroDivisionError as e:', [PY]),
  m('G46', '402 is a quota wait', GW, "code, cls = 'RQ_UPSTREAM_QUOTA', 'QUOTA'", "code, cls = 'RQ_UPSTREAM_QUOTA', 'PROVIDER'", [PY]),
  m('G47', '401/403 are credential', GW, "code, cls = 'RQ_UPSTREAM_AUTH', 'CREDENTIAL'", "code, cls = 'RQ_UPSTREAM_AUTH', 'PROVIDER'", [PY]),
  m('G48', '429 is a provider rate limit, not a block', GW, "code, cls = 'RQ_UPSTREAM_RATE', 'PROVIDER'", "code, cls = 'RQ_UPSTREAM_RATE', 'DETERMINISTIC'", [PY]),
  m('G49', '5xx is provider', GW, "code, cls = 'RQ_UPSTREAM_5XX', 'PROVIDER'", "code, cls = 'RQ_UPSTREAM_5XX', 'DETERMINISTIC'", [PY]),
  m('G50', '400/422 are deterministic', GW, "code, cls = 'RQ_UPSTREAM_INVALID', 'DETERMINISTIC'", "code, cls = 'RQ_UPSTREAM_INVALID', 'PROVIDER'", [PY]),
  m('G51', 'Retry-After is passed on', GW, 'ra = int(str(v).strip())', 'ra = None', [PY]),
  m('G52', 'no blind retry of a failed call', GW, '            status, rh, rb = self.transport(method, UPSTREAM_HOST, UPSTREAM_PORT, path, headers, body, self.timeout)\n',
    '            status, rh, rb = self.transport(method, UPSTREAM_HOST, UPSTREAM_PORT, path, headers, body, self.timeout)\n            if status >= 500:\n                status, rh, rb = self.transport(method, UPSTREAM_HOST, UPSTREAM_PORT, path, headers, body, self.timeout)\n', [PY]),
  m('G53', 'the ledger table is the frozen DDL', GW, 'cny REAL, usd REAL, request_sha256 TEXT)', 'cny REAL, usd REAL)', [PY]),
  m('G54', 'the ledger is WAL', GW, "c.execute('PRAGMA journal_mode=WAL')", 'pass', [PY]),
  m('G55', 'the ledger is synchronous FULL', GW, "c.execute('PRAGMA synchronous=FULL')", "c.execute('PRAGMA synchronous=NORMAL')", [PY]),
  m('G56', 'shipped config: the agent purpose is flash only', CFG, '"RQ_AGENT": { "models": ["deepseek-flash"]', '"RQ_AGENT": { "models": ["deepseek-flash", "deepseek-v4-pro"]', [PY]),
  m('G57', 'shipped config: the HK key has no mining scope', CFG, '"purposes": ["RQ_AGENT", "RQ_AGENT_PRO_FALLBACK"],\n      "source": "ENV"', '"purposes": ["RQ_AGENT", "RQ_AGENT_PRO_FALLBACK", "MINING_LLM"],\n      "source": "ENV"', [PY]),
  m('G58', 'shipped config: agent max_tokens ceiling 4000', CFG, '"max_tokens": 4000, "admission": true, "peak_refused": true, "requires_quality_gate": false', '"max_tokens": 9000, "admission": true, "peak_refused": true, "requires_quality_gate": false', [PY]),
  // ---- text rules and facts
  m('F01', 'check report: JSON object required', CHK, "if (!isObj(r)) { add('CHECK_NOT_JSON')", "if (false) { add('CHECK_NOT_JSON')", [VAL]),
  m('F02', 'check report: exact keys', CHK, 'if (!sameKeys(r, KEYS)) {', 'if (false) {', [VAL]),
  m('F03', 'check report: verdict enum', CHK, "if (!VERDICTS.includes(r.verdict)) add('CHECK_VERDICT_INVALID');", '', [VAL]),
  m('F04', 'check report: item keys', CHK, 'if (!isObj(it) || !sameKeys(it, ITEM_KEYS) ||', 'if (!isObj(it) ||', [VAL]),
  m('F05', 'check report: status enum', CHK, "if (!STATUSES.includes(it.status)) add('CHECK_ITEM_STATUS_INVALID', path, it.status);", '', [VAL]),
  m('F06', 'check report: unknown req_id', CHK, "if (!matrix.has(it.req_id)) add('CHECK_REQ_UNKNOWN', path, it.req_id);", "if (false) add('CHECK_REQ_UNKNOWN', path, it.req_id);", [VAL]),
  m('F07', 'check report: duplicate req_id', CHK, "else if (seenReq.has(it.req_id)) add('CHECK_REQ_DUPLICATE', path, it.req_id);", "else if (false) add('CHECK_REQ_DUPLICATE', path, it.req_id);", [VAL]),
  m('F08', 'check report: every matrix row appears', CHK, "for (const id of matrix.keys()) if (!seenReq.has(id)) add('CHECK_REQ_MISSING', 'items', id);", '', [VAL]),
  m('F09', 'check report: unknown fact id', CHK, "for (const id of ids) if (!byId.has(id)) { add('CHECK_FACT_UNKNOWN', path, id); ok = false; }", '', [VAL]),
  m('F10', 'check report: uncited item', CHK, 'if (required && ids.length === 0) return null;', '', [VAL]),
  m('F11', 'check report: only a GAP may be uncited', CHK, "{ required: it.status !== 'GAP' }", '{ required: true }', [VAL]),
  m('F12', 'check report: CONSISTENT with a GAP or CONTRADICTION', CHK, "if (items.some((it) => isObj(it) && (it.status === 'GAP' || it.status === 'CONTRADICTION'))) add('CHECK_CONSISTENT_WITH_GAP');", '', [VAL]),
  m('F13', 'check report: CONSISTENT with a CONTRADICTION', CHK, "(it.status === 'GAP' || it.status === 'CONTRADICTION')", "(it.status === 'GAP')", [VAL]),
  m('F14', 'check report: CONSISTENT with hold reasons', CHK, "if (holds.length) add('CHECK_CONSISTENT_WITH_HOLD_REASONS');", '', [VAL]),
  m('F15', 'check report: HOLD needs reasons', CHK, "if (r.verdict === 'HOLD' && holds.length === 0) add('CHECK_HOLD_WITHOUT_REASONS');", '', [VAL]),
  m('F16', 'check report: hold code enum', CHK, '|| !HOLD_CODES.includes(h.code) || !matrix.has(h.req_id)', '|| !matrix.has(h.req_id)', [VAL]),
  m('F17', 'check report: hold req_id must be in the matrix', CHK, '|| !HOLD_CODES.includes(h.code) || !matrix.has(h.req_id)', '|| !HOLD_CODES.includes(h.code)', [VAL]),
  m('F18', 'check report: a hold reason is cited unless it is missing evidence', CHK, "{ required: h.code !== 'HOLD_MISSING_EVIDENCE' }", '{ required: false }', [VAL]),
  m('F19', 'check report: free text goes through the text rules', CHK, 'for (const t of texts) errors.push(', 'for (const t of []) errors.push(', [VAL]),
  m('F20', 'text rules: numbers must be in a cited fact', TR, 'if (checkNumbers && factsById) {', 'if (false) {', [VAL]),
  m('F21', 'text rules: key-shaped strings', TR, "if (SECRET_SHAPED.test(text)) add('SECRET_SHAPED');", '', [VAL]),
  m('F22', 'numbers: an uncited string is checked against the whole pack', FACTS, 'citedIds.length ? citedIds : [...factsById.keys()]', 'citedIds.length ? citedIds : []', [VAL]),
  m('F24', 'numbers: fact ids in the text are not numbers', FACTS, ".replace(FACT_ID_G, ' ')", '', [VAL]),
  m('F25', 'firewall: mining out/', FACTS, 'return MINING_OUT.test(p) || ', 'return ', [VAL]),
  m('F26', 'firewall: MINING_SELECTION / MINING_GATE_RECORD files', FACTS, '|| FORBIDDEN_FILE.test(p)', '', [VAL]),
  m('F27', 'firewall: vault paths', FACTS, '|| VAULT_PATH.test(p)', '', [VAL]),
  m('F28', 'firewall: race and paper results', FACTS, '|| RACE_PAPER_PATH.test(p)', '', [VAL]),
  m('F29', 'firewall: forbidden record types', FACTS, "|| (typeof s.record_type === 'string' && FORBIDDEN_TYPE.test(s.record_type))", '', [VAL]),
  m('F30', 'a check report is never an input (cards, proposals, bundles)', FACTS, "if (o.purpose !== 'CHECK' && isCheckReportSource(f))", 'if (false)', [VAL]),
  m('F31', 'pack: duplicate fact ids', FACTS, "if (seen.has(f.id)) add('PACK_FACT_DUPLICATE', f.id);", '', [VAL]),
  m('F32', 'pack: no Owner or desk keys', FACTS, "if (keys.length) add('PACK_FORBIDDEN_FIELD', keys[0]);", '', [VAL]),
  m('F33', 'pack: no key-shaped strings', FACTS, "if (SECRET_SHAPED.test(JSON.stringify(pack))) add('PACK_SECRET_SHAPED');", '', [VAL]),
  m('F34', 'pack: matrix rows cite known facts', FACTS, "for (const id of row.fact_ids) if (!seen.has(id)) add('PACK_MATRIX_FACT_UNKNOWN', `${row.req_id}:${id}`);", '', [VAL]),
  m('F35', 'pack: token budget per call', FACTS, "if (estimateTokens(pack) > (o.maxTokens || MAX_CALL_TOKENS)) add('PACK_TOO_LARGE', estimateTokens(pack));", '', [VAL]),
  m('F36', 'pack: author = checker is refused', FACTS, "else if (o.check_admission_sha256 && a.prompt_admission_sha256 === o.check_admission_sha256) add('PACK_AUTHOR_IS_CHECKER');", '', [VAL]),
  m('F37', 'pack: author row required when asked', FACTS, "if (o.author_required) add('PACK_AUTHOR_MISSING');", '', [VAL]),
  // ---- card
  m('K01', 'card: market must match', CARD, "if (c.market !== ctx.market) add('CARD_MARKET_MISMATCH', 'market', c.market);", '', [VAL]),
  m('K02', 'card: week must match', CARD, "if (c.week_id !== ctx.week_id) add('CARD_WEEK_MISMATCH', 'week_id', c.week_id);", '', [VAL]),
  m('K03', 'card: items are cited', CARD, "if (ids.length === 0) add('CARD_ITEM_UNCITED', path);", '', [VAL]),
  m('K04', 'card: cited ids exist', CARD, "for (const id of ids) if (!byId.has(id)) add('CARD_FACT_UNKNOWN', path, id);", '', [VAL]),
  m('K05', 'card: pattern keys come from the code counts', CARD, "if (!counts.has(p.pattern_key)) add('CARD_PATTERN_UNKNOWN', path, p.pattern_key);", "if (false) add('CARD_PATTERN_UNKNOWN', path, p.pattern_key);", [VAL]),
  m('K06', 'card: pattern counts are the code counts', CARD, "else if (counts.get(p.pattern_key) !== p.count)", 'else if (false)', [VAL]),
  m('K07', 'card: zero ideas need a reason', CARD, "if (ideas.length === 0 && r === null) add('CARD_ZERO_IDEAS_NO_REASON');", '', [VAL]),
  m('K08', 'card: no reason alongside ideas', CARD, "if (ideas.length > 0 && r !== null) add('CARD_REASON_WITH_IDEAS');", '', [VAL]),
  m('K09', 'card: the no-idea reason is cited', CARD, "if (r.fact_ids.length === 0 || !r.fact_ids.every((id) => byId.has(id))) add('CARD_NO_IDEA_REASON_UNCITED', 'no_idea_reason');", '', [VAL]),
  m('K10', 'card: at most 2 question proposals (check)', CARD, "if (qs.length > MAX_QUESTIONS) add('CARD_QUESTIONS_TOO_MANY', 'question_proposals', qs.length);", '', [VAL]),
  m('K11', 'card: at most 2 question proposals (constant)', CARD, 'const MAX_QUESTIONS = 2;', 'const MAX_QUESTIONS = 3;', [VAL]),
  m('K12', 'card: a question is in the card market', CARD, ' && q.market === ctx.market', '', [VAL]),
  m('K13', 'card: a question is a question', CARD, ' && INTERROGATIVE.test(q.question_zh)', '', [VAL]),
  m('K14', 'card: a question names a registered mechanism or NEW', CARD, "(q.mechanism_id === 'NEW' || ctx.registry.mechanisms.some((m) => m.mechanism_id === q.mechanism_id))", 'true', [VAL]),
  m('K15', 'card: no direction in a question', CARD, "['PREDICTION', 'VERDICT', 'DIRECTION']);", "['PREDICTION', 'VERDICT']);", [VAL]),
  m('K16', 'card: ideas per week counts the ones already recorded', CARD, '(ctx.existing_idea_count || 0) + ideas.length > MAX_IDEAS_PER_WEEK', 'ideas.length > MAX_IDEAS_PER_WEEK', [VAL]),
  m('K17', 'card: every idea goes through the idea validator', CARD, 'validateIdeaDraft(d, ctx).errors', '[]', [VAL]),
  // ---- factor idea
  m('I01', 'idea: exact keys', FI, 'if (!isObj(d) || Object.keys(d).sort().join() !== DRAFT_KEYS.join())', 'if (!isObj(d))', [VAL]),
  m('I02', 'idea: cited facts exist', FI, "for (const id of ids) if (!byId.has(id)) add('FACTOR_IDEA_FACT_UNKNOWN', id);", '', [VAL]),
  m('I03', 'idea: at least two distinct valid facts', FI, "if (valid.size < 2) add('FACTOR_IDEA_FACTS_MIN', valid.size);", "if (valid.size < 1) add('FACTOR_IDEA_FACTS_MIN', valid.size);", [VAL]),
  m('I04', 'idea: firewall sources', FI, "for (const id of valid) if (firewallHit(byId.get(id))) add('FACTOR_IDEA_FIREWALL_SOURCE', id);", '', [VAL]),
  m('I05', 'idea: a mechanism must be a registered SELECTION_TIMING one', FI, "if (!hit || hit.layer !== 'SELECTION_TIMING')", 'if (!hit)', [VAL]),
  m('I06', 'idea: NEW has exactly the five keys', FI, 'Object.keys(n).sort().join() === NEW_KEYS.join() && ', '', [VAL]),
  m('I07', 'idea: NEW id is SEL.*', FI, ' && NEW_ID.test(n.proposed_id || \'\')', '', [VAL]),
  m('I08', 'idea: NEW id is not already registered', FI, ' && !reg.mechanisms.some((x) => x.mechanism_id === n.proposed_id)', '', [VAL]),
  m('I09', 'idea: NEW layer is SELECTION_TIMING', FI, "\n      && n.layer === 'SELECTION_TIMING' && NEW_DECISION_POINTS", '\n      && NEW_DECISION_POINTS', [VAL]),
  m('I10', 'idea: NEW decision point is SELECT/DIRECTION/ENTRY', FI, ' && NEW_DECISION_POINTS.includes(n.decision_point)', '', [VAL]),
  m('I11', 'idea: readings are registered', FI, "d.readings.every((r) => typeof r === 'string' && own(reg.readings, r))", "d.readings.every((r) => typeof r === 'string')", [VAL]),
  m('I11A', 'idea: a market needs a verified frozen mining space', FI, "if (!frozenSpace) add('FACTOR_IDEA_NO_FROZEN_SPACE', ctx.market);", "if (false) add('FACTOR_IDEA_NO_FROZEN_SPACE', ctx.market);", [W21]),
  m('I11B', 'idea: every registered reading belongs to the frozen mining space', FI, "if (reg.readings[id].origin !== 'SPACE') add('FACTOR_IDEA_READING_NOT_IN_MINING_SPACE', `${id}@${space.sha256}`);", "if (false) add('FACTOR_IDEA_READING_NOT_IN_MINING_SPACE', `${id}@${space.sha256}`);", [W21]),
  m('I11C', 'idea: outside-space refusal identifies the frozen space sha', FI, "`${id}@${space.sha256}`", "`${id}`", [W21]),
  m('I11D', 'idea: persisted records are revalidated against the frozen mining space', FI, '  errors.push(...validateIdeaDraft(draft, ctx).errors);', '', [W21]),
  m('I12', 'idea: holding periods come from the registered list', FI, 'Number.isInteger(h) && reg.holding_periods.includes(h)', 'Number.isInteger(h)', [VAL]),
  m('I13', 'idea: the question is interrogative', FI, "&& !INTERROGATIVE.test(d.question_zh.trim())) add('FACTOR_IDEA_QUESTION_NOT_INTERROGATIVE');", "&& false) add('FACTOR_IDEA_QUESTION_NOT_INTERROGATIVE');", [VAL]),
  m('I14', 'idea: formula check', FI, 'if (FORMULA.some((re) => re.test(t)))', 'if (false)', [VAL]),
  m('I15', 'idea: function-call tokens', FI, '/[A-Za-z_][A-Za-z0-9_]*\\s*[(（]/,', '/(?!)/,', [VAL]),
  m('I16', 'idea: operator names', FI, '/\\b(rank|zscore|ts_[a-z0-9_]+|neutralize_[a-z0-9_]+|decay_linear|delta)\\b/i,', '/(?!)/,', [VAL]),
  m('I17', 'idea: arithmetic between readings', FI, "/[A-Za-z_][\\w.]*\\s*[+*/^×÷]\\s*[A-Za-z_(][\\w.]*|[A-Za-z_][\\w.]*\\s+-\\s+[A-Za-z_(][\\w.]*/,", '/(?!)/,', [VAL]),
  m('I18', 'idea: comparison signs', FI, '/[<>=≥≤≠]/,', '/(?!)/,', [VAL]),
  m('I19', 'idea: no numbers (weights, thresholds, windows)', FI, "if (numericTokens(t).length) add('FACTOR_IDEA_NUMERIC_PARAM', path);", '', [VAL]),
  m('I20', 'idea: direction words', FI, "lists: ['PREDICTION', 'VERDICT', 'DIRECTION']", "lists: ['PREDICTION', 'VERDICT']", [VAL]),
  m('I21', 'idea: prediction words', FI, "lists: ['PREDICTION', 'VERDICT', 'DIRECTION']", "lists: ['VERDICT', 'DIRECTION']", [VAL]),
  m('I22', 'idea: verdict words', FI, "lists: ['PREDICTION', 'VERDICT', 'DIRECTION']", "lists: ['PREDICTION', 'DIRECTION']", [VAL]),
  m('I23', 'idea: at most 5 per week (constant)', FI, 'const MAX_IDEAS_PER_WEEK = 5;', 'const MAX_IDEAS_PER_WEEK = 6;', [VAL]),
  m('I24', 'record: PIT copied from the registry by code', FI, 'pit_available_at: ctx.registry.readings[id].pit_available_at }))', 'pit_available_at: null }))', [VAL]),
  m('I25', 'record: PIT text must equal the registry', FI, ' || ctx.registry.readings[r.id].pit_available_at !== r.pit_available_at', '', [VAL]),
  m('I26', 'record: id matches market and week', FI, 'if (!m || m[1] !== rec.market || m[2] !== rec.week_id || rec.market !== ctx.market || rec.week_id !== ctx.week_id)', 'if (!m)', [VAL]),
  m('I27', 'record: fact pack sha matches', FI, "if (rec.fact_pack_sha256 !== packSha(ctx.pack)) add('FACTOR_IDEA_PACK_SHA_MISMATCH');", '', [VAL]),
  m('I28', 'record: exact keys', FI, ' || Object.keys(rec).sort().join() !== RECORD_KEYS.join()', '', [VAL]),
  // ---- routing, host split, admission stub
  m('R01', 'market -> agent host', ROUT, "CN_A: 'LINUX', US_EQUITY: 'HK', CRYPTO: 'HK'", "CN_A: 'LINUX', US_EQUITY: 'LINUX', CRYPTO: 'HK'", [VAL]),
  m('R02', 'agent host: the task row must agree', ROUT, 'if (task.agent_host !== want || running !== want)', 'if (running !== want)', [VAL]),
  m('R03', 'agent host: the running host must agree', ROUT, 'if (task.agent_host !== want || running !== want)', 'if (task.agent_host !== want)', [VAL]),
  m('R04', 'routing: no triage reading is TRIAGE_PENDING', ROUT, "if (!t || typeof t.route !== 'string') return", 'if (false) return', [VAL]),
  m('R05', 'routing: not-do-settled closes the idea', ROUT, "if (t.route === 'NOT_DO_SETTLED') return", 'if (false) return', [VAL]),
  m('R06', 'routing: only registered factors -> AI_PREREG', ROUT, "registry.readings[r.id].origin === 'FACTOR_LIBRARY'", "registry.readings[r.id].origin === 'SPACE'", [VAL]),
  m('R07', 'routing: crypto generator path held (existing mechanism)', ROUT, "if (crypto) return { ...base, route: 'GENERATOR', state: 'GENERATOR_HELD_CRYPTO', reason: 'RF1116: the generator path is held for crypto', triage_route: t.route };", '', [VAL]),
  m('R08', 'routing: crypto generator path held (NEW mechanism)', ROUT, "    if (crypto) return { ...base, route: 'GENERATOR', state: 'GENERATOR_HELD_CRYPTO', reason: 'RF1116: the generator path is held for crypto' };\n", '', [VAL]),
  m('R09', 'view: only generator-path ideas', ROUT, "if (!r || !['GENERATOR_VIEW_PENDING', 'WAITING_MECHANISM_ADMISSION'].includes(r.state)) continue;", 'if (!r) continue;', [VAL]),
  m('R10', 'view: the mechanism must be in the (merged) register', ROUT, 'if (!registerIds.has(mid)) continue;', '', [VAL]),
  m('R11', 'view: unknown provenance is refused', ROUT, 'if (!pack) { refused.push(', 'if (false) { refused.push(', [VAL]),
  m('R12', 'view: a pack behind the firewall never reaches the generator', ROUT, "const bad = checkPack(pack, { purpose: 'GENERATOR_VIEW', maxTokens: Infinity }).errors.some((e) => e.code === 'PACK_FIREWALL_SOURCE' || e.code === 'PACK_CHECK_REPORT_AS_INPUT');", 'const bad = false;', [VAL]),
  m('R13', 'admission stub only takes NEW mechanisms', STUB, "if (!isNew(idea)) throw err('MECHANISM_PROPOSAL_NOT_NEW', idea.idea_id);", '', [VAL]),
  m('R14', 'admission stub only queues WAITING', STUB, "state: 'WAITING_EXTERNAL:MECHANISM_ADMISSION'", "state: 'ADMITTED'", [VAL]),
  // ---- agent
  m('T01', 'request: max_tokens ceiling comes from the config', AG, 'max_tokens: MAX_TOKENS, temperature: 0, response_format', 'max_tokens: 100000, temperature: 0, response_format', [AGT]),
  m('T02', 'request: temperature 0', AG, 'max_tokens: MAX_TOKENS, temperature: 0,', 'max_tokens: MAX_TOKENS, temperature: 1,', [AGT]),
  m('T03', 'request: JSON mode', AG, "temperature: 0, response_format: { type: 'json_object' }, stream: false }", 'temperature: 0, stream: false }', [AGT]),
  m('T04', 'request: no streaming', AG, "response_format: { type: 'json_object' }, stream: false }", "response_format: { type: 'json_object' }, stream: true }", [AGT]),
  m('T05', 'request: no tools of any kind (a tools key is added)', AG, 'temperature: 0, response_format:', "tools: [], temperature: 0, response_format:", [AGT]),
  m('T06', 'keyless: a key-named variable refuses start', AG, 'if (KEY_NAME.test(k) || (typeof v === \'string\' && KEY_VALUE.test(v)))', "if (typeof v === 'string' && KEY_VALUE.test(v))", [AGT]),
  m('T07', 'keyless: a key-shaped value refuses start', AG, 'if (KEY_NAME.test(k) || (typeof v === \'string\' && KEY_VALUE.test(v)))', 'if (KEY_NAME.test(k))', [AGT]),
  m('T08', 'quality gate: two attempts', AG, 'const ATTEMPTS = 2;', 'const ATTEMPTS = 3;', [AGT]),
  m('T09', 'quality gate: one revision per attempt', AG, 'const REVISIONS = 1;', 'const REVISIONS = 2;', [AGT]),
  m('T10', 'quality gate: pro at most once per task', AG, 'if (ctx.proUsed) return', 'if (false) return', [AGT]),
  m('T11', 'quality gate: the pro call carries the record', AG, "[{ role: 'system', content: system }, { role: 'user', content: user }], { quality_gate: record });", "[{ role: 'system', content: system }, { role: 'user', content: user }]);", [AGT]),
  m('T12', 'revision re-asks with codes only', AG, "Return the corrected JSON object only.` }];", "Return the corrected JSON object only. ${user}` }];", [AGT]),
  m('T13', 'gateway class: peak is a defer', AG, "if (e.rq_code === 'RQ_PEAK_REFUSED') return { status: 'DEFER', ...base };", '', [AGT]),
  m('T14', 'gateway class: quota waits', AG, "wait_state: 'WAITING_QUOTA'", "wait_state: 'WAITING_PROVIDER'", [AGT]),
  m('T15', 'gateway class: credential waits and alerts once', AG, "alert: 'RQ_CREDENTIAL', ...base", '...base', [AGT]),
  m('T16', 'gateway class: provider errors retry with Retry-After', AG, 'retry_after_s: Number.isInteger(e.retry_after_s) ? e.retry_after_s : null', 'retry_after_s: null', [AGT]),
  m('T17', 'a failed check reports CHECKER_DEFECT', AG, "(kind === 'AI_CHECK' ? { defect_code: 'CHECKER_DEFECT' } : {})", '{}', [AGT]),
  m('T18', 'the agent refuses the wrong host', AG, 'assertAgentHost(task, opts.host);', '', [AGT]),
  m('T19', 'a dirty pack is blocked before any call', AG, 'if (pc.errors.length) return blocked(pc.errors[0].code, pc.errors[0].detail);', '', [AGT]),
  m('T20', 'a split check merges to HOLD if any part holds', AG, "verdict: parts.some((p) => p.verdict === 'HOLD') ? 'HOLD' : 'CONSISTENT'", "verdict: 'CONSISTENT'", [AGT]),
  m('T21', 'the P0 metric records a cited no-idea reason', AG, 'no_idea_reason_cited: card.no_idea_reason !== null', 'no_idea_reason_cited: false', [AGT]),
  m('T22', 'NEW mechanisms are queued as admission proposals', AG, "if (routes[i].state === 'WAITING_MECHANISM_ADMISSION') proposals.push(proposeAdmission(idea));", '', [AGT]),
  m('T23', 'the card prompt is the admitted one', AG, 'admission: adm.system_sha256, user, validate: (raw) => validateCard', 'admission: "0".repeat(64), user, validate: (raw) => validateCard', [AGT]),
  // ---- seam, client, cli, deploy
  m('S01', 'seam: six provider tries', SEAM, 'const PROVIDER_TRIES = 6;', 'const PROVIDER_TRIES = 7;', [AGT]),
  m('S02', 'seam: Retry-After wins over the backoff', SEAM, 'Number.isInteger(result.retry_after_s) ? result.retry_after_s : PROVIDER_BACKOFF_S[tries - 1]', 'PROVIDER_BACKOFF_S[tries - 1]', [AGT]),
  m('S03', 'seam: the credential alert is passed on', SEAM, 'alert: result.alert || null', 'alert: null', [AGT]),
  m('S04', 'seam: kinds outside Q2 are refused', SEAM, 'if (!KINDS.includes(row.kind))', 'if (false)', [AGT]),
  m('S05', 'seam: the task agent_host must match the market', SEAM, 'if (row.agent_host !== want)', 'if (false)', [AGT, VAL]),
  m('S06', 'seam: task id shape', SEAM, "if (typeof row.task_id !== 'string' || !TASK_ID.test(row.task_id))", 'if (false)', [AGT]),
  m('C01', 'client: only a unix socket path', GC, "if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.includes('://') || socketPath.length > 107)", "if (typeof socketPath !== 'string')", [AGT]),
  m('C02', 'client: no automatic retry (a retry loop is added)', GC, "return request('POST', '/chat/completions', headers, JSON.stringify(body));", "return request('POST', '/chat/completions', headers, JSON.stringify(body)).then((r) => (r.ok ? r : request('POST', '/chat/completions', headers, JSON.stringify(body))));", [AGT]),
  m('C03', 'cli: refuses to start with a key in the environment', CLI, "try { assertKeylessEnv(process.env); } catch (e) { process.stderr.write(`${e.message}\\n`); process.exit(3); }", '', [AGT]),
  m('D01', 'deploy: HK agent has no IP', HKAG, 'IPAddressDeny=any\n', '', [AGT]),
  m('D02', 'deploy: HK agent only AF_UNIX', HKAG, 'RestrictAddressFamilies=AF_UNIX\n', '', [AGT]),
  m('D03', 'deploy: HK agent has no environment file', HKAG, 'User=rq-agent\n', 'User=rq-agent\nEnvironmentFile=-/root/.config/research-queue/deepseek-review.env\n', [AGT]),
  m('D04', 'deploy: Linux agent container has no network', RUN, '--network none', '--network bridge', [AGT]),
  m('D05', 'deploy: Linux agent container is read-only', RUN, '--read-only ', '', [AGT]),
];

// lexicon: every term in the three lists is pinned by a test; neutralise each regex in turn
const lexSrc = fs.readFileSync(path.join(ROOT, LEX), 'utf8');
let li = 0;
for (const mm of lexSrc.matchAll(/\['([^']+)', (\/[^\n]*?\/[a-z]*)\](?=[,\n])/g)) {
  li += 1;
  MUTANTS.push(m(`L${String(li).padStart(2, '0')}`, `lexicon term: ${mm[1]}`, LEX, mm[0], `['${mm[1]}', /(?!)/]`, [VAL]));
}

function listFailures(out) {
  return [...new Set((out.match(/^✖ .+$/gm) || []).map((l) => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')))].slice(0, 5);
}
function runOne(file) {
  if (file.endsWith('.py')) {
    const r = spawnSync('python3', ['-B', file], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 5 * 60 * 1000 });
    return { status: r.status, failing: ((r.stderr || '').match(/^(FAIL|ERROR): .+$/gm) || []).slice(0, 5) };
  }
  const r = spawnSync(process.execPath, ['--test', file], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
  return { status: r.status === null ? 124 : r.status, failing: listFailures(`${r.stdout || ''}\n${r.stderr || ''}`) };
}
function runTests(files) {
  let last = { status: 0, failing: [] };
  for (const f of files) { last = runOne(f); if (last.status !== 0) return last; }
  return last;
}

function main(argv) {
  const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
  const outFile = argv.includes('--write') ? argv[argv.indexOf('--write') + 1] : null;
  const merge = argv.includes('--merge');
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...new Set(MUTANTS.map((x) => x.file))], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) { process.stderr.write(`refusing to run: uncommitted changes in mutated files:\n${dirty}\n`); return 2; }
  const files = [...new Set(MUTANTS.flatMap((x) => x.tests))];
  for (const f of files) { const b = runOne(f); if (b.status !== 0) { process.stderr.write(`baseline is not green: ${f} ${JSON.stringify(b.failing)}\n`); return 2; } }
  const results = [];
  for (const mu of MUTANTS.filter((x) => !only || only.has(x.id))) {
    const abs = path.join(ROOT, mu.file);
    const original = fs.readFileSync(abs, 'utf8');
    const count = original.split(mu.find).length - 1;
    if (count !== 1) { process.stderr.write(`${mu.id}: find text occurs ${count} times in ${mu.file}\n`); results.push({ id: mu.id, guard: mu.guard, file: mu.file, result: 'BAD_MUTANT', occurrences: count }); continue; }
    let r;
    try { fs.writeFileSync(abs, original.replace(mu.find, () => mu.replace)); r = runTests(mu.tests); } finally { fs.writeFileSync(abs, original); }
    const killed = r.status !== 0;
    results.push({ id: mu.id, guard: mu.guard, file: mu.file, result: killed ? 'KILLED' : 'SURVIVED', failing: r.failing, head });
    process.stdout.write(`${mu.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${mu.guard}${killed ? `  <- ${r.failing[0] || `exit ${r.status}`}` : ''}\n`);
  }
  let all = results;
  if (merge && outFile && fs.existsSync(path.join(ROOT, outFile))) {
    const prior = JSON.parse(fs.readFileSync(path.join(ROOT, outFile), 'utf8')).results.filter((x) => !results.some((y) => y.id === x.id));
    all = [...prior, ...results].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  const summary = { schema: 'RQ_GATEWAY_AGENT_MUTATION_RESULTS_V1', baseline: 'GREEN', mutants: all.length, killed: all.filter((x) => x.result === 'KILLED').length,
    survived: all.filter((x) => x.result === 'SURVIVED').map((x) => x.id), bad: all.filter((x) => x.result === 'BAD_MUTANT').map((x) => x.id), heads: [...new Set(all.map((x) => x.head).filter(Boolean))], results: all };
  if (outFile) { fs.mkdirSync(path.dirname(path.join(ROOT, outFile)), { recursive: true }); fs.writeFileSync(path.join(ROOT, outFile), `${JSON.stringify(summary, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify({ mutants: summary.mutants, killed: summary.killed, survived: summary.survived, bad: summary.bad, heads: summary.heads })}\n`);
  return summary.survived.length || summary.bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MUTANTS };
