// ORM-SKIP: events/event_attendees tables do not exist on prod — feature unused
export const metadata = { path: '/crm-events', GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'


function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80) + '-' + crypto.randomUUID().substring(0, 6)
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const events = await knex('events')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .orderBy('start_time', 'desc')
      .limit(100)
    return NextResponse.json({ ok: true, data: events })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { title, description, eventType, locationName, locationAddress, virtualLink,
      startTime, endTime, timezone, capacity, registrationDeadline, price, isFree, registrationFields,
      preapprovedEmails, landingCopy, landingStyle, termsText, reminderConfig,
      isRecurring, recurrenceRule, addToCalendar } = body

    if (!title?.trim()) return NextResponse.json({ ok: false, error: 'Title required' }, { status: 400 })
    if (!startTime || !endTime) return NextResponse.json({ ok: false, error: 'Start and end time required' }, { status: 400 })

    const id = crypto.randomUUID()
    const slug = slugify(title)

    await knex('events').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      title: title.trim(), description: description?.trim() || null, slug,
      event_type: eventType || 'in-person', status: 'draft',
      location_name: locationName || null, location_address: locationAddress || null,
      virtual_link: virtualLink || null,
      start_time: new Date(startTime), end_time: new Date(endTime),
      timezone: timezone || 'America/New_York',
      is_recurring: isRecurring || false,
      recurrence_rule: isRecurring && recurrenceRule ? JSON.stringify(recurrenceRule) : null,
      capacity: capacity || null,
      registration_deadline: registrationDeadline ? new Date(registrationDeadline) : null,
      price: isFree === false ? price : null, currency: 'USD', is_free: isFree !== false,
      registration_fields: JSON.stringify(registrationFields || []),
      preapproved_emails: preapprovedEmails?.length ? JSON.stringify(preapprovedEmails) : null,
      landing_copy: landingCopy ? JSON.stringify(landingCopy) : null,
      landing_style: landingStyle || 'warm',
      terms_text: termsText || null,
      reminder_config: JSON.stringify(reminderConfig || []),
      created_at: new Date(), updated_at: new Date(),
    })

    // Generate recurring occurrences
    if (isRecurring && recurrenceRule?.frequency && recurrenceRule?.until) {
      const start = new Date(startTime)
      const end = new Date(endTime)
      const duration = end.getTime() - start.getTime()
      const untilDate = new Date(recurrenceRule.until)
      let current = new Date(start)
      const interval = recurrenceRule.interval || 1

      while (current < untilDate) {
        if (recurrenceRule.frequency === 'weekly') current.setDate(current.getDate() + 7 * interval)
        else if (recurrenceRule.frequency === 'monthly') current.setMonth(current.getMonth() + interval)
        else break
        if (current >= untilDate) break

        await knex('events').insert({
          id: crypto.randomUUID(), tenant_id: auth.tenantId, organization_id: auth.orgId,
          title: title.trim(), description: description?.trim() || null, slug: slugify(title),
          event_type: eventType || 'in-person', status: 'draft',
          location_name: locationName || null, location_address: locationAddress || null,
          virtual_link: virtualLink || null,
          start_time: new Date(current), end_time: new Date(current.getTime() + duration),
          timezone: timezone || 'America/New_York', recurrence_parent_id: id,
          capacity: capacity || null, price: isFree === false ? price : null, is_free: isFree !== false,
          registration_fields: JSON.stringify(registrationFields || []),
          landing_copy: landingCopy ? JSON.stringify(landingCopy) : null,
          landing_style: landingStyle || 'warm', terms_text: termsText || null,
          reminder_config: JSON.stringify(reminderConfig || []),
          created_at: new Date(), updated_at: new Date(),
        }).catch(() => {})
      }
    }

    // Add to user's calendar if requested
    if (addToCalendar !== false) {
      try {
        const bookingId = crypto.randomUUID()
        const start = new Date(startTime)
        const end = new Date(endTime)
        const meetingLocation = eventType === 'virtual' ? virtualLink : locationName
        await knex('bookings').insert({
          id: bookingId, tenant_id: auth.tenantId, organization_id: auth.orgId,
          booking_page_id: null,
          guest_name: title.trim(), guest_email: 'event@calendar.local',
          start_time: start, end_time: end,
          status: 'confirmed',
          notes: `Event: ${title.trim()}${description ? '\n' + description.trim() : ''}`,
          created_at: new Date(),
        })

        // Sync to Google Calendar if connected
        try {
          const { createGoogleCalendarEvent } = await import('@/modules/calendar/lib/google-calendar-service')
          const result = await createGoogleCalendarEvent(auth.sub, {
            summary: title.trim(),
            description: description?.trim() || undefined,
            startTime: start, endTime: end,
            meetingType: eventType === 'virtual' ? 'google_meet' : 'in_person',
            meetingLocation: meetingLocation || undefined,
          })
          if (result?.eventId) {
            await knex('bookings').where('id', bookingId).update({
              meeting_link: result.meetLink || null,
              google_calendar_event_id: result.eventId || null,
              google_calendar_html_link: result.htmlLink || null,
            })
          }
        } catch {}
      } catch (calErr) {
        console.error('[crm-events] Calendar add failed:', calErr)
      }
    }

    const event = await knex('events').where('id', id).first()
    return NextResponse.json({ ok: true, data: event }, { status: 201 })
  } catch (error: any) {
    console.error('[crm-events.create]', error?.message)
    return NextResponse.json({ ok: false, error: 'Failed to create event' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const body = await req.json()
    const update: Record<string, any> = { updated_at: new Date() }

    if (body.title !== undefined) update.title = body.title.trim()
    if (body.description !== undefined) update.description = body.description?.trim() || null
    if (body.eventType !== undefined) update.event_type = body.eventType
    if (body.status !== undefined) update.status = body.status
    if (body.locationName !== undefined) update.location_name = body.locationName
    if (body.locationAddress !== undefined) update.location_address = body.locationAddress
    if (body.virtualLink !== undefined) update.virtual_link = body.virtualLink
    if (body.startTime !== undefined) update.start_time = new Date(body.startTime)
    if (body.endTime !== undefined) update.end_time = new Date(body.endTime)
    if (body.timezone !== undefined) update.timezone = body.timezone
    if (body.capacity !== undefined) update.capacity = body.capacity
    if (body.registrationDeadline !== undefined) update.registration_deadline = body.registrationDeadline ? new Date(body.registrationDeadline) : null
    if (body.price !== undefined) update.price = body.price
    if (body.isFree !== undefined) update.is_free = body.isFree
    if (body.registrationFields !== undefined) update.registration_fields = JSON.stringify(body.registrationFields)
    if (body.preapprovedEmails !== undefined) update.preapproved_emails = body.preapprovedEmails?.length ? JSON.stringify(body.preapprovedEmails) : null
    if (body.landingCopy !== undefined) update.landing_copy = body.landingCopy ? JSON.stringify(body.landingCopy) : null
    if (body.landingStyle !== undefined) update.landing_style = body.landingStyle
    if (body.termsText !== undefined) update.terms_text = body.termsText
    if (body.reminderConfig !== undefined) update.reminder_config = JSON.stringify(body.reminderConfig)
    if (body.isPublished === true) update.status = 'published'
    if (body.isPublished === false) update.status = 'draft'

    await knex('events').where('id', id).where('organization_id', auth.orgId).update(update)

    // Send cancellation emails if requested
    if (body.status === 'cancelled' && body.sendCancellationEmail) {
      const event = await knex('events').where('id', id).first()
      const attendees = await knex('event_attendees').where('event_id', id).where('status', 'registered')
      const resendKey = process.env.RESEND_API_KEY
      if (resendKey && event && attendees.length > 0) {
        try {
          const { Resend } = await import('resend')
          const resend = new Resend(resendKey)
          for (const att of attendees) {
            await resend.emails.send({
              from: process.env.EMAIL_FROM || 'noreply@localhost',
              to: [att.attendee_email],
              subject: `Event Cancelled: ${event.title}`,
              html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px">
                <h2 style="font-size:20px;margin:0 0 12px">Hi ${att.attendee_name.split(' ')[0]},</h2>
                <p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:20px">We're sorry to let you know that <strong>${event.title}</strong> has been cancelled.</p>
                <p style="color:#475569;font-size:14px;line-height:1.6">${body.cancellationMessage || 'We apologize for any inconvenience. If you have any questions, please don\'t hesitate to reach out.'}</p>
              </div>`,
            }).catch(() => {})
          }
          // Mark attendees as cancelled
          await knex('event_attendees').where('event_id', id).where('status', 'registered').update({ status: 'cancelled', cancelled_at: new Date() })
        } catch {}
      }
    }

    const event = await knex('events').where('id', id).first()
    return NextResponse.json({ ok: true, data: event })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
    await knex('events').where('id', id).where('organization_id', auth.orgId).update({ deleted_at: new Date() })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
