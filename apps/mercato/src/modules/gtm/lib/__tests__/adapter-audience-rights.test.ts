import {
  adapterAudienceRights,
  testOnlyLicensesPermitted,
  type AdapterDescriptor,
} from '../adapters/types'

/*
 * Direct coverage of adapterAudienceRights (review 2026-09-02, T4). Every
 * branch is reached here so a descriptor cannot satisfy a rights gate with a
 * constant nobody reviewed.
 */

function descriptor(overrides: {
  license?: Partial<AdapterDescriptor['constraints']['license']>
  dsr?: Partial<AdapterDescriptor['dsr']>
} = {}): AdapterDescriptor {
  return {
    contract_version: '2',
    adapter_id: 'rights-test',
    layer: 'source',
    capabilities: [{ signal_kind: 'x', entity_units: ['people'], geographies: ['US'], channels: [] }],
    constraints: {
      license: {
        status: 'approved',
        terms_version: 'terms-1',
        export: true,
        customer_display: true,
        outreach_allowed: true,
        retention_days: 30,
        audience_modes: ['business', 'consumer'],
        manual_outreach_allowed: true,
        automated_email_allowed: false,
        public_profile_contact_allowed: true,
        public_opportunity_use_allowed: true,
        ...overrides.license,
      },
      max_batch: 10,
    },
    cost_model: { unit: 'u', quoted_credits_per_unit: 1, price_version: 'p', pay_on_found: false },
    evidence_policy: { source_url: 'required', observed_at: 'required', max_age_days: 30, min_confidence: 0.5 },
    ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: [] },
    dsr: { deletion_supported: true, ...overrides.dsr },
  }
}

describe('adapterAudienceRights', () => {
  const savedNodeEnv = process.env.NODE_ENV
  const savedTestMode = process.env.OM_TEST_MODE
  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv
    if (savedTestMode === undefined) delete process.env.OM_TEST_MODE
    else process.env.OM_TEST_MODE = savedTestMode
  })

  it('refuses provisional and blocked licenses for every audience', () => {
    for (const status of ['provisional', 'blocked'] as const) {
      expect(adapterAudienceRights(descriptor({ license: { status } }), 'business').allowed).toBe(false)
      expect(adapterAudienceRights(descriptor({ license: { status } }), 'consumer').allowed).toBe(false)
    }
  })

  it('refuses incomplete display or export rights', () => {
    expect(adapterAudienceRights(descriptor({ license: { terms_version: '' } }), 'business').allowed).toBe(false)
    expect(adapterAudienceRights(descriptor({ license: { export: false } }), 'business').allowed).toBe(false)
    expect(adapterAudienceRights(descriptor({ license: { customer_display: false } }), 'consumer').allowed).toBe(false)
  })

  it('business use needs a business audience mode (legacy missing = business) and outreach rights', () => {
    expect(adapterAudienceRights(descriptor(), 'business')).toEqual({ allowed: true })
    expect(adapterAudienceRights(descriptor({ license: { audience_modes: undefined } }), 'business').allowed).toBe(true)
    expect(adapterAudienceRights(descriptor({ license: { audience_modes: ['consumer'] } }), 'business').allowed).toBe(false)
    expect(adapterAudienceRights(descriptor({ license: { outreach_allowed: false } }), 'business').allowed).toBe(false)
  })

  it('consumer use is never inferred: every SPEC-069 right must be explicit', () => {
    expect(adapterAudienceRights(descriptor(), 'consumer', 'person')).toEqual({ allowed: true })
    expect(adapterAudienceRights(descriptor({ license: { audience_modes: undefined } }), 'consumer').allowed).toBe(false)
    expect(adapterAudienceRights(descriptor({ license: { audience_modes: ['business'] } }), 'consumer').allowed).toBe(false)
    expect(adapterAudienceRights(descriptor({ license: { manual_outreach_allowed: false } }), 'consumer').allowed).toBe(false)
    expect(adapterAudienceRights(descriptor({ license: { retention_days: null } }), 'consumer').allowed).toBe(false)
    // a paper deletion flag is the only thing standing between a consumer
    // record and a DSR the provider cannot honour (H3)
    expect(adapterAudienceRights(descriptor({ dsr: { deletion_supported: false } }), 'consumer').allowed).toBe(false)
  })

  it('splits opportunity rights from profile-contact rights by entity kind', () => {
    const noProfile = descriptor({ license: { public_profile_contact_allowed: false } })
    expect(adapterAudienceRights(noProfile, 'consumer', 'opportunity').allowed).toBe(true)
    expect(adapterAudienceRights(noProfile, 'consumer', 'person').allowed).toBe(false)
    expect(adapterAudienceRights(noProfile, 'consumer', 'company').allowed).toBe(false)
    expect(adapterAudienceRights(noProfile, 'consumer').allowed).toBe(false)
    const noOpportunity = descriptor({ license: { public_opportunity_use_allowed: false } })
    expect(adapterAudienceRights(noOpportunity, 'consumer', 'opportunity').allowed).toBe(false)
    expect(adapterAudienceRights(noOpportunity, 'consumer', 'person').allowed).toBe(true)
  })

  // Review 2026-09-02 (L2/H14): test_only used to be accepted as
  // customer-serving in every environment.
  it('accepts test_only only where fixtures may run', () => {
    const fixture = descriptor({ license: { status: 'test_only' } })
    process.env.NODE_ENV = 'test'
    expect(adapterAudienceRights(fixture, 'business')).toEqual({ allowed: true })
    process.env.NODE_ENV = 'development'
    expect(adapterAudienceRights(fixture, 'business').allowed).toBe(true)
    process.env.NODE_ENV = 'production'
    delete process.env.OM_TEST_MODE
    expect(adapterAudienceRights(fixture, 'business')).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringContaining('test_only') }),
    )
    expect(adapterAudienceRights(fixture, 'consumer', 'person').allowed).toBe(false)
    process.env.OM_TEST_MODE = '1'
    expect(adapterAudienceRights(fixture, 'business').allowed).toBe(true)
    // an unset NODE_ENV is treated like production
    delete process.env.OM_TEST_MODE
    expect(testOnlyLicensesPermitted({})).toBe(false)
    expect(testOnlyLicensesPermitted({ NODE_ENV: 'staging' })).toBe(false)
    expect(testOnlyLicensesPermitted({ OM_TEST_MODE: '1' })).toBe(true)
  })
})
