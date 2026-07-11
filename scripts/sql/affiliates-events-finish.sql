-- ==============================================================================
-- Affiliate finish-work + Event QR sign-in kiosk — schema additions.
--
-- These are legacy raw-knex tables (no mercato entity, not in any migration).
-- The live production database is their source of truth, so this file is the
-- tracked record of columns/indexes applied directly on the box with:
--   docker exec launchos-postgres psql -U crm -d crm -f /path/to/affiliates-events-finish.sql
-- Every statement is idempotent (IF NOT EXISTS) so it can be re-run on any
-- environment safely.
-- ==============================================================================

-- ── Affiliates: tiered commissions ──
-- affiliate_campaigns.tiers: JSON array of { name, minConversions, commissionRate }.
-- At conversion time the highest tier whose minConversions <= the affiliate's
-- total_conversions (BEFORE the new conversion) wins; its commissionRate is a
-- percentage of the sale. NULL / empty array = no tiers, existing rate logic.
ALTER TABLE affiliate_campaigns ADD COLUMN IF NOT EXISTS tiers jsonb DEFAULT NULL;

-- ── Events: kiosk sign-in ──
-- events.kiosk_token: unguessable token that addresses the public kiosk page
-- (/api/crm-events/kiosk/[token]). NULL = kiosk not enabled for the event.
ALTER TABLE events ADD COLUMN IF NOT EXISTS kiosk_token text;

-- event_attendees check-in tracking. checkin_source: 'kiosk' | 'manual' | 'qr'.
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS checked_in_at timestamptz NULL;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS checkin_source text NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendees_event_checkin
  ON event_attendees (event_id, checked_in_at);
