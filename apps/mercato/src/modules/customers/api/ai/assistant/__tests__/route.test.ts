import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { meterCustomersAi } from '@/lib/usage/meter'

jest.mock('@/lib/usage/allowance', () => ({
  ALLOWANCE_BLOCK_MESSAGE: 'allowance blocked',
  checkCustomersAiAllowance: jest.fn(),
}))

jest.mock('@/lib/usage/meter', () => ({
  meterCustomersAi: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))

jest.mock('@/modules/customers/api/ai/persona', () => ({
  buildPersonaPrompt: jest.fn(() => ''),
  getPersonaForOrg: jest.fn(),
}))

jest.mock('@/modules/customers/lib/crm-tool-catalog', () => ({
  renderToolCatalogForPrompt: jest.fn(() => ''),
}))

import { POST } from '../route'

const mockCheckCustomersAiAllowance = jest.mocked(checkCustomersAiAllowance)
const mockMeterCustomersAi = jest.mocked(meterCustomersAi)
const originalEnv = process.env
const originalFetch = global.fetch
const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>

const auth = {
  sub: '',
  tenantId: 'tenant-1',
  orgId: 'crm-org-1',
  email: 'owner@example.test',
  roles: [],
}

function request(): Request {
  return new Request('http://localhost/api/ai/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello Scout' }] }),
  })
}

function geminiRateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  })
}

function openAiSuccessResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: 'OpenAI answer' } }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Scout provider fallback routing', () => {
  let consoleWarnSpy: jest.SpyInstance
  let consoleLogSpy: jest.SpyInstance

  beforeAll(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterAll(() => {
    consoleWarnSpy.mockRestore()
    consoleLogSpy.mockRestore()
    process.env = originalEnv
    global.fetch = originalFetch
  })

  beforeEach(() => {
    jest.clearAllMocks()
    fetchMock.mockReset()
    process.env = {
      ...originalEnv,
      AI_MODEL: 'gemini-test-model',
      OPENAI_FALLBACK_MODEL: 'openai-test-model',
      GOOGLE_GENERATIVE_AI_API_KEY: 'platform-google',
      OPENAI_API_KEY: 'platform-openai',
    }
    global.fetch = fetchMock
  })

  it('never spills a Google BYO request onto the platform OpenAI key', async () => {
    mockCheckCustomersAiAllowance.mockImplementation(async (_auth, provider) => (
      provider === 'google'
        ? { allowed: true, byoApiKey: 'customer-google' }
        : { allowed: true }
    ))
    fetchMock.mockResolvedValueOnce(geminiRateLimitResponse())

    const response = await POST(request(), { auth })

    expect(response.status).toBe(402)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('generativelanguage.googleapis.com')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-goog-api-key')).toBe('customer-google')
    expect(mockCheckCustomersAiAllowance).toHaveBeenNthCalledWith(1, auth, 'google')
    expect(mockCheckCustomersAiAllowance).toHaveBeenNthCalledWith(2, auth, 'openai')
    expect(mockMeterCustomersAi).not.toHaveBeenCalled()
  })

  it('uses the OpenAI BYO key after a retriable Google BYO failure and meters it as BYO', async () => {
    mockCheckCustomersAiAllowance.mockImplementation(async (_auth, provider) => (
      provider === 'google'
        ? { allowed: true, byoApiKey: 'customer-google' }
        : { allowed: true, byoApiKey: 'customer-openai' }
    ))
    fetchMock
      .mockResolvedValueOnce(geminiRateLimitResponse())
      .mockResolvedValueOnce(openAiSuccessResponse())

    const response = await POST(request(), { auth })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, provider: 'openai' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.openai.com/v1/chat/completions')
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer customer-openai')
    expect(mockMeterCustomersAi).toHaveBeenCalledWith(auth, {
      model: 'openai-test-model',
      tokensIn: 12,
      tokensOut: 5,
      feature: 'scout-assistant',
      byoKey: true,
    })
  })

  it('uses the platform OpenAI fallback under allowance when Google is not configured', async () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    mockCheckCustomersAiAllowance.mockResolvedValue({ allowed: true })
    fetchMock.mockResolvedValueOnce(openAiSuccessResponse())

    const response = await POST(request(), { auth })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, provider: 'openai' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/chat/completions')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer platform-openai')
    expect(mockMeterCustomersAi).toHaveBeenCalledWith(auth, {
      model: 'openai-test-model',
      tokensIn: 12,
      tokensOut: 5,
      feature: 'scout-assistant',
      byoKey: false,
    })
  })
})
