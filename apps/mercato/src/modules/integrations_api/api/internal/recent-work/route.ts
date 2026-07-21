import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { classifyRecentWorkIdentity, summarizeRecentWorkPartitions } from '../../../lib/recent-work-health'

/*
 * Internal server-to-server endpoint (Noli U-2 work feed). Returns the CRM's
 * recent completed work + items needing the user for a noli user's org,
 * normalized to the platform WorkEvent shape. Read-only; same shared-secret
 * auth as the other /internal/* endpoints.
 *
 * done      → outbound emails sent, meeting briefs prepared, automations run,
 *             landing pages published, leads captured
 * needs_you → pending bookings to confirm, pending inbox proposals
 */
export const metadata = {
  path: '/internal/recent-work',
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  const expected = secret ? `Bearer ${secret}` : ''
  if (
    !secret ||
    authHeader.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    noliUserId?: unknown
    sinceDays?: unknown
  }
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!noliUserId) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }
  const sinceDays = Math.min(Math.max(Number(body.sinceDays) || 7, 1), 30)
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)

  try {
    const { findNoliUserById, findPrimaryOrgIdForUser, isEntitled } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) return NextResponse.json({ events: [] })
    const entitled = await isEntitled(noliUser.id, 'crm')
    if (!entitled) {
      return NextResponse.json({ error: 'CRM access unavailable' }, { status: 403 })
    }
    const noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
    if (!noliOrgId) return NextResponse.json({ events: [] })

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    let organizationId: string | null = null
    const mappedOrganizations = (await knex('organizations')
      .where('noli_org_id', noliOrgId)
      .whereNull('deleted_at')
      .select('id')) as Array<{ id?: string | null }>
    if (mappedOrganizations.length > 1) throw new Error('Ambiguous Noli organization mapping')
    organizationId = mappedOrganizations[0]?.id ?? null

    // Legacy floor: before noli_org_id existed, a Clerk-linked user could own
    // an unlinked local org. Accept only one exact Clerk mapping and verify that
    // any existing org link does not contradict the authoritative Noli org.
    if (!organizationId) {
      const userOrganizations = (await knex('users')
        .where('clerk_user_id', noliUser.clerk_user_id)
        .whereNull('deleted_at')
        .whereNotNull('organization_id')
        .select('organization_id')) as Array<{ organization_id?: string | null }>
      const uniqueOrganizationIds = [
        ...new Set(userOrganizations.map((row) => row.organization_id).filter((id): id is string => Boolean(id))),
      ]
      if (uniqueOrganizationIds.length > 1) throw new Error('Ambiguous Clerk organization mapping')
      const legacyOrganizationId = uniqueOrganizationIds[0]
      if (legacyOrganizationId) {
        const legacyOrganization = (await knex('organizations')
          .where('id', legacyOrganizationId)
          .whereNull('deleted_at')
          .select('noli_org_id')
          .first()) as { noli_org_id?: string | null } | undefined
        if (legacyOrganization?.noli_org_id && legacyOrganization.noli_org_id !== noliOrgId) {
          throw new Error('Conflicting organization mapping')
        }
        if (legacyOrganization) organizationId = legacyOrganizationId
      }
    }
    const identity = classifyRecentWorkIdentity({
      hasNoliIdentity: true,
      entitled,
      organizationId,
    })
    if (identity.state === 'forbidden') {
      return NextResponse.json({ error: 'CRM access unavailable' }, { status: 403 })
    }
    if (identity.state === 'empty') return NextResponse.json({ events: [] })
    const orgId = identity.organizationId

    const partitionNames = [
      'emails',
      'briefs',
      'automations',
      'pages',
      'leads',
      'pendingBookings',
      'proposals',
      'stallingDeals',
    ] as const
    const partitionResults = await Promise.allSettled([
        knex('email_messages')
          .where('organization_id', orgId)
          .where('direction', 'outbound')
          .whereIn('status', ['sent', 'delivered', 'opened', 'clicked'])
          .where('created_at', '>=', since)
          .orderBy('created_at', 'desc')
          .limit(10)
          .select('id', 'to_address', 'subject', 'body_text', 'created_at'),
        knex('meeting_prep_briefs')
          .where('organization_id', orgId)
          .where('created_at', '>=', since)
          .orderBy('created_at', 'desc')
          .limit(5)
          .select('id', 'event_summary', 'created_at'),
        knex('customer_activities')
          .where('organization_id', orgId)
          .where('activity_type', 'automation')
          .where('created_at', '>=', since)
          .orderBy('created_at', 'desc')
          .limit(8)
          .select('id', 'subject', 'created_at'),
        knex('landing_pages')
          .where('organization_id', orgId)
          .where('status', 'published')
          .where('published_at', '>=', since)
          .orderBy('published_at', 'desc')
          .limit(5)
          .select('id', 'title', 'published_at'),
        knex('customer_activities')
          .where('organization_id', orgId)
          .where('activity_type', 'form_submission')
          .where('created_at', '>=', since)
          .orderBy('created_at', 'desc')
          .limit(8)
          .select('id', 'subject', 'created_at'),
        knex('bookings')
          .where('organization_id', orgId)
          .where('status', 'pending')
          .where('start_time', '>=', new Date())
          .orderBy('start_time', 'asc')
          .limit(8)
          .select('id', 'guest_name', 'start_time', 'created_at'),
        knex('inbox_proposals')
          .where('organization_id', orgId)
          .where('status', 'pending')
          .orderBy('created_at', 'desc')
          .limit(8)
          .select('id', 'summary', 'created_at'),
        // Watchdog: open deals that haven't moved in a week.
        knex('customer_deals')
          .where('organization_id', orgId)
          .where('status', 'open')
          .whereNull('deleted_at')
          .where('updated_at', '<', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
          .count({ n: '*' })
          .first(),
      ])
    const { failedPartitions, totalFailure } = summarizeRecentWorkPartitions(partitionNames, partitionResults)
    if (failedPartitions.length > 0) {
      console.error('[internal.recent-work] partition reads failed', { failedPartitions })
    }
    if (totalFailure) {
      return NextResponse.json({ error: 'Recent work temporarily unavailable' }, { status: 503 })
    }

    const [
      emailsResult,
      briefsResult,
      automationsResult,
      pagesResult,
      leadsResult,
      pendingBookingsResult,
      proposalsResult,
      stallingDealsResult,
    ] = partitionResults
    const emails = emailsResult.status === 'fulfilled' ? emailsResult.value : []
    const briefs = briefsResult.status === 'fulfilled' ? briefsResult.value : []
    const automations = automationsResult.status === 'fulfilled' ? automationsResult.value : []
    const pages = pagesResult.status === 'fulfilled' ? pagesResult.value : []
    const leads = leadsResult.status === 'fulfilled' ? leadsResult.value : []
    const pendingBookings = pendingBookingsResult.status === 'fulfilled' ? pendingBookingsResult.value : []
    const proposals = proposalsResult.status === 'fulfilled' ? proposalsResult.value : []
    const stallingDeals = stallingDealsResult.status === 'fulfilled' ? stallingDealsResult.value : { n: 0 }

    const iso = (v: unknown) =>
      v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()
    const events: Array<Record<string, unknown>> = []

    for (const e of emails as Array<Record<string, unknown>>) {
      events.push({
        id: `crm-email-${e.id}`,
        at: iso(e.created_at),
        specialist: 'CRM',
        title: `Followed up with ${String(e.to_address ?? 'a contact')}`,
        detail: e.subject ? String(e.subject).slice(0, 100) : undefined,
        body: e.body_text ? String(e.body_text).slice(0, 4000) : undefined,
        kind: 'done',
        minutes: 8,
      })
    }
    for (const b of briefs as Array<Record<string, unknown>>) {
      events.push({
        id: `crm-brief-${b.id}`,
        at: iso(b.created_at),
        specialist: 'CRM',
        title: 'Prepared a meeting brief',
        detail: b.event_summary ? String(b.event_summary).slice(0, 100) : undefined,
        kind: 'done',
        minutes: 20,
      })
    }
    for (const a of automations as Array<Record<string, unknown>>) {
      events.push({
        id: `crm-auto-${a.id}`,
        at: iso(a.created_at),
        specialist: 'CRM',
        title: 'Ran a follow-up automation',
        detail: a.subject ? String(a.subject).slice(0, 100) : undefined,
        kind: 'done',
        minutes: 6,
      })
    }
    for (const p of pages as Array<Record<string, unknown>>) {
      events.push({
        id: `crm-page-${p.id}`,
        at: iso(p.published_at),
        specialist: 'CRM',
        title: `Published landing page: ${String(p.title ?? '').slice(0, 100)}`,
        kind: 'done',
        minutes: 45,
      })
    }
    for (const l of leads as Array<Record<string, unknown>>) {
      events.push({
        id: `crm-lead-${l.id}`,
        at: iso(l.created_at),
        specialist: 'CRM',
        title: 'Captured a new lead',
        detail: l.subject ? String(l.subject).slice(0, 100) : undefined,
        kind: 'done',
        minutes: 4,
      })
    }
    for (const b of pendingBookings as Array<Record<string, unknown>>) {
      events.push({
        id: `crm-booking-${b.id}`,
        at: iso(b.created_at),
        specialist: 'CRM',
        title: `Confirm a booking from ${String(b.guest_name ?? 'a guest')}`,
        detail: new Date(String(b.start_time)).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
        url: 'https://crm.noliai.com/backend/calendar',
        kind: 'needs_you',
      })
    }
    for (const p of proposals as Array<Record<string, unknown>>) {
      events.push({
        id: `crm-proposal-${p.id}`,
        at: iso(p.created_at),
        specialist: 'CRM',
        title: 'Review a proposed action from your inbox',
        detail: p.summary ? String(p.summary).slice(0, 100) : undefined,
        url: 'https://crm.noliai.com/backend',
        kind: 'needs_you',
      })
    }
    const stalled = Number((stallingDeals as { n?: string | number } | undefined)?.n ?? 0)
    if (stalled > 0) {
      events.push({
        id: `crm-stalled-${orgId}`,
        at: new Date().toISOString(),
        specialist: 'CRM',
        title: `${stalled} open deal${stalled === 1 ? ' has' : 's have'} not moved in a week`,
        detail: 'Worth a nudge or a stage update.',
        url: 'https://crm.noliai.com/backend',
        kind: 'needs_you',
      })
    }

    return NextResponse.json({ events, partial: failedPartitions.length > 0 })
  } catch (err) {
    console.error('[internal.recent-work] failed', {
      name: err instanceof Error ? err.name : 'unknown',
    })
    return NextResponse.json({ error: 'Recent work temporarily unavailable' }, { status: 503 })
  }
}
