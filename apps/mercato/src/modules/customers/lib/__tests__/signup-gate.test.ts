/** @jest-environment node */

import { isSignupInvited, normalizeSignupEmail, SIGNUP_INVITE_ONLY_MESSAGE } from '../signup-gate'

const originalEnv = process.env

beforeEach(() => {
  process.env = { ...originalEnv }
  delete process.env.SIGNUP_INVITED_EMAILS
})

afterAll(() => {
  process.env = originalEnv
})

describe('signup gate', () => {
  it('rejects an email with no invitation', () => {
    expect(isSignupInvited('stranger@example.com')).toBe(false)
    expect(isSignupInvited('')).toBe(false)
    expect(isSignupInvited(undefined)).toBe(false)
  })

  it('accepts a whitelisted email regardless of case and whitespace', () => {
    expect(isSignupInvited('wesley.b.hansen@gmail.com')).toBe(true)
    expect(isSignupInvited('  Wesley.B.Hansen@Gmail.com ')).toBe(true)
  })

  it('accepts emails invited via SIGNUP_INVITED_EMAILS', () => {
    process.env.SIGNUP_INVITED_EMAILS = ' Invited@Example.com , other@example.com'
    expect(isSignupInvited('invited@example.com')).toBe(true)
    expect(isSignupInvited('other@example.com')).toBe(true)
    expect(isSignupInvited('nobody@example.com')).toBe(false)
  })

  it('normalizes emails the same way the routes do', () => {
    expect(normalizeSignupEmail('  A@B.COM ')).toBe('a@b.com')
    expect(normalizeSignupEmail(null)).toBe('')
  })

  it('exposes the message both routes use', () => {
    expect(SIGNUP_INVITE_ONLY_MESSAGE).toBe('Signups are currently invite-only. Contact us for access.')
  })
})
