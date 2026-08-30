import type { CandidateEvidence, CandidateIdentity } from '../adapters/types'
import {
  FIT_ACCEPT_THRESHOLD,
  FIT_REVIEW_THRESHOLD,
  FIT_REASONS,
  ruleBasedFitScorer,
  summarizeFitResults,
  type FitResult,
} from '../research/qualify'

const play = { entityUnit: 'companies', geography: 'California, US' }

const strongEvidence: CandidateEvidence[] = [
  {
    claim: 'Posted a job opening for a revenue operations lead',
    source_url: 'https://jobs.example-dynamics.example/rev-ops-lead',
    observed_at: '2026-07-20T09:00:00.000Z',
    confidence: 0.9,
  },
]

const company = {
  entity_kind: 'company' as const,
  identity: {
    name: 'Example Dynamics LLC',
    domain: 'example-dynamics.example',
  },
}

describe('ruleBasedFitScorer', () => {
  it('is deterministic: identical input always yields identical output', () => {
    const a = ruleBasedFitScorer.score(company, play, strongEvidence)
    const b = ruleBasedFitScorer.score(company, play, strongEvidence)
    expect(a).toEqual(b)
  })

  it('accepts a well-evidenced in-scope company', () => {
    const result = ruleBasedFitScorer.score(company, play, strongEvidence)
    expect(result.verdict).toBe('accepted')
    expect(result.fitScore).toBeGreaterThanOrEqual(FIT_ACCEPT_THRESHOLD)
    expect(result.reason).toBe(FIT_REASONS.accepted)
  })

  it('rejects an entity kind that does not match the play entity unit', () => {
    const person = {
      entity_kind: 'person' as const,
      identity: { name: 'Alex Example', domain: 'example-dynamics.example' },
    }
    const result = ruleBasedFitScorer.score(person, play, strongEvidence)
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.entityKindMismatch)
  })

  it('accepts an evidence-backed realtor demand opportunity with a public destination and human action', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'South Bay first-home questions',
          opportunity_kind: 'community',
          platform: 'Reddit',
          intent_kind: 'buyer_intent',
          audience_description: 'People asking public questions about buying a first home locally',
          location: 'South Bay, California',
          access_type: 'public',
          urls: ['https://community.example/south-bay/first-home-questions'],
          participation_rules: 'Professionals may answer public questions when they disclose their affiliation.',
          participation_rules_status: 'observed',
          recommended_action: 'Answer one current question helpfully and disclose professional affiliation.',
          message_angle: 'Explain the first-home process with practical South Bay examples before offering help.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'California, US',
        audience: 'South Bay first-time home buyers',
        signal: 'People asking public questions about buying a first home',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      strongEvidence,
    )

    expect(result).toEqual(
      expect.objectContaining({
        verdict: 'accepted',
        reason: FIT_REASONS.accepted,
      }),
    )
  })

  it('does not treat adapter-authored rule reminders as proof that participation is permitted', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Austin first-home negotiation question',
          opportunity_kind: 'thread',
          platform: 'Reddit',
          audience_description: 'I am buying my first home in Austin. How should I respond to this counteroffer?',
          location: 'Austin, Texas',
          access_type: 'public',
          source_published_at: '2026-08-28T10:00:00.000Z',
          urls: ['https://www.reddit.com/r/FirstTimeHomeBuyer/comments/example/rules-unverified'],
          participation_rules: 'Review the current Reddit community and thread rules before participating.',
          participation_rules_status: 'unverified',
          recommended_action: 'Read the full public conversation and contribute one useful response manually.',
          message_angle: 'Answer the negotiation question before mentioning professional services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'People preparing to buy a home in Austin',
        signal: 'A current public buyer question demonstrates intent',
        referenceTime: '2026-08-29T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('review')
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'opportunity.actionability',
          status: 'unknown',
          observed: expect.arrayContaining(['rules_status:unverified']),
        }),
      ]),
    )
    expect(result.unknowns).toContain('opportunity.actionability')
  })

  it('recognizes a direct seller request while keeping unverified thread rules in review', () => {
    const sourceUrl = 'https://www.reddit.com/r/askaustin/comments/1vi5hvd/south_austin_realtor_recommendation/'
    const content = [
      'South Austin Realtor recommendation?',
      'Thinking of trying to sell my South Austin home (78745) and am looking for realtor recommendations.',
      'I want someone who can help me prepare the house, including repairs, painting, and staging.',
    ].join(' ')
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'South Austin Realtor recommendation?',
          opportunity_kind: 'thread',
          platform: 'Reddit',
          intent_kind: 'seller_intent',
          audience_description: content,
          location: 'Austin, Texas',
          access_type: 'public',
          source_published_at: '2026-08-08T12:00:00.000Z',
          urls: [sourceUrl],
          participation_rules: 'Review the current subreddit and thread rules before participating.',
          participation_rules_status: 'unverified',
          recommended_action: 'Read the public thread and contribute one useful response manually.',
          message_angle: 'Answer the preparation question before mentioning professional help.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin homeowners preparing to sell',
        signal: 'A current public seller request demonstrates intent',
        referenceTime: '2026-08-30T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      [{
        claim: content,
        source_url: sourceUrl,
        observed_at: '2026-08-30T12:00:00.000Z',
        confidence: 0.85,
      }],
    )

    expect(result.verdict).toBe('review')
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'opportunity.audience', status: 'pass' }),
        expect.objectContaining({ id: 'opportunity.intent', status: 'pass' }),
        expect.objectContaining({ id: 'opportunity.actionability', status: 'unknown' }),
      ]),
    )
    expect(result.unknowns).toContain('opportunity.actionability')
  })

  it('keeps a current public event in review until its participation terms are observed', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Austin first-time home buyer workshop — September 12, 2026',
          opportunity_kind: 'event',
          platform: 'Eventbrite',
          intent_kind: 'buyer_intent',
          audience_description:
            'An Austin workshop for first-time home buyers with questions about offers and closing costs.',
          location: 'Austin, Texas',
          access_type: 'ticketed',
          event_start_at: '2026-09-12T17:00:00.000Z',
          source_published_at: '2026-08-28T10:00:00.000Z',
          urls: ['https://www.eventbrite.com/e/austin-first-time-home-buyer-workshop-123'],
          participation_rules: 'Check the organizer terms before participating.',
          participation_rules_status: 'unverified',
          recommended_action:
            'Open the event page and use its public registration path to attend. Follow organizer rules; do not automate contact or promotion.',
          message_angle:
            'Attend as a participant, answer questions when invited, and avoid promotion unless the organizer rules explicitly allow it.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin first-time home buyers',
        signal: 'A current public buyer event demonstrates local demand',
        referenceTime: '2026-08-29T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('review')
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'opportunity.actionability', status: 'unknown' }),
      ]),
    )
  })

  it('accepts a current public event only when observed terms permit the proposed attendance', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Austin home buyer community workshop — September 12, 2026',
          opportunity_kind: 'event',
          platform: 'Eventbrite',
          audience_description:
            'An Austin workshop where home buyers and local housing professionals can discuss offers and closing costs.',
          location: 'Austin, Texas',
          access_type: 'ticketed',
          event_start_at: '2026-09-12T17:00:00.000Z',
          source_published_at: '2026-08-28T10:00:00.000Z',
          urls: ['https://www.eventbrite.com/e/austin-home-buyer-community-workshop-456'],
          participation_rules:
            'This public workshop welcomes home buyers and local real estate professionals. Educational participation is permitted; unsolicited promotion is not.',
          participation_rules_status: 'observed',
          recommended_action:
            'Use the public registration path to attend manually and contribute only when invited by the organizer.',
          message_angle:
            'Answer buyer questions with useful local context and do not automate contact or promote services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin first-time home buyers',
        signal: 'A current public buyer event demonstrates local demand',
        referenceTime: '2026-08-29T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('accepted')
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'opportunity.actionability', status: 'pass' }),
      ]),
    )
  })

  it('rejects a public buyer event when observed terms prohibit real estate professionals', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Austin first-time home buyer workshop — September 12, 2026',
          opportunity_kind: 'event',
          platform: 'Eventbrite',
          audience_description:
            'An Austin workshop for first-time home buyers with questions about offers and closing costs.',
          location: 'Austin, Texas',
          access_type: 'ticketed',
          event_start_at: '2026-09-12T17:00:00.000Z',
          source_published_at: '2026-08-28T10:00:00.000Z',
          urls: ['https://www.eventbrite.com/e/austin-first-time-home-buyer-workshop-789'],
          participation_rules:
            'Real estate agents, brokers, and lenders are not allowed because of conflicts of interest.',
          participation_rules_status: 'observed',
          recommended_action:
            'Use the public registration path to attend manually and contribute only when invited by the organizer.',
          message_angle:
            'Answer buyer questions with useful local context and do not automate contact or promote services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin first-time home buyers',
        signal: 'A current public buyer event demonstrates local demand',
        referenceTime: '2026-08-29T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.notActionable)
    expect(result.contradictions).toContain('opportunity.actionability')
  })

  it('rejects the observed Eventbrite phrasing that does not allow agents to attend', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Buy your next house without selling',
          opportunity_kind: 'event',
          platform: 'Eventbrite',
          audience_description:
            'An Austin workshop for homeowners. We are currently not allowing agents, brokers, or lenders to attend these events due to a conflict of interest.',
          location: 'Austin, Texas',
          access_type: 'ticketed',
          event_start_at: '2026-09-15T17:00:00.000Z',
          source_published_at: '2026-08-25T10:00:00.000Z',
          urls: ['https://www.eventbrite.com/e/restricted-austin-homeowner-workshop'],
          participation_rules: 'Register for this Austin homeowner workshop.',
          participation_rules_status: 'observed',
          recommended_action: 'Use the public registration path to attend manually and contribute only when invited.',
          message_angle: 'Answer homeowner questions with useful local context without promoting services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin homeowners and local housing audiences',
        signal: 'A current public housing event demonstrates local demand',
        referenceTime: '2026-08-30T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'local_audience' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.notActionable)
    expect(result.contradictions).toContain('opportunity.actionability')
  })

  it('rejects an otherwise relevant result when observed venue rules conflict with the proposed promotion', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Austin first-home negotiation question',
          opportunity_kind: 'thread',
          platform: 'Reddit',
          audience_description: 'I am buying my first home in Austin. How should I respond to this counteroffer?',
          location: 'Austin, Texas',
          access_type: 'public',
          source_published_at: '2026-08-28T10:00:00.000Z',
          urls: ['https://www.reddit.com/r/FirstTimeHomeBuyer/comments/example/promotion-prohibited'],
          participation_rules: 'Industry promotion and advertising are prohibited in this community.',
          participation_rules_status: 'observed',
          recommended_action: 'Read the full public conversation and contribute one useful response manually.',
          message_angle: 'Answer the negotiation question before mentioning your real estate services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'People preparing to buy a home in Austin',
        signal: 'A current public buyer question demonstrates intent',
        referenceTime: '2026-08-29T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.notActionable)
    expect(result.fitScore).toBeLessThan(FIT_REVIEW_THRESHOLD)
    expect(result.contradictions).toContain('opportunity.actionability')
  })

  it('rejects an opportunity without a public destination', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Unverifiable private group',
          opportunity_kind: 'group',
          platform: 'Unknown',
          intent_kind: 'seller_intent',
          audience_description: 'Homeowners',
          recommended_action: 'Join it',
        },
      },
      { entityUnit: 'opportunities', geography: 'California, US' },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.missingDestination)
    expect(result.fitScore).toBeLessThan(FIT_REVIEW_THRESHOLD)
  })

  it('rejects an inactive event even when every other field looks complete', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Tampa home seller workshop calendar',
          opportunity_kind: 'event',
          platform: 'Events',
          audience_description: 'No upcoming events. Tampa homeowners can learn how to prepare a home for sale.',
          location: 'Tampa, Florida',
          access_type: 'public',
          urls: ['https://events.example/tampa-seller-workshop'],
          recommended_action: 'Review the public event page before deciding whether to attend manually.',
          message_angle: 'Answer active seller questions without inferring consent or private intent.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Tampa, Florida',
        audience: 'Tampa homeowners preparing to sell',
        signal: 'A current public seller question demonstrates intent',
        referenceTime: '2026-08-27T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.expiredDestination)
    expect(result.fitScore).toBeLessThan(FIT_REVIEW_THRESHOLD)
  })

  it('keeps rejected realtor noise below every reviewable result', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Luxury home for sale in Phoenix',
          opportunity_kind: 'post',
          platform: 'LinkedIn',
          audience_description: 'Luxury home for sale in Phoenix, reduced to $895,000. Schedule a private tour.',
          location: 'Phoenix, Arizona',
          access_type: 'public',
          source_published_at: '2026-08-27T10:00:00.000Z',
          urls: ['https://linkedin.com/posts/phoenix-listing'],
          recommended_action: 'Read the public post and decide whether a manual contribution is appropriate.',
          message_angle: 'Offer a useful answer only when a real consumer question is present.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Phoenix, Arizona',
        audience: 'Phoenix homeowners preparing to sell',
        signal: 'A current public seller question demonstrates intent',
        referenceTime: '2026-08-27T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.realtorNoise)
    expect(result.fitScore).toBeLessThan(FIT_REVIEW_THRESHOLD)
  })

  it('hard-rejects provider-origin buyer copy that imitates a consumer question', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Thinking about buying a home in Austin?',
          opportunity_kind: 'post',
          platform: 'X',
          audience_description:
            'Before my team sends you listings, let us talk about your goals and the neighborhoods you want to compare.',
          location: 'Austin, Texas',
          access_type: 'public',
          source_published_at: '2026-08-28T10:00:00.000Z',
          urls: ['https://x.com/example/status/provider-origin-buyer-copy'],
          recommended_action: 'Read the public post and contribute only when a consumer asks a genuine question.',
          message_angle: 'Answer the demonstrated buyer need before mentioning professional help.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'People preparing to buy a home in Austin',
        signal: 'A current public buyer question demonstrates intent',
        referenceTime: '2026-08-29T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.realtorNoise)
    expect(result.fitScore).toBeLessThan(FIT_REVIEW_THRESHOLD)
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'exclusion.realtor_noise',
          status: 'fail',
          observed: expect.arrayContaining(['provider_origin_promotion']),
        }),
      ]),
    )
  })

  it('hard-rejects a historical buyer transaction with sensitive financial and age context', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Historical Austin purchase and current mortgage hardship',
          opportunity_kind: 'post',
          platform: 'X',
          audience_description:
            'I moved from California to buy a house in Austin city limits 20 years ago. I still pay my mortgage, couldn’t take equity because my income it’s not enough, several banks turned me down, and I am single and senior.',
          location: 'Austin, Texas',
          access_type: 'public',
          source_published_at: '2026-08-29T18:30:00.000Z',
          urls: ['https://x.com/example/status/historical-sensitive-buyer'],
          recommended_action: 'Read the public post and contribute only when a safe current need is demonstrated.',
          message_angle: 'Do not infer intent from historical or sensitive circumstances.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'People preparing to buy a home in Austin',
        signal: 'A current public buyer question demonstrates intent',
        referenceTime: '2026-08-30T01:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      [{
        claim: 'Current public X post returned by the bounded buyer-intent query.',
        source_url: 'https://x.com/example/status/historical-sensitive-buyer',
        observed_at: '2026-08-30T01:00:00.000Z',
        confidence: 0.8,
      }],
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.realtorNoise)
    expect(result.fitScore).toBeLessThan(FIT_REVIEW_THRESHOLD)
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'exclusion.realtor_noise',
          status: 'fail',
          observed: expect.arrayContaining([
            'historical_completed_transaction',
            'sensitive_bereavement_or_financial_distress',
            'sensitive_age_or_marital_status',
          ]),
        }),
      ]),
    )
  })

  it('rejects a complete-looking realtor result whose returned content is generic market news', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Weekly housing market update',
          opportunity_kind: 'post',
          platform: 'LinkedIn',
          intent_kind: 'seller_intent',
          audience_description: 'Generic real estate news and a weekly market report.',
          location: 'South Bay, California',
          access_type: 'public',
          urls: ['https://www.linkedin.com/posts/example-market-update'],
          recommended_action: 'Read the post and decide whether a manual reply would be useful.',
          message_angle: 'Share a local observation only if it directly answers a current question.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'South Bay, California',
        audience: 'South Bay homeowners considering selling',
        signal: 'Asking how to prepare or price a home for sale',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.realtorNoise)
    expect(result.contradictions).toContain('exclusion.realtor_noise')
  })

  it('rejects a real-estate advertising case study that contains seller-lead language', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Google Ads case study: lower cost per lead for a Phoenix real estate company',
          opportunity_kind: 'post',
          platform: 'LinkedIn',
          audience_description:
            'A brokerage campaign generated qualified seller leads after Google Ads optimization.',
          location: 'Phoenix, Arizona',
          access_type: 'public',
          source_published_at: '2026-08-25T15:15:35.672Z',
          urls: ['https://www.linkedin.com/posts/example-case-study'],
          recommended_action: 'Read the full post and decide whether a manual contribution is appropriate.',
          message_angle: 'Offer useful local context only when it answers a real consumer question.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Phoenix, Arizona',
        audience: 'Phoenix homeowners preparing to sell',
        signal: 'A current public seller question demonstrates intent',
        referenceTime: '2026-08-27T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.realtorNoise)
    expect(result.contradictions).toContain('exclusion.realtor_noise')
  })

  it('rejects a completed listing promotion that contains seller and location language', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Another beautiful home successfully listed and sold in Chandler',
          opportunity_kind: 'post',
          platform: 'LinkedIn',
          audience_description:
            'Another beautiful home successfully listed and sold in Chandler. This lovely 3-bedroom, 2-bath home is in an excellent neighborhood.',
          location: 'Phoenix, Arizona',
          access_type: 'public',
          source_published_at: '2026-08-25T20:25:34.899Z',
          urls: ['https://www.linkedin.com/posts/example-completed-listing'],
          recommended_action: 'Read the post and decide whether to contribute manually.',
          message_angle: 'Offer local context only when it answers an active consumer need.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Phoenix, Arizona',
        audience: 'Phoenix homeowners preparing to sell',
        signal: 'A current public seller question demonstrates intent',
        referenceTime: '2026-08-27T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.realtorNoise)
    expect(result.contradictions).toContain('exclusion.realtor_noise')
  })

  it('rejects a provider-authored social post even when a search snippet contains consumer language', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Scottsdale and Phoenix area residential real estate guidance',
          opportunity_kind: 'post',
          platform: 'Facebook',
          audience_description:
            'A public snippet mentions someone looking for a Realtor and asks whether they are ready to buy a home in Phoenix.',
          location: 'Phoenix, Arizona',
          access_type: 'public',
          source_published_at: '2026-08-25T10:00:00.000Z',
          urls: ['https://www.facebook.com/chrissieclinerealtor/posts/example'],
          participation_rules: 'Public post; review current platform rules.',
          participation_rules_status: 'unverified',
          recommended_action: 'Read the full public post before considering a manual response.',
          message_angle: 'Answer a demonstrated buyer question without promoting services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Phoenix, Arizona',
        audience: 'Phoenix residents preparing to buy a home',
        signal: 'A current public buyer question demonstrates intent',
        referenceTime: '2026-08-30T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.realtorNoise)
    expect(result.contradictions).toContain('exclusion.realtor_noise')
  })

  it('accepts a seller question that also mentions the home the consumer plans to buy next', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Selling before buying a smaller home',
          opportunity_kind: 'thread',
          platform: 'Reddit',
          audience_description:
            'I am selling my Phoenix house so I can buy a smaller home. What should I repair first?',
          location: 'Phoenix, Arizona',
          access_type: 'public',
          source_published_at: '2026-08-26T15:00:00.000Z',
          urls: ['https://www.reddit.com/r/phoenix/comments/example/selling_before_buying'],
          participation_rules: 'Professionals may answer questions but may not send unsolicited direct messages.',
          participation_rules_status: 'observed',
          recommended_action: 'Read the full thread and answer the repair question manually.',
          message_angle: 'Explain which repairs matter before mentioning professional help.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Phoenix, Arizona',
        audience: 'Phoenix homeowners preparing to sell',
        signal: 'A current public seller question demonstrates intent',
        referenceTime: '2026-08-27T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('accepted')
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'opportunity.intent',
          status: 'pass',
          observed: expect.arrayContaining(['mixed_intent']),
        }),
      ]),
    )
  })

  it('accepts a current in-progress buyer negotiation supported by returned evidence', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Negotiation advice',
          opportunity_kind: 'thread',
          platform: 'Reddit',
          intent_kind: 'buyer_intent',
          audience_description:
            'Home is listed for 435k and the appraisal came in at 422k. Taxes are high in Austin TX. I made my offer for 375k with me covering closing costs. The seller countered at 415k. What should be my next move?',
          location: 'Austin, Texas, United States',
          access_type: 'public',
          source_published_at: '2026-08-27T22:16:27.007Z',
          urls: ['https://www.reddit.com/r/FirstTimeHomeBuyer/comments/example/negotiation_advice'],
          participation_rules: 'Public educational replies are permitted; solicitation and direct messages are not.',
          participation_rules_status: 'observed',
          recommended_action: 'Read the full public conversation and contribute one useful response manually.',
          message_angle: 'Answer the specific negotiation question before mentioning professional services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas, United States',
        audience: 'People publicly demonstrating that they are preparing to buy a home in Austin',
        signal: 'A current public question demonstrates home-buying intent',
        referenceTime: '2026-08-28T06:00:20.125Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'buyer_intent' },
      },
      [{
        claim: 'Current public buyer negotiation thread in Austin.',
        source_url: 'https://www.reddit.com/r/FirstTimeHomeBuyer/comments/example/negotiation_advice',
        observed_at: '2026-08-28T06:00:20.125Z',
        confidence: 0.8,
      }],
    )

    expect(result.verdict).toBe('accepted')
    expect(result.reason).toBe(FIT_REASONS.accepted)
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'opportunity.audience', status: 'pass' }),
        expect.objectContaining({ id: 'opportunity.intent', status: 'pass' }),
      ]),
    )
  })

  it('does not trust a provider intent label when returned content proves a different lane', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'South Bay neighborhood community breakfast',
          opportunity_kind: 'event',
          platform: 'Meetup',
          intent_kind: 'seller_intent',
          audience_description: 'A South Bay neighborhood community breakfast for local residents.',
          location: 'South Bay, California',
          access_type: 'public',
          event_start_at: '2026-09-15T17:00:00.000Z',
          urls: ['https://meetup.example/south-bay-community-breakfast'],
          recommended_action: 'Review the agenda and attend manually only when the event rules permit it.',
          message_angle: 'Offer one locally useful resource without implying that attendees plan to sell.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'South Bay, California',
        audience: 'South Bay homeowners considering selling',
        signal: 'Preparing to sell a home',
        referenceTime: '2026-08-26T17:00:00.000Z',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.intentMismatch)
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'opportunity.intent', status: 'fail', observed: expect.arrayContaining(['local_audience']) }),
      ]),
    )
  })

  it('keeps requested geography unknown until returned opportunity content proves the market', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'How should I prepare my home to sell?',
          opportunity_kind: 'thread',
          platform: 'Reddit',
          audience_description: 'I am preparing my home to sell. What should I repair first?',
          provider_location: 'Austin, Texas',
          access_type: 'public',
          urls: ['https://reddit.com/r/homeowners/comments/example'],
          recommended_action: 'Read the current conversation and contribute one useful response manually.',
          message_angle: 'Answer the repair question before mentioning professional services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin homeowners preparing to sell',
        signal: 'A public home-selling question',
        providerQuery: { opportunity_intent_lane: 'seller_intent', locations: ['Austin, Texas'] },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('review')
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'geography.location', status: 'unknown' }),
      ]),
    )
  })

  it('rejects a demonstrated wrong-state opportunity even when its lane is correct', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'South Florida home sale question',
          opportunity_kind: 'thread',
          platform: 'LinkedIn',
          audience_description: 'I am selling my South Florida home. What should I repair first?',
          provider_location: 'Austin, Texas',
          access_type: 'public',
          urls: ['https://www.linkedin.com/posts/example-wrong-market'],
          recommended_action: 'Read the current conversation and contribute one useful response manually.',
          message_angle: 'Answer the repair question before mentioning professional services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin homeowners preparing to sell',
        signal: 'A public home-selling question',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.outsideGeography)
  })

  it('rejects an identically named city in the wrong state before awarding locality credit', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Austin Minnesota home sale question',
          opportunity_kind: 'thread',
          platform: 'Reddit',
          audience_description: 'I am selling my Austin, Minnesota home. What should I repair first?',
          access_type: 'public',
          urls: ['https://reddit.com/r/example/comments/austin-minnesota-home-sale'],
          recommended_action: 'Read the current conversation and contribute one useful response manually.',
          message_angle: 'Answer the repair question before mentioning professional services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin homeowners preparing to sell',
        signal: 'A public home-selling question',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.outsideGeography)
  })

  it('rejects a different local subreddit even when its snippet mentions the requested city as a comparison', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Chicago apartment-price discussion',
          opportunity_kind: 'thread',
          platform: 'Reddit',
          audience_description:
            'I am thinking of selling my house. Austin, Texas is one example mentioned in this Chicago apartment discussion.',
          access_type: 'public',
          urls: ['https://www.reddit.com/r/chicagoapartments/comments/example/apartment_prices'],
          recommended_action: 'Read the current conversation and contribute one useful response manually.',
          message_angle: 'Answer the seller question before mentioning professional services.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin homeowners preparing to sell',
        signal: 'A public home-selling question',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.outsideGeography)
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'geography.location',
          status: 'fail',
          observed: expect.arrayContaining(['destination conflict: reddit:r/chicagoapartments']),
        }),
      ]),
    )
  })

  it('rejects a second-person cash-buyer solicitation even when the provider truncates its title', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: "Looking to sell your house in Austin but don't want to deal with ...",
          opportunity_kind: 'post',
          platform: 'Facebook',
          audience_description:
            "Looking to sell your house in Austin but don't want to deal with ... Austin TEXAS THAT CASHFLOWS ... I need advice on selling my house for cash.",
          location: 'Austin, Texas',
          access_type: 'public',
          source_published_at: '2026-08-21T04:15:11.000Z',
          urls: ['https://www.facebook.com/fixture/posts/austin-cash-buyer-promotion'],
          recommended_action: 'Read the public post and decide whether a manual contribution is appropriate.',
          message_angle: 'Share a practical seller answer only when a genuine consumer asks for help.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'Austin, Texas',
        audience: 'Austin homeowners preparing to sell',
        signal: 'A current public seller question demonstrates intent',
        referenceTime: '2026-08-27T12:00:00.000Z',
        recencyWindow: '30 days',
        providerQuery: { opportunity_intent_lane: 'seller_intent' },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.realtorNoise)
    expect(result.contradictions).toContain('exclusion.realtor_noise')
  })

  it('does not let a provenance claim with negative query terms reject a useful result', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'opportunity',
        identity: {
          name: 'Tampa homebuyer Q&A',
          opportunity_kind: 'post',
          platform: 'Facebook',
          audience_description: 'I am a first-time home buyer in Tampa. Where should I begin before buying a home?',
          location: 'Tampa, Florida',
          access_type: 'public',
          urls: ['https://facebook.example/tampa-homebuyer-qa'],
          participation_rules: 'Public educational answers are permitted when professional affiliation is disclosed.',
          participation_rules_status: 'observed',
          recommended_action: 'Read the public conversation and contribute one useful answer manually.',
          message_angle: 'Answer the buyer question directly before mentioning any professional service.',
        },
      },
      {
        entityUnit: 'post',
        geography: 'Tampa, Florida',
        audience: 'People preparing to buy a home in Tampa',
        signal: 'A current question demonstrates home-buying intent.',
        providerQuery: {
          opportunity_intent_lane: 'buyer_intent',
          audience_keywords: ['home buyer'],
          source_search_keywords: ['Tampa home buyer -"just listed" -"market update"'],
        },
      },
      [{
        claim: 'Public result matched “Tampa home buyer -"just listed" -"market update"”.',
        source_url: 'https://facebook.example/tampa-homebuyer-qa',
        observed_at: '2026-08-27T12:00:00.000Z',
        confidence: 0.88,
      }],
    )
    expect(result.verdict).toBe('accepted')
    expect(result.reason).toBe(FIT_REASONS.accepted)
  })

  it('rejects a candidate located outside the play geography', () => {
    const abroad = {
      entity_kind: 'company' as const,
      identity: {
        name: 'Example GmbH',
        domain: 'example.example',
        location: 'Berlin, Germany',
      },
    }
    const result = ruleBasedFitScorer.score(abroad, play, strongEvidence)
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.outsideGeography)
  })

  it('rejects an explicit non-US provider country even if other location text is contradictory', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Contradictory Location Co',
          location: 'San Diego, CA',
          country_code: 'MX',
        },
      },
      play,
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.outsideGeography)
  })

  it('rejects a nameless identity outright', () => {
    const result = ruleBasedFitScorer.score({ entity_kind: 'company', identity: { name: '  ' } }, play, strongEvidence)
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.missingName)
    expect(result.fitScore).toBe(0)
  })

  it('rejects with an explicit reason when evidence is missing', () => {
    const result = ruleBasedFitScorer.score(company, play, [])
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.noEvidence)
  })

  it('routes weak-but-not-contradictory evidence to human review', () => {
    const weak = strongEvidence.map((row) => ({ ...row, confidence: 0.2 }))
    const result = ruleBasedFitScorer.score(company, play, weak)
    expect(result.verdict).toBe('review')
    expect(result.reason).toBe(FIT_REASONS.weakEvidence)
  })

  it('never leaves a rejected candidate without a reason', () => {
    const inputs = [
      { candidate: company, evidence: [] as CandidateEvidence[] },
      {
        candidate: {
          entity_kind: 'company' as const,
          identity: { name: 'No Domain Co' },
        },
        evidence: [] as CandidateEvidence[],
      },
      {
        candidate: {
          entity_kind: 'person' as const,
          identity: { name: 'Wrong Kind' },
        },
        evidence: strongEvidence,
      },
    ]
    for (const { candidate, evidence } of inputs) {
      const result = ruleBasedFitScorer.score(candidate, play, evidence)
      if (result.verdict === 'rejected') {
        expect(result.reason.length).toBeGreaterThan(0)
      }
    }
  })

  it('clamps the score into 0-100 as an integer', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Example Dynamics LLC',
          domain: 'example-dynamics.example',
          location: 'San Diego, CA',
        },
      },
      play,
      strongEvidence.map((row) => ({ ...row, confidence: 1 })),
    )
    expect(Number.isInteger(result.fitScore)).toBe(true)
    expect(result.fitScore).toBeLessThanOrEqual(100)
    expect(result.fitScore).toBeGreaterThanOrEqual(0)
  })

  it('accepts only when the candidate satisfies the play-specific criteria', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Example Software',
          domain: 'example.example',
          industry: 'Software Development',
          employee_range: '51 to 200',
          technologies: ['Salesforce'],
          location: 'Austin, TX',
        },
      },
      {
        entityUnit: 'companies',
        geography: 'US',
        recencyWindow: 'last 30 days',
        referenceTime: '2026-08-02T12:00:00.000Z',
        providerQuery: {
          industries: ['Software Development'],
          employee_ranges: ['51 to 200'],
          technologies: ['Salesforce'],
          locations: ['Austin, TX'],
          exclude_industries: ['Consumer gambling'],
        },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('accepted')
    expect(result.version).toBe('fit-v7')
    expect(result.criteria?.every((row) => row.status === 'pass')).toBe(true)
  })

  it('rejects a provider row that contradicts a hard ICP criterion', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Example Agency',
          domain: 'agency.example',
          industry: 'Advertising',
        },
      },
      {
        entityUnit: 'companies',
        geography: 'US',
        providerQuery: { industries: ['Software Development'] },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.criterionMismatch)
    expect(result.contradictions).toContain('account.industry')
  })

  it('routes an unprovable hard criterion to review instead of guessing', () => {
    const result = ruleBasedFitScorer.score(
      company,
      { ...play, providerQuery: { employee_ranges: ['51 to 200'] } },
      strongEvidence,
    )
    expect(result.verdict).toBe('review')
    expect(result.reason).toBe(FIT_REASONS.criterionUnknown)
    expect(result.unknowns).toContain('account.employee_range')
  })

  it('gives an exact employee count precedence over a conflicting provider bucket', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Conflicting Company Size',
          domain: 'conflicting-size.example',
          industry: 'Medical Practices',
          employee_count: 53,
          employee_range: '11-50',
          location: 'San Diego, CA',
        },
      },
      {
        entityUnit: 'companies',
        geography: 'San Diego, California',
        providerQuery: { employee_ranges: ['1-10', '11-50'] },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.contradictions).toContain('account.employee_range')
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'account.employee_range',
          status: 'fail',
          observed: ['11-50', '53'],
        }),
      ]),
    )
  })

  it('does not let a broad source-search term prove precise audience fit', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Dental Ops Coach',
          domain: 'dental-ops.example',
          industry: 'Operations Consulting',
          employee_count: 2,
          employee_range: '2-10',
          location: 'San Diego, CA',
          company_description: 'We advise dentists on practice operations.',
        },
      },
      {
        entityUnit: 'companies',
        geography: 'San Diego, California',
        providerQuery: {
          source_search_keywords: ['dental'],
          company_keywords: ['dental practice', 'dental office', 'dental care'],
          industries: ['Medical Practices', 'Hospitals and Health Care'],
          employee_ranges: ['1-10', '11-50'],
          locations: ['San Diego, California'],
        },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.contradictions).toEqual(expect.arrayContaining(['account.industry', 'account.keywords']))
    expect(result.criteria?.some((row) => row.id === 'source_search_keywords')).toBe(false)
  })

  it('separates dental practices from adjacent companies in the golden firmographic rubric', () => {
    const preciseDentalPlay = {
      entityUnit: 'companies',
      geography: 'San Diego, California',
      providerQuery: {
        source_search_keywords: ['dental'],
        company_keywords: [
          'dental practice',
          'dental office',
          'dental center',
          'dental care',
          'dentistry',
          'dental services',
        ],
        industries: ['Medical Practices', 'Hospitals and Health Care'],
        employee_ranges: ['1-10', '11-50'],
        locations: ['San Diego, California'],
        exclude_company_keywords: [
          'dental billing',
          'dental laboratory',
          'dental lab',
          'dental consulting',
          'veterinary dental',
          'dental support',
        ],
        exclude_industries: ['Accounting', 'Operations Consulting', 'Veterinary Services'],
      },
    }
    const score = (identity: CandidateIdentity) =>
      ruleBasedFitScorer.score({ entity_kind: 'company', identity }, preciseDentalPlay, strongEvidence)

    expect(
      score({
        name: 'Example Dental Center',
        domain: 'practice.example',
        industry: 'Hospitals and Health Care',
        employee_count: 9,
        employee_range: '2-10',
        location: 'San Diego, CA',
        company_description: 'A family dental center providing dental services.',
      }).verdict,
    ).toBe('accepted')

    expect(
      score({
        name: 'Example Dental Billing',
        domain: 'billing.example',
        industry: 'Accounting',
        employee_count: 1,
        employee_range: '2-10',
        location: 'San Diego, CA',
        company_description: 'Billing support for dental practices.',
      }).verdict,
    ).toBe('rejected')

    expect(
      score({
        name: 'Example Dental Ceramics',
        domain: 'lab.example',
        industry: 'Hospitals and Health Care',
        employee_count: 10,
        employee_range: '11-50',
        location: 'San Diego, CA',
        company_description: 'A dental laboratory serving local offices.',
      }).verdict,
    ).toBe('rejected')

    expect(
      score({
        name: 'Example Veterinary Dental Center',
        domain: 'veterinary.example',
        industry: 'Veterinary Services',
        employee_count: 33,
        employee_range: '11-50',
        location: 'San Diego, CA',
        company_description: 'Veterinary dental care for animals.',
      }).verdict,
    ).toBe('rejected')

    expect(
      score({
        name: 'Example Multi-location Dental Practice',
        domain: 'large.example',
        industry: 'Medical Practices',
        employee_count: 53,
        employee_range: '11-50',
        location: 'San Diego, CA',
        company_description: 'A family-owned dental practice.',
      }).verdict,
    ).toBe('rejected')

    const localityReview = score({
      name: 'Example La Jolla Dental Care',
      domain: 'lajolla.example',
      industry: 'Hospitals and Health Care',
      employee_count: 19,
      employee_range: '11-50',
      location: 'La Jolla, CA',
      provider_location: 'San Diego, California',
      company_description: 'Comprehensive dental care for local families.',
    })
    expect(localityReview.verdict).toBe('review')
    expect(localityReview.unknowns).toContain('geography.location')
  })

  it('routes a valid county-targeted dental Maps result to review until employee size is proven', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Example Family Dental',
          domain: 'example-dental.test',
          industry: 'Dental clinic',
          location: '13465 Camino Canada, El Cajon, CA 92021',
          provider_location: 'San Diego County,California,United States',
          country_code: 'US',
        },
      },
      {
        entityUnit: 'companies',
        geography: 'San Diego County, California',
        providerQuery: {
          industries: ['Dentistry', 'Medical Practices'],
          employee_ranges: ['2 to 50'],
          locations: ['San Diego County, California'],
        },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('review')
    expect(result.reason).toBe(FIT_REASONS.criterionUnknown)
    expect(result.unknowns).toEqual(['account.employee_range', 'geography.location'])
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'account.industry', status: 'pass' }),
        expect.objectContaining({
          id: 'geography.location',
          status: 'unknown',
        }),
        expect.objectContaining({
          id: 'account.employee_range',
          status: 'unknown',
        }),
      ]),
    )
  })

  it('still rejects an out-of-industry Maps result inside the requested county', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Example Animal Hospital',
          industry: 'Veterinarian',
          location: 'El Cajon, CA 92021',
          provider_location: 'San Diego County,California,United States',
          country_code: 'US',
        },
      },
      {
        entityUnit: 'companies',
        geography: 'San Diego County, California',
        providerQuery: {
          industries: ['Dentistry', 'Medical Practices'],
          employee_ranges: ['2 to 50'],
          locations: ['San Diego County, California'],
        },
      },
      strongEvidence,
    )

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.criterionMismatch)
    expect(result.contradictions).toContain('account.industry')
  })

  it('routes a partially overlapping provider size bucket to review', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Broad Bucket Company',
          domain: 'broad.example',
          industry: 'Software Development',
          employee_range: '1 to 200',
          location: 'Austin, TX',
        },
      },
      {
        entityUnit: 'companies',
        geography: 'US',
        providerQuery: { employee_ranges: ['51 to 200'] },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('review')
    expect(result.reason).toBe(FIT_REASONS.criterionUnknown)
    expect(result.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'account.employee_range',
          status: 'unknown',
        }),
      ]),
    )
  })

  it('rejects a disjoint provider size bucket', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: {
          name: 'Large Company',
          domain: 'large.example',
          industry: 'Software Development',
          employee_range: '501 to 1000',
          location: 'Austin, TX',
        },
      },
      {
        entityUnit: 'companies',
        geography: 'US',
        providerQuery: { employee_ranges: ['51 to 200'] },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.criterionMismatch)
  })

  it('rejects a candidate that matches an explicit exclusion', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: { ...company.identity, industry: 'Consumer gambling' },
      },
      { ...play, providerQuery: { exclude_industries: ['Consumer gambling'] } },
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.excluded)
  })

  it('enforces the play signal recency window against a frozen reference time', () => {
    const result = ruleBasedFitScorer.score(
      company,
      {
        ...play,
        recencyWindow: 'last 7 days',
        referenceTime: '2026-08-02T12:00:00.000Z',
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.staleSignal)
  })
})

