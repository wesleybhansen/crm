import {
  assessOpportunityDestination,
  calibratedOpportunityConfidence,
  canonicalOpportunityUrl,
  classifyOpportunityIntent,
  rankOpportunityCandidates,
  realtorOpportunityNoiseReasons,
  opportunityEvidenceText,
} from '../research/opportunity-quality'

describe('opportunity quality primitives', () => {
  it('classifies returned content without accepting a search query as evidence', () => {
    expect(classifyOpportunityIntent('Neighborhood community breakfast for local residents.')).toMatchObject({
      kind: 'local_audience',
      buyerSignals: [],
      sellerSignals: [],
    })
    expect(classifyOpportunityIntent('Looking for a home after relocating to the South Bay.').kind).toBe(
      'buyer_intent',
    )
    expect(classifyOpportunityIntent('How should I prepare my house for sale?').kind).toBe('seller_intent')
    expect(classifyOpportunityIntent('Unrelated technology conference agenda.').kind).toBeNull()
  })

  it('excludes provider targeting claims from semantic evidence', () => {
    const text = opportunityEvidenceText(
      {
        name: 'Tampa homebuyer question',
        audience_description: 'Where should a first-time buyer start in Tampa?',
      },
      [{
        claim: 'Matched “seller leads -"market update" -"just listed"”.',
        source_url: 'https://example.test/tampa-buyer',
        observed_at: '2026-08-27T12:00:00.000Z',
        confidence: 0.8,
      }],
    )
    expect(text).toContain('first-time buyer')
    expect(text).not.toContain('seller leads')
    expect(realtorOpportunityNoiseReasons(text)).toEqual([])
  })

  it('canonicalizes tracking variants and source aliases into one destination', () => {
    const x = canonicalOpportunityUrl([
      'https://mobile.twitter.com/Example/status/123/?utm_source=test&b=2&a=1#replies',
    ])
    const canonical = canonicalOpportunityUrl(['https://x.com/Example/status/123?a=1&b=2'])
    expect(x).toBe(canonical)

    expect(
      canonicalOpportunityUrl(['https://old.reddit.com/r/SouthBay/comments/abc/?utm_campaign=test']),
    ).toBe('https://reddit.com/r/SouthBay/comments/abc')
  })

  it('rejects expired events and inaccessible groups while treating unproven access as unknown', () => {
    const expired = assessOpportunityDestination({
      identity: {
        name: 'Past workshop',
        opportunity_kind: 'event',
        access_type: 'public',
        event_start_at: '2026-08-01T12:00:00.000Z',
        urls: ['https://events.example/past-workshop'],
      },
      evidence: [
        {
          claim: 'Public event page',
          source_url: 'https://events.example/past-workshop',
          observed_at: '2026-08-20T12:00:00.000Z',
          confidence: 0.8,
        },
      ],
      referenceTime: new Date('2026-08-26T12:00:00.000Z'),
      maxAgeDays: 30,
    })
    expect(expired.status).toBe('fail')
    expect(expired.issues).toContain('event_expired')

    const approvalRequired = assessOpportunityDestination({
      identity: {
        name: 'Private group',
        opportunity_kind: 'group',
        access_type: 'approval_required',
        urls: ['https://groups.example/private'],
      },
      evidence: [
        {
          claim: 'Public preview only',
          source_url: 'https://groups.example/private',
          observed_at: '2026-08-26T12:00:00.000Z',
          confidence: 0.8,
        },
      ],
      referenceTime: new Date('2026-08-26T12:00:00.000Z'),
      maxAgeDays: 30,
    })
    expect(approvalRequired.status).toBe('fail')
    expect(approvalRequired.issues).toContain('destination_requires_approval')

    const unknownAccess = assessOpportunityDestination({
      identity: { name: 'Group', opportunity_kind: 'group', urls: ['https://groups.example/local'] },
      evidence: [],
      referenceTime: null,
      maxAgeDays: null,
    })
    expect(unknownAccess.status).toBe('unknown')
    expect(unknownAccess.issues).toContain('destination_access_unknown')
  })

  it('detects common realtor false positives without flagging a genuine question', () => {
    expect(realtorOpportunityNoiseReasons('Just listed: 3 beds, 2 baths. MLS #12345')).toContain(
      'property_listing_inventory',
    )
    expect(realtorOpportunityNoiseReasons('Join our brokerage. We are hiring realtors.')).toContain(
      'agent_recruiting',
    )
    expect(realtorOpportunityNoiseReasons('How should I price my home before selling?')).toEqual([])
  })

  it('calibrates confidence from demonstrated content, freshness, geography, and engagement', () => {
    const weak = calibratedOpportunityConfidence({
      content: 'Hello',
      sourceUrl: 'https://example.test/post',
      observedAt: '2026-08-26T12:00:00.000Z',
      attemptedAt: '2026-08-26T12:00:00.000Z',
      engagement: 0,
      location: null,
    })
    const strong = calibratedOpportunityConfidence({
      content: 'I am relocating to the South Bay and looking for a home. What should a first-time buyer know?',
      sourceUrl: 'https://example.test/post',
      observedAt: '2026-08-26T12:00:00.000Z',
      attemptedAt: '2026-08-26T12:00:00.000Z',
      engagement: 30,
      location: 'South Bay, California',
    })
    expect(strong).toBeGreaterThan(weak)
    expect(strong).toBeLessThanOrEqual(0.95)
  })

  it('reranks the bounded pool against the frozen play instead of provider order', () => {
    const observedAt = '2026-08-26T12:00:00.000Z'
    const irrelevant = {
      entity_kind: 'opportunity' as const,
      identity: {
        name: 'Generic technology conference',
        opportunity_kind: 'event' as const,
        platform: 'Events',
        audience_description: 'A technology conference for software teams.',
        access_type: 'public' as const,
        event_start_at: '2026-09-10T12:00:00.000Z',
        urls: ['https://events.example/technology'],
      },
      evidence: [
        { claim: 'Public technology event', source_url: 'https://events.example/technology', observed_at: observedAt, confidence: 0.8 },
      ],
    }
    const useful = {
      entity_kind: 'opportunity' as const,
      identity: {
        name: 'Austin first-time buyer questions',
        opportunity_kind: 'thread' as const,
        platform: 'Reddit',
        audience_description: 'First-time buyers asking how to buy a home in Austin.',
        location: 'Austin, Texas',
        access_type: 'public' as const,
        engagement_count: 18,
        urls: ['https://reddit.com/r/Austin/comments/buyer'],
      },
      evidence: [
        { claim: 'Public Austin buyer discussion', source_url: 'https://reddit.com/r/Austin/comments/buyer', observed_at: observedAt, confidence: 0.86 },
      ],
    }
    const ranked = rankOpportunityCandidates(
      [irrelevant, useful],
      {
        audience: 'Austin first-time home buyers',
        signal: 'Questions about buying a home',
        geography: 'Austin, Texas',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      new Date(observedAt),
    )
    expect(ranked[0].identity.name).toBe('Austin first-time buyer questions')
  })
})
