import { fixtureSourceAdapter } from '../adapters/fixture'
import { ruleBasedFitScorer } from '../research/qualify'

/*
 * Mirrors TC-GTM-001 / TC-GTM-003 (the ephemeral integration rehearsal): a
 * synthetic B2B people play sourced through the deterministic fixture adapter
 * must still produce at least one ACCEPTED row after every qualifier change,
 * or the customer flow (research -> enrich -> campaign) has no rows to work
 * with. Listing-type observations are current by construction, so the
 * absence of a platform publication time must not park them in review.
 */
const play = {
  marketType: 'b2b',
  audience: 'Synthetic US operations leaders',
  signal: 'Synthetic operations hiring activity',
  signalKind: 'hiring_activity',
  entityUnit: 'people',
  geography: 'United States',
  recencyWindow: '90 days',
  providerQuery: { titles: ['Head of Operations'] },
  // execute.ts passes the run's qualification reference time; without it
  // every age is unknowable and the recency criterion cannot pass.
  referenceTime: new Date(),
}

describe('fixture-sourced B2B people reach accepted', () => {
  it('accepts at least one deterministic fixture person for the rehearsal play', async () => {
    const result = await fixtureSourceAdapter.search({
      signal_kind: 'hiring_activity',
      entity_unit: 'people',
      geography: 'US',
      query: 'Synthetic US operations leaders Synthetic operations hiring activity United States',
      provider_query: play.providerQuery,
      max_candidates: 2,
    })
    expect(result.status === 'ok' || result.status === 'partial').toBe(true)
    const verdicts = (result.data ?? []).map((candidate) => {
      const fit = ruleBasedFitScorer.score(candidate, play, candidate.evidence)
      return { verdict: fit.verdict, reason: fit.reason, criteria: fit.criteria.map((row) => `${row.id}:${row.status}`) }
    })
    expect(verdicts.map((row) => row.verdict)).toContain("accepted")
  })
})
