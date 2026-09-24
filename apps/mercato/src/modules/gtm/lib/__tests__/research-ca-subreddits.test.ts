import { realtorMarketSubreddits } from '../research/opportunity-query-lanes'

describe('California realtor markets search their metro communities first', () => {
  test('a South Bay city leads with the Los Angeles communities', () => {
    expect(realtorMarketSubreddits('Manhattan Beach, CA').slice(0, 2)).toEqual(['LosAngeles', 'AskLosAngeles'])
  })
  test('Orange County, San Diego and Bay Area cities', () => {
    expect(realtorMarketSubreddits('Newport Beach, California')[0]).toBe('orangecounty')
    expect(realtorMarketSubreddits('Irvine, CA').slice(0, 2)).toEqual(['irvine', 'orangecounty'])
    expect(realtorMarketSubreddits('Encinitas, CA')[0]).toBe('sandiego')
    expect(realtorMarketSubreddits('Palo Alto, CA')[0]).toBe('bayarea')
  })
  test('other states and unknown cities keep the city communities', () => {
    expect(realtorMarketSubreddits('Austin, TX').slice(0, 2)).toEqual(['Austin', 'AskAustin'])
    expect(realtorMarketSubreddits('Bakersfield, CA')[0]).toBe('Bakersfield')
  })
})

import { assessOpportunityDestination } from '../research/opportunity-quality'

describe('members-only Facebook group posts', () => {
  const base = {
    opportunity_kind: 'post',
    access_type: 'approval_required',
    source_published_at: '2026-09-20T00:00:00Z',
  }
  test('a group post is a soft "join to reply", not a rejection', () => {
    const result = assessOpportunityDestination({
      identity: { ...base, urls: ['https://www.facebook.com/groups/2043068675999544/posts/3951719875134405/'] },
      evidence: [], referenceTime: new Date('2026-09-24T00:00:00Z'), maxAgeDays: 30,
      content: 'I am looking for a realtor to list our home.',
    })
    expect(result.status).not.toBe('fail')
    expect(result.issues).toContain('destination_join_group_to_reply')
  })
  test('any other approval-only destination still fails', () => {
    const result = assessOpportunityDestination({
      identity: { ...base, urls: ['https://forum.example.com/members/thread/1'] },
      evidence: [], referenceTime: new Date('2026-09-24T00:00:00Z'), maxAgeDays: 30, content: 'x',
    })
    expect(result.status).toBe('fail')
  })
})
