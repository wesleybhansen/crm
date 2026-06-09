-- ==============================================================================
-- S.8 pre-launch sweep — partial unique indexes that make find-then-insert
-- dedup paths race-proof at the database level.
--
-- These three tables are legacy raw-knex tables (no mercato entity, not in any
-- migration). The live production database is their source of truth, so this
-- file is the tracked record of indexes that were applied directly with:
--   docker exec launchos-postgres psql -U crm -d crm -f <this file>
-- Every statement is idempotent (IF NOT EXISTS) and CONCURRENTLY so it can be
-- re-run on any environment without locking the table.
--
-- Verified zero pre-existing duplicates before applying (2026-06-09).
-- Application code adopts the winner on a 23505 conflict in the public
-- form-submit paths and the inbox-conversation upsert.
-- ==============================================================================

-- HIGH-4: Stripe checkout webhook idempotency. One payment_records row per
-- (org, checkout session). With this in place the webhook's SELECT-then-INSERT
-- race resolves correctly: the losing concurrent redelivery throws 23505 -> the
-- handler returns non-2xx -> Stripe retries -> the already-processed guard wins.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS payment_records_org_session_uniq
  ON payment_records (organization_id, stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

-- MED-2: Contact dedup. One contact per (org, lowercased email) among live rows.
-- Soft-deleted rows are excluded so a re-created contact after deletion is fine.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS customer_entities_org_email_uniq
  ON customer_entities (organization_id, lower(primary_email))
  WHERE primary_email IS NOT NULL AND primary_email <> '' AND deleted_at IS NULL;

-- MED-4: Unified inbox dedup. One conversation per (org, contact). Contactless
-- conversations (anonymous email/phone/chat) are excluded and keep their
-- application-level matching.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS inbox_conversations_org_contact_uniq
  ON inbox_conversations (organization_id, contact_id)
  WHERE contact_id IS NOT NULL;
