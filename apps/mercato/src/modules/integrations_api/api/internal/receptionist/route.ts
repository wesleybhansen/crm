import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'

/* Internal receptionist endpoint for the Noli AI Receptionist (phone answering).
 *
 * The Noli hub's /api/receptionist/booking route calls THIS endpoint mid-call
 * (via the shared NOLI_INTERNAL_SERVICE_SECRET) to serve the voice agent's
 * custom functions. Three ops in one route:
 *   op=availability      -> next open slots from the user's active booking page
 *   op=book              -> book a slot (same conflict/race guards + contact
 *                           dedup as the public booking POST)
 *   op=contact-by-phone  -> caller recognition: match caller ID to a contact
 *
 * LATENCY MATTERS: these run while a caller is on the phone. Keep queries lean;
 * the hub adds its own caching. Identity resolution mirrors email-send.
 */

export const dynamic = 'force-dynamic'

export const metadata = {
  path: '/internal/receptionist',
  POST: { requireAuth: false },
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/* ── timezone helpers (no deps): find the UTC instant whose wall-clock time in
 * `tz` equals the given components. Two-pass offset correction handles DST. */
function tzOffsetMs(tz: string, utc: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p: Record<string, string> = {}
  for (const part of dtf.formatToParts(utc)) p[part.type] = part.value
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '00' : p.hour), +p.minute, +p.second)
  return asUtc - utc.getTime()
}
function zonedToUtc(tz: string, y: number, m: number, d: number, hh: number, mm: number): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm))
  const off1 = tzOffsetMs(tz, guess)
  const better = new Date(guess.getTime() - off1)
  const off2 = tzOffsetMs(tz, better)
  return new Date(guess.getTime() - off2)
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = typeof body.op === 'string' ? body.op : ''
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!op || !noliUserId) {
    return NextResponse.json({ ok: false, error: 'op and noliUserId are required' }, { status: 400 })
  }

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'noli user not found' }, { status: 404 })
    }
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId || !auth?.orgId || !auth?.tenantId) {
      return NextResponse.json({ ok: false, error: 'user has no CRM access' }, { status: 403 })
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    /* ── caller recognition ──────────────────────────────────────────── */
    if (op === 'contact-by-phone') {
      const phone = typeof body.phone === 'string' ? body.phone : ''
      const digits = phone.replace(/\D/g, '')
      if (digits.length < 7) return NextResponse.json({ ok: true, found: false })
      const last10 = digits.slice(-10)
      // Match on the last 10 digits so +1/1-/formatting differences don't miss.
      const row = await knex('customer_entities')
        .where('organization_id', String(auth.orgId))
        .where('tenant_id', String(auth.tenantId))
        .where('status', 'active')
        .whereNotNull('primary_phone')
        .whereRaw("regexp_replace(primary_phone, '\\D', '', 'g') like ?", [`%${last10}`])
        .select('id', 'display_name', 'lifecycle_stage')
        .first()
      if (!row) return NextResponse.json({ ok: true, found: false })
      // Upcoming confirmed booking for this caller (so the receptionist can say
      // "are you calling about Thursday?").
      const nextBooking = await knex('bookings')
        .where('organization_id', String(auth.orgId))
        .where('status', 'confirmed')
        .where('start_time', '>', new Date())
        .whereRaw("regexp_replace(coalesce(guest_phone,''), '\\D', '', 'g') like ?", [`%${last10}`])
        .orderBy('start_time', 'asc')
        .select('start_time')
        .first()
      return NextResponse.json({
        ok: true,
        found: true,
        contactId: row.id,
        name: row.display_name,
        stage: row.lifecycle_stage || null,
        upcomingBooking: nextBooking ? new Date(nextBooking.start_time).toISOString() : null,
      })
    }

    /* Both remaining ops need the user's active booking page. */
    const page = await knex('booking_pages')
      .where('organization_id', String(auth.orgId))
      .where('is_active', true)
      .where('owner_user_id', String(auth.userId))
      .orderBy('created_at', 'asc')
      .first()
    if (!page) {
      return NextResponse.json({ ok: false, error: 'no active booking page', code: 'no_booking_page' }, { status: 404 })
    }
    const tz = page.timezone || 'America/Los_Angeles'
    const durationMin = page.duration_minutes || 30
    const availability =
      typeof page.availability === 'string' ? JSON.parse(page.availability) : page.availability || {}

    /* ── availability: generate open slots for the next N days ───────── */
    if (op === 'availability') {
      const days = Math.max(1, Math.min(14, Number(body.days) || 7))
      const max = Math.max(1, Math.min(10, Number(body.max) || 8))
      const now = new Date()
      const leadMs = 2 * 60 * 60 * 1000 // never offer a slot less than 2h out
      const horizon = new Date(now.getTime() + days * 86_400_000)

      const busy: Array<{ start: Date; end: Date }> = (
        await knex('bookings')
          .where('booking_page_id', page.id)
          .where('status', 'confirmed')
          .where('end_time', '>', now)
          .where('start_time', '<', horizon)
          .select('start_time', 'end_time')
      ).map((b: { start_time: string; end_time: string }) => ({
        start: new Date(b.start_time),
        end: new Date(b.end_time),
      }))
      // Google Calendar busy times too, when connected (best-effort; a slow or
      // failed Google call must not stall the phone call).
      if (page.owner_user_id) {
        try {
          const { getGoogleBusyTimes } = await import('@/modules/calendar/lib/google-calendar-service')
          const g = (await Promise.race([
            getGoogleBusyTimes(page.owner_user_id, now, horizon),
            new Promise((resolve) => setTimeout(() => resolve([]), 2500)),
          ])) as Array<{ start: string; end: string }>
          for (const bt of g || []) busy.push({ start: new Date(bt.start), end: new Date(bt.end) })
        } catch { /* offer CRM-only availability */ }
      }

      const slots: Array<{ slotId: string; label: string; startISO: string }> = []
      for (let dayOff = 0; dayOff <= days && slots.length < max; dayOff++) {
        const probe = new Date(now.getTime() + dayOff * 86_400_000)
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
        }).formatToParts(probe)
        const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
        const dayKey = get('weekday').toLowerCase().slice(0, 3)
        if (!DAY_KEYS.includes(dayKey)) continue
        const range = availability?.[dayKey] as { start?: string; end?: string } | undefined
        if (!range?.start || !range?.end) continue
        const [sh, sm] = range.start.split(':').map(Number)
        const [eh, em2] = range.end.split(':').map(Number)
        const y = Number(get('year')), mo = Number(get('month')), d = Number(get('day'))
        for (let t = sh * 60 + (sm || 0); t + durationMin <= eh * 60 + (em2 || 0); t += durationMin) {
          const start = zonedToUtc(tz, y, mo, d, Math.floor(t / 60), t % 60)
          const end = new Date(start.getTime() + durationMin * 60000)
          if (start.getTime() < now.getTime() + leadMs) continue
          if (busy.some((b) => b.start < end && b.end > start)) continue
          slots.push({
            slotId: `${page.id}|${start.toISOString()}`,
            startISO: start.toISOString(),
            label: start.toLocaleString('en-US', {
              timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
            }),
          })
          if (slots.length >= max) break
        }
      }
      return NextResponse.json({ ok: true, timezone: tz, durationMinutes: durationMin, slots })
    }

    /* ── book: same guards as the public booking POST ─────────────────── */
    if (op === 'book') {
      const slotId = typeof body.slotId === 'string' ? body.slotId : ''
      const callerName = typeof body.callerName === 'string' ? body.callerName.trim() : ''
      const callerPhone = typeof body.callerPhone === 'string' ? body.callerPhone.trim() : ''
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      const [pageId, startISO] = slotId.split('|')
      const start = new Date(startISO || '')
      if (!pageId || pageId !== String(page.id) || Number.isNaN(start.getTime()) || !callerName || !callerPhone) {
        return NextResponse.json({ ok: false, error: 'valid slotId, callerName, callerPhone required' }, { status: 400 })
      }
      const end = new Date(start.getTime() + durationMin * 60000)
      const digits = callerPhone.replace(/\D/g, '').slice(-10)

      // Idempotency: the voice platform may retry the function call — the same
      // caller on the same slot is one booking, not two.
      const dupe = await knex('bookings')
        .where('booking_page_id', page.id)
        .where('start_time', start)
        .whereIn('status', ['confirmed', 'pending'])
        .whereRaw("regexp_replace(coalesce(guest_phone,''), '\\D', '', 'g') like ?", [`%${digits}`])
        .first()
      if (dupe) {
        return NextResponse.json({ ok: true, alreadyBooked: true, bookingId: dupe.id })
      }

      // Best-effort Google re-check at book time: the availability pass may have
      // timed out its Google fetch (2.5s race), so a Google event can exist on a
      // slot we offered. A slow/failed check must not stall the live call.
      if (page.owner_user_id) {
        try {
          const { getGoogleBusyTimes } = await import('@/modules/calendar/lib/google-calendar-service')
          const gBusy = (await Promise.race([
            getGoogleBusyTimes(page.owner_user_id, start, end),
            new Promise((resolve) => setTimeout(() => resolve([]), 2000)),
          ])) as Array<{ start: string; end: string }>
          const conflict = (gBusy || []).some(
            (bt) => new Date(bt.start) < end && new Date(bt.end) > start,
          )
          if (conflict) {
            return NextResponse.json({ ok: false, error: 'slot no longer available', code: 'slot_taken' }, { status: 409 })
          }
        } catch { /* book on CRM data only */ }
      }

      const id = crypto.randomUUID()
      const autoConfirm = page.auto_confirm !== false
      let slotTaken = false
      await knex.transaction(async (trx) => {
        await trx('booking_pages').where('id', page.id).forUpdate().first()
        const raceConflict = await trx('bookings')
          .where('booking_page_id', page.id)
          .where('status', 'confirmed')
          .where(function () {
            this.where('start_time', '<', end).andWhere('end_time', '>', start)
          })
          .first()
        if (raceConflict) {
          slotTaken = true
          return
        }
        await trx('bookings').insert({
          id,
          tenant_id: page.tenant_id,
          organization_id: page.organization_id,
          booking_page_id: page.id,
          guest_name: callerName,
          guest_email: '',
          guest_phone: callerPhone,
          start_time: start,
          end_time: end,
          status: autoConfirm ? 'confirmed' : 'pending',
          meeting_type: page.meeting_type || 'in_person',
          meeting_location: page.meeting_location || null,
          confirmation_token: null,
          confirmation_token_expires_at: null,
          confirmed_at: autoConfirm ? new Date() : null,
          notes: reason ? `Booked by the AI receptionist. Caller said: ${reason}` : 'Booked by the AI receptionist.',
          created_at: new Date(),
        })
      })
      if (slotTaken) {
        return NextResponse.json({ ok: false, error: 'slot no longer available', code: 'slot_taken' }, { status: 409 })
      }

      // Contact dedup/create, same as the public flow (phone-first here).
      let contactId: string | null = null
      try {
        const { findOrMergeContact } = await import('@/modules/customers/lib/dedup')
        const dd = await findOrMergeContact(knex, page.organization_id, page.tenant_id, '', callerName, callerPhone, em)
        if (dd?.existing) contactId = dd.existing.id
      } catch { /* fall through to create */ }
      if (!contactId) {
        contactId = crypto.randomUUID()
        await knex('customer_entities')
          .insert({
            id: contactId,
            tenant_id: page.tenant_id,
            organization_id: page.organization_id,
            kind: 'person',
            display_name: callerName,
            primary_email: null,
            primary_phone: callerPhone,
            source: 'receptionist',
            status: 'active',
            lifecycle_stage: 'prospect',
            created_at: new Date(),
            updated_at: new Date(),
          })
          .catch(() => { contactId = null })
      }

      return NextResponse.json({
        ok: true,
        bookingId: id,
        contactId,
        confirmed: autoConfirm,
        label: start.toLocaleString('en-US', {
          timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
        }),
      })
    }

    return NextResponse.json({ ok: false, error: `unknown op: ${op}` }, { status: 400 })
  } catch (e) {
    console.error('[internal/receptionist] failed:', (e as Error).message)
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
