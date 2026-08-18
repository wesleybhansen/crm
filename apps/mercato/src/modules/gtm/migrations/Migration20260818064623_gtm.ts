import { Migration } from '@mikro-orm/migrations';

export class Migration20260818064623_gtm extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "gtm_ai_telemetry" add column "token_usage_known" boolean not null default true;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "gtm_ai_telemetry" drop column "token_usage_known";`);
  }

}
