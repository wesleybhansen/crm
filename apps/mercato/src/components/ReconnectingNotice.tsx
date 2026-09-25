"use client"

import { useEffect, useState } from 'react'

const RETRY_DELAYS_SECONDS = [3, 5, 10, 20, 30]
const ATTEMPT_KEY = 'noli:reconnect-attempt'

const RESET_AFTER_MS = 2 * 60 * 1000

function readAttempt(): number {
  try {
    const raw = window.sessionStorage.getItem(ATTEMPT_KEY)
    if (!raw) return 0
    const parsed = JSON.parse(raw) as { n?: unknown; at?: unknown }
    const n = typeof parsed.n === 'number' && parsed.n > 0 ? parsed.n : 0
    const at = typeof parsed.at === 'number' ? parsed.at : 0
    // A fresh outage starts the back-off again.
    return Date.now() - at > RESET_AFTER_MS ? 0 : n
  } catch {
    return 0
  }
}

function writeAttempt(value: number) {
  try {
    window.sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ n: value, at: Date.now() }))
  } catch {
    // storage blocked: retries still work, they just don't back off
  }
}

/**
 * Shown when the server couldn't confirm the user's sign-in because of a
 * temporary failure (database down, timeout, a deploy in progress). The user
 * is still signed in, so this retries on its own with a growing delay instead
 * of sending them to sign in again.
 */
export function ReconnectingNotice() {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  useEffect(() => {
    const attempt = readAttempt()
    const delay = RETRY_DELAYS_SECONDS[Math.min(attempt, RETRY_DELAYS_SECONDS.length - 1)]
    writeAttempt(attempt + 1)
    setSecondsLeft(delay)
    const startedAt = Date.now()
    const tick = window.setInterval(() => {
      const remaining = Math.max(0, delay - Math.floor((Date.now() - startedAt) / 1000))
      setSecondsLeft(remaining)
      if (remaining <= 0) {
        window.clearInterval(tick)
        window.location.reload()
      }
    }, 500)
    return () => window.clearInterval(tick)
  }, [])

  return (
    <div role="status" aria-live="polite" className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold text-foreground">Reconnecting&hellip;</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          We&apos;re having trouble reaching the server. You&apos;re still signed in.
          {secondsLeft !== null ? ` Trying again in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}.` : ''}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 inline-flex min-h-[40px] items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again now
        </button>
      </div>
    </div>
  )
}

export default ReconnectingNotice
