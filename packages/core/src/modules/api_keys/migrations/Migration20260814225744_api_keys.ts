import { Migration } from '@mikro-orm/migrations';

export class Migration20260814225744_api_keys extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "api_keys" add column "rate_limit_tier" text null, add column "scopes" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "api_keys" drop column "rate_limit_tier", drop column "scopes";`);
  }

}
