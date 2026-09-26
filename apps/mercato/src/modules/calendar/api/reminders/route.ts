export const metadata = { POST: { requireAuth: false } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { Knex } from 'knex'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { isProcessServiceCall } from '@/lib/cron-auth'
import {
  bookingReminderScopes,
  claimReminder,
  dueReminderWindow,
  releaseReminder,
  type OrgScope,
} from '../../lib/reminder-runs'

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** Send the due booking reminders of one organization. Once per booking and window. */
async function runBookingReminders(knex: Knex, scope: OrgScope, now: Date): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  const bookings = await knex('bookings as b')
    .join('booking_pages as bp', function (this: Knex.JoinClause) {
      this.on('bp.id', '=', 'b.booking_page_id').andOn('bp.organization_id', '=', 'b.organization_id')
    })
    .where('b.organization_id', scope.organizationId)
    .where('b.tenant_id', scope.tenantId)
    .where('b.status', 'confirmed')
    .where('b.start_time', '>', now)
    .where('b.start_time', '<', new Date(now.getTime() + 25 * 3_600_000))
    .whereNotNull('bp.reminder_config')
    .select('b.*', 'bp.title as page_title', 'bp.reminder_config', 'bp.meeting_type', 'bp.meeting_location')

  for (const booking of bookings) {
    const startTime = new Date(booking.start_time)
    const window = dueReminderWindow(booking.reminder_config, startTime, now)
    if (!window || !booking.guest_email) continue
    const claimId = await claimReminder(knex, scope, 'booking', String(booking.id), window)
    if (!claimId) continue

    const eventDate = startTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    const eventTime = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const location = booking.meeting_type === 'google_meet' || booking.meeting_type === 'zoom'
      ? (booking.meeting_link || 'Virtual') : (booking.meeting_location || 'TBD')
    const firstName = String(booking.guest_name || '').split(' ')[0] || 'there'
    const pageTitle = booking.page_title || 'Your booking'
    const subject = window === '24h' ? `Reminder: ${pageTitle} tomorrow` : `Reminder: ${pageTitle} starts in 1 hour`
    const html = `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px">
        <h2 style="font-size:20px;margin:0 0 8px">Hi ${escapeHtml(firstName)}, just a reminder!</h2>
        <p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:20px">
          Your ${escapeHtml(booking.page_title || 'booking')} is coming up ${window === '24h' ? 'tomorrow' : 'in about an hour'}.
        </p>
        <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px">
          <p style="margin:0 0 6px;font-size:14px"><strong>Date:</strong> ${escapeHtml(eventDate)}</p>
          <p style="margin:0 0 6px;font-size:14px"><strong>Time:</strong> ${escapeHtml(eventTime)}</p>
          <p style="margin:0;font-size:14px"><strong>Location:</strong> ${escapeHtml(location)}</p>
        </div>
        ${booking.meeting_link ? `<a href="${escapeHtml(booking.meeting_link)}" style="display:inline-block;background:#3b82f6;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Join Meeting</a>` : ''}
        <p style="color:#94a3b8;font-size:12px;margin-top:24px">See you soon!</p>
      </div>`

    try {
      const result = await sendEmailByPurpose(knex, scope.organizationId, scope.tenantId, 'transactional', {
        to: booking.guest_email,
        subject,
        htmlBody: html,
        contactId: booking.contact_id || undefined,
      })
      if (result?.ok === false) throw new Error(result.error || 'send failed')
      sent++
    } catch (err) {
      failed++
      await releaseReminder(knex, scope, claimId).catch(() => {})
      console.error('[booking-reminders] send failed', { bookingId: booking.id, window, err: err instanceof Error ? err.message : String(err) })
    }
  }
  return { sent, failed }
}

// POST: send the due reminders for upcoming bookings. A signed-in user runs
// their own organization; the box cron (Bearer SEQUENCE_PROCESS_SECRET) runs
// every organization that has something due, each in its own tenant scope.
export async function POST(req: Request) {
  const service = isProcessServiceCall(req, process.env.SEQUENCE_PROCESS_SECRET)
  const auth = service ? null : await getAuthFromRequest(req)
  if (!service && (!auth?.orgId || !auth?.tenantId)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const now = new Date()
    const scopes: OrgScope[] = service
      ? await bookingReminderScopes(knex, now)
      : [{ organizationId: auth!.orgId!, tenantId: auth!.tenantId! }]

    let sent = 0
    let failed = 0
    for (const scope of scopes) {
      try {
        const r = await runBookingReminders(knex, scope, now)
        sent += r.sent
        failed += r.failed
      } catch (err) {
        failed++
        console.error('[booking-reminders] organization run failed', { organizationId: scope.organizationId, err: err instanceof Error ? err.message : String(err) })
      }
    }
    return NextResponse.json({ ok: true, data: { organizations: scopes.length, sent, failed } })
  } catch (error) {
    console.error('[booking-reminders]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
