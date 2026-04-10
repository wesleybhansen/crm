'use client'

import { useEffect } from 'react'

/**
 * Runs background jobs while the app is open:
 * - Reminder check every 60 seconds
 * - Email intelligence sync every 12 hours (already on dashboard, this is a backup)
 */
export function BackgroundJobs() {
  useEffect(() => {
    // Run reminder check immediately on mount
    fetch('/api/reminders/check', { method: 'POST', credentials: 'include' }).catch(() => {})

    // Then check every 60 seconds
    const reminderInterval = setInterval(() => {
      fetch('/api/reminders/check', { method: 'POST', credentials: 'include' }).catch(() => {})
    }, 60_000)

    // Email intelligence sync — check every 6 hours
    const syncInterval = setInterval(() => {
      fetch('/api/email/intelligence-settings', { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          if (!d.ok || !d.data?.is_enabled) return
          const lastSync = d.data.last_sync_at ? new Date(d.data.last_sync_at).getTime() : 0
          if (lastSync < Date.now() - 6 * 60 * 60 * 1000) {
            fetch('/api/email/intelligence-sync', { method: 'POST', credentials: 'include' }).catch(() => {})
          }
        })
        .catch(() => {})
    }, 6 * 60 * 60 * 1000) // 6 hours

    return () => {
      clearInterval(reminderInterval)
      clearInterval(syncInterval)
    }
  }, [])

  return null
}
