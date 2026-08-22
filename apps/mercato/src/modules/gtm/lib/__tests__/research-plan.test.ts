import { fixtureSourceAdapter, fixtureSourceDescriptor } from '../adapters/fixture'
import type { SourceAdapter } from '../adapters/types'
import {
  APIFY_COMPANY_REQUIRED_PRICE_VERSION,
  APIFY_COMPANY_PRICE_VERSION_ENV,
  createApifyCompanySourceAdapter,
} from '../adapters/apify/company-source'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
} from '../adapters/apify/source'
import {
  buildSourcePlan,
  DEFAULT_MAX_CANDIDATES,
  MAX_CANDIDATES_HARD_CAP,
  type PlanPlayInput,
} from '../research/plan'

const executablePlay: PlanPlayInput = {
  marketType: 'b2b',
  geography: 'California, US',
  signal: 'hiring_activity',
  entityUnit: 'companies',
  audience: 'B2B companies hiring revenue operations leads',
}

const adapters: SourceAdapter[] = [fixtureSourceAdapter]

const approvedCompanySource = createApifyCompanySourceAdapter({
  env: {
    GTM_APIFY_ENABLED: 'true',
    GTM_APIFY_TOKEN: 'synthetic-planning-only-token',
    GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
    GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
    GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
    [APIFY_COMPANY_PRICE_VERSION_ENV]: APIFY_COMPANY_REQUIRED_PRICE_VERSION,
  },
})

