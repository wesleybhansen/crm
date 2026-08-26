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
 * needs_you → pending bookings, inbox proposals, and manual-only consumer GTM
 *             work that is ready for the represented user
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

    // GTM data is always tenant-scoped as well as organization-scoped. Resolve
    // that second boundary from the represented Noli identity rather than
    // inferring it from a row or accepting it from the caller. A GTM scope
    // failure degrades only those queue partitions; the rest of the work feed
    // remains available and reports `partial: true`.
    let gtmTenantId: string | null = null
    let gtmScopeError: Error | null = null
    try {
      const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
      const gtmAuth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
      if (!gtmAuth?.tenantId || !gtmAuth.orgId || gtmAuth.orgId !== orgId) {
        throw new Error('GTM identity scope mismatch')
      }
      gtmTenantId = gtmAuth.tenantId
    } catch (err) {
      gtmScopeError = err instanceof Error ? err : new Error('GTM identity scope unavailable')
    }

    const unavailableGtmPartition = () =>
      Promise.reject(gtmScopeError ?? new Error('GTM identity scope unavailable'))

    const partitionNames = [
      'emails',
      'briefs',
      'automations',
      'pages',
      'leads',
      'pendingBookings',
      'proposals',
      'stallingDeals',
      'gtmConsumerLeads',
      'gtmManualDrafts',
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
        gtmTenantId
          ? knex('gtm_candidate_matches as candidate_match')
              .innerJoin('gtm_plays as play', function joinConsumerPlay() {
                this.on('play.id', '=', 'candidate_match.play_id')
                  .andOn('play.organization_id', '=', 'candidate_match.organization_id')
                  .andOn('play.tenant_id', '=', 'candidate_match.tenant_id')
              })
              .innerJoin('gtm_candidates as candidate', function joinCandidate() {
                this.on('candidate.id', '=', 'candidate_match.candidate_id')
                  .andOn('candidate.organization_id', '=', 'candidate_match.organization_id')
                  .andOn('candidate.tenant_id', '=', 'candidate_match.tenant_id')
              })
              .leftJoin('gtm_manual_outreach_drafts as manual_draft', function joinActiveDraft() {
                this.on('manual_draft.candidate_id', '=', 'candidate_match.candidate_id')
                  .andOn('manual_draft.play_id', '=', 'candidate_match.play_id')
                  .andOn('manual_draft.organization_id', '=', 'candidate_match.organization_id')
                  .andOn('manual_draft.tenant_id', '=', 'candidate_match.tenant_id')
                  .onIn('manual_draft.status', ['draft', 'copied', 'opened'])
                  .onNull('manual_draft.deleted_at')
              })
              .where('candidate_match.organization_id', orgId)
              .where('candidate_match.tenant_id', gtmTenantId)
              .where('candidate_match.fit_status', 'accepted')
              .where('play.lead_mode', 'consumer')
              .where('play.outreach_mode', 'manual_only')
              .whereNull('candidate_match.deleted_at')
              .whereNull('candidate.deleted_at')
              .whereNull('play.deleted_at')
              .whereNull('manual_draft.id')
              .orderBy('candidate_match.updated_at', 'desc')
              .limit(8)
              .select(
                'candidate_match.id',
                'candidate_match.updated_at',
                'candidate.identity',
              )
          : unavailableGtmPartition(),
        gtmTenantId
          ? knex('gtm_manual_outreach_drafts as manual_draft')
              .innerJoin('gtm_candidates as candidate', function joinDraftCandidate() {
                this.on('candidate.id', '=', 'manual_draft.candidate_id')
                  .andOn('candidate.organization_id', '=', 'manual_draft.organization_id')
                  .andOn('candidate.tenant_id', '=', 'manual_draft.tenant_id')
              })
              .where('manual_draft.organization_id', orgId)
              .where('manual_draft.tenant_id', gtmTenantId)
              .where('manual_draft.status', 'draft')
              .whereNull('manual_draft.deleted_at')
              .whereNull('candidate.deleted_at')
              .where('manual_draft.retention_expires_at', '>', new Date())
              .orderBy('manual_draft.updated_at', 'desc')
              .limit(8)
              .select('manual_draft.id', 'manual_draft.updated_at', 'candidate.identity')
          : unavailableGtmPartition(),
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
      gtmConsumerLeadsResult,
      gtmManualDraftsResult,
    ] = partitionResults
    const emails = emailsResult.status === 'fulfilled' ? emailsResult.value : []
    const briefs = briefsResult.status === 'fulfilled' ? briefsResult.value : []
    const automations = automationsResult.status === 'fulfilled' ? automationsResult.value : []
    const pages = pagesResult.status === 'fulfilled' ? pagesResult.value : []
    const leads = leadsResult.status === 'fulfilled' ? leadsResult.value : []
    const pendingBookings = pendingBookingsResult.status === 'fulfilled' ? pendingBookingsResult.value : []
    const proposals = proposalsResult.status === 'fulfilled' ? proposalsResult.value : []
    const stallingDeals = stallingDealsResult.status === 'fulfilled' ? stallingDealsResult.value : { n: 0 }
    const gtmConsumerLeads = gtmConsumerLeadsResult.status === 'fulfilled' ? gtmConsumerLeadsResult.value : []
    const gtmManualDrafts = gtmManualDraftsResult.status === 'fulfilled' ? gtmManualDraftsResult.value : []

    const iso = (v: unknown) =>
      v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()
    const events: Array<Record<string, unknown>> = []
    const candidateName = (identityValue: unknown) => {
      if (!identityValue || typeof identityValue !== 'object' || Array.isArray(identityValue)) return 'a consumer lead'
      const name = (identityValue as Record<string, unknown>).name
      return typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : 'a consumer lead'
    }

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
    for (const lead of gtmConsumerLeads as Array<Record<string, unknown>>) {
      const name = candidateName(lead.identity)
      events.push({
        id: `gtm-consumer-lead-${lead.id}`,
        at: iso(lead.updated_at),
        specialist: 'GTM Engineer',
        title: `Prepare a personal message for ${name}`,
        detail: 'Review the evidence, then copy a draft and contact them yourself.',
        url: 'https://app.noliai.com/dashboard/gtm',
        kind: 'needs_you',
      })
    }
    for (const draft of gtmManualDrafts as Array<Record<string, unknown>>) {
      const name = candidateName(draft.identity)
      events.push({
        id: `gtm-manual-draft-${draft.id}`,
        at: iso(draft.updated_at),
        specialist: 'GTM Engineer',
        title: `Personal message ready for ${name}`,
        detail: 'Copy it and open the public profile. Noli will not send it.',
        url: 'https://app.noliai.com/dashboard/gtm',
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
