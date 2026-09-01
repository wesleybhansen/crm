import { resolve } from 'node:path'

export type RealtorBenchmarkCliOptions = {
  evidencePath: string
  reviewsPath: string
  outputPath: string
}

function requiredPath(argumentsList: string[], name: string): string {
  const prefix = `--${name}=`
  const match = argumentsList.find((argument) => argument.startsWith(prefix))
  const value = match?.slice(prefix.length).trim()
  if (!value) throw new Error(`${prefix}<path> is required`)
  return resolve(value)
}

export function parseRealtorBenchmarkCliOptions(argumentsList: string[]): RealtorBenchmarkCliOptions {
  const allowed = new Set(['evidence', 'reviews', 'output'])
  for (const argument of argumentsList) {
    const name = argument.startsWith('--') ? argument.slice(2).split('=', 1)[0] : ''
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${argument}`)
  }
  return {
    evidencePath: requiredPath(argumentsList, 'evidence'),
    reviewsPath: requiredPath(argumentsList, 'reviews'),
    outputPath: requiredPath(argumentsList, 'output'),
  }
}
