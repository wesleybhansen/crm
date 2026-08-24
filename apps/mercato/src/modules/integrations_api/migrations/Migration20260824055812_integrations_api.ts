import { Migration } from '@mikro-orm/migrations';

export class Migration20260824055812_integrations_api extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "integrations_api_ams_events" add column "projection_digest" text null, add column "signed_envelope" jsonb null;`);
    this.addSql(`alter table "integrations_api_ams_events" alter column "state" type text using ("state"::text);`);
    this.addSql(`alter table "integrations_api_ams_events" alter column "state" set default 'held_dark';`);
    this.addSql(`alter table "integrations_api_ams_events" add constraint "integrations_api_ams_events_projection_unique" unique ("organization_id", "tenant_id", "projection_digest");`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "integrations_api_ams_events" drop constraint "integrations_api_ams_events_projection_unique";`);
    this.addSql(`alter table "integrations_api_ams_events" drop column "projection_digest", drop column "signed_envelope";`);

    this.addSql(`alter table "integrations_api_ams_events" alter column "state" type text using ("state"::text);`);
    this.addSql(`alter table "integrations_api_ams_events" alter column "state" set default 'pending';`);
  }

}
