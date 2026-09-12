import { z } from 'zod'

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'toolUseInputTokens'] as const
type CountField = typeof fields[number]
type Provider = 'gemini' | 'openai'

export type ScoutUsageObservation = {
  schemaVersion: 1
  provider: Provider
  scope: 'final_response_only'
  workflowCoverage: 'incomplete'
  reasoningIncludedInOutput: boolean
  counts: Record<CountField, number | null>
  invalidFields: CountField[]
  inconsistencies: Array<'cache_exceeds_input' | 'reasoning_exceeds_output' | 'total_below_parts'>
  parserFailed: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function observeScoutUsage(provider: Provider, usage: unknown): ScoutUsageObservation {
  const observation: ScoutUsageObservation = {
    schemaVersion: 1,
    provider,
    scope: 'final_response_only',
    workflowCoverage: 'incomplete',
    reasoningIncludedInOutput: provider === 'openai',
    counts: {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      toolUseInputTokens: null,
    },
    invalidFields: [],
    inconsistencies: [],
    parserFailed: false,
  }
  try {
    const data = asRecord(usage)
    const raw: Record<CountField, unknown> = provider === 'gemini'
      ? {
          inputTokens: data.promptTokenCount,
          cachedInputTokens: data.cachedContentTokenCount,
          outputTokens: data.candidatesTokenCount,
          reasoningTokens: data.thoughtsTokenCount,
          totalTokens: data.totalTokenCount,
          toolUseInputTokens: data.toolUsePromptTokenCount,
        }
      : {
          inputTokens: data.prompt_tokens,
          cachedInputTokens: asRecord(data.prompt_tokens_details).cached_tokens,
          outputTokens: data.completion_tokens,
          reasoningTokens: asRecord(data.completion_tokens_details).reasoning_tokens,
          totalTokens: data.total_tokens,
          toolUseInputTokens: undefined,
        }
    for (const field of fields) {
      if (raw[field] === undefined || raw[field] === null) continue
      const parsed = tokenCount.safeParse(raw[field])
      if (parsed.success) observation.counts[field] = parsed.data
      else observation.invalidFields.push(field)
    }
    const { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens } = observation.counts
    if (inputTokens !== null && cachedInputTokens !== null && cachedInputTokens > inputTokens) {
      observation.inconsistencies.push('cache_exceeds_input')
    }
    if (provider === 'openai' && outputTokens !== null && reasoningTokens !== null && reasoningTokens > outputTokens) {
      observation.inconsistencies.push('reasoning_exceeds_output')
    }
    if (inputTokens !== null && outputTokens !== null && totalTokens !== null) {
      const minimum = inputTokens + outputTokens + (provider === 'gemini' ? reasoningTokens ?? 0 : 0)
      if (totalTokens < minimum) observation.inconsistencies.push('total_below_parts')
    }
    return observation
  } catch {
    for (const field of fields) observation.counts[field] = null
    observation.invalidFields = []
    observation.inconsistencies = []
    observation.parserFailed = true
    return observation
  }
}
