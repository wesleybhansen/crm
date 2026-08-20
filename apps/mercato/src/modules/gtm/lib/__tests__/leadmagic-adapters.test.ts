import {
  createLeadMagicSourceAdapter,
  leadMagicEnabled,
} from '../adapters/leadmagic/source'
import { createLeadMagicEnrichAdapter } from '../adapters/leadmagic/enrich'

const approvedEnv = {
  GTM_LEADMAGIC_ENABLED: 'true',
  GTM_LEADMAGIC_API_KEY: 'test-key',
  GTM_LEADMAGIC_CUSTOMER_USE_APPROVED: 'true',
  GTM_LEADMAGIC_TERMS_VERSION: 'reviewed-2026-08-02',
  GTM_LEADMAGIC_PRICE_VERSION: 'basic-2026-08-02',
}

describe('LeadMagic provider adapters', () => {
  it('never asks for separately billable contact fields and never exceeds the reserved page', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      credits_consumed: 0, people: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const adapter = createLeadMagicSourceAdapter({ env: approvedEnv, fetchImpl })
    await adapter.search({
      signal_kind: 'firmographic_match',
      entity_unit: 'people',
      geography: 'US',
      query: 'revenue leaders',
      // A caller asking past the 50-row page must not widen the request past
      // the units the ledger reserved.
      max_candidates: 500,
    })
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body)
    expect(body.limit).toBe(50)
    // A returned email costs 1 extra credit and a mobile 5, which would break
    // the credits_consumed === returned people invariant after being charged.
    expect(body.include_contact_details).toBe(false)
    expect(body.include_email).toBe(false)
    expect(body.include_mobile).toBe(false)
  })

  it('sends only the frozen non-negative continuation offset', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      credits_consumed: 0, people: [],
    }), { status: 200 }))
    const adapter = createLeadMagicSourceAdapter({ env: approvedEnv, fetchImpl })
    await adapter.search({
      signal_kind: 'firmographic_match',
      entity_unit: 'people',
      geography: 'US',
      query: 'revenue leaders',
      max_candidates: 50,
      offset: 50,
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body).toEqual(expect.objectContaining({ limit: 50, offset: 50 }))
    expect(body).not.toHaveProperty('cursor')
  })

  it('reads the prefixed company field spellings so enrichment is not blocked', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      credits_consumed: 1,
      people: [{
        contact_full_name: 'Dana Reed',
        contact_job_title: 'VP of Operations',
        contact_linkedin_url: 'https://www.linkedin.com/in/dana-reed',
        company: { company_name: 'Northwind Freight', company_domain: 'northwind.example' },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const adapter = createLeadMagicSourceAdapter({ env: approvedEnv, fetchImpl })
    const result = await adapter.search({
      signal_kind: 'firmographic_match',
      entity_unit: 'people',
      geography: 'US',
      query: 'operations leaders',
      max_candidates: 5,
    })
    expect(result.status).toBe('ok')
    // A null domain/company here makes the email-finder reject the candidate
    // with bad_request before the waterfall ever calls the provider.
    expect(result.data?.[0].identity.domain).toBe('northwind.example')
    expect(result.data?.[0].identity.company).toBe('Northwind Freight')
  })

  it('requires explicit customer-use approval in addition to a key', () => {
    expect(leadMagicEnabled({
      GTM_LEADMAGIC_ENABLED: 'true',
      GTM_LEADMAGIC_API_KEY: 'test-key',
    })).toBe(false)
  })

  it('quotes returned people separately from the candidate cap', () => {
    const adapter = createLeadMagicSourceAdapter({ env: approvedEnv })
    const quote = adapter.quote({
      signal_kind: 'firmographic_match',
      entity_unit: 'people',
      geography: 'US',
      query: 'revenue leaders',
      max_candidates: 25,
    })
    expect(quote).toEqual(expect.objectContaining({
      max_candidates: 25,
      provider_units: 25,
      billable_unit: 'returned_person',
    }))
  })

  it('normalizes discovery without leaking contact data into the source stage', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      people: [{
        id: 'p-1',
        contact_full_name: 'Taylor Example',
        contact_job_title: 'VP Revenue',
        contact_job_level: 'VP',
        contact_job_function: 'Sales & Business Development',
        contact_linkedin_url: 'https://www.linkedin.com/in/taylor-example',
        contact_company_name: 'Example Inc',
        company_domain: 'example.test',
        contact_email: 'must-not-appear@example.test',
      }],
      returned_count: 1,
      limit_applied: 10,
      credits_consumed: 1,
    }), { status: 200, headers: { 'x-request-id': 'req-1' } })) as unknown as typeof fetch
    const adapter = createLeadMagicSourceAdapter({
      env: approvedEnv,
      fetchImpl,
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })
    const result = await adapter.search({
      signal_kind: 'firmographic_match', entity_unit: 'people', geography: 'US',
      query: 'VP Revenue', max_candidates: 10,
      provider_query: { titles: ['VP Revenue'] },
    })
    expect(result.status).toBe('ok')
    expect(result.cost_units).toBe(1)
    expect(JSON.stringify(result.data)).not.toContain('must-not-appear')
    expect(result.data?.[0].evidence[0].source_url).toContain('linkedin.com/in/')
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body).toEqual(expect.objectContaining({
      titles: ['VP Revenue'],
      include_contact_details: false,
      company_filters: expect.objectContaining({ country_codes: ['US'] }),
      people_filters: expect.objectContaining({ contact_country_code: ['US'] }),
    }))
  })

  it('uses documented V3 filter names and authoritative billing units', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      people: [{
        contact_full_name: 'Usable Person',
        contact_linkedin_url: 'https://www.linkedin.com/in/usable-person',
        contact_company_name: 'Example Inc',
        company_domain: 'example.test',
      }, {
        contact_job_title: 'Missing Name',
      }],
      credits_consumed: 2,
    }), { status: 200 })) as unknown as typeof fetch
    const adapter = createLeadMagicSourceAdapter({ env: approvedEnv, fetchImpl })
    const result = await adapter.search({
      signal_kind: 'technology_usage', entity_unit: 'people', geography: 'US',
      query: 'Sales leaders', max_candidates: 10,
      provider_query: {
        company_keywords: ['B2B SaaS'], technologies: ['Salesforce'],
        titles: ['VP Sales'], roles: ['Revenue leader'], seniorities: ['VP'],
        departments: ['Sales'], locations: ['Austin, TX'],
      },
    })
    expect(result.status).toBe('partial')
    expect(result.cost_units).toBe(2)
    expect(result.receipt).toEqual(expect.objectContaining({
      credits_consumed: 2, returned_people: 2, normalized_people: 1,
    }))
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body).toEqual(expect.objectContaining({
      titles: ['VP Sales'], roles: ['Revenue leader'],
      company_filters: expect.objectContaining({ keyword: 'B2B SaaS', tech_stack: ['Salesforce'] }),
      people_filters: expect.objectContaining({
        contact_job_level: ['VP'], contact_job_function: ['Sales'], location: ['Austin, TX'],
      }),
    }))
    expect(body.company_filters).not.toHaveProperty('keywords')
    expect(body.people_filters).not.toHaveProperty('seniorities')
  })

  it('parks transport failures because provider billing is unknowable after dispatch', async () => {
    const adapter = createLeadMagicSourceAdapter({
      env: approvedEnv,
      fetchImpl: jest.fn().mockRejectedValue(new TypeError('connection reset')) as unknown as typeof fetch,
    })
    const result = await adapter.search({
      signal_kind: 'firmographic_match', entity_unit: 'people', geography: 'US',
      query: 'leaders', max_candidates: 10,
      provider_query: { company_keywords: ['software'] },
    })
    expect(result).toEqual(expect.objectContaining({ status: 'ambiguous', cost_units: null }))
  })

  it('charges email enrichment only when a work email is found', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      email: 'taylor@example.test', status: 'valid', credits_consumed: 1,
    }), { status: 200 })) as unknown as typeof fetch
    const adapter = createLeadMagicEnrichAdapter({ env: approvedEnv, fetchImpl })
    const result = await adapter.enrich({
      signal_kind: 'contact_discovery', entity_unit: 'people', geography: 'US', channel: 'email',
      candidate: {
        entity_kind: 'person',
        identity: { name: 'Taylor Example', domain: 'example.test' },
      },
    })
    expect(result.status).toBe('ok')
    expect(result.cost_units).toBe(1)
    expect(result.data?.[0]).toEqual(expect.objectContaining({
      channel: 'email', value: 'taylor@example.test',
    }))
  })

  it('sends company_name when email enrichment has no domain', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      email: null, credits_consumed: 0,
    }), { status: 200 })) as unknown as typeof fetch
    const adapter = createLeadMagicEnrichAdapter({ env: approvedEnv, fetchImpl })
    await adapter.enrich({
      signal_kind: 'contact_discovery', entity_unit: 'people', geography: 'US', channel: 'email',
      candidate: { entity_kind: 'person', identity: { name: 'Taylor Example', company: 'Example Inc' } },
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      full_name: 'Taylor Example', company_name: 'Example Inc',
    })
  })
})
