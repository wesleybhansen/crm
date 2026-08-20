import { createGeminiDraftModel } from '../ai/model'

describe('GTM Gemini usage truth', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('marks usage known only when both provider counts are authoritative', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const model = createGeminiDraftModel('synthetic-key', 'fixture-model')
    await expect(model.generate({ system: 'system', prompt: 'prompt' })).resolves.toMatchObject({
      tokensIn: 12,
      tokensOut: 4,
      tokenUsageKnown: true,
    })

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
