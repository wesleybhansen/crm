import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { normalizeAuthorUserId } from '@open-mercato/shared/lib/commands/helpers'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['calendar.view'] },
  POST: { requireAuth: true, requireFeatures: ['calendar.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['calendar.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['calendar.manage'] },
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// Sensible default: weekdays 9 to 5, no weekends.
const DEFAULT_AVAILABILITY: Record<string, { start: string; end: string }> = {
  mon: { start: '09:00', end: '17:00' },
  tue: { start: '09:00', end: '17:00' },
  wed: { start: '09:00', end: '17:00' },
  thu: { start: '09:00', end: '17:00' },
  fri: { start: '09:00', end: '17:00' },
}
const DEFAULT_TIMEZONE = 'America/Los_Angeles'

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// Returns a clean availability object or throws with a user-facing message.
function validateAvailability(input: unknown): Record<string, { start: string; end: string }> {
  if (input === null || input === undefined) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('availability must be an object keyed by day name')
  }
  const out: Record<string, { start: string; end: string }> = {}
  for (const [rawKey, rawRange] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey.toLowerCase()
    if (!(DAY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Invalid day "${rawKey}". Use sun, mon, tue, wed, thu, fri, or sat.`)
    }
    if (!rawRange || typeof rawRange !== 'object') {
      throw new Error(`Invalid hours for ${key}.`)
    }
    const { start, end } = rawRange as { start?: unknown; end?: unknown }
    if (typeof start !== 'string' || typeof end !== 'string' || !TIME_RE.test(start) || !TIME_RE.test(end)) {
      throw new Error(`Hours for ${key} must be in HH:MM 24-hour format.`)
    }
    if (minutesOf(start) >= minutesOf(end)) {
      throw new Error(`Start time must be before end time for ${key}.`)
    }
    out[key] = { start, end }
  }
  return out
}

// Returns a validated IANA timezone string or throws.
function validateTimezone(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('timezone must be a non-empty string')
  }
  const tz = input.trim()
  if (tz.length > 64) throw new Error('timezone is too long')
  try {
    // Throws a RangeError for an unknown timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new Error(`Unknown timezone "${tz}".`)
  }
  return tz
}

let columnsEnsured = false
async function ensureColumns(knex: any): Promise<void> {
  if (columnsEnsured) return
  try {
    await knex.raw(`ALTER TABLE booking_pages ADD COLUMN IF NOT EXISTS availability JSONB`)
    await knex.raw(`ALTER TABLE booking_pages ADD COLUMN IF NOT EXISTS timezone TEXT`)
    columnsEnsured = true
  } catch {
    // Columns may already exist or DB doesn't support IF NOT EXISTS — ignore.
  }
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const pages = await knex('booking_pages').where('organization_id', auth.orgId).orderBy('created_at', 'desc')
    return NextResponse.json({ ok: true, data: pages })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    await ensureColumns(knex)
    const body = await req.json()
    const { title, slug, description, durationMinutes, meetingType, meetingLocation, zoomLink, autoConfirm, reminderConfig, availability, timezone } = body
    if (!title || !slug) return NextResponse.json({ ok: false, error: 'title and slug required' }, { status: 400 })

    let availabilityValue: Record<string, { start: string; end: string }>
    let timezoneValue: string
    try {
      availabilityValue = availability !== undefined
        ? validateAvailability(availability)
        : { ...DEFAULT_AVAILABILITY }
      // If an empty object was supplied, fall back to the sensible default.
      if (Object.keys(availabilityValue).length === 0) availabilityValue = { ...DEFAULT_AVAILABILITY }
      timezoneValue = timezone !== undefined ? validateTimezone(timezone) : DEFAULT_TIMEZONE
    } catch (validationErr) {
      const message = validationErr instanceof Error ? validationErr.message : 'Invalid availability or timezone'
      return NextResponse.json({ ok: false, error: message }, { status: 400 })
    }

    const id = require('crypto').randomUUID()
    await knex('booking_pages').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      title, slug, description: description || null,
      duration_minutes: durationMinutes || 30,
      meeting_type: meetingType || 'in_person',
      meeting_location: meetingLocation || null,
      zoom_link: zoomLink || null,
      auto_confirm: autoConfirm !== undefined ? autoConfirm : true,
      reminder_config: JSON.stringify(reminderConfig || []),
      availability: JSON.stringify(availabilityValue),
      timezone: timezoneValue,
      owner_user_id: normalizeAuthorUserId(null, auth),
      created_at: new Date(), updated_at: new Date(),
    })
    const page = await knex('booking_pages').where('id', id).first()
    return NextResponse.json({ ok: true, data: page }, { status: 201 })
  } catch (err) {
    console.error('[calendar.booking-pages.POST]', err)
    const message = err instanceof Error ? err.message : 'Failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    await ensureColumns(knex)
    const body = await req.json()
    const { id, title, description, durationMinutes, isActive, meetingType, meetingLocation, zoomLink, autoConfirm, reminderConfig, availability, timezone } = body
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const existing = await knex('booking_pages').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (title !== undefined) updates.title = title
    if (description !== undefined) updates.description = description || null
    if (durationMinutes !== undefined) updates.duration_minutes = durationMinutes
    if (isActive !== undefined) updates.is_active = isActive
    if (meetingType !== undefined) updates.meeting_type = meetingType
    if (meetingLocation !== undefined) updates.meeting_location = meetingLocation || null
    if (zoomLink !== undefined) updates.zoom_link = zoomLink || null
    if (autoConfirm !== undefined) updates.auto_confirm = autoConfirm
    if (reminderConfig !== undefined) updates.reminder_config = JSON.stringify(reminderConfig)
    try {
      if (availability !== undefined) updates.availability = JSON.stringify(validateAvailability(availability))
      if (timezone !== undefined) updates.timezone = validateTimezone(timezone)
    } catch (validationErr) {
      const message = validationErr instanceof Error ? validationErr.message : 'Invalid availability or timezone'
      return NextResponse.json({ ok: false, error: message }, { status: 400 })
    }

    await knex('booking_pages').where('id', id).where('organization_id', auth.orgId).update(updates)
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function DELETE(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    let id = url.searchParams.get('id')
    if (!id) {
      try { const body = await req.json(); id = body.id } catch { /* no body */ }
    }
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const existing = await knex('booking_pages').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    // Unlink any bookings referencing this page before deleting
    await knex('bookings').where('booking_page_id', id).update({ booking_page_id: null })
    await knex('booking_pages').where('id', id).where('organization_id', auth.orgId).del()
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Booking pages',
  methods: {
    GET: { summary: 'List booking pages', tags: ['Calendar'] },
    POST: { summary: 'Create booking page', tags: ['Calendar'] },
    PUT: { summary: 'Update booking page', tags: ['Calendar'] },
    DELETE: { summary: 'Delete booking page', tags: ['Calendar'] },
  },
}
