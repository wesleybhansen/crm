import { Migration } from '@mikro-orm/migrations';

/**
 * CRM Phase 1.4 — Clerk auth migration, schema prep.
 *
 * Adds nullable `clerk_user_id` to `users` (with unique partial index so
 * two rows can't claim the same Clerk identity). Also seeds a single
 * shared "Noli" tenant if no tenants exist yet — Mercato is multi-tenant
 * by design, but Noli ships as single-tenant for now (one shared tenant,
 * one Mercato Organization per Noli user). The seed is idempotent: if a
 * tenant already exists the INSERT is a no-op, so this migration is safe
 * to run on the existing prod box where Wesley's tenant was created
 * during the original Mercato `setupInitialTenant()` flow.
 *
 * After running, capture the Noli tenant id with:
 *   SELECT id, name FROM tenants ORDER BY created_at ASC LIMIT 1;
 * and put it in `.env.production` as NOLI_TENANT_ID.
 */
export class Migration20260509120000 extends Migration {

  override async up(): Promise<void> {
    // 1. Add clerk_user_id column to users (idempotent via duplicate_column guard).
    this.addSql(`DO $$ BEGIN ALTER TABLE "users" ADD COLUMN "clerk_user_id" text null; EXCEPTION WHEN duplicate_column THEN NULL; END $$;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "users_clerk_user_id_unique" ON "users" ("clerk_user_id") WHERE "clerk_user_id" IS NOT NULL;`);

    // 2. Seed the single shared Noli tenant if no tenants exist.
    //    (RAISE NOTICE prints the tenant id into psql output for capture.)
    this.addSql(`
      DO $$
      DECLARE
        existing_count int;
        noli_tenant_id uuid;
      BEGIN
        SELECT COUNT(*) INTO existing_count FROM "tenants" WHERE "deleted_at" IS NULL;
        IF existing_count = 0 THEN
          INSERT INTO "tenants" ("name", "is_active", "created_at", "updated_at")
          VALUES ('Noli', true, now(), now())
          RETURNING "id" INTO noli_tenant_id;
          RAISE NOTICE 'Seeded Noli tenant: %', noli_tenant_id;
        ELSE
          SELECT "id" INTO noli_tenant_id FROM "tenants" WHERE "deleted_at" IS NULL ORDER BY "created_at" ASC LIMIT 1;
          RAISE NOTICE 'Existing tenant found, skipping seed. First tenant id: %', noli_tenant_id;
        END IF;
      END $$;
    `);
  }

  override async down(): Promise<void> {
    // Down only reverses the schema change. We do NOT delete the seeded
    // Noli tenant — by the time you'd want to roll this back, real
    // Organizations and Users are already pointing at it.
    this.addSql(`DROP INDEX IF EXISTS "users_clerk_user_id_unique";`);
    this.addSql(`ALTER TABLE "users" DROP COLUMN IF EXISTS "clerk_user_id";`);
  }

}