describe('summarizeFitResults', () => {
  it('produces the accepted/rejected distribution with per-reason counts', () => {
    const make = (fitScore: number, verdict: FitResult['verdict'], reason: string): FitResult => ({
      fitScore,
      verdict,
      reason,
      version: 'fit-v2',
      breakdown: {
        identity: 0,
        account: 0,
        persona: 0,
        geography: 0,
        evidence: 0,
      },
      unknowns: [],
      contradictions: [],
    })
    const results: FitResult[] = [
      make(80, 'accepted', FIT_REASONS.accepted),
      make(70, 'accepted', FIT_REASONS.accepted),
      make(30, 'rejected', FIT_REASONS.noEvidence),
      make(0, 'rejected', FIT_REASONS.entityKindMismatch),
      make(40, 'rejected', FIT_REASONS.noEvidence),
    ]
    expect(summarizeFitResults(results)).toEqual({
      accepted: 2,
      review: 0,
      rejected: 3,
      byReason: {
        [FIT_REASONS.accepted]: 2,
        [FIT_REASONS.noEvidence]: 2,
        [FIT_REASONS.entityKindMismatch]: 1,
      },
    })
  })

  it('handles an empty result set', () => {
    expect(summarizeFitResults([])).toEqual({
      accepted: 0,
      review: 0,
      rejected: 0,
      byReason: {},
    })
  })
})

