import {
  capabilityCovers,
  type AdapterResult,
  type EnrichRequest,
  type SourceSearchPlan,
  type VerifyRequest,
} from '../adapters/types'
import {
  fixtureSourceAdapter,
  fixtureEnrichAdapter,
  fixtureVerifyAdapter,
  fixtureSourceDescriptor,
  fixtureVerifyDescriptor,
  FIXTURE_RECEIPT_FIELDS,
} from '../adapters/fixture'

const basePlan: SourceSearchPlan = {
  signal_kind: 'hiring_activity',
  entity_unit: 'companies',
  geography: 'US',
  query: 'companies hiring revenue operations leads',
  max_candidates: 5,
}

const baseEnrich: EnrichRequest = {
  signal_kind: 'contact_discovery',
  entity_unit: 'people',
  geography: 'US',
  channel: 'email',
  candidate: {
    entity_kind: 'person',
    identity: { name: 'Alex Example', company: 'Example Dynamics LLC' },
  },
}

const baseVerify: VerifyRequest = {
  signal_kind: 'email_verification',
  entity_unit: 'contacts',
  geography: 'US',
  channel: 'email',
  value: 'alex.example@example-dynamics.example',
}

function expectReceiptContract(result: AdapterResult<unknown>) {
  expect(result.receipt).not.toBeNull()
  for (const field of FIXTURE_RECEIPT_FIELDS) {
    expect(result.receipt).toHaveProperty(field)
  }
}

