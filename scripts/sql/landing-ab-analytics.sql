-- Landing pages: A/B testing + deeper analytics + custom domain lookup support.
-- Idempotent: safe to run multiple times.
--
-- Apply on the box:
--   docker exec -i launchos-postgres psql -U $POSTGRES_USER -d $POSTGRES_DB < scripts/sql/landing-ab-analytics.sql
--
-- Notes:
-- - landing_page_daily_stats.variant_id uses the all-zeros UUID
--   ('00000000-0000-0000-0000-000000000000') to represent the control arm so a
--   plain unique index on (landing_page_id, variant_id, day) works with ON CONFLICT.
-- - These columns/tables are intentionally NOT modeled as MikroORM entities;
--   routes access them with raw knex.

-- A/B test enable flag on the page itself
ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS ab_enabled boolean NOT NULL DEFAULT false;

-- Speeds up custom-domain lookups on the public by-domain route
CREATE INDEX IF NOT EXISTS landing_pages_custom_domain_idx
  ON landing_pages (custom_domain)
  WHERE custom_domain IS NOT NULL;

-- A/B variants (the "B" arms; control is the landing_pages row itself)
CREATE TABLE IF NOT EXISTS landing_page_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  landing_page_id uuid NOT NULL,
  name text NOT NULL,
  published_html text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  weight int NOT NULL DEFAULT 50,
  status text NOT NULL DEFAULT 'active',
  view_count int NOT NULL DEFAULT 0,
  submission_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS landing_page_variants_page_idx
  ON landing_page_variants (landing_page_id);

-- Per-day view/submission counters per arm (control arm = all-zeros variant_id)
CREATE TABLE IF NOT EXISTS landing_page_daily_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  landing_page_id uuid NOT NULL,
  variant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  day date NOT NULL,
  views int NOT NULL DEFAULT 0,
  submissions int NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS landing_page_daily_stats_page_variant_day_uq
  ON landing_page_daily_stats (landing_page_id, variant_id, day);

-- Referrer hostname counts per page (upserted from the Referer header on views)
CREATE TABLE IF NOT EXISTS landing_page_referrers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  landing_page_id uuid NOT NULL,
  host text NOT NULL,
  count int NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS landing_page_referrers_page_host_uq
  ON landing_page_referrers (landing_page_id, host);
