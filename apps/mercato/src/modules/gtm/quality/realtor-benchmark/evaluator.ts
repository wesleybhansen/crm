import {
  REALTOR_BENCHMARK_VERSION,
  realtorBenchmarkLabelSchema,
  realtorBenchmarkPlaySchema,
  type RealtorBenchmarkEvaluation,
  type RealtorBenchmarkLabel,
  type RealtorBenchmarkMetric,
  type RealtorBenchmarkPlay,
} from './schemas'

export const REALTOR_BENCHMARK_THRESHOLDS = {
  minimumLabeledRows: 100,
  maximumLabeledRows: 200,
  minimumRowsPerPlay: 10,
  precisionAt10: 0.8,
  geographyCorrectness: 0.95,
  intentCorrectness: 0.9,
  liveAccessibleDestinations: 0.95,
  duplicateRate: 0.1,
  usefulEnoughToActOn: 0.7,
  sensitiveOrUnsupportedCount: 0,
} as const

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function atLeast(value: number, threshold: number): RealtorBenchmarkMetric {
  return { value, threshold, operator: '>=', passed: value >= threshold }
}

function atMost(value: number, threshold: number): RealtorBenchmarkMetric {
  return { value, threshold, operator: '<=', passed: value <= threshold }
}

function equal(value: number, threshold: number): RealtorBenchmarkMetric {
  return { value, threshold, operator: '=', passed: value === threshold }
}

export function evaluateRealtorBenchmark(
  rawPlays: RealtorBenchmarkPlay[],
  rawLabels: RealtorBenchmarkLabel[],
): RealtorBenchmarkEvaluation {
  const plays = rawPlays.map((play) => realtorBenchmarkPlaySchema.parse(play))
  const labels = rawLabels.map((label) => realtorBenchmarkLabelSchema.parse(label))
  const playById = new Map(plays.map((play) => [play.id, play]))
  const unknownPlayIds = [...new Set(labels.filter((label) => !playById.has(label.playId)).map((label) => label.playId))]
  if (unknownPlayIds.length > 0) throw new Error(`Unknown benchmark play: ${unknownPlayIds.join(', ')}`)

  const labelsByPlay = new Map<string, RealtorBenchmarkLabel[]>()
  const rankKeys = new Set<string>()
  const duplicateRankKeys: string[] = []
  for (const label of labels) {
    const key = `${label.playId}:${label.rank}`
    if (rankKeys.has(key)) duplicateRankKeys.push(key)
    rankKeys.add(key)
    const rows = labelsByPlay.get(label.playId) ?? []
    rows.push(label)
    labelsByPlay.set(label.playId, rows)
  }

  const missingPlayIds = plays
    .filter((play) => (labelsByPlay.get(play.id)?.length ?? 0) < REALTOR_BENCHMARK_THRESHOLDS.minimumRowsPerPlay)
    .map((play) => play.id)
  const counts = plays.map((play) => labelsByPlay.get(play.id)?.length ?? 0)
  const coverage = {
    playCount: plays.length,
    labeledRows: labels.length,
    minimumRowsPerPlay: counts.length > 0 ? Math.min(...counts) : 0,
    maximumRowsPerPlay: counts.length > 0 ? Math.max(...counts) : 0,
    missingPlayIds,
    duplicateRankKeys: [...new Set(duplicateRankKeys)].sort(),
    valid:
      plays.length === 12
      && labels.length >= REALTOR_BENCHMARK_THRESHOLDS.minimumLabeledRows
      && labels.length <= REALTOR_BENCHMARK_THRESHOLDS.maximumLabeledRows
      && missingPlayIds.length === 0
      && duplicateRankKeys.length === 0,
  }

  const top10 = plays.flatMap((play) =>
    [...(labelsByPlay.get(play.id) ?? [])]
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 10),
  )
  const precisionAt10 = ratio(top10.filter((label) => label.relevantToPlay).length, top10.length)
  const geographyCorrectness = ratio(labels.filter((label) => label.geographyCorrect).length, labels.length)
  const intentCorrectness = ratio(labels.filter((label) => {
    const play = playById.get(label.playId)
    return label.systemIntent === play?.lane
      || (label.systemIntent === 'mixed_intent' && (play?.lane === 'buyer_intent' || play?.lane === 'seller_intent'))
  }).length, labels.length)
  const liveAccessibleDestinations = ratio(labels.filter((label) => label.liveAccessible).length, labels.length)
  const duplicateRate = ratio(labels.filter((label) => label.duplicateOfHash != null).length, labels.length)
  const usefulEnoughToActOn = ratio(labels.filter((label) => label.usefulEnoughToActOn).length, labels.length)
  const sensitiveOrUnsupportedCount = labels.filter(
    (label) => label.sensitiveTargeting || label.unsupportedClaim,
  ).length
  const metrics = {
    precisionAt10: atLeast(precisionAt10, REALTOR_BENCHMARK_THRESHOLDS.precisionAt10),
    geographyCorrectness: atLeast(
      geographyCorrectness,
      REALTOR_BENCHMARK_THRESHOLDS.geographyCorrectness,
    ),
    intentCorrectness: atLeast(intentCorrectness, REALTOR_BENCHMARK_THRESHOLDS.intentCorrectness),
    liveAccessibleDestinations: atLeast(
      liveAccessibleDestinations,
      REALTOR_BENCHMARK_THRESHOLDS.liveAccessibleDestinations,
    ),
    duplicateRate: atMost(duplicateRate, REALTOR_BENCHMARK_THRESHOLDS.duplicateRate),
    usefulEnoughToActOn: atLeast(
      usefulEnoughToActOn,
      REALTOR_BENCHMARK_THRESHOLDS.usefulEnoughToActOn,
    ),
    sensitiveOrUnsupportedCount: equal(
      sensitiveOrUnsupportedCount,
      REALTOR_BENCHMARK_THRESHOLDS.sensitiveOrUnsupportedCount,
    ),
  }

  return {
    benchmarkVersion: REALTOR_BENCHMARK_VERSION,
    passed: coverage.valid && Object.values(metrics).every((metric) => metric.passed),
    coverage,
    metrics,
    byPlay: plays.map((play) => {
      const rows = [...(labelsByPlay.get(play.id) ?? [])].sort((left, right) => left.rank - right.rank)
      const first10 = rows.slice(0, 10)
      const relevantAt10 = first10.filter((label) => label.relevantToPlay).length
      return {
        playId: play.id,
        labeledRows: rows.length,
        relevantAt10,
        precisionAt10: ratio(relevantAt10, first10.length),
      }
    }),
  }
}
