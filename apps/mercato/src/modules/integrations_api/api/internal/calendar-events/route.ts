import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/*
 * Internal server-to-server endpoint: Google Calendar event operations, run
 * with the CRM's own grant. Same shared-secret auth as the other /internal/*
 * endpoints.
 *
 * Why this exists (decision 2026-08-12): the CRM is the single owner of Google
 * Calendar access across Noli. The Chief of Staff's two-way appointment sync
 * adapter used to hold a copy of the user's refresh token and call Google
 * itself. It now calls this endpoint instead.
 *
 * ★ NO TOKEN EVER CROSSES THIS BOUNDARY. The caller sends an intent, this
 * endpoint performs it with the CRM's access token and returns data. That is
 * the whole point: retiring the Hub's grant must not mean copying refresh
 * tokens into another service.
 *
 * ★ The caller CANNOT choose the calendar. We always use the calendar on the
 * user's own active connection, so a compromised caller cannot reach a
 * calendar the user never connected.
 *
 * Ops:
 *   list   { syncToken?, updatedMinMs? } -> { items, nextSyncToken, expired }
 *          `expired: true` replaces Google's 410 for a stale syncToken, so the
 *          caller can resync without parsing error strings.
 *   upsert { externalId?, event }        -> { id }
 */
export const metadata = {
  path: '/internal/calendar-events',
  POST: { requireAuth: false },
}

const CAL = 'https://www.googleapis.com/calendar/v3'
const WINDOW_MS = 7 * 86_400_000

type Body = {
  noliUserId?: unknown
  op?: unknown
  syncToken?: unknown
  updatedMinMs?: unknown
  externalId?: unknown
  event?: unknown
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

  const body = (await req.json().catch(() => ({}))) as Body
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  const op = typeof body.op === 'string' ? body.op : ''
  if (!noliUserId) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }
  if (op !== 'list' && op !== 'upsert') {
    return NextResponse.json({ ok: false, error: 'op must be list or upsert' }, { status: 400 })
  }

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'not_connected' }, { status: 409 })
    }

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId) {
      return NextResponse.json({ ok: false, error: 'not_connected' }, { status: 409 })
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const connection = await knex('google_calendar_connections')
      .where('user_id', auth.userId as string)
      .where('is_active', true)
      .first()
    if (!connection) {
      // The user has not connected a calendar in the CRM. This is expected and
      // is not an error: the caller should go quiet, not retry.
      return NextResponse.json({ ok: false, error: 'not_connected' }, { status: 409 })
    }

    const { refreshTokenIfNeeded } = await import('@/modules/calendar/lib/google-calendar-service')
    const accessToken = await refreshTokenIfNeeded(connection)
    const calendarId = encodeURIComponent(connection.calendar_id || 'primary')

    if (op === 'list') {
      const params = new URLSearchParams({
        singleEvents: 'true',
        maxResults: '250',
        showDeleted: 'true',
      })
      const syncToken = typeof body.syncToken === 'string' && body.syncToken ? body.syncToken : null
      if (syncToken) {
        params.set('syncToken', syncToken)
      } else {
        const since = typeof body.updatedMinMs === 'number' && Number.isFinite(body.updatedMinMs)
          ? body.updatedMinMs
          : Date.now() - WINDOW_MS
        params.set('updatedMin', new Date(since).toISOString())
      }

      const r = await fetch(`${CAL}/calendars/${calendarId}/events?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (r.status === 410) {
        // Stale syncToken. Surface it as a typed outcome rather than an error
        // string the caller has to pattern-match.
        return NextResponse.json({ ok: true, expired: true, items: [], nextSyncToken: null })
      }
      if (!r.ok) {
        return NextResponse.json(
          { ok: false, error: `google_${r.status}` },
          { status: r.status >= 500 ? 502 : 400 },
        )
      }
      const d = (await r.json()) as {
        items?: Array<Record<string, unknown>>
        nextSyncToken?: string
      }
      return NextResponse.json({
        ok: true,
        expired: false,
        items: d.items ?? [],
        nextSyncToken: d.nextSyncToken ?? null,
      })
    }

    // op === 'upsert'
    const event = body.event
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return NextResponse.json({ ok: false, error: 'event object required' }, { status: 400 })
    }
    const externalId = typeof body.externalId === 'string' && body.externalId ? body.externalId : null
    const url = externalId
      ? `${CAL}/calendars/${calendarId}/events/${encodeURIComponent(externalId)}`
      : `${CAL}/calendars/${calendarId}/events`

    const r = await fetch(url, {
      method: externalId ? 'PUT' : 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(20_000),
    })
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: `google_${r.status}` },
        { status: r.status >= 500 ? 502 : 400 },
      )
    }
    const d = (await r.json()) as { id?: string }
    return NextResponse.json({ ok: true, id: d.id ?? externalId ?? null })
  } catch (err) {
    console.error('[internal.calendar-events]', err)
    return NextResponse.json({ ok: false, error: 'Calendar operation failed' }, { status: 500 })
  }
}