describe('buildSourcePlan fail-closed boundaries', () => {
  it('fails closed on a strategy_only play (section 7 ladder boundary 1)', () => {
    const plan = buildSourcePlan({ ...executablePlay, marketType: 'b2c' }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('play_not_executable')
      expect(plan.reason).toContain('strategy guidance only')
    }
  })

  it('recomputes eligibility from the play fields, never trusting a stored value', () => {
    // Non-US geography must fail even if a caller claimed the play executable.
    const plan = buildSourcePlan({ ...executablePlay, geography: 'Berlin, Germany' }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('play_not_executable')
  })

  it('fails closed on an unsupported signal with an empty adapter plan', () => {
    const plan = buildSourcePlan({ ...executablePlay, signal: 'website_visits' }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('empty_adapter_plan')
      expect(plan.unsupportedDimensions).toEqual([
        expect.objectContaining({
          adapter_id: 'fixture-source',
          dimension: 'signal_kind',
        }),
      ])
    }
  })

  it('fails closed when the play is missing sourcing dimensions', () => {
    const plan = buildSourcePlan({ ...executablePlay, signal: null }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('missing_play_dimensions')
  })

  it('never silently plans with zero adapters', () => {
    const plan = buildSourcePlan(executablePlay, [])
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('empty_adapter_plan')
  })
})

describe('buildSourcePlan pricing and limits', () => {
  it('freezes a firmographic company-source quote including the actor-start event', () => {
    const play: PlanPlayInput = {
      marketType: 'b2b',
      geography: 'San Diego, California, US',
      signal: 'firmographic_match',
      signalKind: 'firmographic_match',
      entityUnit: 'companies',
      audience: 'Independent dental practices with 1-50 employees',
      providerQuery: {
        company_keywords: ['dental practice'],
        industries: ['Dentistry'],
        employee_ranges: ['1-10', '11-50'],
        locations: ['San Diego, California'],
      },
    }
    const plan = buildSourcePlan(play, [approvedCompanySource], {
      targetAccepted: 5,
      maxRawCandidates: 10,
    }, 2)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.adapterPlan).toEqual([
        expect.objectContaining({
          adapter_id: 'apify-linkedin-company-search',
          providerUnits: 10.25,
          billableUnit: 'full_company',
          maxCandidates: 10,
          estimatedCredits: 20_500,
          priceVersion: APIFY_COMPANY_REQUIRED_PRICE_VERSION,
          providerQuery: play.providerQuery,
        }),
      ])
      expect(plan.estimatedCredits).toBe(20_500)
      expect(plan.limits.maxCredits).toBe(20_500)
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('pursues 25 accepted leads under a separate 100-row raw ceiling', () => {
    const plan = buildSourcePlan(executablePlay, adapters, null, 2)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(DEFAULT_MAX_CANDIDATES).toBe(25)
      expect(plan.limits).toEqual(expect.objectContaining({
        targetAccepted: 25,
        maxRawCandidates: 100,
        maxCandidates: 100,
      }))
      expect(plan.adapterPlan).toEqual([
        expect.objectContaining({
          adapter_id: 'fixture-source',
          estimatedUnits: 25,
          quotedCreditsPerUnit: 1,
          estimatedCredits: 50,
        }),
      ])
      expect(plan.estimatedCredits).toBe(50)
      // maxCredits defaults to the plan estimate: the run can never reserve
      // beyond what was priced
      expect(plan.limits.maxCredits).toBe(50)
      expect(plan.query).toContain('revenue operations')
    }
  })

  it('caps maxCandidates at the hard cap of 100', () => {
    const plan = buildSourcePlan(executablePlay, adapters, { maxCandidates: 500 }, 2)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(MAX_CANDIDATES_HARD_CAP).toBe(100)
      expect(plan.limits.maxCandidates).toBe(100)
      // one adapter with max_batch 25 can only take one 25-unit batch
      expect(plan.adapterPlan[0].estimatedUnits).toBe(fixtureSourceDescriptor.constraints.max_batch)
    }
  })

  it('respects an explicit maxCredits limit', () => {
    const plan = buildSourcePlan(executablePlay, adapters, { maxCandidates: 10, maxCredits: 12 }, 2)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.limits).toEqual({
        targetAccepted: 10,
        maxRawCandidates: 10,
        maxCandidates: 10,
        maxCredits: 12,
      })
      expect(plan.estimatedCredits).toBe(20)
    }
  })

  it('allocates remaining candidates across additional covering adapters', () => {
    const secondAdapter: SourceAdapter = {
      descriptor: { ...fixtureSourceDescriptor, adapter_id: 'fixture-source-b' },
      quote: fixtureSourceAdapter.quote,
      search: fixtureSourceAdapter.search,
    }
    const plan = buildSourcePlan(executablePlay, [fixtureSourceAdapter, secondAdapter], {
      maxCandidates: 30,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.adapterPlan.map((batch) => [batch.adapter_id, batch.estimatedUnits])).toEqual([
        ['fixture-source', 15],
        ['fixture-source-b', 15],
      ])
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.schemaVersion).toBe('7')
    }
  })

  it('quotes bounded deterministic offset pages when one source needs continuation', () => {
    const paginated: SourceAdapter = {
      descriptor: {
        ...fixtureSourceDescriptor,
        adapter_id: 'fixture-paginated',
        constraints: {
          ...fixtureSourceDescriptor.constraints,
          max_batch: 25,
          pagination: { mode: 'offset', page_size: 25, max_pages: 2 },
        },
      },
      quote: fixtureSourceAdapter.quote,
      search: fixtureSourceAdapter.search,
    }
    const plan = buildSourcePlan(executablePlay, [paginated], {
      targetAccepted: 10,
      maxRawCandidates: 50,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.adapterPlan.map((batch) => ({
        units: batch.maxCandidates,
        page: batch.continuationPage,
        offset: batch.continuationOffset,
      }))).toEqual([
        { units: 25, page: 1, offset: 0 },
        { units: 25, page: 2, offset: 25 },
      ])
      expect(plan.plannedRawCapacity).toBe(50)
    }
  })

  it('changes the immutable hash when price or reviewed terms change', () => {
    const baseline = buildSourcePlan(executablePlay, adapters)
    const changed: SourceAdapter = {
      descriptor: {
        ...fixtureSourceDescriptor,
        cost_model: {
          ...fixtureSourceDescriptor.cost_model,
          price_version: 'fixture-v-next',
        },
      },
      quote: fixtureSourceAdapter.quote,
      search: fixtureSourceAdapter.search,
    }
    const repriced = buildSourcePlan(executablePlay, [changed])
    expect(baseline.ok && repriced.ok).toBe(true)
    if (baseline.ok && repriced.ok) expect(repriced.planHash).not.toBe(baseline.planHash)
  })

  it('binds exact geography and canonical entity kind into the priced hash', () => {
    const california = buildSourcePlan(executablePlay, adapters)
    const texas = buildSourcePlan({ ...executablePlay, geography: 'Texas, US' }, adapters)
    expect(california.ok && texas.ok).toBe(true)
    if (california.ok && texas.ok) {
      expect(california.geography).toBe('California, US')
      expect(california.entityKind).toBe('company')
      expect(california.adapterPlan[0].capability.entity_kind).toBe('company')
      expect(texas.planHash).not.toBe(california.planHash)
    }
  })

  it('fails closed on an unknown entity-unit vocabulary', () => {
    const plan = buildSourcePlan({ ...executablePlay, entityUnit: 'mystery_rows' }, adapters)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('missing_play_dimensions')
  })

  it('freezes explicit accepted and raw targets plus the qualification profile', () => {
    const plan = buildSourcePlan({
      ...executablePlay,
      providerQuery: {
        industries: ['Software'],
        company_keywords: ['revenue operations'],
        exclude_industries: ['Consumer gambling'],
      },
      recencyWindow: 'last 30 days',
    }, adapters, { targetAccepted: 12, maxRawCandidates: 60 })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.limits).toEqual(expect.objectContaining({
        targetAccepted: 12, maxRawCandidates: 60, maxCandidates: 60,
      }))
      expect(plan.qualificationProfile.criteria.map((row) => row.id)).toEqual(expect.arrayContaining([
        'account.industry', 'account.keywords', 'exclusion.industry', 'signal.recency',
      ]))
      expect(plan.adapterPlan[0]).toEqual(expect.objectContaining({
        adaptiveOrder: 1, stopWhenTargetAccepted: true,
      }))
    }
  })

  it('hashes distinct Unicode keys independently of insertion order', () => {
    const first = buildSourcePlan({
      ...executablePlay,
      providerQuery: { '\u00e9': ['one'], 'e\u0301': ['two'] },
    }, adapters)
    const second = buildSourcePlan({
      ...executablePlay,
      providerQuery: { 'e\u0301': ['two'], '\u00e9': ['one'] },
    }, adapters)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(first.planHash).toBe(second.planHash)
  })

  it('does not plan a provider whose customer-use rights are provisional', () => {
    const provisional: SourceAdapter = {
      descriptor: {
        ...fixtureSourceDescriptor,
        constraints: {
          ...fixtureSourceDescriptor.constraints,
          license: {
            ...fixtureSourceDescriptor.constraints.license,
            status: 'provisional',
          },
        },
      },
      quote: fixtureSourceAdapter.quote,
      search: fixtureSourceAdapter.search,
    }
    const plan = buildSourcePlan(executablePlay, [provisional])
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.unsupportedDimensions[0]?.dimension).toBe('license')
  })
})
