import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { meterCustomersAi } from '@/lib/usage/meter'

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: jest.fn(),
}))

jest.mock('@/lib/usage/allowance', () => ({
  checkCustomersAiAllowance: jest.fn(),
}))

jest.mock('@/lib/usage/meter', () => ({
  meterCustomersAi: jest.fn(),
}))

import { POST as chatPOST } from '../chat/route'
import { POST as generatePOST } from '../generate/route'

type ProviderCase = {
  provider: 'anthropic' | 'openai'
  platformApiKey: string
  byoApiKey?: string
  expectedApiKey: string
  endpoint: string
  header: string
  headerValue: (apiKey: string) => string
  tokensIn: number
  tokensOut: number
}

const providerCases: ProviderCase[] = [
  {
    provider: 'anthropic',
    platformApiKey: 'platform-anthropic',
    expectedApiKey: 'platform-anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    header: 'x-api-key',
    headerValue: (apiKey) => apiKey,
    tokensIn: 8,
    tokensOut: 3,
  },
  {
    provider: 'openai',
    platformApiKey: 'platform-openai',
    byoApiKey: 'customer-openai',
    expectedApiKey: 'customer-openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    header: 'Authorization',
    headerValue: (apiKey) => `Bearer ${apiKey}`,
    tokensIn: 9,
    tokensOut: 4,
  },
]

const auth = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  orgId: 'crm-org-1',
  email: 'owner@example.test',
  roles: [],
}

const mockGetAuthFromCookies = jest.mocked(getAuthFromCookies)
const mockCheckCustomersAiAllowance = jest.mocked(checkCustomersAiAllowance)
const mockMeterCustomersAi = jest.mocked(meterCustomersAi)
const originalEnv = process.env
const originalFetch = global.fetch
const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>

function providerResponse(providerCase: ProviderCase): Response {
  const body = providerCase.provider === 'anthropic'
    ? {
        content: [{ text: '<main>Anthropic content</main>' }],
        usage: { input_tokens: providerCase.tokensIn, output_tokens: providerCase.tokensOut },
      }
    : {
        choices: [{ message: { content: '<main>OpenAI content</main>' } }],
        usage: { prompt_tokens: providerCase.tokensIn, completion_tokens: providerCase.tokensOut },
      }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function chatRequest(): Request {
  return new Request('http://localhost/api/landing-pages/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Build a page' }] }),
  })
}

function generateRequest(): Request {
  return new Request('http://localhost/api/landing-pages/ai/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: 'services-velocity',
      templateCategory: 'services',
      messages: [{ role: 'user', content: 'A bookkeeping service' }],
    }),
  })
}

describe('landing-page provider routing', () => {
  afterAll(() => {
    process.env = originalEnv
    global.fetch = originalFetch
  })

  beforeEach(() => {
    jest.clearAllMocks()
    fetchMock.mockReset()
    process.env = {
      ...originalEnv,
      GOOGLE_GENERATIVE_AI_API_KEY: 'platform-google',
      ANTHROPIC_API_KEY: 'platform-anthropic',
      OPENAI_API_KEY: 'platform-openai',
    }
    global.fetch = fetchMock
    mockGetAuthFromCookies.mockResolvedValue(auth)
  })

  describe.each([
    { routeName: 'chat', feature: 'lp-chat', request: chatRequest, post: chatPOST },
    { routeName: 'generate', feature: 'landing-generate', request: generateRequest, post: generatePOST },
  ])('$routeName route', ({ feature, request, post }) => {
    it.each(providerCases)(
      'selects the $provider gate, credential, model, and metering ownership',
      async (providerCase) => {
        const model = `${providerCase.provider}-test-model`
        process.env.AI_PROVIDER = providerCase.provider
        process.env.AI_MODEL = model
        mockCheckCustomersAiAllowance.mockResolvedValue({
          allowed: true,
          byoApiKey: providerCase.byoApiKey,
        })
        fetchMock.mockResolvedValueOnce(providerResponse(providerCase))

        const response = await post(request())

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({ ok: true })
        expect(mockCheckCustomersAiAllowance).toHaveBeenCalledWith(auth, providerCase.provider)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(String(fetchMock.mock.calls[0][0])).toBe(providerCase.endpoint)
        expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get(providerCase.header)).toBe(
          providerCase.headerValue(providerCase.expectedApiKey),
        )
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model })
        expect(mockMeterCustomersAi).toHaveBeenCalledWith(auth, {
          model,
          tokensIn: providerCase.tokensIn,
          tokensOut: providerCase.tokensOut,
          feature,
          byoKey: Boolean(providerCase.byoApiKey),
        })
      },
    )
  })
})
