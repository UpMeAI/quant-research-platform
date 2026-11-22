-- RESEARCH_QUEUE_V1 queue database (AUTONOMOUS_RESEARCH_QUEUE_V1 §3.2). The sha256 of this file is pinned in docs/contracts/RESEARCH_QUEUE_V1.md.
CREATE TABLE task (
  task_id TEXT PRIMARY KEY,              -- RQT-<HOST>-<yyyymmdd>-<sha8(idem_key)>
  idem_key TEXT NOT NULL UNIQUE,         -- sha256 canonical {template_id, template_sha256, subject, params}
  host TEXT NOT NULL CHECK (host IN ('LINUX','HK')),
  agent_host TEXT NOT NULL CHECK (agent_host IN ('LINUX','HK')),  -- by market: CN_A->LINUX, US_EQUITY/CRYPTO->HK
  kind TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('CN_A','US_EQUITY','CRYPTO','NONE')),
  template_id TEXT NOT NULL, template_sha256 TEXT NOT NULL, evidence_matrix_sha256 TEXT NOT NULL,
  admission_json TEXT NOT NULL, admission_sha256 TEXT NOT NULL,
  weight_class TEXT NOT NULL CHECK (weight_class IN ('W0','W1','W2','NET')),
  io_class TEXT NOT NULL CHECK (io_class IN ('NONE','LANE1_DB','LANE1_FILES','HK_DB')),
  depends_on TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL, state_reason TEXT, not_before TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 0, transient_budget INTEGER NOT NULL,
  lease_owner TEXT, lease_token TEXT, lease_expires_at TEXT, heartbeat_at TEXT,
  priority INTEGER NOT NULL DEFAULT 50, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE attempt (task_id TEXT, attempt_no INTEGER, lease_token TEXT, runtime TEXT, unit_or_container TEXT,
  started_at TEXT, ended_at TEXT, exit_code INTEGER, exit_signal TEXT, error_code TEXT, receipt_sha256 TEXT,
  PRIMARY KEY (task_id, attempt_no));
CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at TEXT, actor TEXT, from_state TEXT,
  to_state TEXT, reason_code TEXT, detail_json TEXT, prev_hash TEXT, hash TEXT);   -- append-only hash chain
CREATE INDEX task_state_host ON task (state, host);
CREATE INDEX event_task ON event (task_id, seq);
