import crypto from 'crypto'
import {
  adapterAudienceRights,
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type SourceAdapter,
  type SourceSearchPlan,
} from './types'

const CLOCK = '2026-08-26T12:00:00.000Z'

export const fixtureConsumerSourceDescriptor: AdapterDescriptor = {
  contract_version: '2',
  adapter_id: 'fixture-consumer-public-profiles',
  layer: 'source',
  capabilities: [
    {
      signal_kind: 'social_engagement',
      entity_units: ['people'],
      geographies: ['US'],
      channels: [],
    },
    {
      signal_kind: 'social_engagement',
      entity_units: ['opportunities'],
      geographies: ['US'],
      channels: [],
    },
  ],
  constraints: {
    license: {
      status: 'test_only',
      terms_version: 'fixture-consumer-v1',
      export: true,
      customer_display: true,
      outreach_allowed: true,
      retention_days: 30,
      audience_modes: ['consumer'],
      manual_outreach_allowed: true,
      automated_email_allowed: false,
      public_profile_contact_allowed: true,
      public_opportunity_use_allowed: true,
    },
    max_batch: 10,
  },
  cost_model: {
    unit: 'public_profile',
    quoted_credits_per_unit: 1,
    price_version: 'fixture-consumer-v1',
    pay_on_found: true,
  },
  evidence_policy: {
    source_url: 'required',
    observed_at: 'required',
    max_age_days: 30,
    min_confidence: 0.7,
  },
  ambiguity_contract: {
    timeout_is_ambiguous: true,
    receipt_fields: ['provider_request_id', 'provider_status', 'input_hash', 'attempted_at'],
  },
  dsr: { deletion_supported: true },
}

const CONSUMER_PEOPLE: Candidate[] = [
  {
    entity_kind: 'person',
    identity: {
      name: 'Avery Example',
      location: 'Manhattan Beach, California',
      urls: ['https://www.linkedin.com/in/noli-fixture-avery-home-design'],
    },
    evidence: [
      {
        claim: 'Publicly requested follow-up information at a synthetic neighborhood home-design workshop',
        source_url: 'https://events.example/workshops/home-design/avery-example',
        observed_at: CLOCK,
        confidence: 0.94,
      },
    ],
  },
  {
    entity_kind: 'person',
    identity: {
      name: 'Jordan Fixture',
      location: 'Redondo Beach, California',
      urls: ['https://www.linkedin.com/in/noli-fixture-jordan-open-house-design'],
    },
    evidence: [
      {
        claim: 'Publicly asked for a local market update after a synthetic community housing seminar',
        source_url: 'https://events.example/seminars/local-market/jordan-fixture',
        observed_at: CLOCK,
        confidence: 0.91,
      },
    ],
  },
]

