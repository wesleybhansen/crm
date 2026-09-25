/** @jest-environment node */
import { fairHousingAdvisory, lintFairHousing, normalizeForScreening } from '../fair-housing'

describe('fair-housing lint', () => {
  it.each([
    'This home is perfect for families.',
    'No kids, please.',
    'A quiet neighborhood, walking distance to church.',
    'No Section 8.',
    'Adults only building.',
    'Great for empty nesters.',
    'English-speaking tenants.',
    'Female only.',
    'Able-bodied buyers.',
    'Near a country club.',
  ])('flags housing steering: %s', (text) => {
    expect(lintFairHousing(text).ok).toBe(false)
  })

  it.each([
    'Hi Maria, I was thinking of you and hope the new place is treating you well.',
    'Congrats on the gender reveal! Hope the kids are loving the backyard.',
    'You must be able to relax now that the move is done.',
    'Thanks again for trusting us. Would you share a short review of your experience?',
    'If you know anyone who could use a hand buying or selling, I would love to help.',
    'Merry Christmas and happy holidays from all of us.',
    'Our quarterly newsletter: market update, new listings and open house dates.',
    'It was great for our team to work with your family.',
  ])('does not flag ordinary business mail: %s', (text) => {
    expect(lintFairHousing(text)).toEqual({ ok: true, findings: [] })
  })

  // 2026-09-25 review, M9: verified misses.
  it.each([
    'A 55+ community with a pool.',
    '55 and older only.',
    'No Section-8.',
    'No section 8 vouchers.',
    'A kid-free building.',
    'N0 kids please.',
    'No k1ds.',
    'N\u043e kids, adults \u043enly.',
    'Perfect f\u043er families.',
    'Walking distance to the church.',
    'Great bachelor pad.',
  ])('catches: %s', (text) => {
    expect(lintFairHousing(text).ok).toBe(false)
  })

  // 2026-09-25 review, M9: verified false positives.
  it.each([
    "Congrats on finishing your bachelor's degree!",
    'She earned a Bachelor of Science last spring.',
    'You mentioned wanting a quiet neighborhood; I will keep an eye out.',
    'We volunteer with Catholic Charities every December.',
    'Section 8 vouchers are welcome here.',
    'Call me at 555-0100 any time.',
  ])('does not flag: %s', (text) => {
    expect(lintFairHousing(text)).toEqual({ ok: true, findings: [] })
  })

  it('normalises homoglyphs and letter-adjacent digits, keeps real numbers', () => {
    expect(normalizeForScreening('N0 k1ds')).toBe('No kids')
    expect(normalizeForScreening('N\u043e kids')).toBe('No kids')
    expect(normalizeForScreening('Section 8, 55+ and 555-0100')).toBe('Section 8, 55+ and 555-0100')
  })

  it('ignores a religious word that is the recipient’s own name, not others', () => {
    expect(lintFairHousing('Hi Christian, hope all is well.', { ignoreNames: ['Christian Diaz'] }).ok).toBe(true)
    expect(lintFairHousing('Hi Christian, hope all is well.').ok).toBe(false)
    expect(lintFairHousing('Hi Christian, it is a Catholic area.', { ignoreNames: ['Christian Diaz'] }).findings.map((f) => f.term)).toEqual(['Catholic'])
  })

  it('advisory names each term and says it is not legal advice', () => {
    const { findings } = lintFairHousing('Perfect for families in a safe neighborhood.')
    const line = fairHousingAdvisory(findings)!
    expect(line).toMatch(/"Perfect for families"/)
    expect(line).toMatch(/"safe neighborhood"/)
    expect(line).toMatch(/not legal advice/)
    expect(fairHousingAdvisory([])).toBeNull()
  })
})
