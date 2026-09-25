import { EVENTS_TABLES_SQL } from '../migrations/Migration20260925161500'

function tableColumns(table: string): Set<string> {
  const create = EVENTS_TABLES_SQL.find((sql) => sql.startsWith(`CREATE TABLE IF NOT EXISTS "${table}"`))
  if (!create) throw new Error(`no CREATE TABLE for ${table}`)
  const cols = new Set<string>()
  for (const match of create.matchAll(/^\s+"([a-z_]+)"\s/gm)) cols.add(match[1])
  return cols
}

// Every column the crm-events handlers, the kiosk, the Stripe event webhook
// and the contact timeline read or write (apps/mercato .../api/crm-events/**).
const EVENT_COLUMNS = [
  'id', 'tenant_id', 'organization_id', 'title', 'description', 'slug', 'event_type', 'status',
  'location_name', 'location_address', 'virtual_link', 'start_time', 'end_time', 'timezone',
  'is_recurring', 'recurrence_rule', 'recurrence_parent_id', 'capacity', 'registration_deadline',
  'price', 'currency', 'is_free', 'registration_fields', 'preapproved_emails', 'landing_copy',
  'landing_style', 'terms_text', 'reminder_config', 'attendee_count', 'kiosk_token',
  'created_at', 'updated_at', 'deleted_at',
]
const ATTENDEE_COLUMNS = [
  'id', 'tenant_id', 'organization_id', 'event_id', 'contact_id', 'attendee_name', 'attendee_email',
  'status', 'ticket_quantity', 'guest_details', 'registration_data', 'accepted_terms', 'payment_id',
  'checked_in_at', 'checkin_source', 'registered_at', 'cancelled_at', 'created_at',
]

describe('Migration20260925161500 (events tables)', () => {
  it('creates every events column the handlers use', () => {
    const cols = tableColumns('events')
    expect(EVENT_COLUMNS.filter((c) => !cols.has(c))).toEqual([])
  })

  it('creates every event_attendees column the handlers use', () => {
    const cols = tableColumns('event_attendees')
    expect(ATTENDEE_COLUMNS.filter((c) => !cols.has(c))).toEqual([])
  })

  it('is idempotent SQL only', () => {
    for (const sql of EVENTS_TABLES_SQL) {
      expect(sql).toMatch(/IF NOT EXISTS/)
    }
  })

  it('attendee_count starts at 0 so capacity math never sees NULL', () => {
    expect(EVENTS_TABLES_SQL[0]).toMatch(/"attendee_count" integer NOT NULL DEFAULT 0/)
  })
})
