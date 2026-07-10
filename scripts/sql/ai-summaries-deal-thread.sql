-- Deal + thread AI summaries (T2 deferral, 2026-07-09).
-- Idempotent: safe to re-run. Apply on the box with:
--   docker exec -i launchos-postgres psql -U <user> -d <db> < scripts/sql/ai-summaries-deal-thread.sql
--
-- Mirrors the existing customer_entities.ai_summary / ai_summary_at pattern
-- (contacts/[id]/summary). Summaries are incrementally maintained: refreshed
-- lazily when the underlying activity is newer than ai_summary_at, and
-- injected into draft-reply prompts, meeting-prep briefs, and Scout context.

ALTER TABLE customer_deals
  ADD COLUMN IF NOT EXISTS ai_summary text,
  ADD COLUMN IF NOT EXISTS ai_summary_at timestamptz;

ALTER TABLE inbox_conversations
  ADD COLUMN IF NOT EXISTS ai_summary text,
  ADD COLUMN IF NOT EXISTS ai_summary_at timestamptz;
