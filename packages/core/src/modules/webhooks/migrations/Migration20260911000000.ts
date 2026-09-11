import { Migration } from '@mikro-orm/migrations'

/**
 * Chat widget typing indicators, added here so a fresh database gets them
 * after chat_conversations exists. Migration20260907180000 in the customers
 * module adds the same columns when the table already exists (production);
 * on a fresh database that module runs first and skips, and this one lands
 * them. Every statement is idempotent, so both orders converge.
 */
export class Migration20260911000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "chat_conversations" add column if not exists "visitor_typing" boolean not null default false;`)
    this.addSql(`alter table if exists "chat_conversations" add column if not exists "agent_typing" boolean not null default false;`)
    this.addSql(`alter table if exists "chat_conversations" add column if not exists "visitor_typing_at" timestamptz null;`)
    this.addSql(`alter table if exists "chat_conversations" add column if not exists "agent_typing_at" timestamptz null;`)
  }

  override async down(): Promise<void> {
    // The columns are owned by the customers migration on production; leave them.
  }
}
