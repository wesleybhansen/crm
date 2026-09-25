/**
 * Task due dates are calendar dates. The date picker sends "2026-09-30", the
 * API stores it as 2026-09-30T00:00:00Z, and formatting that instant in the
 * viewer's zone (Pacific) showed "9/29/2026" (QA 2026-09-25 #6). A value at
 * exactly UTC midnight, or a bare YYYY-MM-DD, is read as that calendar date;
 * anything with a real time of day keeps the viewer's local date.
 */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const UTC_MIDNIGHT_RE = /^(\d{4})-(\d{2})-(\d{2})T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00(?::?00)?)$/

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The calendar date (YYYY-MM-DD) a due date stands for, or null when it is empty or invalid. */
export function dueDateKey(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const m = DATE_ONLY_RE.exec(trimmed) ?? UTC_MIDNIGHT_RE.exec(trimmed)
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
  }
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }
  return localDateKey(d)
}

/** "9/30/2026" (in the viewer's locale) for the due date's calendar day. */
export function formatDueDate(value: string | Date | null | undefined, locale?: string, options?: Intl.DateTimeFormatOptions): string {
  const key = dueDateKey(value)
  if (!key) return ''
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { ...options, timeZone: 'UTC' })
}

/** True once the due day has fully passed in the viewer's zone (due today is not overdue). */
export function isDueDateOverdue(value: string | Date | null | undefined, now: Date = new Date()): boolean {
  const key = dueDateKey(value)
  if (!key) return false
  return key < localDateKey(now)
}
