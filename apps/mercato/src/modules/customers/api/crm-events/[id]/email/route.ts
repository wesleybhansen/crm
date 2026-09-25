// ORM-SKIP: events/event_attendees are raw-knex tables (no mercato entity), created by customers Migration20260925161500
export const metadata = { path: '/crm-events/[id]/email', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { refusalIfNotConnected } from '../../../../../email/lib/sending-readiness'
import { decryptAttendeesForSend } from '@/modules/customers/lib/event-attendees'


// POST: Send email to all registered attendees of an event
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId || !auth.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const tenantId = auth.tenantId
    const { id: eventId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const event = await knex('events').where('id', eventId).where('organization_id', auth.orgId).first()
    if (!event) return NextResponse.json({ ok: false, error: 'Event not found' }, { status: 404 })

    const body = await req.json()
    const { subject, message } = body
    if (!subject?.trim() || !message?.trim()) return NextResponse.json({ ok: false, error: 'Subject and message required' }, { status: 400 })

    const stored = await knex('event_attendees')
      .where('event_id', eventId)
      .where('status', 'registered')
      .where('organization_id', auth.orgId)
    // Strict for an outbound send: a registration that does not decrypt is
    // skipped, never mailed to ciphertext (M11 / LOW strict decrypt).
    const { rows: attendees } = await decryptAttendeesForSend(stored, tenantId, auth.orgId)

    if (attendees.length === 0) return NextResponse.json({ ok: true, data: { sent: 0, message: 'No registered attendees' } })

    // No sending setup: refuse up front instead of failing every attendee.
    const refusal = await refusalIfNotConnected(knex, auth.orgId, 'marketing')
    if (refusal) return NextResponse.json(refusal, { status: 422 })

    let sent = 0

    for (const att of attendees) {
      const firstName = att.attendee_name.split(' ')[0]
      const personalizedMessage = message.replace(/\{\{firstName\}\}/g, firstName).replace(/\{\{name\}\}/g, att.attendee_name)
      const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px">
        <div style="color:#1e293b;font-size:15px;line-height:1.7;white-space:pre-wrap">${personalizedMessage.replace(/\n/g, '<br>')}</div>
      </div>`

      try {
        const result = await sendEmailByPurpose(knex, auth.orgId, tenantId, 'marketing', {
          actingUserId: auth.sub || null,
          to: att.attendee_email,
          subject,
          htmlBody: html,
          contactId: att.contact_id || undefined,
        })
        if (result.ok) {
          sent++

          // Log to contact timeline
          if (att.contact_id) {
            try {
              const { logTimelineEvent } = await import('@/lib/timeline')
              await logTimelineEvent(knex, {
                tenantId,
                organizationId: auth.orgId,
                contactId: att.contact_id,
                eventType: 'event_email',
                title: `Event email: ${subject}`,
              })
            } catch {}
          }
        }
      } catch {
        // continue to next attendee
      }
    }

    return NextResponse.json({ ok: true, data: { sent, total: attendees.length } })
  } catch (error: any) {
    console.error('[crm-events.email]', error?.message)
    return NextResponse.json({ ok: false, error: 'Failed to send emails' }, { status: 500 })
  }
}
