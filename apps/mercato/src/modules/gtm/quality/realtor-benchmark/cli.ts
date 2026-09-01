import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseRealtorBenchmarkCliOptions } from './cli-options'
import { evaluateRealtorBenchmark } from './evaluator'
import {
  importIndependentHumanReviews,
  type IndependentHumanReviewBatch,
  type RealtorBenchmarkEvidence,
} from './human-review'
import { REALTOR_BENCHMARK_PLAYS } from './plays'

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main(): Promise<void> {
  try {
    const options = parseRealtorBenchmarkCliOptions(process.argv.slice(2))
    const evidence = await readJson(options.evidencePath) as RealtorBenchmarkEvidence[]
    const reviews = await readJson(options.reviewsPath) as IndependentHumanReviewBatch
    const imported = importIndependentHumanReviews(evidence, reviews)
    const evaluation = evaluateRealtorBenchmark(REALTOR_BENCHMARK_PLAYS, imported.labels)
    const artifact = {
      artifactVersion: 'gtm-realtor-independent-review-release-v1',
      generatedAt: new Date().toISOString(),
      status: evaluation.passed ? 'passed' : 'failed',
      audit: imported.audit,
      evaluation,
    }

    await mkdir(dirname(options.outputPath), { recursive: true })
    await writeFile(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await chmod(options.outputPath, 0o600)
    process.stdout.write(`${JSON.stringify({
      status: artifact.status,
      outputPath: options.outputPath,
      sourceSha256: imported.audit.sourceSha256,
      decisionSha256: imported.audit.decisionSha256,
      reviewCount: imported.audit.reviewCount,
      metrics: evaluation.metrics,
    })}\n`)
    if (!evaluation.passed) process.exitCode = 2
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown realtor benchmark evaluator error',
    })}\n`)
    process.exitCode = 1
  }
}

void main()
