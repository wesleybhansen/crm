import { qualifyDecisionMaker } from '../decision-makers/qualify'

const APPROVED = ['Owner', 'Founder', 'CEO', 'President', 'Practice Owner', 'Managing Partner']

describe('qualifyDecisionMaker (v2: head-of-title + negation guards)', () => {
  it('accepts an approved role at the head of the title or of a conjunction segment', () => {
    for (const title of [
      'CEO',
      'Owner',
      'Co-Founder & Practice Owner',
      'Founder and CEO',
      'President, Example Dental',
      'Managing Partner / Attorney',
      'Owner - Example Dental',
      'Senior Managing Partner',
      'CEO | Board Member',
    ]) {
      expect(qualifyDecisionMaker(title, APPROVED)).toEqual(
        expect.objectContaining({ verdict: 'accepted', score: 0.95, version: 'decision-maker-v2' }),
      )
    }
    expect(qualifyDecisionMaker('Co-Founder & Practice Owner', ['Practice Owner', 'Founder']).matched_title)
      .toBe('Practice Owner')
  })

  it('reviews a buried phrase that does not lead the title', () => {
    for (const title of [
      'Marketing Manager reporting to the CEO',
      'Advisor to the CEO',
      'Board Observer at Owner Holdings',
      'Head of Growth (ex-agency owner)',
    ]) {
      const result = qualifyDecisionMaker(title, APPROVED)
      expect(result.verdict).not.toBe('accepted')
    }
    expect(qualifyDecisionMaker('Operations Lead supporting the CEO', APPROVED)).toEqual(
      expect.objectContaining({ verdict: 'review', matched_title: 'CEO', score: 0.6 }),
    )
  })

  it('rejects former and past roles', () => {
    for (const title of ['Former CEO', 'Ex-CEO', 'Retired Owner', 'President Emeritus', 'Past President']) {
      expect(qualifyDecisionMaker(title, APPROVED)).toEqual(
        expect.objectContaining({ verdict: 'rejected', matched_title: null }),
      )
    }
  })

  it('reviews adjacent, acting, and junior versions of an approved role', () => {
    for (const title of [
      'Vice President of Marketing',
      'Deputy CEO',
      'Interim CEO',
      'Acting President',
      'Junior Partner',
      'Product Owner',
      'HR Business Partner',
      'Office of the CEO',
      'Chief of Staff to the CEO',
    ]) {
      expect(qualifyDecisionMaker(title, APPROVED)).toEqual(
        expect.objectContaining({ verdict: 'review', matched_title: null }),
      )
    }
  })

  it('keeps a modifier that is itself part of the approved title', () => {
    expect(qualifyDecisionMaker('Vice President of Sales', ['Vice President of Sales'])).toEqual(
      expect.objectContaining({ verdict: 'accepted', matched_title: 'Vice President of Sales' }),
    )
    expect(qualifyDecisionMaker('Product Owner', ['Product Owner'])).toEqual(
      expect.objectContaining({ verdict: 'accepted' }),
    )
  })

  it('still rejects the historical non-decision-maker terms', () => {
    expect(qualifyDecisionMaker('Executive Assistant to the CEO', ['CEO'])).toEqual(
      expect.objectContaining({ verdict: 'rejected', matched_title: null }),
    )
    expect(qualifyDecisionMaker('Recruiter', APPROVED).verdict).toBe('rejected')
    expect(qualifyDecisionMaker('Clinical Director', ['Owner', 'Founder'])).toEqual(
      expect.objectContaining({ verdict: 'review', matched_title: null }),
    )
  })
})
