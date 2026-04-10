import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

bootstrap()

export const metadata = { POST: { requireAuth: false } }

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await knex('events').where('slug', slug).where('status', 'published').whereNull('deleted_at').first()
    if (!event) return NextResponse.json({ ok: false, error: 'Event not found' }, { status: 404 })

    // Registration deadline check
    if (event.registration_deadline && new Date(event.registration_deadline) < new Date()) {
      return NextResponse.json({ ok: false, error: 'Registration for this event has closed' }, { status: 400 })
    }

    const body = await req.json()
    const { name, email, ticketQuantity, guestDetails, registrationData, acceptedTerms } = body

    if (!name?.trim() || !email?.trim()) return NextResponse.json({ ok: false, error: 'Name and email required' }, { status: 400 })

    // Terms check
    if (event.terms_text && !acceptedTerms) return NextResponse.json({ ok: false, error: 'You must accept the terms' }, { status: 400 })

    // Preapproved check
    if (event.preapproved_emails) {
      const approved = typeof event.preapproved_emails === 'string' ? JSON.parse(event.preapproved_emails) : event.preapproved_emails
      if (Array.isArray(approved) && approved.length > 0) {
        if (!approved.map((e: string) => e.toLowerCase()).includes(email.trim().toLowerCase())) {
          return NextResponse.json({ ok: false, error: 'This event is by invitation only' }, { status: 403 })
        }
      }
    }

    // Capacity check
    const qty = ticketQuantity || 1
    if (event.capacity) {
      const currentCount = event.attendee_count || 0
      if (currentCount + qty > event.capacity) {
        return NextResponse.json({ ok: false, error: event.capacity - currentCount > 0 ? `Only ${event.capacity - currentCount} spots remaining` : 'This event is sold out' }, { status: 409 })
      }
    }

    // Redirect paid events to checkout
    if (!event.is_free && event.price && Number(event.price) > 0) {
      return NextResponse.json({ ok: false, error: 'This is a paid event', requiresPayment: true, checkoutUrl: `/api/crm-events/public/${slug}/checkout` }, { status: 402 })
    }

    // Duplicate check
    const existing = await knex('event_attendees')
      .where('event_id', event.id)
      .where('attendee_email', email.trim().toLowerCase())
      .where('status', 'registered')
      .first()
    if (existing) return NextResponse.json({ ok: false, error: 'You are already registered', alreadyRegistered: true }, { status: 409 })

    // Create attendee
    const attendeeId = crypto.randomUUID()
    await knex('event_attendees').insert({
      id: attendeeId, tenant_id: event.tenant_id, organization_id: event.organization_id,
      event_id: event.id,
      attendee_name: name.trim(), attendee_email: email.trim().toLowerCase(),
      status: 'registered', ticket_quantity: qty,
      guest_details: guestDetails ? JSON.stringify(guestDetails) : null,
      registration_data: registrationData ? JSON.stringify(registrationData) : '{}',
      accepted_terms: !!acceptedTerms,
      registered_at: new Date(), created_at: new Date(),
    })

    // Update attendee count
    await knex('events').where('id', event.id).increment('attendee_count', qty)

    // Auto-create CRM contact (customer_entities + customer_people)
    const existingContact = await knex('customer_entities')
      .where('primary_email', email.trim().toLowerCase())
      .where('organization_id', event.organization_id)
      .whereNull('deleted_at').first()

    let contactId = existingContact?.id
    if (!existingContact) {
      contactId = crypto.randomUUID()
      await knex('customer_entities').insert({
        id: contactId, tenant_id: event.tenant_id, organization_id: event.organization_id,
        kind: 'person', display_name: name.trim(), primary_email: email.trim().toLowerCase(),
        source: 'event', status: 'active', lifecycle_stage: 'prospect',
        is_active: true, created_at: new Date(), updated_at: new Date(),
      }).catch(() => { contactId = null })
      if (contactId) {
        const parts = name.trim().split(' ')
        await knex('customer_people').insert({
          id: crypto.randomUUID(), tenant_id: event.tenant_id, organization_id: event.organization_id,
          entity_id: contactId, first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '',
          created_at: new Date(), updated_at: new Date(),
        }).catch(() => {})
      }
    }
    if (contactId) {
      await knex('event_attendees').where('id', attendeeId).update({ contact_id: contactId }).catch(() => {})
      // Log to timeline
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId: event.tenant_id, organizationId: event.organization_id, contactId,
        eventType: 'event_registration', title: `Registered for ${event.title}`,
        description: `${new Date(event.start_time).toLocaleDateString()}${qty > 1 ? ` · ${qty} tickets` : ''}`,
        metadata: { eventId: event.id, ticketQuantity: qty },
      })
    }

    // Auto-add to event mailing list
    if (contactId) {
      try {
        let eventList = await knex('email_lists')
          .where('source_type', 'event').where('source_id', event.id)
          .where('organization_id', event.organization_id).first()
        if (!eventList) {
          const listId = require('crypto').randomUUID()
          await knex('email_lists').insert({
            id: listId, tenant_id: event.tenant_id, organization_id: event.organization_id,
            name: `Event: ${event.title}`, source_type: 'event', source_id: event.id,
            member_count: 0, created_at: new Date(),
          })
          eventList = { id: listId }
        }
        await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
          [require('crypto').randomUUID(), eventList.id, contactId, new Date()])
        const [{ count }] = await knex('email_list_members').where('list_id', eventList.id).count()
        await knex('email_lists').where('id', eventList.id).update({ member_count: Number(count), updated_at: new Date() })
      } catch {}
    }

    // Build calendar link for the confirmation email
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || `${new URL(req.url).origin}`
    const calendarUrl = `${baseUrl}/api/crm-events/${event.id}/calendar`

    // Send confirmation email
    const eventDate = new Date(event.start_time).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const eventTime = new Date(event.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const location = event.event_type === 'virtual' ? (event.virtual_link || 'Link will be shared') : (event.location_name || 'TBD')
    const emailSubject = `You're registered: ${event.title}`
    const emailHtml = `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px">
      <h2 style="font-size:20px;margin:0 0 8px">You're in, ${name.trim().split(' ')[0]}!</h2>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:20px">You're registered for <strong>${event.title}</strong>.</p>
      <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px">
        <p style="margin:0 0 6px;font-size:14px"><strong>Date:</strong> ${eventDate}</p>
        <p style="margin:0 0 6px;font-size:14px"><strong>Time:</strong> ${eventTime}</p>
        <p style="margin:0;font-size:14px"><strong>Location:</strong> ${location}</p>
      </div>
      ${qty > 1 ? `<p style="color:#475569;font-size:14px">Tickets: ${qty}</p>` : ''}
      ${event.event_type !== 'in-person' && event.virtual_link ? `<a href="${event.virtual_link}" style="display:inline-block;background:#3b82f6;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;margin-bottom:16px">Join Event</a>` : ''}
      <a href="${calendarUrl}" style="display:inline-block;background:#f1f5f9;color:#334155;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-bottom:16px;border:1px solid #e2e8f0">Add to Calendar</a>
      <p style="color:#94a3b8;font-size:12px;margin-top:24px">See you there!</p>
    </div>`

    // Send confirmation email
    try {
      const { sendEmailByPurpose } = await import('@/modules/email/lib/email-router')
      await sendEmailByPurpose(knex, event.organization_id, event.tenant_id, 'transactional', {
        to: email.trim(), subject: emailSubject, htmlBody: emailHtml,
      })
    } catch (err) { console.error('[event.register] Email send failed:', err) }

    return NextResponse.json({ ok: true, data: { attendeeId, ticketQuantity: qty } })
  } catch (error: any) {
    console.error('[crm-events.register]', error?.message)
    return NextResponse.json({ ok: false, error: 'Registration failed' }, { status: 500 })
  }
}
