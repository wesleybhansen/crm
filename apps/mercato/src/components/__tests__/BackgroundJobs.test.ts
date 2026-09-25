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

describe('claimReminderCheck after a clock step-back (2026-09-25 review, LOW)', () => {
  it('treats a stamp from the future as stale', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
    const now = 1_700_000_000_000
    expect(claimReminderCheck(now, storage)).toBe(true)
    // The clock steps back an hour: the next check must still run.
    expect(claimReminderCheck(now - 3_600_000, storage)).toBe(true)
    expect(claimReminderCheck(now - 3_600_000 + 5_000, storage)).toBe(false)
  })
})