describe('criterion matching is token-based, not substring', () => {
  const evidence = [
    {
      claim: 'Matched the approved provider targeting filters.',
      source_url: 'https://example.com/p',
      observed_at: '2026-08-01T00:00:00Z',
      confidence: 0.8,
    },
  ]
  const NOW = new Date('2026-08-02T00:00:00Z')
  const base = {
    name: 'Jane Doe',
    company: 'Acme',
    title: 'VP of Sales',
    domain: 'acme.com',
    location: 'Austin, TX',
  }
  const criterion = (identity: Record<string, unknown>, providerQuery: Record<string, unknown>, id: string) =>
    ruleBasedFitScorer
      .score(
        { entity_kind: 'person', identity } as never,
        {
          entityUnit: 'people',
          geography: 'United States',
          providerQuery,
          referenceTime: NOW,
        },
        evidence as never,
      )
      .criteria?.find((row) => row.id === id)?.status

  it('does not pass a short expected value that merely appears inside a word', () => {
    // "IT" is a substring of "Digital"; "AI" is a substring of "Retail".
    expect(criterion({ ...base, industry: 'Digital Marketing' }, { industries: ['IT'] }, 'account.industry')).toBe(
      'fail',
    )
    expect(criterion({ ...base, industry: 'Retail' }, { industries: ['AI'] }, 'account.industry')).toBe('fail')
  })

  it('still matches a genuine information technology industry', () => {
    expect(criterion({ ...base, industry: 'Information Technology' }, { industries: ['IT'] }, 'account.industry')).toBe(
      'pass',
    )
  })

  it('resolves seniority abbreviations against their spelled-out form', () => {
    expect(criterion({ ...base, title: 'Vice President of Sales' }, { titles: ['VP Sales'] }, 'persona.title')).toBe(
      'pass',
    )
    expect(
      criterion({ ...base, title: 'VP, Global Sales' }, { titles: ['Vice President Sales'] }, 'persona.title'),
    ).toBe('pass')
  })

  it('resolves US state codes against their spelled-out form', () => {
    expect(criterion({ ...base, location: 'Austin, Texas' }, { locations: ['Austin, TX'] }, 'geography.location')).toBe(
      'pass',
    )
    expect(
      criterion({ ...base, location: 'Austin, TX, US' }, { locations: ['Austin, Texas'] }, 'geography.location'),
    ).toBe('pass')
  })

  it('resolves narrow local-healthcare provider categories to the requested industry', () => {
    expect(criterion({ ...base, industry: 'Dental clinic' }, { industries: ['Dentistry'] }, 'account.industry')).toBe(
      'pass',
    )
    expect(criterion({ ...base, industry: 'Dentist' }, { industries: ['Dentistry'] }, 'account.industry')).toBe('pass')
    expect(
      criterion({ ...base, industry: 'Medical clinic' }, { industries: ['Medical Practices'] }, 'account.industry'),
    ).toBe('pass')
    expect(criterion({ ...base, industry: 'Veterinarian' }, { industries: ['Dentistry'] }, 'account.industry')).toBe(
      'fail',
    )
  })

  it('uses a frozen Maps target only to prevent a false reject, never as result-level proof', () => {
    expect(
      criterion(
        {
          ...base,
          location: '13465 Camino Canada, El Cajon, CA 92021',
          provider_location: 'San Diego County,California,United States',
        },
        { locations: ['San Diego County, California'] },
        'geography.location',
      ),
    ).toBe('unknown')
  })

  it('does not treat a different state as a match', () => {
    expect(criterion({ ...base, location: 'Austin, TX' }, { locations: ['Boston, MA'] }, 'geography.location')).toBe(
      'fail',
    )
  })

  it('requires the observed value to contain the expectation, not the reverse', () => {
    // An observed "Engineering" does not prove "Head of Engineering".
    expect(criterion({ ...base, title: 'Engineering' }, { titles: ['Head of Engineering'] }, 'persona.title')).toBe(
      'fail',
    )
    expect(
      criterion(
        { ...base, title: 'Head of Engineering, Platform' },
        { titles: ['Head of Engineering'] },
        'persona.title',
      ),
    ).toBe('pass')
  })
})

