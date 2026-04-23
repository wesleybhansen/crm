/**
 * API-key rate-limit tier definitions.
 *
 * Each API-key request passes through TWO windows (per-minute and per-hour).
 * The limiter rejects the request if either window is exhausted, matching
 * the way GitHub and Stripe handle burst-vs-sustained limits.
 *
 * Stored as `api_keys.rate_limit_tier text` — NULL resolves to `default`
 * so pre-Phase-2 keys keep working without a data migration.
 */

import type { RateLimitConfig } from '@open-mercato/shared/lib/ratelimit/types'

export type ApiKeyRateLimitTier = 'default' | 'pro' | 'unlimited'

/** How a tier decomposes into per-minute + per-hour windows. */
export type TierWindows = {
  /** Per-minute window (null = unlimited, skip the check). */
  minute: RateLimitConfig | null
  /** Per-hour window (null = unlimited, skip the check). */
  hour: RateLimitConfig | null
}

const MINUTE_SECONDS = 60
const HOUR_SECONDS = 60 * 60

/**
 * Tier → windows map. v1 ships `default` and `unlimited`. `pro` is in the
 * map but can be repriced without code changes.
 */
export const RATE_LIMIT_TIERS: Record<ApiKeyRateLimitTier, TierWindows> = {
  default: {
    minute: { points: 60, duration: MINUTE_SECONDS, keyPrefix: 'apikey:min' },
    hour: { points: 1000, duration: HOUR_SECONDS, keyPrefix: 'apikey:hour' },
  },
  pro: {
    minute: { points: 300, duration: MINUTE_SECONDS, keyPrefix: 'apikey:min' },
    hour: { points: 10000, duration: HOUR_SECONDS, keyPrefix: 'apikey:hour' },
  },
  unlimited: {
    minute: null,
    hour: null,
  },
}

/** Resolve a raw DB value to a tier, defaulting NULL / unknown → 'default'. */
export function resolveTier(value: string | null | undefined): ApiKeyRateLimitTier {
  const normalized = (value ?? '').toString().trim().toLowerCase()
  if (normalized === 'unlimited') return 'unlimited'
  if (normalized === 'pro') return 'pro'
  return 'default'
}

export function getTierWindows(tier: ApiKeyRateLimitTier): TierWindows {
  return RATE_LIMIT_TIERS[tier]
}
