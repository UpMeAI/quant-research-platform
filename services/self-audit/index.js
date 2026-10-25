'use strict';

/**
 * QRP 自审计元层。它只记录平台质量事实，不重算策略结论，也不触发发布、回滚或交易。
 * 四类对象与 Smartflow/Ashare 已有四张元表同义；QRP 当前为单机 JSONL，故先用
 * append-only ledger 实现，未来迁移数据库时保持对象语义和 record_hash 不变。
 */
const crypto = require('crypto');
const path = require('path');
const { dataDir, now, append, read } = require('../../packages/ledger');

const DIR = () => dataDir('self-audit');
const FILES = Object.freeze({
  baseline: () => path.join(DIR(), 'strategy_baseline.jsonl'),
  divergence: () => path.join(DIR(), 'divergence_log.jsonl'),
  incident: () => path.join(DIR(), 'incident_catalog.jsonl'),
  anomaly: () => path.join(DIR(), 'anomaly_watchlist.jsonl'),
});
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = (value, code) => { if (value === undefined || value === null || value === '') throw new Error(code); };

function immutableAppend(file, idKey, rec) {
  const same = read(file).filter((row) => row[idKey] === rec[idKey]);
  if (!same.length) return append(file, rec);
  const exact = same.find((row) => row.record_hash === rec.record_hash);
  if (exact) return { ...exact, replayHit: true };
  throw new Error(`SELF_AUDIT_ID_CONFLICT:${rec[idKey]}`);
}

function semanticEqual(left, right, omitted = []) {
  const strip = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)));
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

function freezeStrategyBaseline(input = {}) {
  for (const key of ['strategy_ref', 'market', 'runtime_mode', 'version_ref', 'source_ref', 'source_hash', 'acceptance_ref']) {
    required(input[key], `STRATEGY_BASELINE_MISSING:${key}`);
  }
  if (!input.expected_baseline || typeof input.expected_baseline !== 'object' || Array.isArray(input.expected_baseline)) {
    throw new Error('STRATEGY_BASELINE_MISSING:expected_baseline');
  }
  if (!['OFF', 'SHADOW', 'PAPER', 'LIVE'].includes(input.runtime_mode)) throw new Error(`STRATEGY_BASELINE_BAD_MODE:${input.runtime_mode}`);
  if (!/^[0-9a-f]{64}$/.test(input.source_hash)) throw new Error('STRATEGY_BASELINE_SOURCE_HASH_NOT_SHA256');
  const baselineId = input.baseline_id || `BASELINE-${sha256(input).slice(0, 16)}`;
  const core = {
    schema: 'STRATEGY_BASELINE_V1', baseline_id: baselineId,
    strategy_ref: input.strategy_ref, market: input.market, runtime_mode: input.runtime_mode,
    version_ref: input.version_ref, source_ref: input.source_ref, source_hash: input.source_hash,
    expected_baseline: input.expected_baseline, acceptance_ref: input.acceptance_ref,
    status: 'FROZEN',
  };
  const existing = read(FILES.baseline()).find((row) => row.baseline_id === baselineId);
  if (existing) {
    if (semanticEqual(existing, core, ['record_hash', 'frozen_at'])) return { ...existing, replayHit: true };
    throw new Error(`SELF_AUDIT_ID_CONFLICT:${baselineId}`);
  }
  const body = { ...core, frozen_at: input.frozen_at || now() };
  body.record_hash = sha256(body);
  return immutableAppend(FILES.baseline(), 'baseline_id', body);
}

function recordDivergence(input = {}) {
  for (const key of ['baseline_ref', 'source_run_ref', 'target_run_ref', 'field_path', 'difference_state', 'cause_state', 'status']) {
    required(input[key], `DIVERGENCE_MISSING:${key}`);
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'source_value') || !Object.prototype.hasOwnProperty.call(input, 'target_value')) {
    throw new Error('DIVERGENCE_MISSING:source_value_or_target_value');
  }
  if (!['CONFIRMED', 'SUSPECTED', 'UNKNOWN'].includes(input.difference_state)) throw new Error(`DIVERGENCE_BAD_DIFFERENCE_STATE:${input.difference_state}`);
  if (!['KNOWN', 'UNKNOWN', 'NOT_APPLICABLE'].includes(input.cause_state)) throw new Error(`DIVERGENCE_BAD_CAUSE_STATE:${input.cause_state}`);
  if (!['OPEN', 'EXPLAINED', 'RESOLVED', 'ACCEPTED'].includes(input.status)) throw new Error(`DIVERGENCE_BAD_STATUS:${input.status}`);
  if (!read(FILES.baseline()).some((row) => row.baseline_id === input.baseline_ref)) {
    throw new Error(`DIVERGENCE_BASELINE_NOT_FOUND:${input.baseline_ref}`);
  }
  const stable = {
    schema: 'DIVERGENCE_LOG_V1',
    baseline_ref: input.baseline_ref, source_run_ref: input.source_run_ref,
    target_run_ref: input.target_run_ref, field_path: input.field_path,
    source_value: input.source_value, target_value: input.target_value,
    difference_state: input.difference_state, cause_state: input.cause_state,
    status: input.status, evidence_refs: input.evidence_refs || [],
  };
  const body = { ...stable, divergence_id: input.divergence_id || `DIV-${sha256(stable).slice(0, 16)}`, detected_at: input.detected_at || now() };
  const existing = read(FILES.divergence()).find((row) => row.divergence_id === body.divergence_id);
  if (existing) {
    if (semanticEqual(existing, body, ['record_hash', 'detected_at'])) return { ...existing, replayHit: true };
    throw new Error(`SELF_AUDIT_ID_CONFLICT:${body.divergence_id}`);
  }
  body.record_hash = sha256(body);
  return immutableAppend(FILES.divergence(), 'divergence_id', body);
}