describe('signal recency cannot pass without a trustworthy reference time', () => {
  const stale = [
    {
      claim: 'Matched the approved provider targeting filters.',
      source_url: 'https://example.com/p',
      observed_at: '2020-01-01T00:00:00Z',
      confidence: 0.9,
    },
  ]
  const identity = {
    name: 'Jane Doe',
    company: 'Acme',
    title: 'VP of Sales',
    domain: 'acme.com',
    location: 'Austin, TX',
  }
  const score = (referenceTime?: Date) =>
    ruleBasedFitScorer.score(
      { entity_kind: 'person', identity } as never,
      {
        entityUnit: 'people',
        geography: 'United States',
        providerQuery: {},
        recencyWindow: 'last 7 days',
        ...(referenceTime ? { referenceTime } : {}),
      },
      stale as never,
    )

  it('rejects evidence older than the frozen window', () => {
    const result = score(new Date('2026-08-02T00:00:00Z'))
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.staleSignal)
  })

  it('routes to review rather than accepting when no reference time is supplied', () => {
    // Defaulting the reference to the evidence's own timestamp made every
    // signal look zero days old and silently passed the hard recency gate.
    const result = score()
    expect(result.verdict).toBe('review')
    expect(result.criteria?.find((row) => row.id === 'signal.recency')?.status).toBe('unknown')
  })
})
