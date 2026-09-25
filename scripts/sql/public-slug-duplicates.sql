-- READ-ONLY. Lists public slugs/tokens that are duplicated across rows, i.e.
-- the values that would make the 20260924200000 global unique-index
-- migrations (calendar, forms, courses, landing_pages, email, customers)
-- fail. Every Noli customer shares one tenant and these links resolve with no
-- organisation in the URL, so each value must be unique across ALL orgs.
-- Run before deploying:  psql "$DATABASE_URL" -f scripts/sql/public-slug-duplicates.sql
-- Each row: table, column, duplicated value, row count, organisations involved.
-- A table that does not exist in this database makes that SELECT error; drop
-- that block and re-run.

SELECT 'booking_pages' AS tbl, 'slug' AS col, slug AS value, count(*) AS n, array_agg(DISTINCT organization_id) AS orgs
  FROM booking_pages GROUP BY slug HAVING count(*) > 1
UNION ALL
SELECT 'bookings', 'confirmation_token', confirmation_token, count(*), array_agg(DISTINCT organization_id)
  FROM bookings WHERE confirmation_token IS NOT NULL GROUP BY confirmation_token HAVING count(*) > 1
UNION ALL
SELECT 'forms', 'slug', slug, count(*), array_agg(DISTINCT organization_id)
  FROM forms GROUP BY slug HAVING count(*) > 1
UNION ALL
SELECT 'courses', 'slug', slug, count(*), array_agg(DISTINCT organization_id)
  FROM courses WHERE deleted_at IS NULL GROUP BY slug HAVING count(*) > 1
UNION ALL
SELECT 'landing_pages', 'slug', slug, count(*), array_agg(DISTINCT organization_id)
  FROM landing_pages WHERE deleted_at IS NULL GROUP BY slug HAVING count(*) > 1
UNION ALL
SELECT 'funnels', 'slug', slug, count(*), array_agg(DISTINCT organization_id)
  FROM funnels GROUP BY slug HAVING count(*) > 1
UNION ALL
SELECT 'email_messages', 'tracking_id', tracking_id::text, count(*), array_agg(DISTINCT organization_id)
  FROM email_messages WHERE tracking_id IS NOT NULL GROUP BY tracking_id HAVING count(*) > 1
UNION ALL
SELECT 'surveys', 'slug', slug, count(*), array_agg(DISTINCT organization_id)
  FROM surveys GROUP BY slug HAVING count(*) > 1
UNION ALL
SELECT 'chat_widgets', 'slug', slug, count(*), array_agg(DISTINCT organization_id)
  FROM chat_widgets WHERE slug IS NOT NULL GROUP BY slug HAVING count(*) > 1
UNION ALL
SELECT 'events', 'slug', slug, count(*), array_agg(DISTINCT organization_id)
  FROM events WHERE deleted_at IS NULL GROUP BY slug HAVING count(*) > 1
UNION ALL
SELECT 'events', 'kiosk_token', kiosk_token, count(*), array_agg(DISTINCT organization_id)
  FROM events WHERE kiosk_token IS NOT NULL AND deleted_at IS NULL GROUP BY kiosk_token HAVING count(*) > 1
UNION ALL
SELECT 'affiliates', 'affiliate_code', affiliate_code, count(*), array_agg(DISTINCT organization_id)
  FROM affiliates GROUP BY affiliate_code HAVING count(*) > 1
ORDER BY 1, 2, 3;
