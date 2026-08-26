import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { projectCosMetrics } from '../../../lib/cos-metrics'

export const dynamic = 'force-dynamic'

export const metadata = {
  path: '/internal/cos-metrics',
  POST: { requireAuth: false },
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Internal Integrations',
  summary: 'Read bounded CRM metrics for the Noli Chief of Staff',
  methods: {
    POST: {
      summary: 'Return tenant-scoped deal and contact counts without row data',
      tags: ['Internal Integrations'],
    },
  },
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET ?? ''
  const authorization = (req.headers.get('authorization') ?? '').trim()
  if (!secret || !safeEqual(authorization, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { noliUserId?: unknown; organizationId?: unknown }
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  const organizationId = typeof body.organizationId === 'string' ? body.organizationId.trim() : ''
  const boundedId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value)
  if (!boundedId(noliUserId) || !boundedId(organizationId)) {
    return NextResponse.json({ ok: false, error: 'Invalid identity scope' }, { status: 400 })
  }

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'CRM access unavailable' }, { status: 403 })
    }
    if (String(auth.orgId) !== organizationId) {
      return NextResponse.json({ ok: false, error: 'CRM access unavailable' }, { status: 403 })
    }
    const tenantId = String(auth.tenantId)

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const [deals, contacts] = await Promise.all([
      knex('customer_deals')
        .where('organization_id', organizationId)
        .where('tenant_id', tenantId)
        .whereNull('deleted_at')
        .select(
          knex.raw('count(*) as total_deals'),
          knex.raw("count(*) filter (where status = 'open') as open_deals"),
        )
        .first(),
      knex('customer_entities')
        .where('organization_id', organizationId)
        .where('tenant_id', tenantId)
        .whereNull('deleted_at')
        .count({ total_contacts: '*' })
        .first(),
    ])

    return NextResponse.json(
      {
        ok: true,
        data: projectCosMetrics(deals as Record<string, unknown>, contacts as Record<string, unknown>),
        asOf: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    )
  } catch {
    console.error('[internal.cos-metrics] cos_metrics_unavailable')
    return NextResponse.json(
      { ok: false, error: 'cos_metrics_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    )
  }
}
