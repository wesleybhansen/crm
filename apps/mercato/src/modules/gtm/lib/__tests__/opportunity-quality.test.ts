import {
  areRepeatedOpportunityConversations,
  assessRealtorOpportunitySuitability,
  assessOpportunityDestination,
  calibratedOpportunityConfidence,
  canonicalOpportunityUrl,
  classifyOpportunityIntent,
  classifyOpportunityIntentAtDestination,
  classifyOpportunityIntentV2,
  classifyOpportunityIntentV3,
  demonstratedOpportunityLocation,
  demonstratedPublicSourceGeography,
  opportunityHasContradictoryUsState,
  publicSourceGeographyConflict,
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

  it('recognizes a returned residential location decision without treating product purchases as homes', () => {
    const phoenixBuyer = [
      'What is the scoop on Moon Valley?',
      'We are looking to buy but not get too far out.',
      'What is the vibe? Is it family friendly and safe?',
    ].join(' ')

    expect(classifyOpportunityIntent(phoenixBuyer)).toMatchObject({
      kind: 'buyer_intent',
      buyerSignals: expect.arrayContaining(['residential location decision']),
    })
    expect(assessRealtorOpportunitySuitability(phoenixBuyer, 'buyer_intent', null, 'thread'))
      .toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })
    expect(classifyOpportunityIntent(
      'Where to buy sourdough bread? I was looking to buy fresh sourdough and need bakery recommendations.',
    ).kind).toBeNull()
    expect(classifyOpportunityIntent(
      'Looking to buy near-mint Death Phoenix cards. I am not interested in played copies.',
    ).kind).toBeNull()
    expect(classifyOpportunityIntent(
      'Phoenix made an offer to a professional basketball player.',
    ).kind).toBeNull()
  })

  it('lets direct transaction evidence dominate generic audience nouns', () => {
    const tampaSeller = [
      'Home buyers/investors',
      'Looking to sell home. Any good buyers and or investors in the Land O Lakes area?',
      'Would like to more than likely sell before year is over.',
    ].join(' ')

    expect(classifyOpportunityIntent(tampaSeller)).toMatchObject({ kind: 'seller_intent' })
    expect(
      assessRealtorOpportunitySuitability(
        tampaSeller,
        'buyer_intent',
        'https://www.reddit.com/r/tampa/comments/1vuvy27/home_buyersinvestors',
        'thread',
      ),
    ).toMatchObject({ relevant: false, demonstratedIntent: 'seller_intent' })
    expect(
      assessRealtorOpportunitySuitability(
        tampaSeller,
        'seller_intent',
        'https://www.reddit.com/r/tampa/comments/1vuvy27/home_buyersinvestors',
        'thread',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'seller_intent', reasons: [] })

    expect(
      classifyOpportunityIntent('We are looking to sell our home and buy a new home nearby.').kind,
    ).toBe('mixed_intent')
  })

  it('recovers a truncated local buyer decision only from a place-specific public destination', () => {
    const truncated = [
      "what's the scoop on moon valley? : r/phoenix",
      'I\'ve been in Phoenix for 15 years and have been centrally located.',
      'We are looking to buy but ...',
    ].join(' ')
    const localUrl = 'https://www.reddit.com/r/phoenix/comments/1vv3f3x/whats_the_scoop_on_moon_valley'

    expect(classifyOpportunityIntent(truncated).kind).toBeNull()
    expect(classifyOpportunityIntentAtDestination(truncated, localUrl)).toMatchObject({
      kind: 'buyer_intent',
      buyerSignals: expect.arrayContaining(['local residential purchase question']),
    })
    expect(assessRealtorOpportunitySuitability(truncated, 'buyer_intent', localUrl, 'thread'))
      .toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })
    expect(classifyOpportunityIntentAtDestination(
      "What's the scoop on this bakery? We are looking to buy but ...",
      'https://www.reddit.com/r/FirstTimeHomeBuyer/comments/example/bakery',
    ).kind).toBeNull()
    expect(classifyOpportunityIntentAtDestination(
      'Where can we buy fresh sourdough bread?',
      'https://www.reddit.com/r/phoenix/comments/example/sourdough',
    ).kind).toBeNull()
    expect(classifyOpportunityIntentAtDestination(
      "What's the scoop on this area? We are looking to buy but ...",
      'https://notreddit.com/r/phoenix/comments/example/lookalike-host',
    ).kind).toBeNull()
  })

  it('does not treat entertainment house-hunting language as buyer intent in the current classifier', () => {
    const entertainment = [
      'The nail salon had a television on in the waiting area.',
      'We watched a house hunting and remodeling show while our appointments finished.',
    ].join(' ')

    expect(classifyOpportunityIntentV2(entertainment)).toMatchObject({
      kind: 'buyer_intent',
      buyerSignals: ['home search'],
    })
    expect(classifyOpportunityIntent(entertainment)).toMatchObject({
      kind: null,
      buyerSignals: [],
    })
    expect(classifyOpportunityIntent(
      'We are house hunting for a home in Phoenix and comparing neighborhoods before we make an offer.',
    ).kind).toBe('buyer_intent')
  })

  it('recovers a first-person search that starts with buying language and residential context', () => {
    const currentBuyer = [
      'East Valley home-buying advice: San Tan Valley vs. North Mesa?',
      'I’m starting to look at buying, but I am new to the area.',
      'I am balancing commute with affordability and comparing houses in several neighborhoods.',
    ].join(' ')

    expect(classifyOpportunityIntentV3(currentBuyer).kind).toBeNull()
    expect(classifyOpportunityIntent(currentBuyer)).toMatchObject({
      kind: 'buyer_intent',
      buyerSignals: expect.arrayContaining(['starting residential purchase search']),
    })
    expect(assessRealtorOpportunitySuitability(
      currentBuyer,
      'buyer_intent',
      'https://www.reddit.com/r/AskPhoenix/comments/example/east_valley',
      'thread',
    )).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })

    const productBuyer = [
      'I’m starting to look at buying a mechanical keyboard.',
      'I need a quiet switch for my office commute.',
    ].join(' ')
    expect(classifyOpportunityIntent(productBuyer).kind).toBeNull()
  })

  it('recovers a truncated next-home location choice only at a local Reddit destination', () => {
    const currentBuyer = [
      'Torn between two scenarios for where to buy our next ...',
      'I drove from Cottonwood to Tempe M-F for 9 months while I was house hunting for my first house.',
    ].join(' ')
    const localUrl = 'https://www.reddit.com/r/phoenix/comments/1vyfppk/torn_between_two_scenarios_for_where_to_buy_our/'

    expect(classifyOpportunityIntentAtDestination(currentBuyer, localUrl)).toMatchObject({
      kind: 'buyer_intent',
      buyerSignals: expect.arrayContaining(['next residential purchase location choice']),
    })
    expect(assessRealtorOpportunitySuitability(currentBuyer, 'buyer_intent', localUrl, 'thread'))
      .toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })
    expect(classifyOpportunityIntentAtDestination(
      'Torn between two scenarios for where to buy our next ...',
      'https://example.org/forums/shopping',
    ).kind).toBeNull()
  })

  it('accepts a current social house-hunting declaration without accepting agent promotion', () => {
    expect(assessRealtorOpportunitySuitability(
      'Way to early house hunting in Austin, TX #househunting #housetour #houseshopping',
      'buyer_intent',
      'https://www.tiktok.com/@public-author/video/7400000000000000001',
      'post',
    )).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })

    expect(assessRealtorOpportunitySuitability(
      'House hunting in Austin? Call me for five buyer tips. #AustinRealtor',
      'buyer_intent',
      'https://www.tiktok.com/@agent/video/7400000000000000002',
      'post',
    )).toMatchObject({ relevant: false })
  })

  it('recognizes a first-person plan to begin house hunting and a direct request for lender suggestions', () => {
    const tampaBuyer = [
      'Local mortgage lender suggestions?',
      'Husband and I are looking to start house hunting.',
      'We would love your suggestions for a local mortgage lender.',
    ].join(' ')

    expect(classifyOpportunityIntent(tampaBuyer)).toMatchObject({ kind: 'buyer_intent' })
    expect(assessRealtorOpportunitySuitability(
      tampaBuyer,
      'buyer_intent',
      'https://www.reddit.com/r/tampa/comments/example/house_hunting_lender',
      'thread',
    )).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })

    expect(assessRealtorOpportunitySuitability(
      'Mortgage broker here. We can help every home buyer; contact us for lender suggestions.',
      'buyer_intent',
      'https://www.reddit.com/r/tampa/comments/example/mortgage_promotion',
      'thread',
    )).toMatchObject({ relevant: false })
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
      opportunityHasContradictoryUsState(
        'This workshop is not allowing agents, brokers, or lenders to attend in Austin.',
        'Austin, Texas',
      ),
    ).toBe(false)
    expect(
      demonstratedOpportunityLocation('First home-buying advice requested in Austin, MN.', 'Austin, Texas'),
    ).toBeNull()
    expect(
      demonstratedOpportunityLocation('First home-buying advice requested in Austin, TX.', 'Austin, Texas'),
    ).toBe('Austin, Texas')
    expect(
      demonstratedPublicSourceGeography(
        'https://www.reddit.com/r/Tampa/comments/example/selling_this_fall',
        ['Tampa, Florida'],
      ),
    ).toBe('Tampa, Florida')
    expect(
      demonstratedPublicSourceGeography(
        'https://www.reddit.com/r/AskAustin/comments/example/first_home',
        ['Austin, Texas'],
      ),
    ).toBe('Austin, Texas')
    expect(
      demonstratedPublicSourceGeography(
        'https://www.reddit.com/r/RealEstate/comments/example/tampa_question',
        ['Tampa, Florida'],
      ),
    ).toBeNull()
    expect(
      demonstratedPublicSourceGeography(
        'https://www.reddit.com/r/ChicagoApartments/comments/example/austin_comparison',
        ['Austin, Texas'],
      ),
    ).toBeNull()
    expect(
      publicSourceGeographyConflict(
        'https://www.reddit.com/r/houston/comments/example/cannot_sell_house',
        ['Austin, Texas'],
        'Austin, Texas? I am selling my house in Houston.',
      ),
    ).toBe('reddit:r/houston')
    expect(
      publicSourceGeographyConflict(
        'https://www.reddit.com/r/realestate/comments/example/austin-buyer',
        ['Austin, Texas'],
        'I am buying a house in Austin and need advice.',
      ),
    ).toBeNull()
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
    expect(
      assessRealtorOpportunitySuitability(
        'Phoenix real estate discussion for newer buyers. I am waiting to find a property in Phoenix and asking how buyers should compare current listings.',
        'buyer_intent',
        'https://www.reddit.com/r/RealEstate/comments/example/phoenix_buyers',
        'thread',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })
    expect(realtorOpportunityNoiseReasons('Finally did it! Phoenix, AZ — $587k — got the keys.')).toContain(
      'completed_buyer_transaction',
    )
    expect(
      assessRealtorOpportunitySuitability(
        'Austin TX home appraisal came in at $422k. I made my offer at $375k and the seller countered. What should be my next move on closing costs?',
        'buyer_intent',
        null,
        'thread',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })

    const directSellerRequest = [
      'South Austin Realtor recommendation?',
      'Thinking of trying to sell my South Austin home (78745) and am looking for realtor recommendations.',
      'I want someone who can help me prepare the house, including repairs, painting, and staging.',
    ].join(' ')
    expect(classifyOpportunityIntent(directSellerRequest).kind).toBe('seller_intent')
    expect(
      assessRealtorOpportunitySuitability(
        directSellerRequest,
        'seller_intent',
        'https://www.reddit.com/r/askaustin/comments/1vi5hvd/south_austin_realtor_recommendation/',
        'thread',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'seller_intent', reasons: [] })

    expect(
      assessRealtorOpportunitySuitability(
        'Looking for a realtor? Contact me today for a free home valuation and listing consultation.',
        'seller_intent',
        'https://example.com/realtor-promotion',
        'post',
      ).relevant,
    ).toBe(false)
    expect(
      assessRealtorOpportunitySuitability(
        'I sold my other home myself and will most likely do the same with this one, so I am NOT looking for a realtor.',
        'buyer_intent',
        'https://www.facebook.com/example/posts/not-looking-for-a-realtor',
        'post',
      ).reasons,
    ).toContain('explicit_realtor_disinterest')
  })

  it('accepts direct transaction statements while rejecting unrelated first-person work', () => {
    expect(
      assessRealtorOpportunitySuitability(
        'Looking to buy a home next year in Denver and comparing neighborhoods now.',
        'buyer_intent',
        'https://www.reddit.com/r/Denver/comments/example/buy_next_year',
        'thread',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })
    expect(
      assessRealtorOpportunitySuitability(
        'We are first time home buyers. Would you still recommend Suncoast Credit Union for a Tampa mortgage?',
        'buyer_intent',
        'https://www.reddit.com/r/Tampa/comments/example/first_time_buyer',
        'thread',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })
    expect(
      assessRealtorOpportunitySuitability(
        'Looking to sell my home in Land O Lakes. Any good buyers or realtor recommendations?',
        'seller_intent',
        'https://www.reddit.com/r/Tampa/comments/example/seller',
        'thread',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'seller_intent', reasons: [] })

    const permitTangent = assessRealtorOpportunitySuitability(
      'I am looking to get electrical work permitted. Could it affect insurance or selling the home later?',
      'seller_intent',
      'https://www.reddit.com/r/Austin/comments/example/permit_question',
      'thread',
    )
    expect(permitTangent.relevant).toBe(false)
    expect(permitTangent.reasons).toContain('missing_consumer_need_or_event')

    expect(
      assessRealtorOpportunitySuitability(
        'Looking to sell your home? Contact me today for a cash offer and free valuation.',
        'seller_intent',
        'https://example.com/provider-promotion',
        'post',
      ).relevant,
    ).toBe(false)
  })

  it('recognizes current first-person seller declarations without accepting historical or promotional copy', () => {
    const currentSellerStatements = [
      [
        'I am about to leave Tampa because the traffic has become too much.',
        'I posted about selling my house recently and am deciding what to do next.',
      ].join(' '),
      'Past time to move out of Tampa Bay. Can\'t wait to sell my house and leave the state.',
    ]

    for (const content of currentSellerStatements) {
      expect(classifyOpportunityIntent(content).kind).toBe('seller_intent')
      expect(
        assessRealtorOpportunitySuitability(
          content,
          'seller_intent',
          'https://www.reddit.com/r/tampa/comments/example/current-seller',
          'thread',
        ),
      ).toMatchObject({ relevant: true, demonstratedIntent: 'seller_intent', reasons: [] })
    }

    expect(
      assessRealtorOpportunitySuitability(
        'I posted about selling my house ten years ago and already sold it.',
        'seller_intent',
        'https://www.reddit.com/r/tampa/comments/example/historical-seller',
        'thread',
      ).relevant,
    ).toBe(false)
    expect(
      assessRealtorOpportunitySuitability(
        "Can't wait to sell your house? I'm a realtor—contact me for a free valuation.",
        'seller_intent',
        'https://example.com/realtor-promotion',
        'post',
      ).relevant,
    ).toBe(false)
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
        'Indy Realtor Connect Series. Realtors and lenders host workshops to boost brand visibility, showcase their expertise, and connect with prospective clients.',
        'buyer_intent',
        'event',
      ],
      [
        'Why Buy Now Austin. Step into an exclusive afternoon built for real estate agents to stay ahead, gain insights, connect with peers, and better serve clients. All agents in attendance receive a bonus commission voucher.',
        'buyer_intent',
        'event',
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

  it('distinguishes provider-origin buyer copy from a consumer expressing demand', () => {
    const providerPosts = [
      'Thinking about buying a home in Austin? Before my team sends you listings, let us talk about your goals.',
      "I've helped hundreds of Austin buyers find the right neighborhood and negotiate with confidence.",
      'A real estate agent said Austin buyers should compare mortgage rates before touring homes.',
    ]

    for (const content of providerPosts) {
      expect(realtorOpportunityNoiseReasons(content)).toContain('provider_origin_promotion')
      expect(
        assessRealtorOpportunitySuitability(content, 'buyer_intent', null, 'post').relevant,
      ).toBe(false)
    }

    expect(
      assessRealtorOpportunitySuitability(
        "We're buying a home in Austin and need advice about which neighborhoods to compare before we make an offer.",
        'buyer_intent',
        null,
        'post',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'buyer_intent', reasons: [] })
  })

  it('rejects a brokerage-hosted public workshop without rejecting neutral homebuyer education', () => {
    const brokerageWorkshop = [
      'Short-Term Rentals Workshop: Turn Properties into Cash-Flow!',
      'Attend our free 90 min workshop at Keller Williams Arizona - Biltmore.',
      'Modern Pitch Real Estate Group presents practical investment case studies.',
    ].join(' ')
    expect(realtorOpportunityNoiseReasons(brokerageWorkshop)).toContain(
      'provider_origin_real_estate_event',
    )
    expect(
      assessRealtorOpportunitySuitability(
        brokerageWorkshop,
        'local_audience',
        'https://www.eventbrite.com/e/short-term-rentals-workshop-tickets-123',
        'event',
      ).relevant,
    ).toBe(false)

    const neutralEducation =
      'Join Trellis and Bankers Trust for a free Homebuyer Education Class at Trellis in Phoenix.'
    expect(realtorOpportunityNoiseReasons(neutralEducation)).not.toContain(
      'provider_origin_real_estate_event',
    )
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
    ).toBe(false)
    const directBuyerThread = assessRealtorOpportunitySuitability(
      'I am trying to buy a condo in Denver. Which neighborhoods should I compare before purchasing?',
      'local_audience',
      null,
      'thread',
    )
    expect(directBuyerThread.relevant).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'Tampa homeowners with solar: has anyone looked into adding a battery to lower a high utility bill?',
        'local_audience',
        null,
        'thread',
      ).relevant,
    ).toBe(false)
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
        'Austin Home Buyer Fair for the general public at the AISD Performing Arts Center.',
        'buyer_intent',
        null,
        'event',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'MLK Neighborhood Association of Austin hosts a community conversation for local homeowners.',
        'local_audience',
        null,
        'group',
      ).relevant,
    ).toBe(true)
    expect(
      assessRealtorOpportunitySuitability(
        'Welcome to the Highland Neighborhood Association website in Austin, Texas. View a map of the neighborhood.',
        'local_audience',
        null,
        'group',
      ).relevant,
    ).toBe(false)
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

  it('rejects rental disputes, provider directories, event indexes, and promotional testimonials', () => {
    const failures: Array<[string, 'buyer_intent' | 'local_audience', 'thread' | 'community' | 'event']> = [
      [
        'Lease assignment and early termination: our property management company says ending the lease is impossible because we are relocating to Denver.',
        'buyer_intent',
        'thread',
      ],
      [
        'Looking for Homeowner Community Resource professionals in Tampa? Visit Marketplace by TheHomeMag for a list of trusted pros.',
        'local_audience',
        'community',
      ],
      [
        'Home buyer seminar Events and Things to do in Austin, TX. Browse all upcoming events and workshops.',
        'buyer_intent',
        'community',
      ],
      [
        "First-time homebuyer here. I couldn't have asked for a better realtor. She's a first-class realtor with a big heart.",
        'buyer_intent',
        'event',
      ],
    ]
    for (const [content, lane, kind] of failures) {
      expect(assessRealtorOpportunitySuitability(content, lane, null, kind).relevant).toBe(false)
    }
    expect(classifyOpportunityIntent(failures[0][0]).kind).not.toBe('buyer_intent')
  })

  it('hard-rejects captcha and adult-spam search results before they reach review', () => {
    const spam =
      'ShieldSquare Captcha - stockton on tees escorts. Tampa, Florida, United States. A homeowner in Chinese Camp. Hydrogen powers food truck meetup.'
    expect(realtorOpportunityNoiseReasons(spam)).toContain('source_spam_or_adult_content')
    expect(
      assessRealtorOpportunitySuitability(spam, 'local_audience', 'https://spam.example/result', 'event').relevant,
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
    const historicalDistress =
      'I moved to buy a house in Austin 20 years ago. My income is not enough, several banks turned me down, and I am single and senior.'
    expect(sensitiveConsumerOpportunityReasons(historicalDistress)).toEqual(
      expect.arrayContaining([
        'sensitive_bereavement_or_financial_distress',
        'sensitive_age_or_marital_status',
      ]),
    )
    expect(realtorOpportunityNoiseReasons(historicalDistress)).toEqual(
      expect.arrayContaining([
        'historical_completed_transaction',
        'sensitive_bereavement_or_financial_distress',
        'sensitive_age_or_marital_status',
      ]),
    )
    expect(
      assessRealtorOpportunitySuitability(
        historicalDistress,
        'buyer_intent',
        'https://x.com/example/status/historical-distress',
        'post',
      ).relevant,
    ).toBe(false)
    expect(
      realtorOpportunityNoiseReasons(
        'We bought our Austin home 20 years ago and now need advice about selling it.',
      ),
    ).not.toContain('historical_completed_transaction')
    const pastSellerAnecdote =
      'I was selling a home and needed appliances for the place. What we got was in good shape.'
    expect(realtorOpportunityNoiseReasons(pastSellerAnecdote)).toContain(
      'historical_completed_transaction',
    )
    expect(
      assessRealtorOpportunitySuitability(
        pastSellerAnecdote,
        'seller_intent',
        'https://www.reddit.com/r/phoenix/comments/example/comment/past',
        'thread',
      ).relevant,
    ).toBe(false)
    expect(
      realtorOpportunityNoiseReasons(
        'I was selling a home last year, but now I am listing my Phoenix home again and need advice.',
      ),
    ).not.toContain('historical_completed_transaction')
    const historicalHouseHunt =
      'Many years ago, when my wife and I were house hunting in Phoenix for the first time, it hailed while we were inside one house.'
    expect(realtorOpportunityNoiseReasons(historicalHouseHunt)).toContain(
      'historical_completed_transaction',
    )
    expect(
      assessRealtorOpportunitySuitability(
        historicalHouseHunt,
        'buyer_intent',
        'https://www.reddit.com/r/phoenix/comments/example/hail_in_the_north_valley',
        'thread',
      ).relevant,
    ).toBe(false)
    expect(
      sensitiveConsumerOpportunityReasons(
        'I am a senior vice president buying a home in Austin and comparing mortgage rates.',
      ),
    ).toEqual([])
    expect(sensitiveConsumerOpportunityReasons('Austin homeowners discussing a neighborhood workshop.')).toEqual([])
    expect(
      sensitiveConsumerOpportunityReasons(
        'We have a baby and are looking to buy a home in Austin before the end of the year.',
      ),
    ).toContain('sensitive_minor_or_protected_trait')
    expect(
      sensitiveConsumerOpportunityReasons(
        'Our kids need more space, so we are thinking of selling our Tampa home.',
      ),
    ).toContain('sensitive_minor_or_protected_trait')
    expect(
      sensitiveConsumerOpportunityReasons(
        'I have hair loss and other health problems after living near the Denver site. Should I buy elsewhere?',
      ),
    ).toContain('sensitive_health_or_disability')
    expect(
      sensitiveConsumerOpportunityReasons(
        'The Austin home includes a baby grand piano that the seller may leave in place.',
      ),
    ).toEqual([])
    expect(
      assessRealtorOpportunitySuitability(
        'We have a baby and are looking to buy a home in Austin before the end of the year.',
        'buyer_intent',
        'https://www.reddit.com/r/Austin/comments/example/baby',
        'thread',
      ).relevant,
    ).toBe(false)
    expect(
      assessRealtorOpportunitySuitability(
        'I have hair loss and health problems near a toxic site, so I am looking to buy a Denver home elsewhere.',
        'buyer_intent',
        'https://www.reddit.com/r/Denver/comments/example/health',
        'thread',
      ).relevant,
    ).toBe(false)
  })

  it('canonicalizes tracking variants and source aliases into one destination', () => {
    const x = canonicalOpportunityUrl([
      'https://mobile.twitter.com/Example/status/123/?utm_source=test&b=2&a=1#replies',
    ])
    const canonical = canonicalOpportunityUrl(['https://x.com/Example/status/123?a=1&b=2'])
    expect(x).toBe(canonical)

    // Reddit paths are case-insensitive; the slug case used to split one
    // thread into several candidates (M5).
    expect(
      canonicalOpportunityUrl(['https://old.reddit.com/r/SouthBay/comments/abc/?utm_campaign=test']),
    ).toBe('https://reddit.com/r/southbay/comments/abc')
  })

  it('collapses reddit thread permalink, sort, context, and share variants onto one destination (M5)', () => {
    const variants = [
      'https://www.reddit.com/r/Austin/comments/1abc23/some_slug/',
      'https://www.reddit.com/r/Austin/comments/1abc23/some_slug/?sort=top',
      'https://www.reddit.com/r/austin/comments/1abc23/some_slug/xyz987/?context=3',
      'https://old.reddit.com/r/Austin/comments/1abc23/some_slug/?rdt=12345&ref=share',
    ]
    const canonical = new Set(variants.map((url) => canonicalOpportunityUrl([url])))
    expect([...canonical]).toEqual(['https://reddit.com/r/austin/comments/1abc23'])
    // Subreddit-less forms cannot recover the subreddit (it is kept for the
    // geography-conflict rules), so they canonicalize to the bare post URL.
    expect(canonicalOpportunityUrl(['https://www.reddit.com/comments/1abc23/?sort=new']))
      .toBe('https://reddit.com/comments/1abc23')
    expect(canonicalOpportunityUrl(['https://redd.it/1abc23'])).toBe('https://reddit.com/comments/1abc23')
    expect(canonicalOpportunityUrl(['https://community.example/Thread/?sort=new&utm_source=x&page=2']))
      .toBe('https://community.example/Thread?page=2')
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

    const futureEventWithOldPublication = assessOpportunityDestination({
      identity: {
        name: 'Hot Takes on Housing',
        opportunity_kind: 'event',
        access_type: 'ticketed',
        source_published_at: '2026-07-31T12:00:00.000Z',
        event_start_at: '2026-09-14T12:00:00.000Z',
        urls: ['https://www.eventbrite.com/e/hot-takes-on-housing-123'],
      },
      evidence: [{
        claim: 'Public event page',
        source_url: 'https://www.eventbrite.com/e/hot-takes-on-housing-123',
        observed_at: '2026-08-30T12:00:00.000Z',
        confidence: 0.8,
      }],
      referenceTime: new Date('2026-08-30T12:00:00.000Z'),
      maxAgeDays: 30,
    })
    expect(futureEventWithOldPublication.status).toBe('pass')
    expect(futureEventWithOldPublication.issues).not.toContain('stale_destination')
    expect(futureEventWithOldPublication.issues).not.toContain('event_expired')
    expect(futureEventWithOldPublication.newestObservation).toBe('2026-09-14T12:00:00.000Z')

    const futureEventDiscoveredAfterStaleSnippet = assessOpportunityDestination({
      identity: {
        name: 'Historic homes tour',
        opportunity_kind: 'event',
        access_type: 'public',
        event_start_at: '2026-08-09T12:00:00.000Z',
        urls: ['https://events.example/historic-homes-tour'],
      },
      evidence: [{
        claim: 'Public event page',
        source_url: 'https://events.example/historic-homes-tour',
        observed_at: '2026-08-30T12:00:00.000Z',
        confidence: 0.8,
      }],
      referenceTime: new Date('2026-08-30T12:00:00.000Z'),
      maxAgeDays: 30,
      content: 'Published August 9, 2026. Public Historic Homes Tour on November 15, 2026.',
    })
    expect(futureEventDiscoveredAfterStaleSnippet).toMatchObject({
      status: 'pass',
      newestObservation: '2026-11-15T00:00:00.000Z',
    })
    expect(futureEventDiscoveredAfterStaleSnippet.issues).not.toContain('event_expired')
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
        'Apache Shores Property Owners Association in Austin holds a public hybrid POA meeting for residents.',
        'local_audience',
        'https://apacheshorespoa.example/',
        'group',
      ),
    ).toMatchObject({ relevant: true, demonstratedIntent: 'local_audience', reasons: [] })
    expect(
      assessRealtorOpportunitySuitability(
        'Wedding venue and guest house near the Austin neighborhood association.',
        'local_audience',
        null,
        'community',
      ).relevant,
    ).toBe(false)
    expect(
      assessRealtorOpportunitySuitability(
        'Real Estate & Investing event about wholesaling and flipping investment property.',
        'local_audience',
        'https://www.meetup.com/austin-investors/events/example/',
        'event',
      ),
    ).toMatchObject({ relevant: false, reasons: expect.arrayContaining(['intent_lane_mismatch']) })
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

  it('recognizes repeated conversations across different public URLs', () => {
    const observedAt = '2026-08-27T12:00:00.000Z'
    const candidate = (url: string, description: string) => ({
      entity_kind: 'opportunity' as const,
      identity: {
        name: 'Austin housing prices discussion',
        opportunity_kind: 'thread' as const,
        audience_description: description,
        urls: [url],
      },
      evidence: [{ claim: 'Public discussion', source_url: url, observed_at: observedAt, confidence: 0.8 }],
    })
    const first = candidate(
      'https://reddit.com/r/Austin/comments/one',
      'I want to buy a house and have been looking since May, but housing prices around Hutto are getting unreasonably expensive for a developing area without much nearby.',
    )
    const repeated = candidate(
      'https://example.test/mirror/austin-housing',
      'I want to buy a house and have been looking since May. Housing prices around Hutto are getting unreasonably expensive for a developing area without much nearby.',
    )
    const distinct = candidate(
      'https://reddit.com/r/Austin/comments/two',
      'We are preparing to sell our Austin home and need advice about which repairs matter before choosing a listing price.',
    )
    expect(areRepeatedOpportunityConversations(first, repeated)).toBe(true)
    expect(areRepeatedOpportunityConversations(first, distinct)).toBe(false)
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
