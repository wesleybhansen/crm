/* Booking and event reminders, run per organization.
 *
 * Both reminder routes (api/reminders for bookings, customers/api/crm-events/
 * reminders for events) used to need a signed-in user, so nothing ever ran
 * them: no page called them and the box cron could not. They now also accept
 * the box cron's Bearer SEQUENCE_PROCESS_SECRET and then walk every
 * organization with something due, each in its own tenant scope.
 *
 * A reminder goes out once per booking (or per event attendee) and window
 * ('24h' / '1h'), decided by OUR ledger (reminder_deliveries, unique per
 * organization, kind, subject and window): the row is claimed before the send
 * and released if the send fails, so a cron tick every few minutes never sends
 * twice and a failed send is retried on the next tick. (The old booking
 * de-dup ran a LIKE on a jsonb column, which Postgres rejects, and events had
 * no de-dup at all.)
 *
 * Relative imports only. */
import type { Knex } from 'knex'

export type ReminderWindow = '24h' | '1h'
export type ReminderKind = 'booking' | 'event'
export type OrgScope = { organizationId: string; tenantId: string }

export const REMINDER_LEDGER = 'reminder_deliveries'

type ReminderSetting = { sendBefore?: unknown }

function parseReminders(raw: unknown): ReminderSetting[] {
  let value: unknown = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return [] }
  }
  return Array.isArray(value) ? (value.filter((r) => r && typeof r === 'object') as ReminderSetting[]) : []
}

/**
 * The reminder window due now for something starting at `start`, or null.
 * 24h: 20 to 25 hours ahead. 1h: 15 to 90 minutes ahead. Only windows the
 * owner configured count; when both are configured and due, 1h wins.
 */
export function dueReminderWindow(reminders: unknown, start: Date, now: Date): ReminderWindow | null {
  const hoursUntil = (start.getTime() - now.getTime()) / 3_600_000
  if (!Number.isFinite(hoursUntil) || hoursUntil <= 0) return null
  const configured = new Set(parseReminders(reminders).map((r) => String(r.sendBefore ?? '')))
  if (configured.has('1h') && hoursUntil <= 1.5 && hoursUntil > 0.25) return '1h'
  if (configured.has('24h') && hoursUntil <= 25 && hoursUntil > 20) return '24h'
  return null
}

/** Claim one delivery before sending. Returns the claim id, or null when it was already sent (or claimed). */
export async function claimReminder(
  knex: Knex,
  scope: OrgScope,
  kind: ReminderKind,
  subjectId: string,
  window: ReminderWindow,
): Promise<string | null> {
  const rows = await knex(REMINDER_LEDGER)
    .insert({
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      kind,
      subject_id: subjectId,
      reminder_window: window,
      created_at: new Date(),
    })
    .onConflict(['organization_id', 'kind', 'subject_id', 'reminder_window'])
    .ignore()
    .returning('id')
  const first = Array.isArray(rows) ? rows[0] : null
  if (!first) return null
  return typeof first === 'object' ? String((first as { id: unknown }).id) : String(first)
}

/** Give a claim back after a failed send, so the next run retries it. */
export async function releaseReminder(knex: Knex, scope: OrgScope, claimId: string): Promise<void> {
  await knex(REMINDER_LEDGER)
    .where('id', claimId)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .del()
}

/** Organizations (with their tenant) that have a confirmed booking in the next 25 hours on a page with reminders. */
export async function bookingReminderScopes(knex: Knex, now: Date): Promise<OrgScope[]> {
  const rows = await knex('bookings as b')
    .join('booking_pages as bp', function (this: Knex.JoinClause) {
      this.on('bp.id', '=', 'b.booking_page_id').andOn('bp.organization_id', '=', 'b.organization_id')
    })
    .where('b.status', 'confirmed')
    .where('b.start_time', '>', now)
    .where('b.start_time', '<', new Date(now.getTime() + 25 * 3_600_000))
    .whereNotNull('bp.reminder_config')
    .distinct('b.organization_id', 'b.tenant_id')
  return (rows as Array<{ organization_id: string; tenant_id: string }>).map((r) => ({ organizationId: String(r.organization_id), tenantId: String(r.tenant_id) }))
}

/** Organizations (with their tenant) that have a published event in the next 25 hours. */
export async function eventReminderScopes(knex: Knex, now: Date): Promise<OrgScope[]> {
  const rows = await knex('events')
    .where('status', 'published')
    .whereNull('deleted_at')
    .where('start_time', '>', now)
    .where('start_time', '<', new Date(now.getTime() + 25 * 3_600_000))
    .distinct('organization_id', 'tenant_id')
  return (rows as Array<{ organization_id: string; tenant_id: string }>).map((r) => ({ organizationId: String(r.organization_id), tenantId: String(r.tenant_id) }))
}
