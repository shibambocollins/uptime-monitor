-- SPIKE (Phase 0 step 6, remove after Phase 0): 40 monitors pointing at chaos-target.
--
-- All are seeded DISABLED. At 60 s intervals, 40 enabled monitors write about 80 rows a
-- minute, so leaving them on would hit the 100,000 rows/day D1 cap in under a day. Step 7
-- enables the right set for each run (docs/phase-0-checklist.md).
--
-- Apply: npx wrangler d1 execute uptime --remote --file scripts/phase0-seed.sql (from apps/app)
--
-- Groups, by id:
--   1-20   /delay/500  fixed 500 ms response: the P4 latency comparison (1 vs 40 per tick)
--   21-30  /scheduled  the 2-hour UP/DOWN/SLOW/FLAPPING cycle: detection and state changes
--   31-40  /ping       always 200: the healthy baseline for rows written per check (P5)

DELETE FROM monitors WHERE id BETWEEN 1 AND 40;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
INSERT INTO monitors (id, url, interval_seconds, timeout_ms, latency_threshold_ms, enabled)
SELECT
  i,
  'https://uptime-chaos-target.onrender.com' || CASE
    WHEN i <= 20 THEN '/delay/500'
    WHEN i <= 30 THEN '/scheduled'
    ELSE '/ping'
  END,
  60,
  10000,
  2000,
  0
FROM n;
