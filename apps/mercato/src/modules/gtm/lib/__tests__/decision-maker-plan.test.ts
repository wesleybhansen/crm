import { GtmPlay, GtmResearchRun } from '../../data/entities'
import {
  APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
  createApifyCompanyEmployeesAdapter,
} from '../adapters/apify/company-employees'
import {
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
} from '../adapters/apify/source'
import {
  buildDecisionMakerPlan,
  decisionMakerAttemptForCompany,
  hasUnresolvedDecisionMakerOperations,
  processedDecisionMakerCompanyIds,
  recommendedDecisionMakerTitles,
} from '../decision-makers/plan'
import { qualifyDecisionMaker } from '../decision-makers/qualify'

const ENABLED_ENV = {
  GTM_APIFY_ENABLED: 'true',
  GTM_APIFY_TOKEN: 'synthetic-token',
  GTM_APIFY_CUSTOMER_USE_APPROVED: 'true',
  GTM_APIFY_TERMS_VERSION: APIFY_REQUIRED_TERMS_VERSION,
  GTM_APIFY_PRICE_VERSION: APIFY_REQUIRED_PRICE_VERSION,
  GTM_APIFY_COMPANY_EMPLOYEES_PRICE_VERSION:
    APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
}

const run = Object.assign(new GtmResearchRun(), {
  id: '10000000-0000-4000-8000-000000000001',
  playId: '20000000-0000-4000-8000-000000000001',
  workspaceId: '30000000-0000-4000-8000-000000000001',
})
const play = Object.assign(new GtmPlay(), {
  audience: 'Independent dental practices',
  likelyBuyer: 'Practice owner or managing dentist',
})
const companies = [
  {
    candidate_id: '50000000-0000-4000-8000-000000000002',
    match_id: '60000000-0000-4000-8000-000000000002',
    name: 'Second Dental',
    linkedin_url: 'https://www.linkedin.com/company/second-dental/',
    selection_rank: 1,
  },
  {
    candidate_id: '50000000-0000-4000-8000-000000000001',
    match_id: '60000000-0000-4000-8000-000000000001',
    name: 'First Dental',
    linkedin_url: 'https://www.linkedin.com/company/first-dental/',
    selection_rank: 0,
    linkedin_company_ids: ['111111'],
  },
]

