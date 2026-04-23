/**
 * Global API-key rate-limit enforcement.
 *
 * Runs after auth resolution and before the RBAC feature check in the
 * catch-all API router (apps/mercato/src/app/api/[...slug]/route.ts).
 *
 * - Only throttles API-key-authenticated calls. Cookie-auth (the internal
 *   UI) is bypassed so user clicks never hit a 429.
 * - Consumes against TWO windows (minute + hour) per call so bursts can't
 *   blow the hourly budget in 30 seconds. Matches how GitHub / Stripe do it.
 * - Emits `RateLimit-*` + `Retry-After` headers on every response the
 *   router produces, not just 429s, so well-behaved clients can pace
 *   themselves without ever tripping the limit.
 */

import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import type { RateLimitResult } from '@open-mercato/shared/lib/ratelimit/types'
import { resolveTier, getTierWindows } from './rateLimitTiers'

export type ApiKeyRateLimitOutcome = {
  allowed: true
  headers: Record<string, string>
} | {
  allowed: false
  retryAfterSeconds: number
  limit: number
  windowSeconds: number
  headers: Record<string, string>
}

/**
 * Consume one point against both per-minute and per-hour windows for
 * this API key. Returns an outcome describing whether to continue, plus
 * the response headers to attach.
 */
export async function enforceApiKeyRateLimit(
  service: RateLimiterService,
  auth: NonNullable<AuthContext>,
): Promise<ApiKeyRateLimitOutcome | null> {
  const isApiKey = auth.isApiKey === true
  const keyId = typeof auth.keyId === 'string' ? auth.keyId : null
  if (!isApiKey || !keyId) return null

  const tierValue = typeof auth.rateLimitTier === 'string' ? auth.rateLimitTier : null
  const tier = resolveTier(tierValue)
  const windows = getTierWindows(tier)

  // Unlimited tier — skip the limiter entirely.
  if (!windows.minute && !windows.hour) {
    return { allowed: true, headers: { 'RateLimit-Policy': `tier=${tier}; unlimited` } }
  }

  // Per-minute window is the one clients see via headers (tighter of the two).
  // Run both in parallel; the stricter answer wins.
  const [minuteRes, hourRes] = await Promise.all([
    windows.minute ? service.consume(keyId, windows.minute) : null,
    windows.hour ? service.consume(keyId, windows.hour) : null,
  ])

  // Pick the worst case across both windows. Carry the ORIGINAL configured
  // limit (not consumed+remaining, which overcounts on overage) so the
  // response body and headers advertise the real per-window cap.
  let exhausted: { res: RateLimitResult; points: number; duration: number } | null = null
  if (minuteRes && !minuteRes.allowed && windows.minute) {
    exhausted = { res: minuteRes, points: windows.minute.points, duration: windows.minute.duration }
  } else if (hourRes && !hourRes.allowed && windows.hour) {
    exhausted = { res: hourRes, points: windows.hour.points, duration: windows.hour.duration }
  }
  if (exhausted) {
    const retryAfterSeconds = Math.max(1, Math.ceil(exhausted.res.msBeforeNext / 1000))
    return {
      allowed: false,
      retryAfterSeconds,
      limit: exhausted.points,
      windowSeconds: exhausted.duration,
      headers: {
        'RateLimit-Limit': String(exhausted.points),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(retryAfterSeconds),
        'RateLimit-Policy': `tier=${tier}; window=${exhausted.duration}; limit=${exhausted.points}`,
        'Retry-After': String(retryAfterSeconds),
      },
    }
  }

  // Allowed — surface the minute window's numbers in headers.
  const primaryRes = minuteRes ?? hourRes!
  const primaryWindow = windows.minute ?? windows.hour!
  const resetSeconds = Math.max(0, Math.ceil(primaryRes.msBeforeNext / 1000))
  return {
    allowed: true,
    headers: {
      'RateLimit-Limit': String(primaryWindow.points),
      'RateLimit-Remaining': String(Math.max(0, primaryRes.remainingPoints)),
      'RateLimit-Reset': String(resetSeconds),
      'RateLimit-Policy': `tier=${tier}; window=${primaryWindow.duration}; limit=${primaryWindow.points}`,
    },
  }
}

/**
 * Mutate a Response so the RateLimit-* headers are visible to the
 * caller. Next.js Response objects are immutable in some cases — when
 * mutation fails, we swap to a new Response preserving body + status.
 */
export function applyRateLimitHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value)
    }
    return response
  } catch {
    const next = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers })
    for (const [key, value] of Object.entries(headers)) {
      next.headers.set(key, value)
    }
    return next
  }
}
