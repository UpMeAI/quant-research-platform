-- R2_DAY_EXPORT_READINESS_V2 (ops-coord 2026-11-23; plan-coord ruling 14:24 option (b)). V1 cf8380f0 is unchanged and superseded for the exporter.
-- Returns exactly one row (trade_date|ready_via|n_prices|n_basic|n_adj|n_cov) iff trading day :'d' (YYYY-MM-DD) is ready, else no row:
--   (1) prices_daily, market_daily_basic_observation and adjustment_factor_observation each have >= 4000 distinct non-BJ security_id with trade_date = d
--       (counted at probe time);
--   (2) a security_suspension_day_coverage row exists for d;
--   (3) POST_CLOSE(d) passes V1 (status SUCCEEDED|DEGRADED, DATA_REFRESH SUCCEEDED|DEGRADED, no producer FAILED|BLOCKED|SKIPPED)
--       OR the next open day's PREMARKET (slot '<next>:PREMARKET:d') has DATA_REFRESH SUCCEEDED|DEGRADED.
-- ready_via = POST_CLOSE_D when (3) holds through POST_CLOSE(d), else NEXT_PREMARKET. Read-only, SELECT only; re-run on every tick, never cached.
-- Run: psql -X -At -v ON_ERROR_STOP=1 -v d=YYYY-MM-DD in a session with default_transaction_read_only=on.
SELECT x.d AS trade_date,
       CASE WHEN x.pc_ok THEN 'POST_CLOSE_D' ELSE 'NEXT_PREMARKET' END AS ready_via,
       x.n_prices, x.n_basic, x.n_adj, x.n_cov
  FROM (SELECT :'d'::date AS d,
               (SELECT count(DISTINCT security_id) FROM prices_daily
                 WHERE trade_date = :'d'::date AND security_id NOT LIKE '%.BJ') AS n_prices,
               (SELECT count(DISTINCT security_id) FROM market_daily_basic_observation
                 WHERE trade_date = :'d'::date AND security_id NOT LIKE '%.BJ') AS n_basic,
               (SELECT count(DISTINCT security_id) FROM adjustment_factor_observation
                 WHERE trade_date = :'d'::date AND security_id NOT LIKE '%.BJ') AS n_adj,
               (SELECT count(*) FROM security_suspension_day_coverage
                 WHERE trade_date = :'d'::date) AS n_cov,
               EXISTS (SELECT 1 FROM pipeline_completion pc
                        WHERE pc.cadence = 'DAILY'
                          AND pc.slot = :'d' || ':POST_CLOSE:' || :'d'
                          AND pc.status IN ('SUCCEEDED', 'DEGRADED')
                          AND jsonb_typeof(pc.payload->'producers') = 'array'
                          AND EXISTS (SELECT 1 FROM jsonb_array_elements(pc.payload->'producers') p
                                       WHERE p->>'producer' = 'DATA_REFRESH' AND p->>'status' IN ('SUCCEEDED', 'DEGRADED'))
                          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pc.payload->'producers') p
                                           WHERE p->>'status' IN ('FAILED', 'BLOCKED', 'SKIPPED'))) AS pc_ok,
               EXISTS (SELECT 1 FROM pipeline_completion pm
                        WHERE pm.cadence = 'DAILY'
                          AND pm.slot LIKE '%:PREMARKET:' || :'d'
                          AND split_part(pm.slot, ':', 1) > :'d'
                          AND jsonb_typeof(pm.payload->'producers') = 'array'
                          AND EXISTS (SELECT 1 FROM jsonb_array_elements(pm.payload->'producers') p
                                       WHERE p->>'producer' = 'DATA_REFRESH' AND p->>'status' IN ('SUCCEEDED', 'DEGRADED'))) AS pm_ok
       ) x
 WHERE x.n_prices >= 4000 AND x.n_basic >= 4000 AND x.n_adj >= 4000
   AND x.n_cov >= 1
   AND (x.pc_ok OR x.pm_ok);