describe('decision-maker plan and qualification', () => {
  it('recommends audience-specific owner roles without accepting every practitioner', () => {
    expect(recommendedDecisionMakerTitles(play)).toEqual([
      'Practice Owner', 'Owner', 'Founder', 'Principal Dentist', 'Managing Dentist',
    ])
  })

  it('freezes one deterministic company, roles, descriptor, start, and profile cost into the hash', () => {
    const adapter = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV })
    const first = buildDecisionMakerPlan({ run, play, companies, adapter, maxProfiles: 5 })
    const second = buildDecisionMakerPlan({
      run,
      play,
      companies: [...companies].reverse().map((company) => ({
        ...company,
        linkedin_company_ids: [...(company.linkedin_company_ids ?? [])].reverse(),
      })),
      adapter,
      maxProfiles: 5,
    })
    expect(first.plan_hash).toBe(second.plan_hash)
    expect(first).toEqual(expect.objectContaining({
      schema_version: '4',
      available: true,
      company_count: 1,
      total_company_count: 2,
      processed_company_count: 0,
      remaining_company_count: 2,
      company_position: 1,
      attempt: 1,
      max_profiles: 5,
      provider_units: 50,
      quoted_credits_per_unit: 250,
      maximum_credits: 25_000,
      price_version: APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION,
    }))
    expect(first.companies.map((company) => company.candidate_id)).toEqual([
      '50000000-0000-4000-8000-000000000001',
    ])
  })

  it('continues to the next ranked company only after a settled attributable result', () => {
    const adapter = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV })
    const successfulOperation = {
      localStatusMirror: 'partially_charged',
      settledAt: new Date('2026-08-22T12:00:00.000Z'),
      receipt: {
        decision_maker_plan: {
          schema_version: '3',
          company_candidate_ids: ['50000000-0000-4000-8000-000000000001'],
        },
        gtm_observation: {
          adapter_status: 'partial',
          settlement_pending: false,
        },
      },
    }
    const processed = processedDecisionMakerCompanyIds([successfulOperation])
    expect([...processed]).toEqual(['50000000-0000-4000-8000-000000000001'])
    const plan = buildDecisionMakerPlan({
      run,
      play,
      companies,
      adapter,
      maxProfiles: 3,
      processedCompanyIds: processed,
    })
    expect(plan).toEqual(expect.objectContaining({
      total_company_count: 2,
      processed_company_count: 1,
      remaining_company_count: 1,
      company_position: 2,
    }))
    expect(plan.companies.map((company) => company.candidate_id)).toEqual([
      '50000000-0000-4000-8000-000000000002',
    ])
  })

  it('advances after an operator terminally charges an ambiguous one-company result', () => {
    const processed = processedDecisionMakerCompanyIds([{
      localStatusMirror: 'partially_charged',
      settledAt: '2026-08-22T12:00:00.000Z',
      receipt: {
        decision_maker_plan: {
          schema_version: '4',
          company_candidate_ids: ['50000000-0000-4000-8000-000000000001'],
          attempt: 1,
        },
        gtm_observation: { adapter_status: 'ambiguous', settlement_pending: true },
        operator_reconciliation: { canonical_status: 'partially_charged' },
      },
    }])
    expect([...processed]).toEqual(['50000000-0000-4000-8000-000000000001'])
  })

  it('never advances a terminal-looking operation without durable settlement', () => {
    expect(processedDecisionMakerCompanyIds([{
      localStatusMirror: 'charged',
      settledAt: null,
      receipt: {
        decision_maker_plan: {
          schema_version: '4',
          company_candidate_ids: ['50000000-0000-4000-8000-000000000001'],
        },
      },
    }])).toEqual(new Set())
  })

  it('blocks continuation for unresolved outcomes and advances attempts after a refund', () => {
    const ambiguous = {
      localStatusMirror: 'reconciliation_required',
      receipt: {
        decision_maker_plan: {
          schema_version: '4',
          company_candidate_ids: ['50000000-0000-4000-8000-000000000001'],
          attempt: 1,
        },
        gtm_observation: { adapter_status: 'ambiguous', settlement_pending: false },
      },
    }
    expect(hasUnresolvedDecisionMakerOperations([ambiguous])).toBe(true)
    expect(processedDecisionMakerCompanyIds([ambiguous])).toEqual(new Set())
    const refunded = {
      ...ambiguous,
      localStatusMirror: 'refunded',
      receipt: {
        ...ambiguous.receipt,
        gtm_observation: { adapter_status: 'error', settlement_pending: false },
      },
    }
    expect(hasUnresolvedDecisionMakerOperations([refunded])).toBe(false)
    expect(decisionMakerAttemptForCompany(
      [refunded],
      '50000000-0000-4000-8000-000000000001',
    )).toBe(2)
  })

  it('reports the selected rank when a legacy operation processed a later company', () => {
    const adapter = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV })
    const plan = buildDecisionMakerPlan({
      run,
      play,
      companies,
      adapter,
      processedCompanyIds: ['50000000-0000-4000-8000-000000000002'],
    })
    expect(plan).toEqual(expect.objectContaining({
      processed_company_count: 1,
      remaining_company_count: 1,
      company_position: 1,
    }))
    expect(plan.companies[0]?.candidate_id).toBe('50000000-0000-4000-8000-000000000001')
  })

  it('returns an unavailable completed plan after every eligible company is processed', () => {
    const adapter = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV })
    expect(buildDecisionMakerPlan({
      run,
      play,
      companies,
      adapter,
      processedCompanyIds: companies.map((company) => company.candidate_id),
    })).toEqual(expect.objectContaining({
      available: false,
      company_count: 0,
      processed_company_count: 2,
      remaining_company_count: 0,
      company_position: null,
      maximum_credits: 0,
    }))
  })

  it('changes the immutable hash when company, title, or cap changes', () => {
    const adapter = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV })
    const base = buildDecisionMakerPlan({ run, play, companies, adapter, maxProfiles: 5 })
    const title = buildDecisionMakerPlan({
      run, play, companies, adapter, maxProfiles: 5, jobTitles: ['Managing Partner'],
    })
    const cap = buildDecisionMakerPlan({ run, play, companies, adapter, maxProfiles: 4 })
    const company = buildDecisionMakerPlan({ run, play, companies: companies.slice(0, 1), adapter, maxProfiles: 5 })
    const companyId = buildDecisionMakerPlan({
      run,
      play,
      companies: companies.map((entry) => entry.candidate_id.endsWith('1')
        ? { ...entry, linkedin_company_ids: ['222222'] }
        : entry),
      adapter,
      maxProfiles: 5,
    })
    const retry = buildDecisionMakerPlan({ run, play, companies, adapter, maxProfiles: 5, attempt: 2 })
    expect(new Set([
      base.plan_hash,
      title.plan_hash,
      cap.plan_hash,
      company.plan_hash,
      companyId.plan_hash,
      retry.plan_hash,
    ]).size).toBe(6)
  })

  it('returns an unavailable zero-credit plan when the dedicated price gate is absent', () => {
    const adapter = createApifyCompanyEmployeesAdapter({
      env: { ...ENABLED_ENV, GTM_APIFY_COMPANY_EMPLOYEES_PRICE_VERSION: undefined },
    })
    expect(buildDecisionMakerPlan({ run, play, companies, adapter })).toEqual(expect.objectContaining({
      available: false,
      maximum_credits: 0,
    }))
  })

  it('accepts exact role phrases, rejects misleading junior roles, and reviews uncertainty', () => {
    expect(qualifyDecisionMaker('Co-Founder & Practice Owner', ['Practice Owner', 'Founder'])).toEqual(
      expect.objectContaining({ verdict: 'accepted', matched_title: 'Practice Owner' }),
    )
    expect(qualifyDecisionMaker('Executive Assistant to the CEO', ['CEO'])).toEqual(
      expect.objectContaining({ verdict: 'rejected', matched_title: null }),
    )
    expect(qualifyDecisionMaker('Clinical Director', ['Owner', 'Founder'])).toEqual(
      expect.objectContaining({ verdict: 'review', matched_title: null }),
    )
  })
})
