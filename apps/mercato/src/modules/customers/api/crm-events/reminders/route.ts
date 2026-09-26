// ORM-SKIP: events/event_attendees are raw-knex tables (no mercato entity), created by customers Migration20260925161500
export const metadata = { path: '/crm-events/reminders', POST: { requireAuth: false } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { Knex } from 'knex'
import { openSecretForTenant } from '@open-mercato/shared/lib/encryption/secretColumns'
import { espOwnFromAddress } from '../../../../email/lib/routing-service'
import { decryptAttendeesForSend } from '@/modules/customers/lib/event-attendees'
import { isProcessServiceCall } from '@/lib/cron-auth'
import { claimReminder, dueReminderWindow, eventReminderScopes, releaseReminder, type OrgScope } from '../../../../calendar/lib/reminder-runs'


function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** Send the due event reminders of one organization: once per attendee and window. */
async function runEventReminders(knex: Knex, scope: OrgScope, now: Date): Promise<{ sent: number; failed: number; skipped?: string }> {
  // Send via the org's own ESP only (no platform sender).
  const espConn = await knex('esp_connections')
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .where('is_active', true)
    .first()
  const resendKey = espConn?.provider === 'resend'
    ? await openSecretForTenant(null, espConn.tenant_id ?? scope.tenantId, espConn.api_key)
    : null
  // The customer's own from address only; never Noli's EMAIL_FROM.
  const espFrom = espOwnFromAddress(espConn)
  if (!resendKey || !espFrom) return { sent: 0, failed: 0, skipped: 'No ESP connected' }

  let sent = 0
  let failed = 0
  const events = await knex('events')
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .where('status', 'published')
    .where('start_time', '>', now)
    .where('start_time', '<', new Date(now.getTime() + 25 * 3_600_000))
    .whereNull('deleted_at')

  let resend: { emails: { send: (msg: Record<string, unknown>) => Promise<{ error?: unknown } | unknown> } } | null = null
  for (const event of events) {
    const eventStart = new Date(event.start_time)
    const window = dueReminderWindow(event.reminder_config, eventStart, now)
    if (!window) continue

    const storedAttendees = await knex('event_attendees')
      .where('event_id', event.id)
      .where('organization_id', scope.organizationId)
      .where('status', 'registered')
    // Strict for a send: undecryptable registrations are skipped (M11).
    const { rows: attendees } = await decryptAttendeesForSend(storedAttendees, scope.tenantId, scope.organizationId)
    if (attendees.length === 0) continue

    const eventDate = eventStart.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    const eventTime = eventStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const location = event.event_type === 'virtual' ? (event.virtual_link || 'Virtual') : (event.location_name || 'TBD')
    const timeLabel = window === '1h' ? 'starting in 1 hour' : 'tomorrow'

    if (!resend) {
      const { Resend } = await import('resend')
      resend = new Resend(resendKey) as unknown as typeof resend
    }

    for (const attendee of attendees) {
      if (!attendee.attendee_email) continue
      const claimId = await claimReminder(knex, scope, 'event', String(attendee.id), window)
      if (!claimId) continue
      try {
        const result = await resend!.emails.send({
          from: espFrom,
          to: [attendee.attendee_email],
          subject: `Reminder: ${event.title} is ${timeLabel}`,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px">
              <h2 style="font-size:20px;margin:0 0 12px">Hi ${escapeHtml(String(attendee.attendee_name || '').split(' ')[0] || 'there')},</h2>
              <p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:20px">Just a reminder that <strong>${escapeHtml(event.title)}</strong> is ${timeLabel}.</p>
              <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px">
                <p style="margin:0 0 6px;font-size:14px"><strong>Date:</strong> ${escapeHtml(eventDate)}</p>
                <p style="margin:0 0 6px;font-size:14px"><strong>Time:</strong> ${escapeHtml(eventTime)}</p>
                <p style="margin:0;font-size:14px"><strong>Location:</strong> ${escapeHtml(location)}</p>
              </div>
              ${event.event_type !== 'in-person' && event.virtual_link ? `<a href="${escapeHtml(event.virtual_link)}" style="display:inline-block;background:#3b82f6;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Join Event</a>` : ''}
              <p style="color:#94a3b8;font-size:12px;margin-top:24px">See you there!</p>
            </div>`,
        })
        if (result && typeof result === 'object' && (result as { error?: unknown }).error) throw new Error('ESP refused the message')
        sent++
      } catch (err) {
        failed++
        await releaseReminder(knex, scope, claimId).catch(() => {})
        console.error('[crm-events.reminders] send failed', { eventId: event.id, window, err: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return { sent, failed }
}

// POST: send the due reminders for upcoming events. A signed-in user runs
// their own organization; the box cron (Bearer SEQUENCE_PROCESS_SECRET) runs
// every organization with a published event in the next 25 hours, each in its
// own tenant scope. Once per attendee and window (calendar/lib/reminder-runs).
export async function POST(req: Request) {
  const service = isProcessServiceCall(req, process.env.SEQUENCE_PROCESS_SECRET)
  const auth = service ? null : await getAuthFromRequest(req)
  if (!service && (!auth?.orgId || !auth?.tenantId)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as unknown as Knex
    const now = new Date()
    const scopes: OrgScope[] = service
      ? await eventReminderScopes(knex, now)
      : [{ organizationId: auth!.orgId!, tenantId: auth!.tenantId! }]

    let sent = 0
    let failed = 0
    let message: string | undefined
    for (const scope of scopes) {
      try {
        const r = await runEventReminders(knex, scope, now)
        sent += r.sent
        failed += r.failed
        if (!service && r.skipped) message = r.skipped
      } catch (err) {
        failed++
        console.error('[crm-events.reminders] organization run failed', { organizationId: scope.organizationId, err: err instanceof Error ? err.message : String(err) })
      }
    }
    return NextResponse.json({ ok: true, data: { organizations: scopes.length, sent, failed, ...(message ? { message } : {}) } })
  } catch (error: any) {
    console.error('[crm-events.reminders]', error?.message)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
