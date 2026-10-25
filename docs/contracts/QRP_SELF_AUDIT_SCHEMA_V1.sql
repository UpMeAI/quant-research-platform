-- QRP_SELF_AUDIT_SCHEMA_V1
-- Target: PostgreSQL, future durable-store migration.
-- Current QRP runtime remains append-only JSONL under services/self-audit/.
-- This DDL is a versioned migration contract, not evidence that PostgreSQL is deployed.

BEGIN;

CREATE TABLE strategy_baseline (
  baseline_id text PRIMARY KEY,
  strategy_ref text NOT NULL,
  market text NOT NULL,
  runtime_mode text NOT NULL CHECK (runtime_mode IN ('OFF', 'SHADOW', 'PAPER', 'LIVE')),
  version_ref text NOT NULL,
  source_ref text NOT NULL,
  source_hash text NOT NULL CHECK (length(source_hash) = 64),
  expected_baseline jsonb NOT NULL,
  acceptance_ref text NOT NULL,
  status text NOT NULL CHECK (status = 'FROZEN'),
  record_hash text NOT NULL UNIQUE CHECK (length(record_hash) = 64),
  frozen_at timestamptz NOT NULL
);

CREATE TABLE divergence_log (
  divergence_id text PRIMARY KEY,
  baseline_ref text NOT NULL REFERENCES strategy_baseline(baseline_id),
  source_run_ref text NOT NULL,
  target_run_ref text NOT NULL,
  field_path text NOT NULL,
  source_value jsonb,
  target_value jsonb,
  difference_state text NOT NULL CHECK (difference_state IN ('CONFIRMED', 'SUSPECTED', 'UNKNOWN')),
  cause_state text NOT NULL CHECK (cause_state IN ('KNOWN', 'UNKNOWN', 'NOT_APPLICABLE')),
  status text NOT NULL CHECK (status IN ('OPEN', 'EXPLAINED', 'RESOLVED', 'ACCEPTED')),
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs) = 'array'),
  record_hash text NOT NULL UNIQUE CHECK (length(record_hash) = 64),
  detected_at timestamptz NOT NULL
);

CREATE TABLE incident_catalog (
  incident_id text PRIMARY KEY,
  category text NOT NULL,
  scope text NOT NULL,
  symptom text NOT NULL,
  root_cause text,
  detection text NOT NULL,
  recovery_state text NOT NULL,
  recurrence_guard text,
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs) = 'array'),
  status text NOT NULL CHECK (status IN ('OPEN', 'MITIGATED', 'RESOLVED', 'WONT_FIX')),
  record_hash text NOT NULL UNIQUE CHECK (length(record_hash) = 64),
  opened_at timestamptz NOT NULL
);

CREATE TABLE anomaly_watchlist (
  event_id bigserial PRIMARY KEY,
  anomaly_id text NOT NULL,
  signal text NOT NULL,
  first_seen timestamptz NOT NULL,
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs) = 'array'),
  owner text NOT NULL,
  next_checkpoint timestamptz,
  status text NOT NULL CHECK (status IN ('OPEN', 'OBSERVING', 'RESOLVED', 'DISMISSED')),
  resolution_ref text,
  resolved_at timestamptz,
  record_hash text NOT NULL UNIQUE CHECK (length(record_hash) = 64),
  recorded_at timestamptz NOT NULL,
  CHECK (
    (status IN ('RESOLVED', 'DISMISSED') AND resolution_ref IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status IN ('OPEN', 'OBSERVING') AND resolution_ref IS NULL AND resolved_at IS NULL)
  )
);
CREATE INDEX anomaly_watchlist_head_idx ON anomaly_watchlist(anomaly_id, event_id DESC);

CREATE FUNCTION qrp_anomaly_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_status text;
BEGIN
  SELECT status INTO prior_status FROM anomaly_watchlist
    WHERE anomaly_id = NEW.anomaly_id ORDER BY event_id DESC LIMIT 1;
  IF prior_status IS NULL AND NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'ANOMALY_MUST_START_OPEN:%', NEW.anomaly_id;
  END IF;
  IF prior_status IN ('RESOLVED', 'DISMISSED') THEN
    RAISE EXCEPTION 'ANOMALY_ALREADY_CLOSED:%', NEW.anomaly_id;
  END IF;
  IF prior_status = 'OPEN' AND NEW.status <> 'OBSERVING' THEN
    RAISE EXCEPTION 'ANOMALY_BAD_TRANSITION:%->%', prior_status, NEW.status;
  END IF;
  IF prior_status = 'OBSERVING' AND NEW.status NOT IN ('RESOLVED', 'DISMISSED') THEN
    RAISE EXCEPTION 'ANOMALY_BAD_TRANSITION:%->%', prior_status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER anomaly_watchlist_transition BEFORE INSERT ON anomaly_watchlist
  FOR EACH ROW EXECUTE FUNCTION qrp_anomaly_transition_guard();

-- The meta layer is append-only. Corrections are new rows/events with new evidence;
-- strategy_baseline, divergence_log and incident_catalog use versioned identifiers.
CREATE FUNCTION qrp_self_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'QRP_SELF_AUDIT_APPEND_ONLY:%', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER strategy_baseline_append_only BEFORE UPDATE OR DELETE ON strategy_baseline
  FOR EACH ROW EXECUTE FUNCTION qrp_self_audit_append_only();
CREATE TRIGGER divergence_log_append_only BEFORE UPDATE OR DELETE ON divergence_log
  FOR EACH ROW EXECUTE FUNCTION qrp_self_audit_append_only();
CREATE TRIGGER incident_catalog_append_only BEFORE UPDATE OR DELETE ON incident_catalog
  FOR EACH ROW EXECUTE FUNCTION qrp_self_audit_append_only();
CREATE TRIGGER anomaly_watchlist_append_only BEFORE UPDATE OR DELETE ON anomaly_watchlist
  FOR EACH ROW EXECUTE FUNCTION qrp_self_audit_append_only();

COMMIT;
