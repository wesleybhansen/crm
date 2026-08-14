import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { internalCalendarEventsRequestSchema } from '../../../data/validators'

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
 *   list   { syncToken?, updatedMinMs?, pageToken? }
 *            -> { items, nextPageToken, nextSyncToken, expired }
 *          `expired: true` replaces Google's 410 for a stale syncToken, so the
 *          caller can resync without parsing error strings. Pagination is
 *          passed through rather than resolved here: the caller owns the page
 *          cap and the "no sync token mid-pagination" invariant (LG-16), so
 *          those guarantees stay in one place instead of being duplicated.
 *   upsert { externalId?, event }        -> { id }
 */
export const metadata = {
  path: '/internal/calendar-events',
  POST: { requireAuth: false },
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Internal Integrations',
  summary: 'Operate a user-scoped CRM calendar connection',
  methods: {
    POST: {
      summary: 'List or upsert calendar events without exposing provider credentials',
      tags: ['Internal Integrations'],
    },
  },
}

const CAL = 'https://www.googleapis.com/calendar/v3'
const WINDOW_MS = 7 * 86_400_000

function readProviderEventId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.trim() ? id : null
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

  const bodyResult = internalCalendarEventsRequestSchema.safeParse(
    await readJsonSafe<unknown>(req, {}),
  )
  if (!bodyResult.success) {
    const missingNoliUserId = bodyResult.error.issues.some(
      (issue) => issue.path[0] === 'noliUserId',
    )
    if (missingNoliUserId) {
      return NextResponse.json(
        { ok: false, error: 'noliUserId required' },
        { status: 400 },
      )
    }
    return NextResponse.json(
      { ok: false, error: 'op must be list or upsert' },
      { status: 400 },
    )
  }
  const body = bodyResult.data
  const { noliUserId, op } = body

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'not_connected' }, { status: 409 })
    }

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId || !auth.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'not_connected' }, { status: 409 })
    }
    const userId = String(auth.userId)
    const orgId = String(auth.orgId)
    const tenantId = String(auth.tenantId)

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const connection = await knex('google_calendar_connections')
      .where('user_id', userId)
      .where('organization_id', orgId)
      .where('tenant_id', tenantId)
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
      const pageToken = typeof body.pageToken === 'string' && body.pageToken ? body.pageToken : null
      if (pageToken) params.set('pageToken', pageToken)
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
        return NextResponse.json({
          ok: true,
          expired: true,
          items: [],
          nextPageToken: null,
          nextSyncToken: null,
        })
      }
      if (!r.ok) {
        return NextResponse.json(
          { ok: false, error: `google_${r.status}` },
          { status: r.status >= 500 ? 502 : 400 },
        )
      }
      const d = (await r.json()) as {
        items?: Array<Record<string, unknown>>
        nextPageToken?: string
        nextSyncToken?: string
      }
      // Relayed verbatim, including the ABSENCE of a token. The caller
      // distinguishes "no more pages" from "truncated" by these being null vs
      // present, so do not substitute defaults for missing fields.
      return NextResponse.json({
        ok: true,
        expired: false,
        items: d.items ?? [],
        nextPageToken: d.nextPageToken ?? null,
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
    let providerBody: unknown
    try {
      providerBody = await r.json()
    } catch {
      return NextResponse.json(
        { ok: false, error: 'google_invalid_response' },
        { status: 502 },
      )
    }
    const providerId = readProviderEventId(providerBody)
    const eventId = providerId ?? externalId
    if (!eventId) {
      return NextResponse.json(
        { ok: false, error: 'google_invalid_response' },
        { status: 502 },
      )
    }
    return NextResponse.json({ ok: true, id: eventId })
  } catch (err) {
    console.error('[internal.calendar-events]', err)
    return NextResponse.json({ ok: false, error: 'Calendar operation failed' }, { status: 500 })
  }
}