const CONSUMER_OPPORTUNITIES: Candidate[] = [
  {
    entity_kind: 'opportunity',
    identity: {
      name: 'South Bay First-Time Homebuyer Questions',
      opportunity_kind: 'community',
      platform: 'Reddit',
      intent_kind: 'buyer_intent',
      audience_description: 'People asking public questions about buying a first home in the South Bay',
      activity_level: 'high',
      member_count: 4200,
      access_type: 'public',
      location: 'South Bay, California',
      country_code: 'US',
      urls: ['https://community.example/south-bay/first-home-questions'],
      participation_rules:
        'Answer questions helpfully and disclose professional affiliation. No unsolicited direct messages.',
      recommended_action:
        'Review the newest unanswered questions and contribute one useful local answer before mentioning a service.',
      message_angle:
        'Explain one practical first-home decision with local context and invite follow-up only if the author asks.',
      people_to_follow: [
        {
          name: 'Morgan Example',
          role: 'Community organizer',
          profile_url: 'https://community.example/people/morgan-example',
        },
      ],
    },
    evidence: [
      {
        claim:
          'The synthetic public community has recent South Bay first-home questions and visible weekly participation',
        source_url: 'https://community.example/south-bay/first-home-questions',
        observed_at: CLOCK,
        confidence: 0.96,
        detail: {
          intent_kind: 'buyer_intent',
          recent_posts_30d: 38,
          unanswered_posts: 7,
        },
      },
    ],
  },
  {
    entity_kind: 'opportunity',
    identity: {
      name: 'What should I fix before selling in Manhattan Beach?',
      opportunity_kind: 'thread',
      platform: 'Nextdoor-style fixture',
      intent_kind: 'seller_intent',
      audience_description: 'Local homeowners discussing preparation and timing before a possible sale',
      activity_level: 'high',
      engagement_count: 18,
      access_type: 'approval_required',
      location: 'Manhattan Beach, California',
      country_code: 'US',
      urls: ['https://neighbors.example/manhattan-beach/posts/preparing-to-sell'],
      participation_rules:
        'Neighborhood membership is required. Business recommendations must answer the question and avoid repeated promotion.',
      recommended_action:
        'Read the full discussion, then add a concise preparation checklist if membership and group rules permit it.',
      message_angle: 'Separate repairs that affect buyer confidence from cosmetic work that may not return its cost.',
    },
    evidence: [
      {
        claim:
          'A synthetic public preview shows an active homeowner discussion about preparing a Manhattan Beach home for sale',
        source_url: 'https://neighbors.example/manhattan-beach/posts/preparing-to-sell',
        observed_at: CLOCK,
        confidence: 0.93,
        detail: { intent_kind: 'seller_intent', replies: 12, reactions: 6 },
      },
    ],
  },
  {
    entity_kind: 'opportunity',
    identity: {
      name: 'South Bay Home Seller Workshop',
      opportunity_kind: 'event',
      platform: 'Event fixture',
      intent_kind: 'seller_intent',
      audience_description: 'Homeowners seeking education about pricing, preparation, and the local selling process',
      activity_level: 'medium',
      engagement_count: 75,
      access_type: 'ticketed',
      event_start_at: '2026-09-12T17:30:00.000-07:00',
      location: 'Redondo Beach, California',
      country_code: 'US',
      urls: ['https://events.example/south-bay/home-seller-workshop'],
      participation_rules:
        'Registration is required. Contact the organizer before offering a talk, resource, or sponsor contribution.',
      recommended_action:
        'Review the agenda and ask the organizer whether a neutral local-pricing worksheet would be useful to attendees.',
      message_angle:
        'Offer a no-pressure checklist that helps homeowners compare timing, preparation, and pricing tradeoffs.',
      people_to_follow: [
        {
          name: 'Taylor Fixture',
          role: 'Event organizer',
          profile_url: 'https://events.example/organizers/taylor-fixture',
        },
      ],
    },
    evidence: [
      {
        claim:
          'The synthetic event page advertises an upcoming educational workshop for South Bay homeowners considering a sale',
        source_url: 'https://events.example/south-bay/home-seller-workshop',
        observed_at: CLOCK,
        confidence: 0.95,
        detail: { intent_kind: 'seller_intent', registration_count: 75 },
      },
    ],
  },
  {
    entity_kind: 'opportunity',
    identity: {
      name: 'Moving to the South Bay weekly question thread',
      opportunity_kind: 'thread',
      platform: 'Facebook-style fixture',
      intent_kind: 'buyer_intent',
      audience_description: 'People comparing South Bay neighborhoods before a move or home search',
      activity_level: 'high',
      engagement_count: 34,
      access_type: 'approval_required',
      location: 'South Bay, California',
      country_code: 'US',
      urls: ['https://groups.example/south-bay-relocation/weekly-questions'],
      participation_rules:
        'Join approval is required. Agents may answer questions but may not solicit members or collect contact details.',
      recommended_action:
        'Follow the weekly thread and answer a specific neighborhood or process question without requesting private contact.',
      message_angle:
        'Give a concrete comparison framework and state what should be verified with current public sources.',
    },
    evidence: [
      {
        claim:
          'The synthetic group preview shows recurring questions from people planning a move or home search in the South Bay',
        source_url: 'https://groups.example/south-bay-relocation/weekly-questions',
        observed_at: CLOCK,
        confidence: 0.92,
        detail: { intent_kind: 'buyer_intent', comments: 26, reactions: 8 },
      },
    ],
  },
]

