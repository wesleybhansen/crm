-- Reputation management: review link settings + review request log (2026-07-10).
-- Idempotent: safe to re-run. Apply on the box with:
--   docker exec -i launchos-postgres psql -U <user> -d <db> < scripts/sql/reputation.sql
--
-- business_profiles gains the org's public review link (Google/Facebook/Yelp/other).
-- review_requests records every review-request email that actually went out, so the
-- Reputation page can show sent counts and a recent history. Column types follow the
-- house convention (uuid tenant/org/contact ids, timestamptz timestamps) used by
-- sibling tables like contact_notes and customer_pipeline_automation_runs.

ALTER TABLE business_profiles
  ADD COLUMN IF NOT EXISTS review_url text,
  ADD COLUMN IF NOT EXISTS review_platform text; -- 'google' | 'facebook' | 'yelp' | 'other'

CREATE TABLE IF NOT EXISTS review_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'email',
  status text NOT NULL DEFAULT 'sent',
  rule_id uuid NULL, -- automation_rules.id when sent by an automation; null for manual sends
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_requests_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS review_requests_org_sent_idx
  ON review_requests (organization_id, sent_at DESC);
