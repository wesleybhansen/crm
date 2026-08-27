import type { CandidateEvidence, CandidateIdentity } from '../adapters/types'
import {
  FIT_ACCEPT_THRESHOLD,
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
          urls: ['https://community.example/south-bay/first-home-questions'],
          recommended_action: 'Answer one current question helpfully and disclose professional affiliation.',
        },
      },
      {
        entityUnit: 'opportunities',
        geography: 'California, US',
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
    expect(result.version).toBe('fit-v6')
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