function recordIncident(input = {}) {
  for (const key of ['category', 'scope', 'symptom', 'detection', 'recovery_state', 'status']) {
    required(input[key], `INCIDENT_MISSING:${key}`);
  }
  if (!['OPEN', 'MITIGATED', 'RESOLVED', 'WONT_FIX'].includes(input.status)) throw new Error(`INCIDENT_BAD_STATUS:${input.status}`);
  const stable = {
    schema: 'INCIDENT_CATALOG_V1',
    category: input.category, scope: input.scope, symptom: input.symptom,
    root_cause: input.root_cause ?? null, detection: input.detection,
    recovery_state: input.recovery_state, recurrence_guard: input.recurrence_guard ?? null,
    evidence_refs: input.evidence_refs || [], status: input.status,
  };
  const body = { ...stable, incident_id: input.incident_id || `INC-${sha256(stable).slice(0, 16)}`, opened_at: input.opened_at || now() };
  const existing = read(FILES.incident()).find((row) => row.incident_id === body.incident_id);
  if (existing) {
    if (semanticEqual(existing, body, ['record_hash', 'opened_at'])) return { ...existing, replayHit: true };
    throw new Error(`SELF_AUDIT_ID_CONFLICT:${body.incident_id}`);
  }
  body.record_hash = sha256(body);
  return immutableAppend(FILES.incident(), 'incident_id', body);
}

function watchAnomaly(input = {}) {
  for (const key of ['signal', 'first_seen', 'owner', 'status']) required(input[key], `ANOMALY_MISSING:${key}`);
  if (!['OPEN', 'OBSERVING', 'RESOLVED', 'DISMISSED'].includes(input.status)) throw new Error(`ANOMALY_BAD_STATUS:${input.status}`);
  if (['RESOLVED', 'DISMISSED'].includes(input.status) && (!input.resolution_ref || !input.resolved_at)) {
    throw new Error('ANOMALY_RESOLUTION_INCOMPLETE');
  }
  if (!['RESOLVED', 'DISMISSED'].includes(input.status) && (input.resolution_ref || input.resolved_at)) throw new Error('ANOMALY_OPEN_WITH_RESOLUTION');
  const identity = { signal: input.signal, first_seen: input.first_seen, owner: input.owner };
  const stable = {
    schema: 'ANOMALY_WATCHLIST_V1',
    signal: input.signal, first_seen: input.first_seen, evidence_refs: input.evidence_refs || [],
    owner: input.owner, next_checkpoint: input.next_checkpoint ?? null, status: input.status,
    resolution_ref: input.resolution_ref ?? null, resolved_at: input.resolved_at ?? null,
  };
  const body = { ...stable, anomaly_id: input.anomaly_id || `ANOM-${sha256(identity).slice(0, 16)}`, recorded_at: input.recorded_at || now() };
  // watchlist 是受约束事件流：业务同内容重放幂等，只允许 OPEN → OBSERVING → 终态。
  const history = read(FILES.anomaly()).filter((row) => row.anomaly_id === body.anomaly_id);
  const same = history.find((row) => semanticEqual(row, body, ['record_hash', 'recorded_at']));
  if (same) return { ...same, replayHit: true };
  const head = history[history.length - 1];
  if (!head && body.status !== 'OPEN') throw new Error(`ANOMALY_MUST_START_OPEN:${body.anomaly_id}`);
  if (head && ['RESOLVED', 'DISMISSED'].includes(head.status)) throw new Error(`ANOMALY_ALREADY_CLOSED:${body.anomaly_id}`);
  const allowed = { OPEN: ['OBSERVING'], OBSERVING: ['RESOLVED', 'DISMISSED'] };
  if (head && !(allowed[head.status] || []).includes(body.status)) {
    throw new Error(`ANOMALY_BAD_TRANSITION:${head.status}->${body.status}`);
  }
  body.record_hash = sha256(body);
  return append(FILES.anomaly(), body);
}

function list(kind) {
  if (!FILES[kind]) throw new Error(`SELF_AUDIT_UNKNOWN_KIND:${kind}`);
  return read(FILES[kind]());
}

module.exports = { FILES, sha256, semanticEqual, freezeStrategyBaseline, recordDivergence, recordIncident, watchAnomaly, list };
