/**
 * Gemini counts the model's own reasoning ("thoughts") against maxOutputTokens
 * and bills them as output tokens.
 *
 * Measured 2026-09-14 against the live API, the day the CRM moved to
 * gemini-3.8-flash: the sentiment classifier's 10-token cap produced 7
 * thinking tokens and no answer; a 600-token research cap spent 572 thinking.
 * `thinkingConfig.thinkingBudget` is accepted by gemini-2.5-flash and
 * gemini-3.8-flash, with and without JSON mode and a response schema
 * (HTTP 200, finish STOP, JSON parses). On 2.5 it is honoured as a cap
 * (954 thoughts under 2048). On 3.8 it is treated as guidance: thoughts
 * measured between 0 and 791 under budgets of 2048 to 4096, so the reserve
 * below is headroom that has held on every prompt measured, not a hard
 * ceiling. Two call sites that steer thinking their own way
 * (modules/gtm/lib/ai/model.ts, quality/reply-quality/scored.ts) are left as
 * they are.
 *
 * `geminiText` reads the answer from every text part of the first candidate;
 * the old `parts[0].text` read dropped everything after the first part.
 * `geminiUsage` bills thoughts as output, which is how Google bills them; the
 * old `candidatesTokenCount` read metered them as zero.
 */
export const GEMINI_THINKING_RESERVE_TOKENS = 2048

export function geminiGenerationConfig<T extends { maxOutputTokens: number }>(
  config: T,
): T & { thinkingConfig: { thinkingBudget: number } } {
  return {
    ...config,
    maxOutputTokens: config.maxOutputTokens + GEMINI_THINKING_RESERVE_TOKENS,
    thinkingConfig: { thinkingBudget: GEMINI_THINKING_RESERVE_TOKENS },
  }
}

type GeminiPart = { text?: string; thought?: boolean }
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] | null } | null }> | null
  usageMetadata?: {
    promptTokenCount?: number | null
    candidatesTokenCount?: number | null
    thoughtsTokenCount?: number | null
  } | null
} | null | undefined

export function geminiText(data: GeminiResponse): string {
  const parts = data?.candidates?.[0]?.content?.parts ?? []
  return parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('')
}

/** Token usage the way Google bills it: thoughts are output tokens. */
export function geminiUsage(data: GeminiResponse): { tokensIn: number; tokensOut: number } {
  const usage = data?.usageMetadata
  return {
    tokensIn: Number(usage?.promptTokenCount) || 0,
    tokensOut: (Number(usage?.candidatesTokenCount) || 0) + (Number(usage?.thoughtsTokenCount) || 0),
  }
}