describe('fixture adapter determinism', () => {
  it('returns byte-identical results for the same source plan', async () => {
    const a = await fixtureSourceAdapter.search({ ...basePlan })
    const b = await fixtureSourceAdapter.search({ ...basePlan })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('returns byte-identical results for the same enrich and verify inputs', async () => {
    expect(JSON.stringify(await fixtureEnrichAdapter.enrich({ ...baseEnrich }))).toBe(
      JSON.stringify(await fixtureEnrichAdapter.enrich({ ...baseEnrich })),
    )
    expect(JSON.stringify(await fixtureVerifyAdapter.verify({ ...baseVerify }))).toBe(
      JSON.stringify(await fixtureVerifyAdapter.verify({ ...baseVerify })),
    )
  })

  it('changes the receipt request id when the input changes', async () => {
    const a = await fixtureSourceAdapter.search(basePlan)
    const b = await fixtureSourceAdapter.search({ ...basePlan, query: 'a different query' })
    expect(a.receipt?.provider_request_id).not.toBe(b.receipt?.provider_request_id)
  })
})

describe('fixture source adapter crafted cases', () => {
  it('returns ok with synthetic company candidates on the normal path', async () => {
    const result = await fixtureSourceAdapter.search(basePlan)
    expect(result.status).toBe('ok')
    expect(result.data!.length).toBeGreaterThan(0)
    for (const candidate of result.data!) {
      expect(candidate.entity_kind).toBe('company')
      expect(candidate.identity.domain).toMatch(/\.example$/)
      expect(candidate.evidence.length).toBeGreaterThan(0)
    }
    expect(result.cost_units).toBe(result.data!.length)
    expectReceiptContract(result)
  })

  it('filters to person candidates for a people entity_unit', async () => {
    const result = await fixtureSourceAdapter.search({ ...basePlan, entity_unit: 'people' })
    expect(result.status).toBe('ok')
    for (const candidate of result.data!) expect(candidate.entity_kind).toBe('person')
  })

  it('classifies no_result with zero cost', async () => {
    const result = await fixtureSourceAdapter.search({ ...basePlan, query: 'fixture-no-result' })
    expect(result.status).toBe('no_result')
    expect(result.data).toBeNull()
    expect(result.cost_units).toBe(0)
    expectReceiptContract(result)
  })

  it('classifies partial with a truncated payload', async () => {
    const result = await fixtureSourceAdapter.search({ ...basePlan, query: 'fixture-partial' })
    expect(result.status).toBe('partial')
    expect(result.data!.length).toBe(1)
    expect(result.receipt?.truncated).toBe(true)
    expectReceiptContract(result)
  })

  it('classifies timeout as ambiguous with unknown cost, per the ambiguity contract', async () => {
    expect(fixtureSourceDescriptor.ambiguity_contract.timeout_is_ambiguous).toBe(true)
    const result = await fixtureSourceAdapter.search({ ...basePlan, query: 'fixture-timeout' })
    expect(result.status).toBe('ambiguous')
    expect(result.data).toBeNull()
    expect(result.cost_units).toBeNull()
    expect(result.error).toContain('timeout')
    expectReceiptContract(result)
  })

  it('classifies invalid_schema, rate_limit, and provider_5xx as errors with zero cost', async () => {
    const cases: Array<[string, string]> = [
      ['fixture-invalid-schema', 'invalid_schema'],
      ['fixture-rate-limit', 'rate_limit'],
      ['fixture-5xx', 'provider_5xx'],
    ]
    for (const [trigger, label] of cases) {
      const result = await fixtureSourceAdapter.search({ ...basePlan, query: trigger })
      expect(result.status).toBe('error')
      expect(result.data).toBeNull()
      expect(result.cost_units).toBe(0)
      expect(result.error).toContain(label)
      expectReceiptContract(result)
    }
  })

  it('models delayed completion: pending on call 1, resolved on call 2, same operation ref', async () => {
    const plan = { ...basePlan, query: 'fixture-delayed' }
    const first = await fixtureSourceAdapter.search({ ...plan, call_sequence: 1 })
    expect(first.status).toBe('ambiguous')
    expect(first.data).toBeNull()
    expect(first.cost_units).toBeNull()
    expect(first.receipt?.pending).toBe(true)

    const second = await fixtureSourceAdapter.search({ ...plan, call_sequence: 2 })
    expect(second.status).toBe('ok')
    expect(second.data!.length).toBeGreaterThan(0)
    expect(second.receipt?.pending).toBe(false)
    // delayed completions settle the SAME operation, never a replacement
    expect(second.receipt?.operation_ref).toBe(first.receipt?.operation_ref)
    expectReceiptContract(first)
    expectReceiptContract(second)
  })

  it('models webhook replay: the same receipt id arrives on both deliveries', async () => {
    const plan = { ...basePlan, query: 'fixture-webhook-replay' }
    const first = await fixtureSourceAdapter.search({ ...plan, call_sequence: 1 })
    const second = await fixtureSourceAdapter.search({ ...plan, call_sequence: 2 })
    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    expect(first.receipt?.receipt_id).toBeDefined()
    expect(second.receipt?.receipt_id).toBe(first.receipt?.receipt_id)
    expect(first.receipt?.delivery_number).toBe(1)
    expect(second.receipt?.delivery_number).toBe(2)
  })

  it('classifies ambiguous acceptance as ambiguous with an unknown acceptance indicator', async () => {
    const result = await fixtureSourceAdapter.search({
      ...basePlan,
      query: 'fixture-ambiguous-acceptance',
    })
    expect(result.status).toBe('ambiguous')
    expect(result.cost_units).toBeNull()
    expect(result.receipt?.acceptance_indicator).toBe('unknown')
    expectReceiptContract(result)
  })
})

describe('fixture enrich and verify adapters', () => {
  it('enriches a known synthetic identity with channel-filtered contact points', async () => {
    const result = await fixtureEnrichAdapter.enrich(baseEnrich)
    expect(result.status).toBe('ok')
    expect(result.data).toEqual([
      expect.objectContaining({ channel: 'email', value: 'alex.example@example-dynamics.example' }),
    ])
    expectReceiptContract(result)
  })

  it('derives a deterministic synthetic email for unknown identities', async () => {
    const request: EnrichRequest = {
      ...baseEnrich,
      candidate: {
        entity_kind: 'person',
        identity: { name: 'Riley Placeholder', domain: 'test-owned-domain.example' },
      },
    }
    const result = await fixtureEnrichAdapter.enrich(request)
    expect(result.status).toBe('ok')
    expect(result.data).toEqual([
      expect.objectContaining({ value: 'riley.placeholder@test-owned-domain.example' }),
    ])
  })

  it('routes enrich trigger tokens in the candidate name through the crafted cases', async () => {
    const result = await fixtureEnrichAdapter.enrich({
      ...baseEnrich,
      candidate: { entity_kind: 'company', identity: { name: 'fixture-timeout Corp' } },
    })
    expect(result.status).toBe('ambiguous')
    expect(result.cost_units).toBeNull()
  })

  it('verifies mapped synthetic addresses to their crafted states', async () => {
    const verified = await fixtureVerifyAdapter.verify(baseVerify)
    expect(verified.status).toBe('ok')
    expect(verified.data?.verification_state).toBe('verified')
    expect(verified.cost_units).toBe(1)

    const risky = await fixtureVerifyAdapter.verify({
      ...baseVerify,
      value: 'jamie.fixture@sample-synthetics.example',
    })
    expect(risky.data?.verification_state).toBe('risky')

    // pay_on_found=false: a definitive not_found still costs the attempt
    const notFound = await fixtureVerifyAdapter.verify({
      ...baseVerify,
      value: 'unknown@test-owned-domain.example',
    })
    expect(notFound.data?.verification_state).toBe('not_found')
    expect(notFound.cost_units).toBe(1)
    expectReceiptContract(verified)
  })
})

describe('capabilityCovers fail-closed plan-time checks', () => {
  it('covers a fully supported request', () => {
    expect(capabilityCovers(fixtureSourceDescriptor, basePlan)).toEqual({ covered: true })
  })

  it('covers hierarchical geographies (US covers US-CA) but never the reverse', () => {
    expect(capabilityCovers(fixtureSourceDescriptor, { ...basePlan, geography: 'US-CA' }).covered).toBe(true)
    expect(capabilityCovers(fixtureVerifyDescriptor, baseVerify).covered).toBe(true)
  })

  it('fails closed on an unsupported signal_kind', () => {
    const coverage = capabilityCovers(fixtureSourceDescriptor, {
      ...basePlan,
      signal_kind: 'website_visits',
    })
    expect(coverage.covered).toBe(false)
    expect(coverage.reason).toContain('unsupported signal_kind')
  })

  it('fails closed on an unsupported geography', () => {
    const coverage = capabilityCovers(fixtureSourceDescriptor, { ...basePlan, geography: 'DE' })
    expect(coverage.covered).toBe(false)
    expect(coverage.reason).toContain('unsupported geography')
  })

  it('fails closed on an unsupported entity_unit', () => {
    const coverage = capabilityCovers(fixtureSourceDescriptor, {
      ...basePlan,
      signal_kind: 'funding_event',
      entity_unit: 'people',
    })
    expect(coverage.covered).toBe(false)
    expect(coverage.reason).toContain('unsupported entity_unit')
  })

  it('fails closed on missing dimensions instead of assuming coverage', () => {
    expect(capabilityCovers(fixtureSourceDescriptor, {}).covered).toBe(false)
    expect(capabilityCovers(fixtureSourceDescriptor, { signal_kind: 'hiring_activity' }).covered).toBe(false)
    // verify-layer adapters additionally require a channel
    const noChannel = capabilityCovers(fixtureVerifyDescriptor, {
      signal_kind: 'email_verification',
      entity_unit: 'contacts',
      geography: 'US',
    })
    expect(noChannel.covered).toBe(false)
    expect(noChannel.reason).toContain('channel')
  })

  it('fails closed on an unsupported channel', () => {
    const coverage = capabilityCovers(fixtureVerifyDescriptor, { ...baseVerify, channel: 'linkedin' })
    expect(coverage.covered).toBe(false)
    expect(coverage.reason).toContain('unsupported channel')
  })

  it('is re-checked inside the invoke path: an uncovered direct call cannot run', async () => {
    const result = await fixtureSourceAdapter.search({
      ...basePlan,
      signal_kind: 'website_visits',
    })
    expect(result.status).toBe('error')
    expect(result.data).toBeNull()
    expect(result.cost_units).toBe(0)
    expect(result.error).toContain('unsupported_capability')
    expectReceiptContract(result)
  })
})
