-- SPIKE (Phase 0 soak, remove after Phase 0): 20 monitors pointing at chaos-target, for the
-- 24-hour soak of the fan-out checker (20 checks per tick = 2 CheckRunner groups).
--
-- IDs 101-120, so nothing aimed at the step 6 seed (1-40) can touch them. On 2026-10-21 a
-- leftover script's "disable 1-40" step stopped the first soak after 3 hours.
--
-- Seeded DISABLED. Start the soak with:
--   npx wrangler d1 execute uptime --remote --command "UPDATE monitors SET enabled = 1, next_run_at = 0 WHERE id BETWEEN 101 AND 120"
-- Stop it with the same command and enabled = 0.
--
-- Write cost: about 20 x 1,440 x 2.2 = 63,000 rows/day, 63% of the 100,000 cap. Disable the
-- step 6 monitors (1-40) first; they must stay off during the soak.
--
-- Groups, by id:
--   101-108  /scheduled  the 2-hour UP/DOWN/SLOW/FLAPPING cycle
--   109-116  /ping       always 200
--   117-120  /delay/500  fixed 500 ms, for latency in the tick log

DELETE FROM monitors WHERE id BETWEEN 101 AND 120;

WITH RECURSIVE n(i) AS (SELECT 101 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
INSERT INTO monitors (id, url, interval_seconds, timeout_ms, latency_threshold_ms, enabled)
SELECT
  i,
  'https://uptime-chaos-target.onrender.com' || CASE
    WHEN i <= 108 THEN '/scheduled'
    WHEN i <= 116 THEN '/ping'
    ELSE '/delay/500'
  END,
  60,
  10000,
  2000,
  0
FROM n;
