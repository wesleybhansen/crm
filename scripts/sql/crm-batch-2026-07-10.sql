-- CRM final build batch (2026-07-10): signature enrichment columns +
-- commitments tracking table.
-- Idempotent: safe to re-run. Apply on the box with:
--   docker exec -i launchos-postgres psql -U <user> -d <db> < scripts/sql/crm-batch-2026-07-10.sql

-- Signature enrichment targets (filled only when currently empty).
ALTER TABLE customer_people
  ADD COLUMN IF NOT EXISTS linkedin_url text,
  ADD COLUMN IF NOT EXISTS company_name_hint text;

-- Commitments: first-class "what was promised, both directions" records.
-- Extracted by AI from email threads (and voice debriefs), surfaced in
-- meeting prep and on the contact, resolvable by the user or by Scout.
CREATE TABLE IF NOT EXISTS commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  tenant_id uuid,
  contact_id uuid,
  deal_id uuid,
  direction text NOT NULL DEFAULT 'ours',           -- 'ours' (we promised) | 'theirs' (they promised)
  description text NOT NULL,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open',              -- 'open' | 'resolved' | 'dismissed'
  source text NOT NULL DEFAULT 'email',             -- 'email' | 'debrief' | 'manual'
  source_ref text,                                  -- e.g. inbox conversation id
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS commitments_org_contact_idx ON commitments(organization_id, contact_id, status);
CREATE INDEX IF NOT EXISTS commitments_org_status_idx ON commitments(organization_id, status, due_at);

-- Schema-drift insurance: the automation-rules routes read/write these
-- columns but prod was missing them (observed 2026-07-10).
ALTER TABLE automation_rules
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS conditions jsonb,
  ADD COLUMN IF NOT EXISTS steps jsonb,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS template_id text;
