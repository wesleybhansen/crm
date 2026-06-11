import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

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

  const body = (await req.json().catch(() => ({}))) as { noliUserId?: unknown }
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!noliUserId) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) return NextResponse.json({ exists: false })

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.orgId) return NextResponse.json({ exists: false })
    const orgId = auth.orgId as string

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const count = async (table: string, extra?: (q: ReturnType<typeof knex>) => void) => {
      try {
        const q = knex(table).where('organization_id', orgId)
        if (extra) extra(q as ReturnType<typeof knex>)
        const r = (await q.count({ n: '*' }).first()) as { n?: string | number } | undefined
        return Number(r?.n ?? 0)
      } catch {
        return 0
      }
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
  } catch (err) {
    console.error('[internal.setup-status]', err)
    return NextResponse.json({ exists: false })
  }
}
