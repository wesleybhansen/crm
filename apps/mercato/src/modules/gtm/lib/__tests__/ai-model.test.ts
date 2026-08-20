import { createGeminiDraftModel, GTM_DRAFT_MODEL } from '../ai/model'

describe('GTM Gemini usage truth', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('marks usage known only when both provider counts are authoritative', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: 'internal summary', thought: true },
        { text: '{"ok":true}' },
      ] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    global.fetch = fetchMock as typeof fetch
    const model = createGeminiDraftModel('synthetic-key')
    await expect(model.generate({ system: 'system', prompt: 'prompt' })).resolves.toMatchObject({
      text: '{"ok":true}',
      model: GTM_DRAFT_MODEL,
      tokensIn: 12,
      tokensOut: 7,
      tokenUsageKnown: true,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${GTM_DRAFT_MODEL}:generateContent`)
    const body = JSON.parse(String(init.body)) as { generationConfig: Record<string, unknown> }
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    expect(body.generationConfig).not.toHaveProperty('temperature')
    expect(body.generationConfig).not.toHaveProperty('topP')
    expect(body.generationConfig).not.toHaveProperty('topK')

    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await expect(model.generate({ system: 'system', prompt: 'prompt' })).resolves.toMatchObject({
      tokensIn: 12,
      tokensOut: 0,
      tokenUsageKnown: false,
    })
  })

  it('fails honestly on provider HTTP errors', async () => {
    global.fetch = jest.fn(async () => new Response('{"error":"synthetic"}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    const model = createGeminiDraftModel('synthetic-key', 'fixture-model')
    await expect(model.generate({ system: 'system', prompt: 'prompt' }))
      .rejects.toThrow('model_provider_http_503')
  })
})
