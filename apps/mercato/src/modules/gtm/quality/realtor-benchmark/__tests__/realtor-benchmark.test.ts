import crypto from 'crypto'
import { evaluateRealtorBenchmark } from '../evaluator'
import { REALTOR_BENCHMARK_LABELS } from '../labels'
import { REALTOR_BENCHMARK_PLAYS } from '../plays'
import {
  REALTOR_BENCHMARK_VERSION,
  type RealtorBenchmarkLabel,
} from '../schemas'

function label(playId: string, rank: number): RealtorBenchmarkLabel {
  const play = REALTOR_BENCHMARK_PLAYS.find((row) => row.id === playId)
  if (!play) throw new Error('missing play')
  return {
    benchmarkVersion: REALTOR_BENCHMARK_VERSION,
    playId,
    rank,
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
    observedAt: '2026-08-26T20:00:00.000Z',
    eventStartAt: null,
    systemIntent: play.lane,
    systemDisposition: 'accepted',
    relevantToPlay: true,
    geographyCorrect: true,
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
    expect(result.metrics.precisionAt10.value).toBe(1)
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
})
