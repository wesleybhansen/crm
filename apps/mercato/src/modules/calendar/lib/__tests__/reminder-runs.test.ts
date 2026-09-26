import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { claimReminder, dueReminderWindow, releaseReminder } from '../reminder-runs'
import { isProcessServiceCall } from '../../../../lib/cron-auth'

const scope = { organizationId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222' }
const NOW = new Date('2026-09-26T12:00:00Z')
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000)

function ledgerDb() {
  return createFakeDb(
    { reminder_deliveries: [] },
    { reminder_deliveries: [['organization_id', 'kind', 'subject_id', 'reminder_window']] },
  )
}

describe('dueReminderWindow', () => {
  const both = [{ sendBefore: '24h' }, { sendBefore: '1h' }]
  it('is due only inside a configured window', () => {
    expect(dueReminderWindow(both, hoursAhead(23), NOW)).toBe('24h')
    expect(dueReminderWindow(both, hoursAhead(1), NOW)).toBe('1h')
    expect(dueReminderWindow(both, hoursAhead(10), NOW)).toBeNull()
    expect(dueReminderWindow(both, hoursAhead(0.1), NOW)).toBeNull()
    expect(dueReminderWindow([{ sendBefore: '1h' }], hoursAhead(23), NOW)).toBeNull()
    expect(dueReminderWindow(JSON.stringify([{ sendBefore: '24h' }]), hoursAhead(22), NOW)).toBe('24h')
    expect(dueReminderWindow('not json', hoursAhead(22), NOW)).toBeNull()
    expect(dueReminderWindow(both, hoursAhead(-1), NOW)).toBeNull()
  })
})

describe('reminder ledger', () => {
  it('claims a booking reminder once per window, however often the cron runs', async () => {
    const knex = ledgerDb()
    const first = await claimReminder(knex as never, scope, 'booking', 'b-1', '24h')
    const again = await claimReminder(knex as never, scope, 'booking', 'b-1', '24h')
    const otherWindow = await claimReminder(knex as never, scope, 'booking', 'b-1', '1h')
    expect(first).toBeTruthy()
    expect(again).toBeNull()
    expect(otherWindow).toBeTruthy()
    expect(knex.db.tables.reminder_deliveries).toHaveLength(2)
    expect(knex.db.tables.reminder_deliveries[0]).toMatchObject({ organization_id: scope.organizationId, tenant_id: scope.tenantId, kind: 'booking' })
  })

  it('a released claim (failed send) can be claimed again on the next run', async () => {
    const knex = ledgerDb()
    const claim = await claimReminder(knex as never, scope, 'event', 'att-1', '1h')
    await releaseReminder(knex as never, scope, claim!)
    expect(await claimReminder(knex as never, scope, 'event', 'att-1', '1h')).toBeTruthy()
  })
})

describe('isProcessServiceCall', () => {
  const req = (auth?: string) => new Request('http://x/api/calendar/reminders', { method: 'POST', headers: auth ? { authorization: auth } : {} })
  it('accepts only the exact Bearer secret', () => {
    expect(isProcessServiceCall(req('Bearer s3cret'), 's3cret')).toBe(true)
    expect(isProcessServiceCall(req('Bearer s3cre'), 's3cret')).toBe(false)
    expect(isProcessServiceCall(req('Bearer s3cretX'), 's3cret')).toBe(false)
    expect(isProcessServiceCall(req(), 's3cret')).toBe(false)
    expect(isProcessServiceCall(req('Bearer '), undefined)).toBe(false)
    expect(isProcessServiceCall(req('Bearer ééé'), 'abcdef')).toBe(false)
  })
})
