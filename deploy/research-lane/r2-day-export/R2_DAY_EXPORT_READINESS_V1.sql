-- R2_DAY_EXPORT_READINESS_V1 (ops-coord 2026-11-23): returns exactly one row iff the POST_CLOSE of trading day :'d' (YYYY-MM-DD, CST)
-- finished and no producer is FAILED / BLOCKED / SKIPPED. DEGRADED is the normal V6 state (11-11..11-20 every POST_CLOSE was DEGRADED
-- with the same research producers DEGRADED); SUCCEEDED never occurs, so requiring it would refuse every day. Read-only, SELECT only.
-- Run: psql -X -At -v ON_ERROR_STOP=1 -v d=2026-11-20 (session with default_transaction_read_only=on).
SELECT pc.slot, pc.status, to_char(pc.completed_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SS') AS completed_cst
  FROM pipeline_completion pc
 WHERE pc.cadence = 'DAILY'
   AND pc.slot = :'d' || ':POST_CLOSE:' || :'d'
   AND pc.status IN ('SUCCEEDED', 'DEGRADED')
   AND jsonb_typeof(pc.payload->'producers') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(pc.payload->'producers') p
                WHERE p->>'producer' = 'DATA_REFRESH' AND p->>'status' IN ('SUCCEEDED', 'DEGRADED'))
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pc.payload->'producers') p
                    WHERE p->>'status' IN ('FAILED', 'BLOCKED', 'SKIPPED'))
 ORDER BY pc.completed_at DESC
 LIMIT 1;
