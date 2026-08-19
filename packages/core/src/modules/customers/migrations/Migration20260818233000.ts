import { Migration } from '@mikro-orm/migrations';

export class Migration20260818233000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "customer_entities" add column if not exists "primary_email_hash" text null;`);
    this.addSql(`alter table "customer_entities" add column if not exists "primary_phone_hash" text null;`);
    this.addSql(`create index if not exists "customer_entities_org_email_hash_idx" on "customer_entities" ("organization_id", "primary_email_hash") where "primary_email_hash" is not null;`);
    this.addSql(`create index if not exists "customer_entities_org_phone_hash_idx" on "customer_entities" ("organization_id", "primary_phone_hash") where "primary_phone_hash" is not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "customer_entities_org_email_hash_idx";`);
    this.addSql(`drop index if exists "customer_entities_org_phone_hash_idx";`);
    this.addSql(`alter table "customer_entities" drop column if exists "primary_email_hash";`);
    this.addSql(`alter table "customer_entities" drop column if exists "primary_phone_hash";`);
  }

}
