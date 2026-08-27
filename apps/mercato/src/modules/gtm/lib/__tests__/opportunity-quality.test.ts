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
  sensitiveConsumerOpportunityReasons,
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
    expect(
      opportunityHasContradictoryUsState('First home-buying advice requested in Austin, MN.', 'Austin, Texas'),
    ).toBe(true)
    expect(
      demonstratedOpportunityLocation('First home-buying advice requested in Austin, MN.', 'Austin, Texas'),
    ).toBeNull()
    expect(
      demonstratedOpportunityLocation('First home-buying advice requested in Austin, TX.', 'Austin, Texas'),
    ).toBe('Austin, Texas')
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

  it('rejects polished professional content that only looks like consumer demand', () => {
    const failures: Array<[string, 'buyer_intent' | 'seller_intent' | 'local_audience', string]> = [
      [
        'I hear this question from buyers all the time: wait, do I have to sign an agreement before looking at a house?',
        'buyer_intent',
        'post',
      ],
      [
        'Dream Home Alert. Explore homes for sale and schedule a private tour today.',
        'buyer_intent',
        'post',
      ],
      [
        'Clear to close. A milestone worth celebrating for my first-time buyer client.',
        'buyer_intent',
        'post',
      ],
      [
        "Thinking about selling your home? Here are five questions worth answering. I can help—send me a message.",
        'seller_intent',
        'post',
      ],
      [
        "Let's connect Tampa professionals. I'm a Florida REALTOR serving buyers and sellers.",
        'local_audience',
        'post',
      ],
      [
        "Tips to deter solicitors: I rent and don't own this home, but salespeople keep knocking.",
        'local_audience',
        'thread',
      ],
    ]

    for (const [content, lane, kind] of failures) {
      expect(assessRealtorOpportunitySuitability(content, lane, null, kind).relevant).toBe(false)
    }
  })

  it('requires a participation venue or demonstrated consumer participation for local discovery', () => {
    expect(
      assessRealtorOpportunitySuitability(
        'Austin neighborhoods are changing as more homeowners renovate garages.',
        'local_audience',
        null,
        'post',
      ).relevant,
    ).toBe(false)
    expect(
      assessRealtorOpportunitySuitability(
        'Where in Denver feels like home for a new resident who wants a walkable neighborhood?',
        'local_audience',
        null,
        'thread',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'Austin Community Registry for neighborhood associations and homeowner organizations.',
        'local_audience',
        null,
        'community',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'Upcoming Austin first-time home buyer workshop and homebuyer education class.',
        'buyer_intent',
        null,
        'community',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'Upcoming Austin home seller workshop about preparing a house for sale.',
        'seller_intent',
        null,
        'event',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'I am looking to buy a home in Denver and need help comparing neighborhoods.',
        'buyer_intent',
        null,
        'thread',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'I need advice clearing the contents of my late sister’s Austin home before an estate sale.',
        'local_audience',
        null,
        'thread',
      ).relevant,
    ).toBe(false)
  })

  it('rejects generic lifestyle promotion and estate-content sales as housing demand', () => {
    const lifestylePromotion =
      'WalletHub ranked Tampa among the most pet-friendly cities. When people relocate, they are choosing a lifestyle. Where can I walk the dog before work? There is a bigger real estate story here.'
    expect(realtorOpportunityNoiseReasons(lifestylePromotion)).toContain('market_lifestyle_promotion')
    expect(
      assessRealtorOpportunitySuitability(lifestylePromotion, 'buyer_intent', null, 'post').relevant,
    ).toBe(false)

    const estateContents =
      'I need advice clearing my late sister’s South Austin home after she passed away. I need to sell furniture and find an estate liquidator or bulk buyout service.'
    expect(realtorOpportunityNoiseReasons(estateContents)).toContain('sensitive_personal_crisis')
    expect(classifyOpportunityIntent(estateContents).kind).toBeNull()
    expect(
      assessRealtorOpportunitySuitability(estateContents, 'seller_intent', null, 'thread').relevant,
    ).toBe(false)
  })

  it('hard-blocks vulnerability and protected-trait targeting before qualification', () => {
    expect(
      sensitiveConsumerOpportunityReasons(
        'How can I achieve housing independence after opioid recovery and a stay in sober living?',
      ),
    ).toEqual(expect.arrayContaining(['sensitive_health_or_disability']))
    expect(
      sensitiveConsumerOpportunityReasons(
        'I have no place to stay, cannot pay rent, and need help with a predatory landlord.',
      ),
    ).toEqual(expect.arrayContaining(['sensitive_housing_instability']))
    expect(sensitiveConsumerOpportunityReasons('Austin homeowners discussing a neighborhood workshop.')).toEqual([])
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

  it('derives stale publication dates from returned search content instead of retrieval time', () => {
    const referenceTime = new Date('2026-08-27T12:00:00.000Z')
    const relative = assessOpportunityDestination({
      identity: {
        name: 'Old seller thread',
        opportunity_kind: 'thread',
        access_type: 'public',
        urls: ['https://forum.example/old-relative-thread'],
      },
      evidence: [{
        claim: 'Retrieved today',
        source_url: 'https://forum.example/old-relative-thread',
        observed_at: referenceTime.toISOString(),
        confidence: 0.8,
      }],
      referenceTime,
      maxAgeDays: 30,
      content: '3 years ago — How should I prepare my Denver home before selling?',
    })
    expect(relative.status).toBe('fail')
    expect(relative.issues).toContain('stale_destination')
    expect(relative.ageDays).toBeGreaterThan(1_000)

    const dated = assessOpportunityDestination({
      identity: {
        name: 'Archived Austin forum answer',
        opportunity_kind: 'thread',
        access_type: 'public',
        urls: ['https://forum.example/old-dated-thread'],
      },
      evidence: [{
        claim: 'Retrieved today',
        source_url: 'https://forum.example/old-dated-thread',
        observed_at: referenceTime.toISOString(),
        confidence: 0.8,
      }],
      referenceTime,
      maxAgeDays: 30,
      content: 'Sep 5, 2013 — I am thinking about selling my Austin house.',
    })
    expect(dated.status).toBe('fail')
    expect(dated.issues).toContain('stale_destination')

    const labeledNumeric = assessOpportunityDestination({
      identity: {
        name: 'Archived Phoenix seller discussion',
        opportunity_kind: 'thread',
        access_type: 'public',
        urls: ['https://forum.example/archived-phoenix-thread'],
      },
      evidence: [],
      referenceTime,
      maxAgeDays: 30,
      content: 'Seller discussion · Updated: 11/26/2010 · Phoenix homeowners compare listing preparation.',
    })
    expect(labeledNumeric.status).toBe('fail')
    expect(labeledNumeric.issues).toContain('stale_destination')

    const leadingMonthYear = assessOpportunityDestination({
      identity: {
        name: 'Old Denver housing page',
        opportunity_kind: 'thread',
        access_type: 'public',
        urls: ['https://forum.example/old-denver-page'],
      },
      evidence: [],
      referenceTime,
      maxAgeDays: 30,
      content: 'Apr 2012 - Present · Denver homebuyer questions and community notes.',
    })
    expect(leadingMonthYear.status).toBe('fail')
    expect(leadingMonthYear.issues).toContain('stale_destination')
  })

  it('rejects explicitly inactive destinations and derives event dates from returned content', () => {
    const referenceTime = new Date('2026-08-27T12:00:00.000Z')
    const inactive = assessOpportunityDestination({
      identity: {
        name: 'Tampa home seller workshop',
        opportunity_kind: 'event',
        access_type: 'public',
        urls: ['https://events.example/tampa-seller-workshop'],
      },
      evidence: [],
      referenceTime,
      maxAgeDays: 30,
      content: 'No upcoming events. Tampa home seller workshop calendar.',
    })
    expect(inactive.status).toBe('fail')
    expect(inactive.issues).toContain('destination_inactive')

    const upcoming = assessOpportunityDestination({
      identity: {
        name: 'Austin first-time buyer class',
        opportunity_kind: 'event',
        access_type: 'public',
        urls: ['https://events.example/austin-buyer-class'],
      },
      evidence: [{
        claim: 'Public event calendar',
        source_url: 'https://events.example/austin-buyer-class',
        observed_at: referenceTime.toISOString(),
        confidence: 0.8,
      }],
      referenceTime,
      maxAgeDays: 30,
      content: 'Register for the Austin first-time homebuyer class on September 18, 2026.',
    })
    expect(upcoming.status).toBe('pass')
    expect(upcoming.issues).not.toContain('event_time_unknown')

    const numericUpcoming = assessOpportunityDestination({
      identity: {
        name: 'Phoenix homebuyer workshop',
        opportunity_kind: 'event',
        access_type: 'public',
        urls: ['https://events.example/phoenix-buyer-workshop'],
      },
      evidence: [{
        claim: 'Public event calendar',
        source_url: 'https://events.example/phoenix-buyer-workshop',
        observed_at: referenceTime.toISOString(),
        confidence: 0.8,
      }],
      referenceTime,
      maxAgeDays: 30,
      content: 'Register for the Phoenix first-time homebuyer workshop on 09/22/2026.',
    })
    expect(numericUpcoming.status).toBe('pass')
    expect(numericUpcoming.issues).not.toContain('event_time_unknown')

    const explicitFreshTimestampWins = assessOpportunityDestination({
      identity: {
        name: 'Current Austin discussion referencing an old sale',
        opportunity_kind: 'thread',
        access_type: 'public',
        source_published_at: '2026-08-26T12:00:00.000Z',
        urls: ['https://forum.example/current-austin-thread'],
      },
      evidence: [],
      referenceTime,
      maxAgeDays: 30,
      content: 'Posted yesterday. We bought in 2012 and now need advice about selling our Austin home.',
    })
    expect(explicitFreshTimestampWins.status).toBe('pass')
    expect(explicitFreshTimestampWins.issues).not.toContain('stale_destination')
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
    expect(realtorOpportunityNoiseReasons('Job opening at a local title company. Apply for this position.')).toContain(
      'employment_listing',
    )
    expect(realtorOpportunityNoiseReasons('Three houses for rent near downtown Tampa.')).toContain(
      'rental_or_venue_inventory',
    )
    expect(realtorOpportunityNoiseReasons('Home-made trailer for sale in Denver.')).toContain(
      'non_property_home_phrase',
    )
    expect(realtorOpportunityNoiseReasons('Luxury home for sale in Phoenix, reduced to $895,000.')).toContain(
      'property_listing_inventory',
    )
  })

  it('requires public participation evidence for local-audience venues', () => {
    expect(
      assessRealtorOpportunitySuitability(
        'Austin Community Registry. Join neighborhood associations and attend public meetings.',
        'local_audience',
        null,
        'community',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'Wedding venue and guest house near the Austin neighborhood association.',
        'local_audience',
        null,
        'community',
      ).relevant,
    ).toBe(false)
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

  it('ranks a fresh useful result above stale and irrelevant complete-looking results', () => {
    const referenceTime = new Date('2026-08-27T12:00:00.000Z')
    const evidence = (url: string) => [{
      claim: 'Retrieved result',
      source_url: url,
      observed_at: referenceTime.toISOString(),
      confidence: 0.82,
    }]
    const ranked = rankOpportunityCandidates(
      [
        {
          entity_kind: 'opportunity' as const,
          identity: {
            name: 'Old Denver seller forum',
            opportunity_kind: 'thread' as const,
            platform: 'Forum',
            audience_description: 'Sep 5, 2013 — How should I sell my Denver house?',
            location: 'Denver, Colorado',
            access_type: 'public' as const,
            urls: ['https://forum.example/old-denver-seller'],
          },
          evidence: evidence('https://forum.example/old-denver-seller'),
        },
        {
          entity_kind: 'opportunity' as const,
          identity: {
            name: 'Denver wedding venue',
            opportunity_kind: 'community' as const,
            platform: 'Directory',
            audience_description: 'Wedding venue and guest house near a Denver neighborhood association.',
            location: 'Denver, Colorado',
            access_type: 'public' as const,
            urls: ['https://directory.example/denver-wedding-venue'],
          },
          evidence: evidence('https://directory.example/denver-wedding-venue'),
        },
        {
          entity_kind: 'opportunity' as const,
          identity: {
            name: 'Current Denver seller question',
            opportunity_kind: 'thread' as const,
            platform: 'Reddit',
            audience_description: '1 day ago — I am preparing to sell my Denver home. Which repairs matter first?',
            location: 'Denver, Colorado',
            access_type: 'public' as const,
            urls: ['https://reddit.com/r/Denver/comments/current-seller'],
          },
          evidence: evidence('https://reddit.com/r/Denver/comments/current-seller'),
        },
      ],
      {
        audience: 'Denver homeowners preparing to sell',
        signal: 'Current questions about selling a home',
        geography: 'Denver, Colorado',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      referenceTime,
    )
    expect(ranked.map((candidate) => candidate.identity.name)).toEqual([
      'Current Denver seller question',
      'Old Denver seller forum',
      'Denver wedding venue',
    ])
  })
})
