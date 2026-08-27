import {
  assessRealtorOpportunitySuitability,
  assessOpportunityDestination,
  calibratedOpportunityConfidence,
  canonicalOpportunityUrl,
  classifyOpportunityIntent,
  demonstratedOpportunityLocation,
  opportunityHasContradictoryUsState,
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

  it('treats a requested market as targeting until returned material proves it', () => {
    expect(demonstratedOpportunityLocation('Unrelated global discussion', 'Austin, Texas')).toBeNull()
    expect(
      demonstratedOpportunityLocation('Question posted in r/Austin by a local home buyer', 'Austin, Texas'),
    ).toBe('Austin, Texas')
    expect(
      opportunityHasContradictoryUsState('I am selling my South Florida home.', 'Austin, Texas'),
    ).toBe(true)
  })

  it('distinguishes consumer housing demand from generic seller language and agent marketing', () => {
    expect(
      assessRealtorOpportunitySuitability(
        'I am moving to Austin and looking to buy a home. Which neighborhoods should I compare?',
        'buyer_intent',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'OfferUp seller preparing to move a collectible card collection.',
        'seller_intent',
      ).relevant,
    ).toBe(false)
    expect(
      assessRealtorOpportunitySuitability(
        "I'm a realtor. Contact me for five buyer tips.",
        'buyer_intent',
      ).reasons,
    ).toEqual(expect.arrayContaining(['agent_self_promotion', 'generic_advice_content']))
    expect(
      assessRealtorOpportunitySuitability(
        'Google Ads case study: a Phoenix brokerage reduced cost per lead and generated more qualified seller leads.',
        'seller_intent',
      ).reasons,
    ).toContain('marketing_case_study')
    expect(
      assessRealtorOpportunitySuitability(
        'I am selling my current house so I can buy a smaller home. What should I repair first?',
        'seller_intent',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'mixed_intent', reasons: [] })
    expect(
      assessRealtorOpportunitySuitability(
        'First-time buyer moving to Austin and looking for a home near a walkable neighborhood.',
        'buyer_intent',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })
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

  it('uses source publication time for posts and never retrieval time as a freshness proxy', () => {
    const referenceTime = new Date('2026-08-27T12:00:00.000Z')
    const stale = assessOpportunityDestination({
      identity: {
        name: 'Old buyer thread',
        opportunity_kind: 'thread',
        access_type: 'public',
        source_published_at: '2024-11-01T12:00:00.000Z',
        urls: ['https://reddit.com/r/Austin/comments/old'],
      },
      evidence: [{
        claim: 'Retrieved today',
        source_url: 'https://reddit.com/r/Austin/comments/old',
        observed_at: referenceTime.toISOString(),
        confidence: 0.8,
      }],
      referenceTime,
      maxAgeDays: 30,
    })
    expect(stale.status).toBe('fail')
    expect(stale.issues).toContain('stale_destination')

    const unknown = assessOpportunityDestination({
      identity: {
        name: 'Undated buyer thread',
        opportunity_kind: 'thread',
        access_type: 'public',
        urls: ['https://reddit.com/r/Austin/comments/undated'],
      },
      evidence: [{
        claim: 'Retrieved today',
        source_url: 'https://reddit.com/r/Austin/comments/undated',
        observed_at: referenceTime.toISOString(),
        confidence: 0.8,
      }],
      referenceTime,
      maxAgeDays: 30,
    })
    expect(unknown.status).toBe('unknown')
    expect(unknown.issues).toContain('destination_freshness_unknown')
  })

  it('detects common realtor false positives without flagging a genuine question', () => {
    expect(realtorOpportunityNoiseReasons('Just listed: 3 beds, 2 baths. MLS #12345')).toContain(
      'property_listing_inventory',
    )
    expect(realtorOpportunityNoiseReasons('Join our brokerage. We are hiring realtors.')).toContain(
      'agent_recruiting',
    )
    expect(
      realtorOpportunityNoiseReasons(
        'Google Ads case study: 72% lower cost per lead and 14 qualified seller leads for a real estate company.',
      ),
    ).toContain('marketing_case_study')
    expect(
      realtorOpportunityNoiseReasons(
        'Another beautiful home successfully Listed & Sold in Chandler! This lovely 3-bedroom, 2-bath home is located in an excellent neighborhood.',
      ),
    ).toContain('completed_listing_promotion')
    expect(
      realtorOpportunityNoiseReasons(
        'I just sold my Phoenix home and need help buying a smaller place nearby. Where should I look?',
      ),
    ).not.toContain('completed_listing_promotion')
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
        source_published_at: observedAt,
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
