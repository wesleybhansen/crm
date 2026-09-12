/** @jest-environment node */

import {
  checkMagicToken,
  magicLinkExpiresAt,
  magicLinkTtlDays,
  magicLinkTtlLabel,
  MAGIC_LINK_REUSE_WINDOW_MS,
  type MagicTokenRow,
} from '../magic-tokens'

const DAY = 24 * 60 * 60 * 1000
const originalEnv = process.env

beforeEach(() => {
  process.env = { ...originalEnv }
  delete process.env.COURSE_MAGIC_LINK_TTL_DAYS
})

afterAll(() => {
  process.env = originalEnv
})

function row(overrides: Partial<MagicTokenRow> = {}): MagicTokenRow {
  return {
    id: 'tok-1',
    organization_id: 'org-1',
    email: 'student@example.com',
    token: 'abc',
    expires_at: new Date(Date.now() + 3 * DAY),
    used_at: null,
    ...overrides,
  }
}

describe('magic link issuance', () => {
  it('defaults to a 7 day TTL', () => {
    const now = 1_700_000_000_000
    expect(magicLinkTtlDays()).toBe(7)
    expect(magicLinkExpiresAt(now).getTime()).toBe(now + 7 * DAY)
    expect(magicLinkTtlLabel()).toBe('7 days')
  })

  it('honours COURSE_MAGIC_LINK_TTL_DAYS and ignores junk values', () => {
    process.env.COURSE_MAGIC_LINK_TTL_DAYS = '1'
    expect(magicLinkExpiresAt(0).getTime()).toBe(DAY)
    expect(magicLinkTtlLabel()).toBe('1 day')
    process.env.COURSE_MAGIC_LINK_TTL_DAYS = '-3'
    expect(magicLinkTtlDays()).toBe(7)
    process.env.COURSE_MAGIC_LINK_TTL_DAYS = 'soon'
    expect(magicLinkTtlDays()).toBe(7)
  })
})

describe('checkMagicToken', () => {
  it('accepts an unexpired, unused token as a first use', () => {
    expect(checkMagicToken(row())).toEqual({ ok: true, firstUse: true })
  })

  it('rejects an expired token even if never used', () => {
    const now = Date.now()
    expect(checkMagicToken(row({ expires_at: new Date(now - 1) }), now)).toEqual({ ok: false, reason: 'expired' })
    expect(checkMagicToken(row({ expires_at: new Date(now) }), now)).toEqual({ ok: false, reason: 'expired' })
  })

  it('accepts ISO string timestamps from the driver', () => {
    const now = Date.now()
    expect(checkMagicToken(row({ expires_at: new Date(now + DAY).toISOString() }), now)).toEqual({ ok: true, firstUse: true })
    expect(checkMagicToken(row({ expires_at: new Date(now - DAY).toISOString() }), now)).toEqual({ ok: false, reason: 'expired' })
  })

  it('treats a missing or unparseable expiry as expired (fail closed)', () => {
    expect(checkMagicToken(row({ expires_at: null }))).toEqual({ ok: false, reason: 'expired' })
    expect(checkMagicToken(row({ expires_at: 'not a date' }))).toEqual({ ok: false, reason: 'expired' })
  })

  it('allows re-use only inside the short grace window after first use', () => {
    const now = Date.now()
    const justUsed = row({ used_at: new Date(now - 1000) })
    expect(checkMagicToken(justUsed, now)).toEqual({ ok: true, firstUse: false })

    const usedLongAgo = row({ used_at: new Date(now - MAGIC_LINK_REUSE_WINDOW_MS - 1) })
    expect(checkMagicToken(usedLongAgo, now)).toEqual({ ok: false, reason: 'used' })
  })

  it('reports expiry ahead of prior use', () => {
    const now = Date.now()
    const r = row({ expires_at: new Date(now - 1), used_at: new Date(now - DAY) })
    expect(checkMagicToken(r, now)).toEqual({ ok: false, reason: 'expired' })
  })
})
