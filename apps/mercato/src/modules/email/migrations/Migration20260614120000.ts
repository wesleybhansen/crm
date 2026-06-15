import { Migration } from '@mikro-orm/migrations';

// Adds a `purpose` tag to email connections so a mailbox can be dedicated to the
// Customer Service tab (purpose = 'customer_service') separately from the user's
// personal Inbox mailbox (purpose = null). The unique connection index is
// widened to include `purpose` so a user can have both a personal SMTP/IMAP
// inbox AND a dedicated support SMTP/IMAP inbox without colliding.
//
// All statements are idempotent because email_connections may be created at
// runtime by an earlier idempotent migration.
export class Migration20260614120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "email_connections" add column if not exists "purpose" text null;`);
    // Replace the old (organization_id, user_id, provider) unique index with one
    // that also keys on purpose, so personal vs customer_service mailboxes of the
    // same provider can coexist for a single user.
    this.addSql(`drop index if exists "email_conn_org_user_provider_idx";`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_indexes where indexname = 'email_conn_org_user_provider_purpose_idx') then create unique index "email_conn_org_user_provider_purpose_idx" on "email_connections" ("organization_id", "user_id", "provider", "purpose"); end if; end $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "email_conn_org_user_provider_purpose_idx";`);
    this.addSql(`do $$ begin if not exists (select 1 from pg_indexes where indexname = 'email_conn_org_user_provider_idx') then create unique index "email_conn_org_user_provider_idx" on "email_connections" ("organization_id", "user_id", "provider"); end if; end $$;`);
    this.addSql(`alter table "email_connections" drop column if exists "purpose";`);
  }

}