function candidatesFor(plan: SourceSearchPlan): Candidate[] {
  return plan.entity_unit.trim().toLowerCase().startsWith('opportun') ? CONSUMER_OPPORTUNITIES : CONSUMER_PEOPLE
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`
}

function hash(plan: SourceSearchPlan): string {
  const { call_sequence: _sequence, ...identity } = plan
  return crypto.createHash('sha256').update(canonical(identity)).digest('hex')
}

function laneOffset(plan: SourceSearchPlan, candidateCount: number): number {
  const providerQuery = plan.provider_query ?? {}
  const laneId = typeof providerQuery.source_query_lane_id === 'string'
    ? providerQuery.source_query_lane_id
    : ''
  const laneNumber = Number.parseInt(laneId.split(':').at(-1) ?? '1', 10)
  if (!Number.isFinite(laneNumber) || laneNumber <= 1 || candidateCount === 0) return 0
  // The fixture has three synthetic query lanes. Partition the stable rows so
  // each lane exercises a different result instead of manufacturing duplicates
  // merely because the provider fixture ignores query semantics.
  return Math.ceil(((laneNumber - 1) * candidateCount) / 3) % candidateCount
}

export const fixtureConsumerSourceAdapter: SourceAdapter = {
  descriptor: fixtureConsumerSourceDescriptor,
  quote(plan) {
    const candidates = candidatesFor(plan)
    const maxCandidates = Math.min(
      fixtureConsumerSourceDescriptor.constraints.max_batch,
      Math.max(0, Math.floor(plan.max_candidates)),
    )
    return {
      max_candidates: maxCandidates,
      provider_units: maxCandidates,
      billable_unit: 'public_profile',
      expected_candidates: {
        low: Math.min(maxCandidates, candidates.length),
        high: Math.min(maxCandidates, candidates.length),
        basis: 'contract',
      },
      quoted_credits_per_unit: 1,
      estimated_credits_before_markup: maxCandidates,
    }
  },
  async search(plan): Promise<AdapterResult<Candidate[]>> {
    const inputHash = hash(plan)
    const rights = adapterAudienceRights(fixtureConsumerSourceDescriptor, 'consumer')
    const coverage = capabilityCovers(fixtureConsumerSourceDescriptor, plan)
    if (!rights.allowed || !coverage.covered) {
      return {
        status: 'error',
        data: null,
        receipt: {
          provider_request_id: `fixture_consumer_${inputHash.slice(0, 16)}`,
          provider_status: 'unsupported',
          input_hash: inputHash.slice(0, 32),
          attempted_at: CLOCK,
        },
        cost_units: 0,
        error: rights.reason ?? coverage.reason ?? 'unsupported consumer fixture request',
      }
    }
    const candidates = candidatesFor(plan)
    const count = Math.max(0, Math.floor(plan.max_candidates))
    const start = laneOffset(plan, candidates.length)
    const data = Array.from({ length: Math.min(count, candidates.length) }, (_, index) =>
      candidates[(start + index) % candidates.length],
    )
    return {
      status: data.length > 0 ? 'ok' : 'no_result',
      data: data.length > 0 ? data : null,
      receipt: {
        provider_request_id: `fixture_consumer_${inputHash.slice(0, 16)}`,
        provider_status: data.length > 0 ? 'completed' : 'no_result',
        input_hash: inputHash.slice(0, 32),
        attempted_at: CLOCK,
      },
      cost_units: data.length,
    }
  },
}
