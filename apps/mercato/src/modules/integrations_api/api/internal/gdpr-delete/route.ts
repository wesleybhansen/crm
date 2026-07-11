import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * Internal server-to-server GDPR purge (coordinated Noli platform delete).
 *
 * The hub orchestrator (POST /api/admin/gdpr-delete) calls this — proven by
 * the shared NOLI_INTERNAL_SERVICE_SECRET — to erase a user's CRM data in the
 * CRM's OWN database. Public at the dispatcher level (requireAuth: false);
 * we authenticate with the shared secret instead of a Clerk/JWT session,
 * exactly like /internal/provision-key.
 *
 * Body: { noliUserId: string, email?: string }
 *
 * v1 SAFE behavior:
 *   - Resolve the Mercato user WITHOUT provisioning (raw lookup by clerk id /
 *     email — resolveClerkUserToAuthContext would create a user and gates on
 *     an entitlement a churned user no longer has).
 *   - If the user is the SOLE active user of their org → hard-delete the
 *     org's tenant-scoped CRM rows (contacts, deals, notes, tasks, email,
 *     inbox, sequences, automations, landing pages, form submissions, api
 *     keys), each table wrapped in its own try/catch and ALWAYS scoped by
 *     organization_id — never cross-org.
 *   - If other users share the org → skip the org data entirely (teammates'
 *     workspace stays intact) and only scrub the departing user's own row.
 *   - Either way the user's own `users` row is anonymized + soft-deleted and
 *     their sessions dropped.
 * Idempotent: a re-run finds nothing and returns zero counts. Never 500s on
 * partially-missing tables — delete what exists, report the rest.
 */
export const metadata = {
  path: '/internal/gdpr-delete',
  POST: { requireAuth: false },
}

/* Org-scoped tables purged when the user is the org's sole user. Each is
 * deleted `where organization_id = :orgId`; tables keyed through a parent
 * (sequence_steps, sequence_step_executions, landing_page_forms) are handled
 * separately below. Children listed before parents where FKs could bite. */
const ORG_TABLES = [
  'sequence_enrollments',
  'sequences',
  'automation_rule_logs',
  'automation_scheduled_steps',
  'automation_rules',
  // Commitments, reputation, events, affiliates (added in the 2026-07-10 batch).
  'commitments',
  'review_requests',
  'event_attendees',
  'events',
  'affiliate_referrals',
  'affiliate_payouts',
  'affiliates',
  // Landing analytics + variants (raw tables from the A/B build).
  'landing_page_daily_stats',
  'landing_page_referrers',
  'landing_page_variants',
  'landing_page_forms',
  'form_submissions',
  'landing_pages',
  // Inbox (both the knex-side unified conversations and the inbox_ops module).
  'inbox_discrepancies',
  'inbox_proposal_actions',
  'inbox_proposals',
  'inbox_settings',
  'inbox_emails',
  'inbox_conversations',
  'email_messages',
  // Contact-scoped PII + activity.
  'contact_timeline_events',
  'contact_engagement_scores',
  'contact_attachments',
  'customer_addresses',
  'customer_activities',
  'customer_comments',
  'customer_tag_assignments',
  'customer_deal_people',
  'customer_deal_companies',
  'tasks',
  'contact_notes',
  'customer_deals',
  'customer_people',
  'customer_companies',
  'customer_entities',
  'api_keys',
] as const

