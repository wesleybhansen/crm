/** @jest-environment node */
import { fairHousingAdvisory, lintFairHousing } from '../fair-housing'

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
