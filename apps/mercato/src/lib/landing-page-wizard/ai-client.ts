/**
 * Reusable AI caller with provider fallback chain: Gemini -> Anthropic -> OpenAI.
 * Extracted from the landing-page-ai generate route for shared use across wizard endpoints.
 */

interface CallAIOptions {
  jsonMode?: boolean
  maxTokens?: number
  /*
   * Over-allowance BYOK fall-through. When set, this key is preferred over the
   * matching env key for whichever provider it belongs to (resolved from the
   * allowance gate's chosen provider). Pass `gate.byoApiKey` here and use
   * `result.byoKey` when metering. See landing_pages/api/ai/generate/route.ts.
   */
  apiKey?: string
  provider?: 'google' | 'anthropic' | 'openai' | 'xai'
}

export interface AIUsage {
  tokensIn: number
  tokensOut: number
}

export interface CallAIResult {
  text: string
  model: string
  usage: AIUsage
  provider: 'google' | 'anthropic' | 'openai' | 'xai'
}

/*
 * Backwards-compatible string return. Prefer `callAIWithUsage` in new code so
 * the caller can meter the result (see GAP-1 fix).
 */
export async function callAI(
  systemPrompt: string,
  userPrompt: string,
  options: CallAIOptions = {}
): Promise<string> {
  return (await callAIWithUsage(systemPrompt, userPrompt, options)).text
}

export async function callAIWithUsage(
  systemPrompt: string,
  userPrompt: string,
  options: CallAIOptions = {}
): Promise<CallAIResult> {
  const { jsonMode = false, maxTokens = 8192, apiKey: byoKey, provider: byoProvider } = options

  // When a BYO key is supplied, run ONLY its provider (no fallback) so we never
  // silently bill the platform key after the gate routed us to the customer's key.
  if (byoKey && byoProvider) {
    if (byoProvider === 'google') return callGemini(systemPrompt, userPrompt, byoKey, { jsonMode, maxTokens })
    if (byoProvider === 'anthropic') return callAnthropic(systemPrompt, userPrompt, byoKey, { maxTokens })
    if (byoProvider === 'xai') return callXai(systemPrompt, userPrompt, byoKey, { jsonMode, maxTokens })
    return callOpenAI(systemPrompt, userPrompt, byoKey, { jsonMode, maxTokens })
  }

  const geminiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  // Try Gemini first
  if (geminiKey) {
    try {
      return await callGemini(systemPrompt, userPrompt, geminiKey, { jsonMode, maxTokens })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[ai-client] Gemini failed, trying fallback:', message)
    }
  }

  // Fallback to Anthropic
  if (anthropicKey) {
    try {
      return await callAnthropic(systemPrompt, userPrompt, anthropicKey, { maxTokens })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[ai-client] Anthropic failed, trying fallback:', message)
    }
  }

  // Fallback to OpenAI
  if (openaiKey) {
    try {
      return await callOpenAI(systemPrompt, userPrompt, openaiKey, { jsonMode, maxTokens })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[ai-client] OpenAI failed:', message)
      throw new Error(`OpenAI error: ${message}`)
    }
  }

  throw new Error(
    'No AI API key configured. Set GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY in .env'
  )
}

/**
 * Parse an AI JSON response, stripping markdown code fences if present.
 */
export function parseAIJsonResponse<T>(raw: string): T {
  let cleaned = raw.trim()

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '')
  }

  return JSON.parse(cleaned) as T
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  opts: { jsonMode: boolean; maxTokens: number },
  retries = 2
): Promise<CallAIResult> {
  const model = process.env.AI_MODEL || 'gemini-3.5-flash'

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, attempt * 5000))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90000)

    const generationConfig: Record<string, unknown> = {
      temperature: 0.7,
      maxOutputTokens: opts.maxTokens,
    }
    if (opts.jsonMode) {
      generationConfig.responseMimeType = 'application/json'
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig,
        }),
        signal: controller.signal,
      }
    )
    clearTimeout(timeout)

    const data = await response.json()
    if (data.error) {
      const msg = data.error.message || ''
      if (
        (msg.includes('Resource exhausted') || msg.includes('429') || msg.includes('rate')) &&
        attempt < retries
      ) {
        console.log(`[ai-client] Gemini rate limited, retry ${attempt + 1}/${retries}...`)
        continue
      }
      throw new Error(msg || 'Gemini error')
    }

    return {
      text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
      model,
      provider: 'google',
      usage: {
        tokensIn: data?.usageMetadata?.promptTokenCount || 0,
        tokensOut: data?.usageMetadata?.candidatesTokenCount || 0,
      },
    }
  }

  throw new Error('Gemini rate limit exceeded after retries')
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  opts: { maxTokens: number }
): Promise<CallAIResult> {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90000)

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: controller.signal,
  })
  clearTimeout(timeout)

  const data = await response.json()
  if (data.error) {
    throw new Error(data.error.message || 'Anthropic error')
  }

  return {
    text: data.content?.[0]?.text || '',
    model,
    provider: 'anthropic',
    usage: {
      tokensIn: data?.usage?.input_tokens || 0,
      tokensOut: data?.usage?.output_tokens || 0,
    },
  }
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  opts: { jsonMode: boolean; maxTokens: number }
): Promise<CallAIResult> {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90000)

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: opts.maxTokens,
  }
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
  clearTimeout(timeout)

  const data = await response.json()
  if (data.error) {
    throw new Error(data.error.message || 'OpenAI error')
  }

  return {
    text: data.choices?.[0]?.message?.content || '',
    model,
    provider: 'openai',
    usage: {
      tokensIn: data?.usage?.prompt_tokens || 0,
      tokensOut: data?.usage?.completion_tokens || 0,
    },
  }
}

async function callXai(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  opts: { jsonMode: boolean; maxTokens: number }
): Promise<CallAIResult> {
  // xAI/Grok is OpenAI-compatible — same chat/completions shape, different host.
  const model = process.env.XAI_MODEL || 'grok-4.5'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90000)

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: opts.maxTokens,
  }
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
  clearTimeout(timeout)

  const data = await response.json()
  if (data.error) {
    throw new Error(data.error.message || 'xAI error')
  }

  return {
    text: data.choices?.[0]?.message?.content || '',
    model,
    provider: 'xai',
    usage: {
      tokensIn: data?.usage?.prompt_tokens || 0,
      tokensOut: data?.usage?.completion_tokens || 0,
    },
  }
}