export async function POST(req: Request) {
  // 1. Shared-secret auth (constant-time compare on BYTE lengths — a plain
  //    string-length check can still make timingSafeEqual throw on multibyte).
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const got = Buffer.from((req.headers.get('authorization') || '').trim())
  const expected = Buffer.from(secret ? `Bearer ${secret}` : '')
  if (!secret || got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Body
  const body = (await req.json().catch(() => ({}))) as {
    noliUserId?: unknown
    email?: unknown
    soleMember?: unknown
  }
  // Hub-authoritative sole-member status (from noli-core, which sees every org
  // member regardless of which apps they opened). Whole-org purge needs BOTH
  // this and the local check.
  const hubSoleMember = body.soleMember !== false
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  let email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!noliUserId) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }

  try {
    // 3. noli-core user → Clerk id + email (the noli-core row may already be
    //    purged on a re-run — the orchestrator's email is the fallback).
    let clerkUserId: string | null = null
    try {
      const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
      const noliUser = await findNoliUserById(noliUserId)
      if (noliUser) {
        clerkUserId = noliUser.clerk_user_id ?? null
        email = noliUser.email || email
      }
    } catch {
      /* proceed with what we were given */
    }

    // No resolvable identity at all → nothing we can safely match on. (An
    // unguarded empty where() would match arbitrary users — never risk that.)
    if (!clerkUserId && !email) {
      return NextResponse.json({ ok: true, deleted: {} })
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // 4. Resolve the Mercato user WITHOUT provisioning side-effects. Prefer the
    //    Clerk id (the authoritative identity); only fall back to email when no
    //    Clerk id is known, so a recycled/stale email can't select and purge a
    //    different user's workspace.
    const userRow = (await knex('users')
      .whereNull('deleted_at')
      .where((qb) => {
        if (clerkUserId) qb.where('clerk_user_id', clerkUserId)
        else if (email) qb.where('email', email)
        else qb.whereRaw('false')
      })
      .first()
      .catch(() => null)) as
      | { id: string; organization_id: string | null; email: string }
      | null
      | undefined
    if (!userRow) {
      return NextResponse.json({ ok: true, deleted: {} })
    }

    const orgId = userRow.organization_id
    const deleted: Record<string, number> = {}

    // Scrub the departing user's own identity row: sessions dropped, email
    // anonymized (unique-safe), soft-deleted. Always self-scoped → always safe.
    const scrubOwnUser = async () => {
      try {
        deleted.sessions = await knex('sessions').where('user_id', userRow.id).del()
      } catch {
        /* table/column drift — skip */
      }
      try {
        deleted.users = await knex('users')
          .where('id', userRow.id)
          .update({
            email: `gdpr-deleted+${userRow.id}@deleted.invalid`,
            email_hash: null,
            google_sub: null,
            name: null,
            clerk_user_id: null,
            deleted_at: new Date(),
          })
      } catch {
        /* skip */
      }
    }

    if (!orgId) {
      await scrubOwnUser()
      return NextResponse.json({ ok: true, deleted })
    }

    // 5. Sole-user gate: NEVER delete a workspace other users still share.
    const activeUsers = (await knex('users')
      .where('organization_id', orgId)
      .whereNull('deleted_at')) as Array<{ id: string }>
    const others = activeUsers.filter((u) => u.id !== userRow.id)
    if (others.length > 0 || !hubSoleMember) {
      await scrubOwnUser()
      return NextResponse.json({ ok: true, skipped: 'multi-user org', deleted })
    }

    // 6. Sole user → purge the org's CRM data. Every delete is scoped by
    //    organization_id (or a parent chain that is); per-table try/catch so
    //    a missing table or FK hiccup never aborts the rest.
    const skipped: string[] = []

    // Parent-keyed children first (no organization_id column of their own).
    try {
      deleted.sequence_step_executions = await knex('sequence_step_executions')
        .whereIn(
          'enrollment_id',
          knex('sequence_enrollments').select('id').where('organization_id', orgId),
        )
        .del()
    } catch {
      skipped.push('sequence_step_executions')
    }
    try {
      deleted.sequence_steps = await knex('sequence_steps')
        .whereIn('sequence_id', knex('sequences').select('id').where('organization_id', orgId))
        .del()
    } catch {
      skipped.push('sequence_steps')
    }
    try {
      deleted.landing_page_forms = await knex('landing_page_forms')
        .whereIn(
          'landing_page_id',
          knex('landing_pages').select('id').where('organization_id', orgId),
        )
        .del()
    } catch {
      skipped.push('landing_page_forms')
    }

    for (const table of ORG_TABLES) {
      try {
        deleted[table] = await knex(table).where('organization_id', orgId).del()
      } catch {
        skipped.push(table)
      }
    }

    await scrubOwnUser()

    return NextResponse.json({
      ok: true,
      deleted,
      ...(skipped.length ? { skipped_tables: skipped } : {}),
    })
  } catch (err) {
    console.error('[internal.gdpr-delete]', err)
    return NextResponse.json({ ok: false, error: 'GDPR delete failed' }, { status: 500 })
  }
}
