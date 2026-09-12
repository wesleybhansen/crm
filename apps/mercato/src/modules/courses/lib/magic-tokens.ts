/**
 * Course magic-link token policy, shared by every issuer
 * (student/magic-link, enrollments, checkout) and the verifier (student/verify).
 *
 * Storage: `course_magic_tokens` (id, organization_id, email, token, expires_at, used_at, created_at).
 *
 * - Expiry: tokens are valid for COURSE_MAGIC_LINK_TTL_DAYS days (default 7) from issuance.
 * - Bounded use: the first successful verification stamps `used_at`. The same link keeps working
 *   for a short grace window after that (email-client link prefetchers and double clicks would
 *   otherwise burn strict single-use links before the student ever lands). After the window the
 *   token is dead and the student must request a fresh link.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_MAGIC_LINK_TTL_DAYS = 7
export const MAGIC_LINK_REUSE_WINDOW_MS = 10 * 60 * 1000

export function magicLinkTtlDays(): number {
  const raw = Number(process.env.COURSE_MAGIC_LINK_TTL_DAYS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAGIC_LINK_TTL_DAYS
}

/** Expiry timestamp for a token issued now. */
export function magicLinkExpiresAt(now: number = Date.now()): Date {
  return new Date(now + magicLinkTtlDays() * DAY_MS)
}

/** Human copy for emails / pages, e.g. "7 days". */
export function magicLinkTtlLabel(): string {
  const days = magicLinkTtlDays()
  return days === 1 ? '1 day' : `${days} days`
}

export type MagicTokenRow = {
  id: string
  organization_id: string
  email: string
  token: string
  expires_at: Date | string | null
  used_at: Date | string | null
  created_at?: Date | string | null
}

export type MagicTokenRejection = 'expired' | 'used'
export type MagicTokenCheck = { ok: true; firstUse: boolean } | { ok: false; reason: MagicTokenRejection }

function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** Decide whether a stored token may be redeemed right now. */
export function checkMagicToken(row: MagicTokenRow, now: number = Date.now()): MagicTokenCheck {
  const expiresAt = toMs(row.expires_at)
  // A missing/unparseable expiry is treated as expired: never fail open on an auth token.
  if (expiresAt === null || now >= expiresAt) return { ok: false, reason: 'expired' }

  const usedAt = toMs(row.used_at)
  if (usedAt === null) return { ok: true, firstUse: true }
  if (now - usedAt <= MAGIC_LINK_REUSE_WINDOW_MS) return { ok: true, firstUse: false }
  return { ok: false, reason: 'used' }
}
