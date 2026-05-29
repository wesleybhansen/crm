import { Migration } from '@mikro-orm/migrations';

export class Migration20260529000000 extends Migration {

  override async up(): Promise<void> {
    // Multi-tenancy M5b: link a Mercato org to its noli-core organization so a
    // noli-core team shares ONE Mercato org. Nullable + unique (legacy orgs
    // stay null until lazily backfilled on the owner's next sign-in).
    this.addSql(`alter table "organizations" add column "noli_org_id" text null;`);
    this.addSql(`alter table "organizations" add constraint "organizations_noli_org_id_uniq" unique ("noli_org_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "organizations" drop constraint "organizations_noli_org_id_uniq";`);
    this.addSql(`alter table "organizations" drop column "noli_org_id";`);
  }

}
