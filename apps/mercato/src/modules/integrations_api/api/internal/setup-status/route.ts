import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { internalSetupStatusRequestSchema } from '../../../data/validators'

/*
 * Internal server-to-server endpoint (Noli U-53 guided setup). Returns which
 * one-time CRM setup decisions are still open for a noli user's org so the
 * COS opener can propose the next one. Read-only; same shared-secret auth as
 * the other /internal/* endpoints.
 */
export const metadata = {
  path: '/internal/setup-status',
  POST: { requireAuth: false },
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Internal Integrations',
  summary: 'Read the scoped Noli CRM setup projection',
  methods: {
    POST: {
      summary: 'Resolve setup facts while distinguishing absence from dependency outage',
      tags: ['Internal Integrations'],
    },
  },
}

const SETUP_STATUS_UNAVAILABLE = 'setup_status_unavailable'

function readCount(row: { n?: string | number } | undefined): number {
  const value = row?.n
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(SETUP_STATUS_UNAVAILABLE)
  }
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(SETUP_STATUS_UNAVAILABLE)
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(SETUP_STATUS_UNAVAILABLE)
  }
  return count
}

function unavailableResponse() {
  return NextResponse.json(
    { exists: false, unavailable: true, error: SETUP_STATUS_UNAVAILABLE },
    { status: 503 },
  )
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

  const bodyResult = internalSetupStatusRequestSchema.safeParse(
    await readJsonSafe<unknown>(req, {}),
  )
  if (!bodyResult.success) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }
  const { noliUserId } = bodyResult.data

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) return NextResponse.json({ exists: false })

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.orgId || !auth.tenantId) return NextResponse.json({ exists: false })
    const orgId = String(auth.orgId)
    const tenantId = String(auth.tenantId)

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const count = async (table: string, extra?: (q: ReturnType<typeof knex>) => void) => {
      const q = knex(table)
        .where('organization_id', orgId)
        .where('tenant_id', tenantId)
      if (extra) extra(q as ReturnType<typeof knex>)
      const row = (await q.count({ n: '*' }).first()) as { n?: string | number } | undefined
      return readCount(row)
    }

    const [contacts, landingPages, bookingPages, emailConnections] = await Promise.all([
      count('customer_entities', (q) => void q.whereNull('deleted_at')),
      count('landing_pages'),
      count('booking_pages'),
      count('email_accounts'),
    ])

    return NextResponse.json({
      exists: true,
      hasContacts: contacts > 0,
      hasCapturePage: landingPages > 0 || bookingPages > 0,
      emailConnected: emailConnections > 0,
    })
  } catch {
    console.error('[internal.setup-status] setup_status_unavailable')
    return unavailableResponse()
  }
}
