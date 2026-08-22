import { Migration } from '@mikro-orm/migrations';

export class Migration20260822171311_integrations_api extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "integrations_api_ams_commands" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "source_organization_id" uuid not null, "principal_ref" uuid not null, "command_id" uuid not null, "command_type" text not null, "command_ref" text not null, "idempotency_digest" text not null, "nonce_digest" text not null, "canonical_hash" text not null, "payload_digest" text not null, "issuer" text not null, "audience" text not null, "contract_version" text not null, "schema_version" int not null, "key_version" text not null, "issued_at" timestamptz not null, "expires_at" timestamptz not null, "state" text not null default 'shadow_validated', "safe_failure_code" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "integrations_api_ams_commands_pkey" primary key ("id"));`);
    this.addSql(`create index "integrations_api_ams_commands_org_tenant_idx" on "integrations_api_ams_commands" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "integrations_api_ams_commands" add constraint "integrations_api_ams_commands_nonce_unique" unique ("organization_id", "tenant_id", "nonce_digest");`);
    this.addSql(`alter table "integrations_api_ams_commands" add constraint "integrations_api_ams_commands_idempotency_unique" unique ("organization_id", "tenant_id", "idempotency_digest");`);
    this.addSql(`alter table "integrations_api_ams_commands" add constraint "integrations_api_ams_commands_command_unique" unique ("organization_id", "tenant_id", "command_id");`);

    this.addSql(`create table "integrations_api_ams_events" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "source_organization_id" uuid not null, "event_id" uuid not null, "event_type" text not null, "contract_version" text not null, "schema_version" int not null, "issuer" text not null, "audience" text not null, "canonical_hash" text not null, "payload_digest" text not null, "nonce_digest" text not null, "key_version" text not null, "occurred_at" timestamptz not null, "expires_at" timestamptz not null, "state" text not null default 'pending', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "integrations_api_ams_events_pkey" primary key ("id"));`);
    this.addSql(`create index "integrations_api_ams_events_org_tenant_idx" on "integrations_api_ams_events" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "integrations_api_ams_events" add constraint "integrations_api_ams_events_nonce_unique" unique ("organization_id", "tenant_id", "nonce_digest");`);
    this.addSql(`alter table "integrations_api_ams_events" add constraint "integrations_api_ams_events_event_unique" unique ("organization_id", "tenant_id", "event_id");`);

    this.addSql(`create table "integrations_api_consent_versions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "crm_contact_ref" text not null, "purpose" text not null, "version" bigint not null, "state" text not null, "policy_ref" text not null, "source_ref" text not null, "effective_at" timestamptz not null, "expires_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "integrations_api_consent_versions_pkey" primary key ("id"));`);
    this.addSql(`create index "integrations_api_consent_versions_org_tenant_idx" on "integrations_api_consent_versions" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "integrations_api_consent_versions" add constraint "integrations_api_consent_versions_subject_unique" unique ("organization_id", "tenant_id", "crm_contact_ref", "purpose", "version");`);

    this.addSql(`create table "integrations_api_suppression_versions" ("id" uuid not null default gen_random_uuid(), "organization_id" uuid not null, "tenant_id" uuid not null, "crm_contact_ref" text not null, "channel" text not null, "version" bigint not null, "active" boolean not null, "reason_code" text not null, "effective_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "integrations_api_suppression_versions_pkey" primary key ("id"));`);
    this.addSql(`create index "integrations_api_suppression_versions_org_tenant_idx" on "integrations_api_suppression_versions" ("organization_id", "tenant_id");`);
    this.addSql(`alter table "integrations_api_suppression_versions" add constraint "integrations_api_suppression_versions_subject_unique" unique ("organization_id", "tenant_id", "crm_contact_ref", "channel", "version");`);
  }

}
