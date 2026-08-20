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

// Same Gemini model the CRM customer-service drafter uses (draft-reply.ts).
export const GTM_DRAFT_MODEL = 'gemini-2.5-flash'

/*
 * Real Gemini client: one raw generativelanguage call, JSON response mode,
 * mirroring modules/customers/lib/draft-reply.ts (same provider, same usage
 * shape). Pure fetch, no server-only import, so nothing here blocks the unit
 * suite; the routes are the only callers that construct it with a live key.
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
            contents: [{ parts: [{ text: `${system}\n\n${prompt}` }] }],
            generationConfig: {
              maxOutputTokens: 4000,
              temperature: 0.8,
              responseMimeType: 'application/json',
            },
          }),
        },
      )
      const data = (await res.json().catch(() => null)) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
      } | null
      if (!res.ok) {
        throw new Error(`model_provider_http_${res.status}`)
      }
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
      const tokenUsageKnown =
        typeof data?.usageMetadata?.promptTokenCount === 'number'
        && typeof data?.usageMetadata?.candidatesTokenCount === 'number'
      return {
        text,
        model,
        tokensIn: data?.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: data?.usageMetadata?.candidatesTokenCount ?? 0,
        tokenUsageKnown,
      }
    },
  }
}
