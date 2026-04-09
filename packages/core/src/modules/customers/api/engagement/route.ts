/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Engagement scores + events API.
 *
 * Replaces apps/mercato/src/app/api/engagement/route.ts. Read views (hottest /
 * coldest / contact / default) preserve the response shape the dashboard,
 * contact detail, and pipeline pages already consume. PUT delegates to the
 * customers.engagement.set_score command which goes through the command bus
 * (audit-log eligible, tenant-scoped, future-undo-able).
 *
 * The reads use ORM em.find with explicit org scoping rather than knex joins
 * to keep tenant isolation enforced at the framework level. The "hottest"
 * and "coldest" views need to project a few fields off CustomerEntity (name,
 * email) so they fork the EM and use a small projected query helper.
 */
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CustomerContactEngagementScore, CustomerEngagementEvent, CustomerEntity } from '../../data/entities'
import { z } from 'zod'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.engagement.view'] },
  PUT: { requireAuth: true, requireFeatures: ['customers.engagement.manage'] },
}

const putBodySchema = z.object({
  contactId: z.string().uuid(),
  score: z.number().int(),
})

type ScoreRow = {
  id: string
  display_name: string | null
  primary_email: string | null
  score: number
  last_activity_at: Date | null
}

async function joinScoresWithContacts(
  em: EntityManager,
  orgId: string,
  tenantId: string,
  scores: CustomerContactEngagementScore[],
): Promise<ScoreRow[]> {
  if (scores.length === 0) return []
  const contactIds = scores.map((s) => s.contactId)
  const contacts = await em.find(CustomerEntity, {
    id: { $in: contactIds },
    organizationId: orgId,
    tenantId,
    deletedAt: null,
  })
  const byId = new Map(contacts.map((c) => [c.id, c]))
  const rows: ScoreRow[] = []
  for (const s of scores) {
    const c = byId.get(s.contactId)
    if (!c) continue
    rows.push({
      id: c.id,
      display_name: c.displayName,
      primary_email: c.primaryEmail ?? null,
      score: s.score,
      last_activity_at: s.lastActivityAt ?? null,
    })
  }
  return rows
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const url = new URL(req.url)
    const view = url.searchParams.get('view')
    const contactId = url.searchParams.get('contactId')

    if (view === 'hottest') {
      const scores = await em.find(
        CustomerContactEngagementScore,
        {
          organizationId: auth.orgId,
          tenantId: auth.tenantId,
          score: { $gt: 0 },
        },
        { orderBy: { score: 'desc' }, limit: 10 },
      )
      const data = await joinScoresWithContacts(em, auth.orgId, auth.tenantId, scores)
      return NextResponse.json({ ok: true, data })
    }

    if (view === 'coldest') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const scores = await em.find(
        CustomerContactEngagementScore,
        {
          organizationId: auth.orgId,
          tenantId: auth.tenantId,
          $or: [
            { lastActivityAt: { $lt: thirtyDaysAgo } },
            { lastActivityAt: null },
          ],
        },
        { orderBy: { lastActivityAt: 'asc' }, limit: 10 },
      )
      const data = await joinScoresWithContacts(em, auth.orgId, auth.tenantId, scores)
      return NextResponse.json({ ok: true, data })
    }

    if (contactId) {
      const score = await em.findOne(CustomerContactEngagementScore, {
        contactId,
        organizationId: auth.orgId,
        tenantId: auth.tenantId,
      })
      const events = await em.find(
        CustomerEngagementEvent,
        {
          contactId,
          organizationId: auth.orgId,
          tenantId: auth.tenantId,
        },
        { orderBy: { createdAt: 'desc' }, limit: 20 },
      )
      return NextResponse.json({
        ok: true,
        data: {
          score: score?.score ?? 0,
          lastActivity: score?.lastActivityAt ?? null,
          events: events.map((e) => ({
            id: e.id,
            event_type: e.eventType,
            points: e.points,
            metadata: e.metadata,
            created_at: e.createdAt,
          })),
        },
      })
    }

    // Default view: top 100 scores for the org
    const scores = await em.find(
      CustomerContactEngagementScore,
      { organizationId: auth.orgId, tenantId: auth.tenantId },
      { orderBy: { score: 'desc' }, limit: 100 },
    )
    const data = await joinScoresWithContacts(em, auth.orgId, auth.tenantId, scores)
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    console.error('[engagement.GET]', err)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const parsed = putBodySchema.parse(body)
    const container = await createRequestContainer()
    // Verify the contact belongs to this org+tenant first to keep cross-tenant
    // safety guarantees on this admin override path.
    const em = (container.resolve('em') as EntityManager).fork()
    const contact = await em.findOne(CustomerEntity, {
      id: parsed.contactId,
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
      deletedAt: null,
    })
    if (!contact) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
    }
    const commandBus = container.resolve('commandBus') as CommandBus
    await commandBus.execute('customers.engagement.set_score', {
      input: {
        tenantId: auth.tenantId,
        organizationId: auth.orgId,
        contactId: parsed.contactId,
        score: parsed.score,
      },
      ctx: { container, auth, request: req },
    })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    if (err?.issues) {
      return NextResponse.json({ ok: false, error: 'Validation failed', details: err.issues }, { status: 400 })
    }
    console.error('[engagement.PUT]', err)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  summary: 'Engagement scores and events',
  description: 'Read engagement scores by view (default | hottest | coldest | contact). PUT updates a contact score directly.',
  methods: {
    GET: {
      summary: 'Read engagement scores',
      tags: ['Customers'],
      responses: [
        { status: 200, description: 'Returns engagement data shaped by ?view= param', schema: z.object({ ok: z.literal(true), data: z.unknown() }) },
      ],
    },
    PUT: {
      summary: 'Set engagement score for a contact',
      tags: ['Customers'],
      requestBody: {
        contentType: 'application/json',
        schema: putBodySchema,
        description: 'Sets the absolute score value for a contact (admin override).',
      },
      responses: [
        { status: 200, description: 'Score updated', schema: z.object({ ok: z.literal(true) }) },
      ],
    },
  },
}
