export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'

// POST: Check and send pending reminders for upcoming bookings
export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const now = new Date()
    const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000)
    let sent = 0

    // Find bookings starting within next 25 hours that have booking pages with reminders
    const bookings = await knex('bookings as b')
      .join('booking_pages as bp', 'bp.id', 'b.booking_page_id')
      .where('b.organization_id', auth.orgId)
      .where('b.status', 'confirmed')
      .where('b.start_time', '>', now)
      .where('b.start_time', '<', in25h)
      .whereNotNull('bp.reminder_config')
      .select('b.*', 'bp.title as page_title', 'bp.reminder_config', 'bp.meeting_type', 'bp.meeting_location')

    for (const booking of bookings) {
      const reminders = typeof booking.reminder_config === 'string'
        ? JSON.parse(booking.reminder_config) : (booking.reminder_config || [])
      if (reminders.length === 0) continue

      const startTime = new Date(booking.start_time)
      const hoursUntil = (startTime.getTime() - now.getTime()) / (1000 * 60 * 60)

      let shouldSend = false
      let reminderType = ''

      for (const r of reminders) {
        if (r.sendBefore === '24h' && hoursUntil <= 25 && hoursUntil > 20) {
          shouldSend = true; reminderType = '24h'
        }
        if (r.sendBefore === '1h' && hoursUntil <= 1.5 && hoursUntil > 0.25) {
          shouldSend = true; reminderType = '1h'
        }
      }

      if (!shouldSend) continue

      // Check if we already sent this reminder
      const alreadySent = await knex('email_messages')
        .where('organization_id', auth.orgId)
        .where('metadata', 'like', `%booking_reminder_${booking.id}_${reminderType}%`)
        .first()
      if (alreadySent) continue

      // Build reminder email
      const eventDate = startTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      const eventTime = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      const location = booking.meeting_type === 'google_meet' || booking.meeting_type === 'zoom'
        ? (booking.meeting_link || 'Virtual') : (booking.meeting_location || 'TBD')
      const firstName = booking.guest_name.split(' ')[0]

      const subject = reminderType === '24h'
        ? `Reminder: ${booking.page_title || 'Your booking'} tomorrow`
        : `Reminder: ${booking.page_title || 'Your booking'} starts in 1 hour`

      const html = `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px">
        <h2 style="font-size:20px;margin:0 0 8px">Hi ${firstName}, just a reminder!</h2>
        <p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:20px">
          Your ${booking.page_title || 'booking'} is coming up ${reminderType === '24h' ? 'tomorrow' : 'in about an hour'}.
        </p>
        <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px">
          <p style="margin:0 0 6px;font-size:14px"><strong>Date:</strong> ${eventDate}</p>
          <p style="margin:0 0 6px;font-size:14px"><strong>Time:</strong> ${eventTime}</p>
          <p style="margin:0;font-size:14px"><strong>Location:</strong> ${location}</p>
        </div>
        ${booking.meeting_link ? `<a href="${booking.meeting_link}" style="display:inline-block;background:#3b82f6;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Join Meeting</a>` : ''}
        <p style="color:#94a3b8;font-size:12px;margin-top:24px">See you soon!</p>
      </div>`

      try {
        await sendEmailByPurpose(knex, auth.orgId, auth.tenantId || '', 'transactional', {
          to: booking.guest_email,
          subject,
          htmlBody: html,
          contactId: booking.contact_id || undefined,
        })

        // Store in email_messages for dedup tracking
        await knex('email_messages').insert({
          id: require('crypto').randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          direction: 'outbound',
          from_address: 'noreply@localhost',
          to_address: booking.guest_email,
          subject,
          body_html: html,
          contact_id: booking.contact_id || null,
          status: 'sent',
          tracking_id: require('crypto').randomUUID(),
          metadata: JSON.stringify({ type: `booking_reminder_${booking.id}_${reminderType}` }),
          created_at: new Date(),
        }).catch(() => {})

        sent++
      } catch (err) {
        console.error(`[booking-reminders] Failed for ${booking.id}:`, err)
      }
    }

    return NextResponse.json({ ok: true, data: { sent } })
  } catch (error) {
    console.error('[booking-reminders]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
