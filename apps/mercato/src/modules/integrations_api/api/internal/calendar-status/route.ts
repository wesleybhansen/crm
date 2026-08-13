import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * Internal server-to-server endpoint: calendar integration status for a noli
 * user's CRM account. Read-only, same shared-secret auth as the other
 * /internal/* endpoints.
 *
 * Why this exists (decision 2026-08-12): the CRM is the single owner of Google
 * Calendar access across Noli. The Hub used to hold its own Google grant and
 * mirror the tokens to the Chief of Staff; that duplicate integration is being
 * retired. The Hub now reads connection state from here and sends the user to
 * the CRM to connect.
 *
 * IMPORTANT, on providers: Google is the only INBOUND calendar integration the
 * CRM has. "Apple Calendar" in CRM settings is not a connection at all, it is
 * an OUTBOUND ICS subscription feed the user pastes into their own calendar
 * app. Data flows CRM -> Apple, never back. It is reported here so the Hub can
 * describe it honestly rather than implying Noli can read an iCloud calendar.
 * Any real inbound iCloud support would be a CalDAV integration that does not
 * exist yet.
 *
 * No tokens are ever returned by this endpoint.
 */
export const metadata = {
  path: '/internal/calendar-status',
  POST: { requireAuth: false },
}

function appBaseUrl(): string {
  const raw = (process.env.APP_URL || 'https://crm.noliai.com').trim()
  return raw.replace(/\/+$/, '')
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

  const base = appBaseUrl()
  const manageUrl = `${base}/backend/settings-simple`

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: true, exists: false, manageUrl })
    }

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId) {
      // No CRM access for this user. The Hub should say the CRM is required
      // rather than offering a connect link that will 403.
      return NextResponse.json({ ok: true, exists: false, manageUrl })
    }
    const userId = auth.userId as string

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    let google: { connected: boolean; email: string | null } = { connected: false, email: null }
    try {
      const conn = await knex('google_calendar_connections')
        .where('user_id', userId)
        .where('is_active', true)
        .first()
      google = { connected: Boolean(conn), email: conn?.google_email || null }
    } catch {
      // Table missing or query failure degrades to "not connected" rather than
      // failing the whole status call.
      google = { connected: false, email: null }
    }

    return NextResponse.json({
      ok: true,
      exists: true,
      manageUrl,
      providers: {
        google: {
          kind: 'oauth',
          direction: 'two_way',
          connected: google.connected,
          email: google.email,
        },
        apple: {
          kind: 'ics_subscription',
          direction: 'outbound_only',
          // The user subscribes to this in Apple Calendar. Noli cannot read
          // anything back from it.
          feedUrl: `${base}/api/calendar/feed/${userId}.ics`,
        },
      },
    })
  } catch (err) {
    console.error('[internal.calendar-status]', err)
    return NextResponse.json({ ok: false, error: 'Calendar status lookup failed' }, { status: 500 })
  }
}
