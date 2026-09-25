/** @jest-environment node */
import { enrollmentBlockedReason, noEmailBannerText, summarizeEnrollResults } from '../enrollment'

describe('enrollmentBlockedReason', () => {
  it('allows only active sequences', () => {
    expect(enrollmentBlockedReason('active')).toBeNull()
    expect(enrollmentBlockedReason('draft')).toBe('This sequence is a draft. Activate it before enrolling contacts.')
    expect(enrollmentBlockedReason('paused')).toMatch(/paused/)
    expect(enrollmentBlockedReason('archived')).toMatch(/archived/)
    expect(enrollmentBlockedReason(undefined)).toMatch(/active sequence/)
  })
})

describe('summarizeEnrollResults', () => {
  it('returns null for nothing attempted', () => {
    expect(summarizeEnrollResults([])).toBeNull()
  })

  it('reports success with correct plurals', () => {
    expect(summarizeEnrollResults([{ ok: true }])).toEqual({ tone: 'success', text: 'Enrolled 1 contact.' })
    expect(summarizeEnrollResults([{ ok: true }, { ok: true }])?.text).toBe('Enrolled 2 contacts.')
  })

  it('carries the server reason instead of guessing "may already be enrolled"', () => {
    const r = summarizeEnrollResults([{ ok: false, error: 'This sequence is a draft. Activate it before enrolling contacts.' }])
    expect(r).toEqual({ tone: 'error', text: 'Could not enroll the contact. This sequence is a draft. Activate it before enrolling contacts.' })
    expect(r?.text).not.toMatch(/may already/)
  })

  it('deduplicates reasons and handles partial success', () => {
    const r = summarizeEnrollResults([
      { ok: true },
      { ok: false, error: 'Contact is already enrolled in this sequence' },
      { ok: false, error: 'Contact is already enrolled in this sequence' },
    ])
    expect(r?.text).toBe('Enrolled 1 of 3 contacts. 2 contacts were not enrolled. Contact is already enrolled in this sequence')
  })

  it('falls back when no reason came back', () => {
    expect(summarizeEnrollResults([{ ok: false }, { ok: false, error: '' }])?.text).toBe('Could not enroll any of the 2 contacts. Unknown error')
  })
})

describe('noEmailBannerText', () => {
  it('only promises waiting enrollments for an active sequence', () => {
    expect(noEmailBannerText('active')).toMatch(/wait at their email step/)
    expect(noEmailBannerText('draft')).not.toMatch(/wait/)
    expect(noEmailBannerText('draft')).toMatch(/activate this sequence and enroll contacts once/)
  })
})
