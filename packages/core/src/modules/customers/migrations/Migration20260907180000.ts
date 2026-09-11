import { Migration } from '@mikro-orm/migrations'

/**
 * Schema the "tier 7" route move assumed but never created in this fork:
 * the team feature (organization owner, seat cap, invites) and the chat
 * widget typing indicators. Until now /api/team answered 500 (Settings page)
 * and /api/chat/conversations answered 500 (Chat Widgets page). Found by the
 * 2026-09-07 end-to-end pass.
 */
export class Migration20260907180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "organizations" add column if not exists "owner_user_id" uuid null;`)
    this.addSql(`alter table "organizations" add column if not exists "max_seats" int null;`)
    // The earliest surviving member of each organization is its owner.
    this.addSql(`update "organizations" o set "owner_user_id" = first_user.id from (select distinct on (u.organization_id) u.organization_id, u.id from "users" u where u.deleted_at is null order by u.organization_id, u.created_at asc) first_user where first_user.organization_id = o.id and o."owner_user_id" is null;`)
    this.addSql(`create table if not exists "team_invites" ("id" uuid not null, "organization_id" uuid not null, "tenant_id" uuid not null, "email" text not null, "role" text not null, "token" text not null, "status" text not null default 'pending', "invited_by" uuid null, "expires_at" timestamptz not null, "created_at" timestamptz not null default now(), constraint "team_invites_pkey" primary key ("id"));`)
    this.addSql(`create unique index if not exists "team_invites_token_unique" on "team_invites" ("token");`)
    this.addSql(`create index if not exists "team_invites_org_status_idx" on "team_invites" ("organization_id", "status");`)
    this.addSql(`alter table if exists "chat_conversations" add column if not exists "visitor_typing" boolean not null default false;`)
    this.addSql(`alter table if exists "chat_conversations" add column if not exists "agent_typing" boolean not null default false;`)
    this.addSql(`alter table if exists "chat_conversations" add column if not exists "visitor_typing_at" timestamptz null;`)
    this.addSql(`alter table if exists "chat_conversations" add column if not exists "agent_typing_at" timestamptz null;`)
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "chat_conversations" drop column if exists "agent_typing_at";`)
    this.addSql(`alter table if exists "chat_conversations" drop column if exists "visitor_typing_at";`)
    this.addSql(`alter table if exists "chat_conversations" drop column if exists "agent_typing";`)
    this.addSql(`alter table if exists "chat_conversations" drop column if exists "visitor_typing";`)
    this.addSql(`drop table if exists "team_invites";`)
    this.addSql(`alter table "organizations" drop column if exists "max_seats";`)
    this.addSql(`alter table "organizations" drop column if exists "owner_user_id";`)
  }
}
