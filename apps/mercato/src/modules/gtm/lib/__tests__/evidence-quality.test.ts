import { fixtureSourceDescriptor } from '../adapters/fixture'
import { assessEvidence } from '../research/evidence-quality'

const now = new Date('2026-08-02T12:00:00.000Z')

describe('provider evidence quality gate', () => {
  it('accepts fresh, source-anchored evidence', () => {
    const result = assessEvidence(
      [{
        claim: 'Example Co is hiring a revenue operations lead.',
        source_url: 'https://jobs.example.test/revops',
        observed_at: '2026-08-01T12:00:00.000Z',
        confidence: 0.9,
        // The platform publication time proves freshness; observed_at alone
        // (retrieval time) cannot, see the test below.
        detail: { published_at: '2026-07-30T12:00:00.000Z' },
      }],
      fixtureSourceDescriptor.evidence_policy,
      now,
    )
    expect(result.status).toBe('strong')
    expect(result.validEvidence).toHaveLength(1)
    expect(result.issues).toEqual([])
  })

  it('flags evidence with no platform publication time instead of presenting retrieval time as freshness (H7)', () => {
    const result = assessEvidence(
      [{
        claim: 'Example Co is hiring a revenue operations lead.',
        source_url: 'https://jobs.example.test/revops',
        observed_at: '2026-08-01T12:00:00.000Z',
        confidence: 0.9,
      }],
      fixtureSourceDescriptor.evidence_policy,
      now,
    )
    expect(result.validEvidence).toHaveLength(1)
    expect(result.issues).toEqual(['publication_time_unknown'])
    expect(result.issues).not.toContain('stale_evidence')
  })

  it('ages evidence by its platform publication time, not by when Noli fetched it (H7)', () => {
    const result = assessEvidence(
      [{
        claim: 'Two-year-old post fetched today',
        source_url: 'https://jobs.example.test/old-post',
        observed_at: '2026-08-02T11:00:00.000Z',
        confidence: 0.9,
        detail: { published_at: '2024-03-01T00:00:00.000Z' },
      }],
      fixtureSourceDescriptor.evidence_policy,
      now,
    )
    expect(result.issues).toContain('stale_evidence')
    expect(result.status).toBe('weak')
  })

  it('fails closed when required provenance is missing', () => {
    const result = assessEvidence(
      [{
        claim: 'Unanchored provider assertion',
        source_url: null,
        observed_at: '2026-08-01T12:00:00.000Z',
        confidence: 0.9,
      }],
      fixtureSourceDescriptor.evidence_policy,
      now,
    )
    expect(result.status).toBe('invalid')
    expect(result.validEvidence).toEqual([])
    expect(result.issues).toContain('missing_source_url')
  })

  it('marks old observations weak instead of presenting them as current', () => {
    const result = assessEvidence(
      [{
        claim: 'Historic job posting',
        source_url: 'https://jobs.example.test/old',
        observed_at: '2024-01-01T00:00:00.000Z',
        confidence: 0.8,
      }],
      fixtureSourceDescriptor.evidence_policy,
      now,
    )
    expect(result.status).toBe('weak')
    expect(result.issues).toContain('stale_evidence')
  })
})
