import { Migration } from '@mikro-orm/migrations';

/* Contact dedup lost its unique constraint when contacts became encrypted.
 * customer_entities_org_email_uniq is on (organization_id, lower(primary_email)),
 * but primary_email now holds AES-GCM ciphertext with a random IV, so the same
 * address never collides and the 23505 race adoption in contact-write.ts can
 * never fire. The hash column is the real identity now; make it unique per
 * organization (partial, so legacy rows without a hash are untouched). */
export class Migration20260910090000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`drop index if exists "customer_entities_org_email_hash_idx";`);
    this.addSql(`create unique index if not exists "customer_entities_org_email_hash_uniq" on "customer_entities" ("organization_id", "primary_email_hash") where "primary_email_hash" is not null and "deleted_at" is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "customer_entities_org_email_hash_uniq";`);
    this.addSql(`create index if not exists "customer_entities_org_email_hash_idx" on "customer_entities" ("organization_id", "primary_email_hash") where "primary_email_hash" is not null;`);
  }

}
