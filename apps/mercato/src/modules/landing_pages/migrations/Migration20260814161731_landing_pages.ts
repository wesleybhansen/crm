import { Migration } from '@mikro-orm/migrations'

export class Migration20260814161731_landing_pages extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "form_submissions" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "form_id" uuid not null, "landing_page_id" uuid not null, "data" jsonb not null, "contact_id" uuid null, "source_ip" text null, "user_agent" text null, "referrer" text null, "created_at" timestamptz not null default now(), constraint "form_submissions_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index if not exists "form_submissions_org_page_idx" on "form_submissions" ("organization_id", "landing_page_id");`,
    )

    this.addSql(
      `create table if not exists "landing_pages" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "title" text not null, "slug" text not null, "template_id" text null, "template_category" text null, "status" text not null default 'draft', "config" jsonb null, "custom_domain" text null, "published_html" text null, "owner_user_id" uuid null, "view_count" int not null default 0, "submission_count" int not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "published_at" timestamptz null, "deleted_at" timestamptz null, constraint "landing_pages_pkey" primary key ("id"));`,
    )
    this.addSql(
      `create index if not exists "landing_pages_org_slug_idx" on "landing_pages" ("organization_id", "slug");`,
    )

    this.addSql(
      `create table if not exists "landing_page_forms" ("id" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "landing_page_id" uuid not null, "name" text not null default 'default', "fields" jsonb not null default '[]', "redirect_url" text null, "notification_email" text null, "success_message" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), constraint "landing_page_forms_pkey" primary key ("id"));`,
    )

    this.addSql(
      `alter table "landing_page_forms" add constraint "landing_page_forms_landing_page_id_foreign" foreign key ("landing_page_id") references "landing_pages" ("id") on update cascade;`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "landing_page_forms" drop constraint if exists "landing_page_forms_landing_page_id_foreign";`,
    )
  }
}
