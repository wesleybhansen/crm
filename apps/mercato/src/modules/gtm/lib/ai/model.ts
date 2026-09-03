/*
 * Injected model-client contract for the GTM AI drafting paths (per-recipient
 * message drafting and voice derivation).
 *
 * The library code (lib/campaign/ai-draft.ts, the voice-derive orchestration)
 * depends only on this narrow interface, so unit tests drive it with a fake
 * and the routes inject the real Gemini client. Token usage is returned by the
 * client so the caller meters through the existing CRM AI usage path
 * (@/lib/usage/meter -> logCrmAiUsage); the model client itself never meters.
 */

export type GtmModelResult = {
  text: string
  model: string
  tokensIn: number
  tokensOut: number
  tokenUsageKnown?: boolean
}

export interface GtmDraftModel {
  readonly modelId?: string
  generate(input: { system: string; prompt: string }): Promise<GtmModelResult>
}

// Reusable metering callback shape; the route wires this to meterCustomersAi.
export type GtmAiMeter = (usage: {
  model: string
  tokensIn: number
  tokensOut: number
  tokenUsageKnown?: boolean
  feature: string
  status?: 'succeeded' | 'failed'
  componentEstimates?: Record<string, number> | null
  latencyMs?: number | null
  retryCount?: number
  failureCode?: string | null
}) => void | Promise<void>

export function estimateModelTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 4)
}

// Upper bound for one untrusted text fragment that callers splice into a
// prompt (an evidence claim, an inbound email body, a pasted writing sample).
export const UNTRUSTED_PROMPT_TEXT_MAX_LENGTH = 4_000

/*
 * Flattens one piece of provider- or prospect-authored text so it can never
 * close or open a delimiter inside the prompt envelope: angle brackets and
 * line breaks are the two tools an injected payload needs to fake a
 * `</recipient_data>` boundary or a "SYSTEM:" line, so both are removed and
 * the result is length-bounded. Callers keep their own brace stripping for
 * merge-field safety; this is the prompt-envelope layer.
 */
export function sanitizeUntrustedPromptText(
  value: unknown,
  maxLength: number = UNTRUSTED_PROMPT_TEXT_MAX_LENGTH,
): string {
  if (typeof value !== 'string') return ''
  const bound = Number.isSafeInteger(maxLength) && maxLength > 0
    ? maxLength
    : UNTRUSTED_PROMPT_TEXT_MAX_LENGTH
  return value
    .replace(/[<>]/g, ' ')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, bound)
}

// GTM-only drafting model. Other CRM AI surfaces retain their own contracts.
export const GTM_DRAFT_MODEL = 'gemini-3.7-flash'

/*
 * Real Gemini client: one raw generativelanguage call, JSON response mode,
 * mirroring modules/customers/lib/draft-reply.ts (same provider, same usage
 * shape). Pure fetch, no server-only import, so nothing here blocks the unit
 * suite; the routes are the only callers that construct it with a live key.
 *
 * The system text travels as Gemini's `systemInstruction`, never as user
 * content, so the "untrusted DATA" envelope the callers describe has an
 * API-level instruction channel behind it rather than being earlier user text.
 *
 * Token truth: when the provider omits usage counts the call is still billed
 * by the provider, so the result reports max(provider count, local estimate)
 * for each direction and keeps tokenUsageKnown=false so the receipt records
 * that the numbers are an estimate. Callers meter result.tokensIn/Out as-is,
 * which is exactly why the substitution happens here and not in each caller.
 */
export function createGeminiDraftModel(apiKey: string, model: string = GTM_DRAFT_MODEL): GtmDraftModel {
  return {
    modelId: model,
    async generate({ system, prompt }) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 4000,
              responseMimeType: 'application/json',
              thinkingConfig: { thinkingLevel: 'low' },
            },
          }),
        },
      )
      const data = (await res.json().catch(() => null)) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]
        usageMetadata?: {
          promptTokenCount?: number
          candidatesTokenCount?: number
          thoughtsTokenCount?: number
        }
      } | null
      if (!res.ok) {
        throw new Error(`model_provider_http_${res.status}`)
      }
      const text = data?.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text ?? '')
        .join('')
        .trim() ?? ''
      const tokenUsageKnown =
        typeof data?.usageMetadata?.promptTokenCount === 'number'
        && typeof data?.usageMetadata?.candidatesTokenCount === 'number'
      const providerTokensIn = data?.usageMetadata?.promptTokenCount ?? 0
      const providerTokensOut =
        (data?.usageMetadata?.candidatesTokenCount ?? 0)
        + (data?.usageMetadata?.thoughtsTokenCount ?? 0)
      if (tokenUsageKnown) {
        return { text, model, tokensIn: providerTokensIn, tokensOut: providerTokensOut, tokenUsageKnown }
      }
      // Unknown usage is never metered as zero: the provider did the work and
      // will bill it, so the customer allowance is debited the larger of the
      // partial provider count and the local byte-based estimate.
      return {
        text,
        model,
        tokensIn: Math.max(providerTokensIn, estimateModelTokens(`${system}\n\n${prompt}`)),
        tokensOut: Math.max(providerTokensOut, estimateModelTokens(text)),
        tokenUsageKnown: false,
      }
    },
  }
}
