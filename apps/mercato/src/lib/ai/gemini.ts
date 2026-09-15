/**
 * Gemini counts the model's own reasoning ("thoughts") against maxOutputTokens.
 * Measured 2026-09-14 on gemini-3.8-flash, the CRM's model since that day: the
 * sentiment classifier's 10-token cap produced 7 thinking tokens and no answer,
 * and a 600-token cap on a research prompt spent 572 tokens thinking. Every
 * caller that asks for N answer tokens therefore reserves a bounded thinking
 * budget on top, so thinking can never starve the answer. Gemini 2.5 and 3.x
 * both honour thinkingBudget (measured: thoughts stayed under it).
 *
 * `geminiText` reads the answer from every text part of the first candidate,
 * because a thinking model can return more than one part and the old
 * `parts[0].text` read silently dropped everything after the first.
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
type GeminiResponse = { candidates?: Array<{ content?: { parts?: GeminiPart[] | null } | null }> | null } | null | undefined

export function geminiText(data: GeminiResponse): string {
  const parts = data?.candidates?.[0]?.content?.parts ?? []
  return parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('')
}
