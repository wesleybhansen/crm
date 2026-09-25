import { claimReminderCheck, REMINDER_CHECK_INTERVAL_MS } from '../BackgroundJobs'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

describe('claimReminderCheck', () => {
  it('polls no more than once a minute', () => {
    expect(REMINDER_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('lets one tab or page load claim the check per interval', () => {
    const storage = memoryStorage()
    const start = 1_000_000
    expect(claimReminderCheck(start, storage)).toBe(true)
    // A second tab, or a fresh page load right after, skips the call.
    expect(claimReminderCheck(start + 5_000, storage)).toBe(false)
    expect(claimReminderCheck(start + 30_000, storage)).toBe(false)
    // The next scheduled tick runs it again.
    expect(claimReminderCheck(start + REMINDER_CHECK_INTERVAL_MS, storage)).toBe(true)
  })

  it('still runs when storage is unavailable or throws', () => {
    expect(claimReminderCheck(1, null)).toBe(true)
    const throwing = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(claimReminderCheck(1, throwing)).toBe(true)
  })
})
