'use strict';
/**
 * RQ_CHECK_REPORT_V1 的验证器（§5.6，AQ-12）。输入是模型的原文（字符串）或已解析的对象，加上它所核对的事实包。
 * 拒绝：非 JSON、多余或缺失的键、req_id 缺失 / 重复 / 未知、未知或未引用的事实 id、CONSISTENT 带 GAP / CONTRADICTION / HOLD 理由、HOLD 无理由、
 * 数字不在被引用的事实里、预测词、结论与建议词、密钥形状。返回 { ok, errors:[{code, path, detail}], report }。
 */
const { isObj } = require('./canon');
const { factsMap } = require('./facts');
const { textErrors } = require('./text-rules');

const VERDICTS = ['CONSISTENT', 'HOLD'];
const STATUSES = ['COVERED', 'GAP', 'CONTRADICTION', 'NA_CONFIRMED'];
const HOLD_CODES = ['HOLD_MISSING_EVIDENCE', 'HOLD_CONTRADICTION', 'HOLD_SCOPE_DRIFT', 'HOLD_UNREGISTERED_TRIAL', 'HOLD_WINDOW_BREACH', 'HOLD_PROVENANCE'];
const KEYS = ['hold_reasons', 'items', 'unknowns', 'verdict'];
const ITEM_KEYS = ['fact_ids', 'note_zh', 'req_id', 'status'];
const HOLD_KEYS = ['code', 'fact_ids', 'remediation_zh', 'req_id'];
const sameKeys = (o, keys) => Object.keys(o).sort().join() === keys.join();
const isIdList = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

function validateCheckReport(raw, pack) {
  const errors = [];
  const add = (code, path, detail) => errors.push({ code, path, detail });
  let r = raw;
  if (typeof raw === 'string') { try { r = JSON.parse(raw); } catch (e) { r = null; } }
  if (!isObj(r)) { add('CHECK_NOT_JSON'); return { ok: false, errors, report: null }; }
  const byId = factsMap(pack);
  const matrix = new Map(((pack && pack.evidence_matrix) || []).map((m) => [m.req_id, m]));
  if (!sameKeys(r, KEYS)) { add('CHECK_KEYS', null, Object.keys(r).join()); return { ok: false, errors, report: null }; }
  if (!VERDICTS.includes(r.verdict)) add('CHECK_VERDICT_INVALID');
  const texts = [];
  const cite = (ids, path, { required }) => {
    let ok = isIdList(ids);
    if (!ok) { add('CHECK_ITEM_KEYS', path, 'fact_ids'); return []; }
    for (const id of ids) if (!byId.has(id)) { add('CHECK_FACT_UNKNOWN', path, id); ok = false; }
    if (required && ids.length === 0) return null;
    return ok ? ids : ids.filter((id) => byId.has(id));
  };

  const items = Array.isArray(r.items) ? r.items : (add('CHECK_ITEM_KEYS', 'items'), []);
  const seenReq = new Set();
  items.forEach((it, i) => {
    const path = `items[${i}]`;
    if (!isObj(it) || !sameKeys(it, ITEM_KEYS) || typeof it.req_id !== 'string' || typeof it.note_zh !== 'string') { add('CHECK_ITEM_KEYS', path); return; }
    if (!STATUSES.includes(it.status)) add('CHECK_ITEM_STATUS_INVALID', path, it.status);
    if (!matrix.has(it.req_id)) add('CHECK_REQ_UNKNOWN', path, it.req_id);
    else if (seenReq.has(it.req_id)) add('CHECK_REQ_DUPLICATE', path, it.req_id);
    seenReq.add(it.req_id);
    const ids = cite(it.fact_ids, path, { required: it.status !== 'GAP' });
    if (ids === null) add('CHECK_ITEM_UNCITED', path, it.req_id);
    texts.push({ text: it.note_zh, cited: Array.isArray(it.fact_ids) ? it.fact_ids : [], path: `${path}.note_zh` });
  });
  for (const id of matrix.keys()) if (!seenReq.has(id)) add('CHECK_REQ_MISSING', 'items', id);

  const holds = Array.isArray(r.hold_reasons) ? r.hold_reasons : (add('CHECK_HOLD_REASON_INVALID', 'hold_reasons'), []);
  holds.forEach((h, i) => {
    const path = `hold_reasons[${i}]`;
    if (!isObj(h) || !sameKeys(h, HOLD_KEYS) || !HOLD_CODES.includes(h.code) || !matrix.has(h.req_id) || typeof h.remediation_zh !== 'string') { add('CHECK_HOLD_REASON_INVALID', path); return; }
    const ids = cite(h.fact_ids, path, { required: h.code !== 'HOLD_MISSING_EVIDENCE' });
    if (ids === null) add('CHECK_HOLD_REASON_UNCITED', path, h.code);
    texts.push({ text: h.remediation_zh, cited: Array.isArray(h.fact_ids) ? h.fact_ids : [], path: `${path}.remediation_zh` });
  });

  const unknowns = Array.isArray(r.unknowns) && r.unknowns.every((u) => typeof u === 'string') ? r.unknowns : (add('CHECK_KEYS', 'unknowns', 'unknowns must be strings'), []);
  unknowns.forEach((u, i) => texts.push({ text: u, cited: [], path: `unknowns[${i}]` }));

  if (r.verdict === 'CONSISTENT') {
    if (items.some((it) => isObj(it) && (it.status === 'GAP' || it.status === 'CONTRADICTION'))) add('CHECK_CONSISTENT_WITH_GAP');
    if (holds.length) add('CHECK_CONSISTENT_WITH_HOLD_REASONS');
  }
  if (r.verdict === 'HOLD' && holds.length === 0) add('CHECK_HOLD_WITHOUT_REASONS');

  for (const t of texts) errors.push(...textErrors(t.text, { prefix: 'CHECK', lists: ['PREDICTION', 'VERDICT'], cited: t.cited, factsById: byId }, t.path));
  return { ok: errors.length === 0, errors, report: errors.length === 0 ? r : null };
}

module.exports = { validateCheckReport, VERDICTS, STATUSES, HOLD_CODES };
