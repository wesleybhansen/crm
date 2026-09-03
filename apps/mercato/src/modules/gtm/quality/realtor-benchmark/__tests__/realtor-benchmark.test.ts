import crypto from 'crypto'
import { evaluateRealtorBenchmark } from '../evaluator'
import { REALTOR_BENCHMARK_LABELS } from '../labels'
import { REALTOR_BENCHMARK_PLAYS } from '../plays'
import {
  REALTOR_BENCHMARK_VERSION,
  type RealtorBenchmarkLabel,
} from '../schemas'

function uuidFor(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function label(playId: string, rank: number): RealtorBenchmarkLabel {
  const play = REALTOR_BENCHMARK_PLAYS.find((row) => row.id === playId)
  if (!play) throw new Error('missing play')
  return {
    benchmarkVersion: REALTOR_BENCHMARK_VERSION,
    playId,
    rank,
    researchRunId: uuidFor(`run:${playId}`),
    candidateMatchId: uuidFor(`match:${playId}:${rank}`),
    providerOperationId: uuidFor(`op:${playId}`),
    source: 'apify-reddit',
    destinationHash: crypto.createHash('sha256').update(`${playId}:${rank}`).digest('hex'),
    destinationKind: play.lane === 'local_audience' ? 'community' : 'post',
    sanitizedContent:
      play.lane === 'buyer_intent'
        ? `First-time buyer asking about a home search in ${play.market}.`
        : play.lane === 'seller_intent'
          ? `Homeowner asking how to prepare and price a home to sell in ${play.market}.`
          : `Public ${play.market} neighborhood community and housing discussion.`,
    sanitizedObservedLocation: play.geography,
    sourcePublishedAt: play.lane === 'local_audience' ? null : '2026-08-25T20:00:00.000Z',
    observedAt: '2026-08-26T20:00:00.000Z',
    eventStartAt: null,
    systemIntent: play.lane,
    systemDisposition: 'accepted',
    relevantToPlay: true,
    geographyCorrect: true,
    intentCorrect: true,
    currentWithinWindow: true,
    liveAccessible: true,
    usefulEnoughToActOn: rank <= 8,
    duplicateOfHash: rank === 10 && playId === REALTOR_BENCHMARK_PLAYS[0].id
      ? crypto.createHash('sha256').update(`${playId}:1`).digest('hex')
      : null,
    sensitiveTargeting: false,
    unsupportedClaim: false,
    criterionEvidence: ['intent demonstrated in returned content', 'market named in public result'],
    rejectReasons: [],
    sanitized: true,
  }
}

describe('controlled realtor opportunity benchmark', () => {
  it('defines buyer, seller, and local-audience plays across four markets', () => {
    expect(REALTOR_BENCHMARK_PLAYS).toHaveLength(12)
    expect(new Set(REALTOR_BENCHMARK_PLAYS.map((play) => play.market)).size).toBe(4)
    for (const market of new Set(REALTOR_BENCHMARK_PLAYS.map((play) => play.market))) {
      expect(REALTOR_BENCHMARK_PLAYS.filter((play) => play.market === market).map((play) => play.lane).sort())
        .toEqual(['buyer_intent', 'local_audience', 'seller_intent'])
    }
  })

  it('fails closed while the real sanitized label set is empty', () => {
    const result = evaluateRealtorBenchmark(REALTOR_BENCHMARK_PLAYS, REALTOR_BENCHMARK_LABELS)
    expect(result.passed).toBe(false)
    expect(result.coverage.valid).toBe(false)
    expect(result.coverage.missingPlayIds).toHaveLength(12)
  })

  it('computes the exact launch thresholds over a 120-row controlled set', () => {
    const labels = REALTOR_BENCHMARK_PLAYS.flatMap((play) =>
      Array.from({ length: 10 }, (_, index) => label(play.id, index + 1)),
    )
    const result = evaluateRealtorBenchmark(REALTOR_BENCHMARK_PLAYS, labels)
    expect(result.coverage).toMatchObject({ valid: true, labeledRows: 120, minimumRowsPerPlay: 10 })
    expect(result.metrics.precisionOverAccepted.value).toBe(1)
    expect(result.metrics.recallOverHumanRelevant.value).toBe(1)
    expect(result.metrics.rankedPrecisionAt10.value).toBe(1)
    expect(result.metrics.geographyCorrectness.value).toBe(1)
    expect(result.metrics.intentCorrectness.value).toBe(1)
    expect(result.metrics.liveAccessibleDestinations.value).toBe(1)
    expect(result.metrics.duplicateRate.value).toBeCloseTo(1 / 120)
    expect(result.metrics.usefulEnoughToActOn.value).toBe(0.8)
    expect(result.metrics.sensitiveOrUnsupportedCount.value).toBe(0)
    expect(result.passed).toBe(true)
  })

  it('fails on false positives, wrong intent, dead destinations, duplicates, or unsafe output', () => {
    const labels = REALTOR_BENCHMARK_PLAYS.flatMap((play) =>
      Array.from({ length: 10 }, (_, index) => {
        const row = label(play.id, index + 1)
        return {
          ...row,
          relevantToPlay: index < 6,
          systemIntent: index < 7 ? row.systemIntent : null,
          intentCorrect: index < 7,
          currentWithinWindow: index < 8,
          liveAccessible: index < 8,
          usefulEnoughToActOn: index < 5,
          duplicateOfHash: index < 2 ? label(play.id, 10).destinationHash : null,
          sensitiveTargeting: index === 9,
        }
      }),
    )
    const result = evaluateRealtorBenchmark(REALTOR_BENCHMARK_PLAYS, labels)
    expect(result.passed).toBe(false)
    expect(Object.values(result.metrics).filter((metric) => !metric.passed).length).toBeGreaterThan(1)
  })

  it('measures precision over what the system ACCEPTED, not over the exported ranking (C1)', () => {
    // Every row rejected by the qualifier, every row liked by a human: the
    // old ranked metric scored this 1.0 and passed. The system accepted
    // nothing, so accepted precision is 0 and the gate fails.
    const allRejected = REALTOR_BENCHMARK_PLAYS.flatMap((play) =>
      Array.from({ length: 10 }, (_, index) => ({ ...label(play.id, index + 1), systemDisposition: 'rejected' as const })),
    )
    const rejectedResult = evaluateRealtorBenchmark(REALTOR_BENCHMARK_PLAYS, allRejected)
    expect(rejectedResult.metrics.rankedPrecisionAt10.value).toBe(1)
    expect(rejectedResult.metrics.precisionOverAccepted.value).toBe(0)
    expect(rejectedResult.metrics.recallOverHumanRelevant.value).toBe(0)
    expect(rejectedResult.passed).toBe(false)

    // Accepted junk is a false positive whatever its rank: ranks 1-8 relevant
    // and rejected, ranks 9-10 accepted and irrelevant.
    const acceptedJunk = REALTOR_BENCHMARK_PLAYS.flatMap((play) =>
      Array.from({ length: 10 }, (_, index) => {
        const row = label(play.id, index + 1)
        const accepted = index >= 8
        return {
          ...row,
          systemDisposition: accepted ? ('accepted' as const) : ('rejected' as const),
          relevantToPlay: !accepted,
          usefulEnoughToActOn: !accepted,
          rejectReasons: accepted ? ['not relevant'] : [],
        }
      }),
    )
    const junkResult = evaluateRealtorBenchmark(REALTOR_BENCHMARK_PLAYS, acceptedJunk)
    expect(junkResult.metrics.rankedPrecisionAt10.value).toBe(0.8)
    expect(junkResult.metrics.precisionOverAccepted.value).toBe(0)
    expect(junkResult.passed).toBe(false)
    expect(junkResult.byPlay[0]).toMatchObject({ acceptedRows: 2, acceptedRelevant: 0, precisionOverAccepted: 0 })

    // Accepting 8 of 10 human-relevant rows and nothing else passes.
    const good = REALTOR_BENCHMARK_PLAYS.flatMap((play) =>
      Array.from({ length: 10 }, (_, index) => ({
        ...label(play.id, index + 1),
        systemDisposition: index < 8 ? ('accepted' as const) : ('review' as const),
      })),
    )
    const goodResult = evaluateRealtorBenchmark(REALTOR_BENCHMARK_PLAYS, good)
    expect(goodResult.metrics.precisionOverAccepted.value).toBe(1)
    expect(goodResult.metrics.recallOverHumanRelevant.value).toBe(0.8)
    expect(goodResult.passed).toBe(true)
  })

  it('fails closed when a frozen label lacks its run, match, or provider operation binding (C1)', () => {
    const labels = REALTOR_BENCHMARK_PLAYS.flatMap((play) =>
      Array.from({ length: 10 }, (_, index) => label(play.id, index + 1)),
    )
    const unbound = labels.map((row) => {
      const copy = { ...row } as Record<string, unknown>
      delete copy.providerOperationId
      return copy as unknown as RealtorBenchmarkLabel
    })
    expect(() => evaluateRealtorBenchmark(REALTOR_BENCHMARK_PLAYS, unbound)).toThrow()
  })
})
