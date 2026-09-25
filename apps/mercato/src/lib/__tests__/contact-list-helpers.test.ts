import { contactInitials } from '../contact-initials'
import { dueDateKey, formatDueDate, isDueDateOverdue } from '../due-date'
import { createLatestRequestGuard } from '../latest-request'

describe('contactInitials', () => {
  it('uses letters and digits only, skipping a bracketed prefix', () => {
    expect(contactInitials('[e2e] Alice Qatest')).toBe('AQ')
    expect(contactInitials('[e2e] Imported')).toBe('I')
    expect(contactInitials('Ada Lovelace')).toBe('AL')
    expect(contactInitials('  jane   doe smith ')).toBe('JD')
    expect(contactInitials('"Bob" (Rob) Stone')).toBe('BR')
    expect(contactInitials('[vip]')).toBe('V')
    expect(contactInitials('---')).toBe('?')
    expect(contactInitials(null)).toBe('?')
    expect(contactInitials('Élodie Ümit')).toBe('ÉÜ')
    expect(contactInitials('3M Company', 1)).toBe('3')
  })
})

describe('due dates are calendar dates', () => {
  it('reads a bare date or a UTC-midnight instant as that calendar day', () => {
    expect(dueDateKey('2026-09-30')).toBe('2026-09-30')
    expect(dueDateKey('2026-09-30T00:00:00.000Z')).toBe('2026-09-30')
    expect(dueDateKey('2026-09-30T00:00:00+00:00')).toBe('2026-09-30')
    expect(dueDateKey('2026-09-30 00:00+00')).toBe('2026-09-30')
    expect(dueDateKey(new Date(Date.UTC(2026, 8, 30)))).toBe('2026-09-30')
    expect(dueDateKey('')).toBeNull()
    expect(dueDateKey(null)).toBeNull()
    expect(dueDateKey('not a date')).toBeNull()
  })

  it('formats the calendar day whatever the viewer time zone', () => {
    expect(formatDueDate('2026-09-30T00:00:00.000Z', 'en-US')).toBe('9/30/2026')
    expect(formatDueDate('2026-09-30', 'en-US')).toBe('9/30/2026')
    expect(formatDueDate(null)).toBe('')
  })

  it('is overdue only after the due day has passed', () => {
    const now = new Date(2026, 8, 30, 15, 0, 0) // local Sep 30, 3pm
    expect(isDueDateOverdue('2026-09-30T00:00:00.000Z', now)).toBe(false)
    expect(isDueDateOverdue('2026-09-29', now)).toBe(true)
    expect(isDueDateOverdue('2026-10-01', now)).toBe(false)
    expect(isDueDateOverdue(null, now)).toBe(false)
  })
})

describe('createLatestRequestGuard', () => {
  it('only the newest request stays current', () => {
    const guard = createLatestRequestGuard()
    const first = guard.next()
    expect(first()).toBe(true)
    const second = guard.next()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })
})
