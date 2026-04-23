import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOrMergeContact } from '@/modules/customers/lib/dedup'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['calendar.view'] },
  POST: { requireAuth: false }, // Public — guests book appointments
  PUT: { requireAuth: true, requireFeatures: ['calendar.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['calendar.manage'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const upcoming = url.searchParams.get('upcoming') !== 'false'

    let query = knex('bookings').where('organization_id', auth.orgId)
    if (upcoming) query = query.where('start_time', '>=', new Date()).whereIn('status', ['confirmed', 'pending'])
    query = query.orderBy('start_time', 'asc').limit(50)

    const bookings = await query
    return NextResponse.json({ ok: true, data: bookings })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { bookingPageId, guestName, guestEmail, guestPhone, startTime, notes } = body

    if (!bookingPageId || !guestName || !guestEmail || !startTime) {
      return NextResponse.json({ ok: false, error: 'bookingPageId, guestName, guestEmail, startTime required' }, { status: 400 })
    }

    const page = await knex('booking_pages').where('id', bookingPageId).where('is_active', true).first()
    if (!page) return NextResponse.json({ ok: false, error: 'Booking page not found' }, { status: 404 })

    const start = new Date(startTime)
    const end = new Date(start.getTime() + (page.duration_minutes || 30) * 60000)

    // Check for CRM booking conflicts
    const conflict = await knex('bookings')
      .where('booking_page_id', bookingPageId)
      .where('status', 'confirmed')
      .where(function() {
        this.where('start_time', '<', end).andWhere('end_time', '>', start)
      }).first()

    if (conflict) {
      return NextResponse.json({ ok: false, error: 'This time slot is no longer available' }, { status: 409 })
    }

    // Check Google Calendar conflicts if connected
    if (page.owner_user_id) {
      try {
        const { getGoogleBusyTimes } = await import('@/modules/calendar/lib/google-calendar-service')
        const busyTimes = await getGoogleBusyTimes(page.owner_user_id, start, end)
        const googleConflict = busyTimes.some(bt =>
          new Date(bt.start) < end && new Date(bt.end) > start
        )
        if (googleConflict) {
          return NextResponse.json({ ok: false, error: 'This time slot is not available' }, { status: 409 })
        }
      } catch {
        // Google Calendar check failed — allow booking anyway
      }
    }

    const id = require('crypto').randomUUID()
    const autoConfirm = page.auto_confirm !== false
    const initialStatus = autoConfirm ? 'confirmed' : 'pending'
    const confirmationToken = autoConfirm ? null : require('crypto').randomUUID()
    const confirmationTokenExpiresAt = autoConfirm ? null : new Date(Date.now() + 72 * 60 * 60 * 1000)

    await knex('bookings').insert({
      id, tenant_id: page.tenant_id, organization_id: page.organization_id,
      booking_page_id: bookingPageId,
      guest_name: guestName, guest_email: guestEmail, guest_phone: guestPhone || null,
      start_time: start, end_time: end,
      status: initialStatus,
      meeting_type: page.meeting_type || 'in_person',
      meeting_location: page.meeting_location || null,
      confirmation_token: confirmationToken,
      confirmation_token_expires_at: confirmationTokenExpiresAt,
      confirmed_at: autoConfirm ? new Date() : null,
      notes: notes || null, created_at: new Date(),
    })

    // Auto-create contact (with dedup check)
    const dedupResult = await findOrMergeContact(knex, page.organization_id, page.tenant_id, guestEmail, guestName, guestPhone)

    let bookingContactId: string | null = null
    if (dedupResult.existing) {
      bookingContactId = dedupResult.existing.id
    } else {
      bookingContactId = require('crypto').randomUUID()
      await knex('customer_entities').insert({
        id: bookingContactId,
        tenant_id: page.tenant_id, organization_id: page.organization_id,
        kind: 'person', display_name: guestName, primary_email: guestEmail,
        primary_phone: guestPhone || null, source: 'booking',
        status: 'active', lifecycle_stage: 'prospect',
        created_at: new Date(), updated_at: new Date(),
      }).catch(() => { bookingContactId = null })
      if (bookingContactId) {
        const bookingNameParts = (guestName || '').split(' ')
        await knex('customer_people').insert({
          id: require('crypto').randomUUID(), tenant_id: page.tenant_id, organization_id: page.organization_id,
          entity_id: bookingContactId, first_name: bookingNameParts[0] || '', last_name: bookingNameParts.slice(1).join(' ') || '',
          created_at: new Date(), updated_at: new Date(),
        }).catch(() => {})
      }
    }

    // First-touch source attribution — only tag newly-created contacts.
    if (bookingContactId && !dedupResult.existing) {
      try {
        const { tagContactSource } = await import('@open-mercato/core/modules/customers/lib/sourceTagging')
        await tagContactSource(knex, { tenantId: page.tenant_id, organizationId: page.organization_id }, bookingContactId, 'booking', page.title || page.slug)
      } catch {}
    }

    // Auto-add to email lists with source_type 'booking_created'
    if (bookingContactId) {
      try {
        const autoLists = await knex('email_lists')
          .where('organization_id', page.organization_id)
          .where('source_type', 'booking_created')
        for (const list of autoLists) {
          const desc = list.description || ''
          const triggerMatch = desc.match(/\[auto_trigger:(.+?)\]/)
          if (triggerMatch) {
            try {
              const targetIds = JSON.parse(triggerMatch[1])
              if (Array.isArray(targetIds) && targetIds.length > 0 && !targetIds.includes(bookingPageId)) continue
            } catch {}
          }
          await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
            [require('crypto').randomUUID(), list.id, bookingContactId, new Date()])
          const [{ count }] = await knex('email_list_members').where('list_id', list.id).count()
          await knex('email_lists').where('id', list.id).update({ member_count: Number(count), updated_at: new Date() })
        }
      } catch {}
    }

    // Log to contact timeline
    if (bookingContactId) {
      try {
        await knex('contact_timeline_events').insert({
          id: require('crypto').randomUUID(),
          tenant_id: page.tenant_id,
          organization_id: page.organization_id,
          contact_id: bookingContactId,
          event_type: 'booking_created',
          title: `Booked: ${page.title}`,
          description: `${start.toLocaleDateString()} at ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          metadata: JSON.stringify({ bookingId: id, bookingPageId, startTime: start.toISOString() }),
          created_at: new Date(),
        })
      } catch {}
    }

    // Create Google Calendar event if connected
    let meetLink: string | null = null
    let googleEventId: string | null = null
    if (page.owner_user_id) {
      try {
        const { createGoogleCalendarEvent } = await import('@/modules/calendar/lib/google-calendar-service')
        const meetingType = page.meeting_type || 'google_meet'
        const result = await createGoogleCalendarEvent(page.owner_user_id, {
          summary: `${page.title} — ${guestName}`,
          description: `Booking with ${guestName} (${guestEmail})${notes ? '\n\nNotes: ' + notes : ''}`,
          startTime: start,
          endTime: end,
          attendeeEmail: guestEmail,
          meetingType,
          meetingLocation: page.meeting_location || undefined,
          meetingLink: page.meeting_link || undefined,
        })
        if (result) {
          meetLink = result.meetLink
          googleEventId = result.eventId
          if (result.htmlLink) {
            await knex('bookings').where('id', id).update({ google_calendar_html_link: result.htmlLink }).catch(() => {})
          }
        }
      } catch {
        // Google Calendar event creation failed — booking still succeeded
      }
    }

    // Determine final meeting_link: Google Meet link > zoom_link from page > existing meeting_location
    const finalMeetingLink = meetLink || (page.meeting_type === 'zoom' ? page.zoom_link : null) || null
    if (finalMeetingLink || googleEventId) {
      await knex('bookings').where('id', id).update({
        meeting_link: finalMeetingLink,
        google_calendar_event_id: googleEventId,
      })
    }

    // Send booking emails
    try {
      const { sendBookingConfirmationToGuest, sendBookingNotificationToOwner } = await import('../../lib/booking-emails')
      const booking = await knex('bookings').where('id', id).first()
      if (booking) {
        // Send guest confirmation
        await sendBookingConfirmationToGuest({
          knex, orgId: page.organization_id, tenantId: page.tenant_id,
          ownerUserId: page.owner_user_id, booking, bookingPage: page,
        })

        // Only send owner notification if owner email differs from guest email
        const ownerUser = page.owner_user_id
          ? await knex('users').where('id', page.owner_user_id).select('email').first()
          : null
        if (ownerUser?.email && ownerUser.email.toLowerCase() !== guestEmail.toLowerCase()) {
          await sendBookingNotificationToOwner({
            knex, orgId: page.organization_id, tenantId: page.tenant_id,
            ownerUserId: page.owner_user_id, booking, bookingPage: page,
          })
        }
      }
    } catch (emailErr) {
      console.error('[calendar.bookings] Email send failed (non-blocking):', emailErr)
    }

    return NextResponse.json({ ok: true, data: { id, startTime: start, endTime: end, meetLink } }, { status: 201 })
  } catch (error) {
    console.error('[calendar.bookings.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { id, status, notes, guest_name, start_time, end_time, meeting_type, meeting_location } = body
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const existing = await knex('bookings').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const updates: Record<string, unknown> = {}
    if (status !== undefined && status !== existing.status) {
      const validTransitions = [
        { from: 'confirmed', to: 'cancelled' },
        { from: 'pending', to: 'confirmed' },
        { from: 'pending', to: 'cancelled' },
      ]
      const isValid = validTransitions.some(t => t.from === existing.status && t.to === status)
      if (!isValid) {
        return NextResponse.json({ ok: false, error: `Cannot transition from '${existing.status}' to '${status}'` }, { status: 400 })
      }
      updates.status = status
      if (existing.status === 'pending' && status === 'confirmed') {
        updates.confirmed_at = new Date()
        updates.confirmation_token = null
        updates.confirmation_token_expires_at = null
      }
    }
    if (notes !== undefined) updates.notes = notes
    if (guest_name !== undefined) updates.guest_name = guest_name
    if (start_time !== undefined) updates.start_time = new Date(start_time)
    if (end_time !== undefined) updates.end_time = new Date(end_time)
    if (meeting_type !== undefined) updates.meeting_type = meeting_type
    if (meeting_location !== undefined) updates.meeting_location = meeting_location

    if (Object.keys(updates).length > 0) {
      await knex('bookings').where('id', id).where('organization_id', auth.orgId).update(updates)
    }

    return NextResponse.json({ ok: true, hasGoogleEvent: !!existing.google_calendar_event_id })
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
    let deleteSeries = url.searchParams.get('deleteSeries') === 'true'
    if (!id) {
      try {
        const body = await req.json()
        id = body.id
        if (body.deleteSeries) deleteSeries = true
      } catch {}
    }
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const existing = await knex('bookings').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    if (deleteSeries) {
      // Determine the parent ID for the series
      const parentId = existing.recurrence_parent_id || (existing.recurrence_rule ? existing.id : null)
      if (parentId) {
        // Delete all children first (FK constraint)
        await knex('bookings')
          .where('recurrence_parent_id', parentId)
          .where('organization_id', auth.orgId)
          .del()
        // Delete the parent
        await knex('bookings')
          .where('id', parentId)
          .where('organization_id', auth.orgId)
          .del()
        return NextResponse.json({ ok: true, deletedSeries: true })
      }
    }

    // Single event delete
    // If this event has children (is a parent), delete children first due to FK constraint
    if (existing.recurrence_rule) {
      await knex('bookings')
        .where('recurrence_parent_id', existing.id)
        .where('organization_id', auth.orgId)
        .del()
    }
    await knex('bookings').where('id', id).where('organization_id', auth.orgId).del()
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Bookings',
  methods: {
    GET: { summary: 'List bookings', tags: ['Calendar'] },
    POST: { summary: 'Create booking (public)', tags: ['Calendar'] },
    PUT: { summary: 'Update booking (cancel/reschedule)', tags: ['Calendar'] },
    DELETE: { summary: 'Delete booking', tags: ['Calendar'] },
  },
}
