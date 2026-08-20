import type { CandidateEvidence } from '../adapters/types'
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
  identity: { name: 'Example Dynamics LLC', domain: 'example-dynamics.example' },
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

  it('rejects a candidate located outside the play geography', () => {
    const abroad = {
      entity_kind: 'company' as const,
      identity: { name: 'Example GmbH', domain: 'example.example', location: 'Berlin, Germany' },
    }
    const result = ruleBasedFitScorer.score(abroad, play, strongEvidence)
    expect(result.verdict).toBe('rejected')
    expect(result.reason).toBe(FIT_REASONS.outsideGeography)
  })

  it('rejects a nameless identity outright', () => {
    const result = ruleBasedFitScorer.score(
      { entity_kind: 'company', identity: { name: '  ' } },
      play,
      strongEvidence,
    )
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
      { candidate: { entity_kind: 'company' as const, identity: { name: 'No Domain Co' } }, evidence: [] as CandidateEvidence[] },
      {
        candidate: { entity_kind: 'person' as const, identity: { name: 'Wrong Kind' } },
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
        identity: { name: 'Example Dynamics LLC', domain: 'example-dynamics.example', location: 'San Diego, CA' },
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
          name: 'Example Software', domain: 'example.example', industry: 'Software Development',
          employee_range: '51 to 200', technologies: ['Salesforce'], location: 'Austin, TX',
        },
      },
      {
        entityUnit: 'companies', geography: 'US', recencyWindow: 'last 30 days',
        referenceTime: '2026-08-02T12:00:00.000Z',
        providerQuery: {
          industries: ['Software Development'], employee_ranges: ['51 to 200'],
          technologies: ['Salesforce'], locations: ['Austin, TX'],
          exclude_industries: ['Consumer gambling'],
        },
      },
      strongEvidence,
    )
    expect(result.verdict).toBe('accepted')
    expect(result.version).toBe('fit-v3')
    expect(result.criteria?.every((row) => row.status === 'pass')).toBe(true)
  })

  it('rejects a provider row that contradicts a hard ICP criterion', () => {
    const result = ruleBasedFitScorer.score(
      {
        entity_kind: 'company',
        identity: { name: 'Example Agency', domain: 'agency.example', industry: 'Advertising' },
      },
      {
        entityUnit: 'companies', geography: 'US',
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

  it('rejects a candidate that matches an explicit exclusion', () => {
    const result = ruleBasedFitScorer.score(
      { entity_kind: 'company', identity: { ...company.identity, industry: 'Consumer gambling' } },
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
      breakdown: { identity: 0, account: 0, persona: 0, geography: 0, evidence: 0 },
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
    expect(summarizeFitResults([])).toEqual({ accepted: 0, review: 0, rejected: 0, byReason: {} })
  })
})

describe('criterion matching is token-based, not substring', () => {
  const evidence = [{
    claim: 'Matched the approved provider targeting filters.',
    source_url: 'https://example.com/p',
    observed_at: '2026-08-01T00:00:00Z',
    confidence: 0.8,
  }]
  const NOW = new Date('2026-08-02T00:00:00Z')
  const base = {
    name: 'Jane Doe', company: 'Acme', title: 'VP of Sales',
    domain: 'acme.com', location: 'Austin, TX',
  }
  const criterion = (
    identity: Record<string, unknown>,
    providerQuery: Record<string, unknown>,
    id: string,
  ) => ruleBasedFitScorer.score(
    { entity_kind: 'person', identity } as never,
    { entityUnit: 'people', geography: 'United States', providerQuery, referenceTime: NOW },
    evidence as never,
  ).criteria?.find((row) => row.id === id)?.status

  it('does not pass a short expected value that merely appears inside a word', () => {
    // "IT" is a substring of "Digital"; "AI" is a substring of "Retail".
    expect(criterion({ ...base, industry: 'Digital Marketing' }, { industries: ['IT'] }, 'account.industry')).toBe('fail')
    expect(criterion({ ...base, industry: 'Retail' }, { industries: ['AI'] }, 'account.industry')).toBe('fail')
  })

  it('still matches a genuine information technology industry', () => {
    expect(criterion({ ...base, industry: 'Information Technology' }, { industries: ['IT'] }, 'account.industry')).toBe('pass')
  })

  it('resolves seniority abbreviations against their spelled-out form', () => {
    expect(criterion({ ...base, title: 'Vice President of Sales' }, { titles: ['VP Sales'] }, 'persona.title')).toBe('pass')
    expect(criterion({ ...base, title: 'VP, Global Sales' }, { titles: ['Vice President Sales'] }, 'persona.title')).toBe('pass')
  })

  it('resolves US state codes against their spelled-out form', () => {
    expect(criterion({ ...base, location: 'Austin, Texas' }, { locations: ['Austin, TX'] }, 'geography.location')).toBe('pass')
    expect(criterion({ ...base, location: 'Austin, TX, US' }, { locations: ['Austin, Texas'] }, 'geography.location')).toBe('pass')
  })

  it('does not treat a different state as a match', () => {
    expect(criterion({ ...base, location: 'Austin, TX' }, { locations: ['Boston, MA'] }, 'geography.location')).toBe('fail')
  })

  it('requires the observed value to contain the expectation, not the reverse', () => {
    // An observed "Engineering" does not prove "Head of Engineering".
    expect(criterion({ ...base, title: 'Engineering' }, { titles: ['Head of Engineering'] }, 'persona.title')).toBe('fail')
    expect(criterion({ ...base, title: 'Head of Engineering, Platform' }, { titles: ['Head of Engineering'] }, 'persona.title')).toBe('pass')
  })
})

describe('signal recency cannot pass without a trustworthy reference time', () => {
  const stale = [{
    claim: 'Matched the approved provider targeting filters.',
    source_url: 'https://example.com/p',
    observed_at: '2020-01-01T00:00:00Z',
    confidence: 0.9,
  }]
  const identity = {
    name: 'Jane Doe', company: 'Acme', title: 'VP of Sales',
    domain: 'acme.com', location: 'Austin, TX',
  }
  const score = (referenceTime?: Date) => ruleBasedFitScorer.score(
    { entity_kind: 'person', identity } as never,
    { entityUnit: 'people', geography: 'United States', providerQuery: {}, recencyWindow: 'last 7 days', ...(referenceTime ? { referenceTime } : {}) },
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
