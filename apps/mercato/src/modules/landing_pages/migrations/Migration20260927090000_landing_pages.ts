import { Migration } from '@mikro-orm/migrations'

/* landing_page_checkouts (2026-09-25): one row per Stripe Checkout Session
 * a public checkout starts on a business's own connected Stripe account
 * (apps/mercato/src/modules/payments/services/public-checkout.ts): from an
 * offer (source 'offer', offer_id = checkout_offers.id, page_ref = the calling
 * page) or from a CRM wizard landing page (source 'landing_page').
 *
 * The Stripe webhook claims a row (pending -> processing) before recording
 * the payment and marks it paid afterwards, so webhook retries and concurrent
 * redeliveries record a payment once. The row also pins the connected account
 * the session was created on: an event from any other account is ignored.
 * No buyer personal data is stored here; the buyer becomes a contact (with
 * the usual encryption) when the webhook records the payment.
 *
 * Idempotent (IF NOT EXISTS). Self-contained. */
export class Migration20260927090000_landing_pages extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS "landing_page_checkouts" (
  "id" uuid PRIMARY KEY,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "source" text NOT NULL,
  "offer_id" uuid NULL,
  "landing_page_id" uuid NULL,
  "page_ref" text NULL,
  "item_kind" text NOT NULL,
  "item_id" uuid NOT NULL,
  "item_name" text NULL,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL,
  "mode" text NOT NULL,
  "stripe_account_id" text NOT NULL,
  "stripe_checkout_session_id" text NOT NULL,
  "checkout_url" text NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "claimed_at" timestamptz NULL,
  "paid_at" timestamptz NULL,
  "payment_record_id" uuid NULL,
  "contact_id" uuid NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "landing_page_checkouts_status_check" CHECK ("status" IN ('pending', 'processing', 'paid')),
  CONSTRAINT "landing_page_checkouts_source_check" CHECK ("source" IN ('offer', 'landing_page'))
);`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "landing_page_checkouts_session_uniq" ON "landing_page_checkouts" ("stripe_checkout_session_id");`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "landing_page_checkouts_org_created_idx" ON "landing_page_checkouts" ("organization_id", "created_at");`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "landing_page_checkouts_offer_idx" ON "landing_page_checkouts" ("offer_id") WHERE "offer_id" IS NOT NULL;`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "landing_page_checkouts";`)
  }
}
