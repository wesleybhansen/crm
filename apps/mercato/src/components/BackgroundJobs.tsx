'use client'

import { useEffect } from 'react'

export const REMINDER_CHECK_INTERVAL_MS = 60_000
export const EMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000
/** Wait for the page itself to finish loading before the first background call. */
export const BACKGROUND_JOBS_START_DELAY_MS = 5_000
const LAST_REMINDER_CHECK_KEY = 'noli:lastReminderCheckAt'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function safeStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/**
 * True when no open tab has run the reminder check within the interval.
 * Claims the slot when it returns true, so several open tabs (or a fresh page
 * load right after another) share one check per minute instead of each
 * firing their own.
 */
export function claimReminderCheck(now: number, storage: StorageLike | null = safeStorage()): boolean {
  if (!storage) return true
  try {
    const last = Number(storage.getItem(LAST_REMINDER_CHECK_KEY) ?? 0)
    if (Number.isFinite(last) && last > 0 && now - last < REMINDER_CHECK_INTERVAL_MS - 1_000) return false
    storage.setItem(LAST_REMINDER_CHECK_KEY, String(now))
  } catch {
    // Storage blocked: fall through and run the check.
  }
  return true
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/**
 * Runs background jobs while the app is open:
 * - Reminder check once a minute, shared across all open tabs
 * - Email intelligence sync every 15 minutes while the tab is visible (the
 *   dashboard also triggers it)
 *
 * The first run waits a few seconds so it does not compete with the page's
 * own requests.
 */
export function BackgroundJobs() {
  useEffect(() => {
    const runReminderCheck = () => {
      // Keeps running in background tabs: this poll is what delivers due
      // reminders, and browsers already slow hidden-tab timers to about once
      // a minute.
      if (!claimReminderCheck(Date.now())) return
      fetch('/api/reminders/check', { method: 'POST', credentials: 'include' }).catch(() => {})
    }

    const triggerEmailSync = () => {
      if (isHidden()) return
      fetch('/api/email/intelligence-settings', { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          if (!d.ok || !d.data?.is_enabled) return
          const lastSync = d.data.last_sync_at ? new Date(d.data.last_sync_at).getTime() : 0
          if (lastSync < Date.now() - EMAIL_SYNC_INTERVAL_MS) {
            fetch('/api/email/intelligence-sync', { method: 'POST', credentials: 'include' }).catch(() => {})
          }
        })
        .catch(() => {})
    }

    const startTimer = setTimeout(() => {
      runReminderCheck()
      triggerEmailSync()
    }, BACKGROUND_JOBS_START_DELAY_MS)
    const reminderInterval = setInterval(runReminderCheck, REMINDER_CHECK_INTERVAL_MS)
    const syncInterval = setInterval(triggerEmailSync, EMAIL_SYNC_INTERVAL_MS)

    return () => {
      clearTimeout(startTimer)
      clearInterval(reminderInterval)
      clearInterval(syncInterval)
    }
  }, [])

  return null
}
