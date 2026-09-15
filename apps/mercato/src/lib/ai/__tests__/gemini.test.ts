import { GEMINI_THINKING_RESERVE_TOKENS, geminiGenerationConfig, geminiText, geminiUsage } from '@/lib/ai/gemini'

// Measured 2026-09-14 on gemini-3.8-flash: the sentiment classifier's 10-token
// cap produced 7 thinking tokens and no answer at all.
describe('geminiGenerationConfig', () => {
  it('reserves a thinking budget on top of the answer budget the caller asked for', () => {
    const config = geminiGenerationConfig({ temperature: 0, maxOutputTokens: 10 })
    expect(config.maxOutputTokens).toBe(10 + GEMINI_THINKING_RESERVE_TOKENS)
    expect(config.thinkingConfig).toEqual({ thinkingBudget: GEMINI_THINKING_RESERVE_TOKENS })
    expect(config.temperature).toBe(0)
  })

  it('passes every other setting through untouched', () => {
    const config = geminiGenerationConfig({ maxOutputTokens: 400, responseMimeType: 'application/json' })
    expect(config.responseMimeType).toBe('application/json')
  })
})

describe('geminiText', () => {
  it('joins every text part and skips thoughts', () => {
    expect(geminiText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab')
    expect(geminiText({ candidates: [{ content: { parts: [{ text: 'plan', thought: true }, { text: 'answer' }] } }] })).toBe('answer')
  })

  it('is empty for a missing or empty candidate', () => {
    expect(geminiText(undefined)).toBe('')
    expect(geminiText({ candidates: [] })).toBe('')
    expect(geminiText({ candidates: [{ content: null }] })).toBe('')
  })
})

describe('geminiUsage', () => {
  it('bills thoughts as output tokens, the way Google does', () => {
    const usage = geminiUsage({ usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 700 } })
    expect(usage).toEqual({ tokensIn: 120, tokensOut: 730 })
  })

  it('treats missing counts as zero', () => {
    expect(geminiUsage({ usageMetadata: { promptTokenCount: 5 } })).toEqual({ tokensIn: 5, tokensOut: 0 })
    expect(geminiUsage(undefined)).toEqual({ tokensIn: 0, tokensOut: 0 })
  })
})
