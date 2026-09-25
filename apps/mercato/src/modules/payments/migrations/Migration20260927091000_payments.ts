import { Migration } from '@mikro-orm/migrations'

/* checkout_offers (2026-09-25): what a business's marketing pages may sell.
 *
 * A page (AMS on pages.noliai.com or the business's own domain, or a CRM
 * page) starts a Stripe Checkout by naming an offer id:
 * POST /api/payments/public/offers/{id}/checkout. The offer fixes the product
 * or course (so the price comes from the business's own product row), the
 * billing mode, and the hosts a buyer may be returned to after paying
 * (success_url_hosts). allowed_upsell_offer_ids lists the offers a page may
 * present as one-click upsells after this one. Exactly one of product_id /
 * course_id is set. Sessions are created on the business's own connected
 * Stripe account (services/public-checkout.ts).
 *
 * Idempotent (IF NOT EXISTS). Self-contained. */
export class Migration20260927091000_payments extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS "checkout_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NULL,
  "product_id" uuid NULL,
  "course_id" uuid NULL,
  "mode" text NOT NULL DEFAULT 'payment',
  "success_url_hosts" text[] NOT NULL DEFAULT '{}'::text[],
  "allowed_upsell_offer_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[],
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "checkout_offers_mode_check" CHECK ("mode" IN ('payment', 'subscription')),
  CONSTRAINT "checkout_offers_item_check" CHECK (("product_id" IS NULL) <> ("course_id" IS NULL))
);`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "checkout_offers_org_idx" ON "checkout_offers" ("organization_id", "tenant_id", "active");`)
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "checkout_offers";`)
  }
}
