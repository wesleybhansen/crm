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

const CONSUMER_CANDIDATES: Candidate[] = [
  {
    entity_kind: 'person',
    identity: {
      name: 'Avery Example',
      location: 'Manhattan Beach, California',
      urls: ['https://www.linkedin.com/in/noli-fixture-avery-home-design'],
    },
    evidence: [{
      claim: 'Publicly requested follow-up information at a synthetic neighborhood home-design workshop',
      source_url: 'https://events.example/workshops/home-design/avery-example',
      observed_at: CLOCK,
      confidence: 0.94,
    }],
  },
  {
    entity_kind: 'person',
    identity: {
      name: 'Jordan Fixture',
      location: 'Redondo Beach, California',
      urls: ['https://www.linkedin.com/in/noli-fixture-jordan-open-house-design'],
    },
    evidence: [{
      claim: 'Publicly asked for a local market update after a synthetic community housing seminar',
      source_url: 'https://events.example/seminars/local-market/jordan-fixture',
      observed_at: CLOCK,
      confidence: 0.91,
    }],
  },
]

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

export const fixtureConsumerSourceAdapter: SourceAdapter = {
  descriptor: fixtureConsumerSourceDescriptor,
  quote(plan) {
    const maxCandidates = Math.min(
      fixtureConsumerSourceDescriptor.constraints.max_batch,
      Math.max(0, Math.floor(plan.max_candidates)),
    )
    return {
      max_candidates: maxCandidates,
      provider_units: maxCandidates,
      billable_unit: 'public_profile',
      expected_candidates: {
        low: Math.min(maxCandidates, CONSUMER_CANDIDATES.length),
        high: Math.min(maxCandidates, CONSUMER_CANDIDATES.length),
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
    const data = CONSUMER_CANDIDATES.slice(0, Math.max(0, plan.max_candidates))
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
