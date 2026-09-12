import { observeScoutUsage } from '../scout-usage-observation'

describe('Scout numerical usage observations', () => {
  it('preserves Gemini cache and separate thought counts without adding them to candidate output', () => {
    const result = observeScoutUsage('gemini', {
      promptTokenCount: 1000, cachedContentTokenCount: 800,
      candidatesTokenCount: 100, thoughtsTokenCount: 50, totalTokenCount: 1150,
      toolUsePromptTokenCount: 10,
    })
    expect(result.counts).toEqual({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100, reasoningTokens: 50, totalTokens: 1150, toolUseInputTokens: 10 })
    expect(result.reasoningIncludedInOutput).toBe(false)
    expect(result.inconsistencies).toEqual([])
    expect(result.workflowCoverage).toBe('incomplete')
  })

  it('does not double count OpenAI reasoning or turn missing cache into zero', () => {
    const result = observeScoutUsage('openai', {
      prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
      completion_tokens_details: { reasoning_tokens: 50 },
    })
    expect(result.counts).toEqual({ inputTokens: 1000, cachedInputTokens: null, outputTokens: 100, reasoningTokens: 50, totalTokens: 1100, toolUseInputTokens: null })
    expect(result.reasoningIncludedInOutput).toBe(true)
    expect(result.inconsistencies).toEqual([])
  })

  it.each([undefined, null, [], 'bad', 123])('keeps absent/invalid usage containers unknown: %p', (usage) => {
    expect(Object.values(observeScoutUsage('gemini', usage).counts)).toEqual([null, null, null, null, null, null])
  })

  it.each(['10', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}, []])('does not coerce malformed token count %p', (value) => {
    const result = observeScoutUsage('openai', { prompt_tokens: value })
    expect(result.counts.inputTokens).toBeNull()
    expect(result.invalidFields).toEqual(['inputTokens'])
  })

  it('retains explicitly reported zero and safe integer extremes', () => {
    const result = observeScoutUsage('openai', { prompt_tokens: Number.MAX_SAFE_INTEGER, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 0 })
    expect(result.counts.inputTokens).toBe(Number.MAX_SAFE_INTEGER)
    expect(result.counts.cachedInputTokens).toBe(0)
    expect(result.counts.outputTokens).toBe(0)
    expect(result.invalidFields).toEqual([])
  })

  it('flags impossible subsets and totals without silently adjusting reported numbers', () => {
    const result = observeScoutUsage('openai', { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 6 }, total_tokens: 1 })
    expect(result.inconsistencies).toEqual(['cache_exceeds_input', 'reasoning_exceeds_output', 'total_below_parts'])
    expect(result.counts.cachedInputTokens).toBe(20)
    expect(result.counts.totalTokens).toBe(1)
  })

  it('does not retain unknown fields, strings, prompt content or credentials', () => {
    const result = observeScoutUsage('openai', { prompt_tokens: 'secret-input', apiKey: 'secret-key', choices: [{ message: 'private reply' }], prompt_tokens_details: { cached_tokens: 4, text: 'private prompt' } })
    expect(JSON.stringify(result)).not.toMatch(/secret|private|apiKey|choices/)
    expect(result.counts.cachedInputTokens).toBe(4)
    expect(JSON.stringify(result).length).toBeLessThan(1000)
  })

  it('isolates unexpected parser exceptions from generation and returns unknown counts', () => {
    const result = observeScoutUsage('gemini', Object.defineProperty({}, 'promptTokenCount', { get() { throw new Error('private failure') } }))
    expect(result.parserFailed).toBe(true)
    expect(Object.values(result.counts)).toEqual([null, null, null, null, null, null])
    expect(JSON.stringify(result)).not.toContain('private failure')
  })
})
