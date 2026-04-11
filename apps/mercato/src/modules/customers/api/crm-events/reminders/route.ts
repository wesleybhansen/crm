export const metadata = { path: '/crm-events/reminders', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'


// POST: Check and send pending reminders for all upcoming events
export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) return NextResponse.json({ ok: true, data: { sent: 0, message: 'Email not configured' } })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const now = new Date()
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const in1h = new Date(now.getTime() + 60 * 60 * 1000)
    let sent = 0

    // Find published events starting within reminder windows
    const events = await knex('events')
      .where('organization_id', auth.orgId)
      .where('status', 'published')
      .where('start_time', '>', now)
      .where('start_time', '<', in24h)
      .whereNull('deleted_at')

    for (const event of events) {
      const reminders = typeof event.reminder_config === 'string' ? JSON.parse(event.reminder_config) : (event.reminder_config || [])
      const eventStart = new Date(event.start_time)
      const hoursUntil = (eventStart.getTime() - now.getTime()) / (1000 * 60 * 60)

      // Check which reminders should fire
      let shouldSend24h = false
      let shouldSend1h = false

      for (const r of reminders) {
        if (r.sendBefore === '24h' && hoursUntil <= 25 && hoursUntil > 20) shouldSend24h = true
        if (r.sendBefore === '1h' && hoursUntil <= 1.5 && hoursUntil > 0.25) shouldSend1h = true
      }

      if (!shouldSend24h && !shouldSend1h) continue

      // Get attendees
      const attendees = await knex('event_attendees')
        .where('event_id', event.id)
        .where('status', 'registered')

      const eventDate = eventStart.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      const eventTime = eventStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      const location = event.event_type === 'virtual' ? (event.virtual_link || 'Virtual') : (event.location_name || 'TBD')
      const timeLabel = shouldSend1h ? 'starting in 1 hour' : 'tomorrow'

      const { Resend } = await import('resend')
      const resend = new Resend(resendKey)

      for (const attendee of attendees) {
        try {
          await resend.emails.send({
            from: process.env.EMAIL_FROM || 'noreply@localhost',
            to: [attendee.attendee_email],
            subject: `Reminder: ${event.title} is ${timeLabel}`,
            html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px">
              <h2 style="font-size:20px;margin:0 0 12px">Hi ${attendee.attendee_name.split(' ')[0]},</h2>
              <p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:20px">Just a reminder that <strong>${event.title}</strong> is ${timeLabel}.</p>
              <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px">
                <p style="margin:0 0 6px;font-size:14px"><strong>Date:</strong> ${eventDate}</p>
                <p style="margin:0 0 6px;font-size:14px"><strong>Time:</strong> ${eventTime}</p>
                <p style="margin:0;font-size:14px"><strong>Location:</strong> ${location}</p>
              </div>
              ${event.event_type !== 'in-person' && event.virtual_link ? `<a href="${event.virtual_link}" style="display:inline-block;background:#3b82f6;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Join Event</a>` : ''}
              <p style="color:#94a3b8;font-size:12px;margin-top:24px">See you there!</p>
            </div>`,
          })
          sent++
        } catch {}
      }
    }

    return NextResponse.json({ ok: true, data: { sent } })
  } catch (error: any) {
    console.error('[crm-events.reminders]', error?.message)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
