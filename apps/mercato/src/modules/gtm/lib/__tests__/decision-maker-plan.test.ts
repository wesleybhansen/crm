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
  },
  {
    candidate_id: '50000000-0000-4000-8000-000000000001',
    match_id: '60000000-0000-4000-8000-000000000001',
    name: 'First Dental',
    linkedin_url: 'https://www.linkedin.com/company/first-dental/',
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
      companies: [...companies].reverse(),
      adapter,
      maxProfiles: 5,
    })
    expect(first.plan_hash).toBe(second.plan_hash)
    expect(first).toEqual(expect.objectContaining({
      schema_version: '2',
      available: true,
      company_count: 1,
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

  it('changes the immutable hash when company, title, or cap changes', () => {
    const adapter = createApifyCompanyEmployeesAdapter({ env: ENABLED_ENV })
    const base = buildDecisionMakerPlan({ run, play, companies, adapter, maxProfiles: 5 })
    const title = buildDecisionMakerPlan({
      run, play, companies, adapter, maxProfiles: 5, jobTitles: ['Managing Partner'],
    })
    const cap = buildDecisionMakerPlan({ run, play, companies, adapter, maxProfiles: 4 })
    const company = buildDecisionMakerPlan({ run, play, companies: companies.slice(0, 1), adapter, maxProfiles: 5 })
    expect(new Set([base.plan_hash, title.plan_hash, cap.plan_hash, company.plan_hash]).size).toBe(4)
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
