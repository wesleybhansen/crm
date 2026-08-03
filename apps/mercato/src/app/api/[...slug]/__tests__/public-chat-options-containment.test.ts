import { NextRequest } from 'next/server'

jest.mock('@/bootstrap', () => ({
  bootstrap: jest.fn(),
  isBootstrapped: jest.fn(() => true),
}))

jest.mock('@/.mercato/generated/modules.generated', () => ({
  modules: [{
    id: 'unrelated',
    apis: [{
      path: '/unrelated/echo',
      handlers: { GET: async () => new Response('unrelated GET') },
    }],
  }],
}), { virtual: true })

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(async () => null),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({ t: (_key: string, fallback: string) => fallback })),
}))

jest.mock('@open-mercato/shared/modules/events', () => ({
  getGlobalEventBus: jest.fn(() => ({ emit: jest.fn(async () => undefined) })),
}))

jest.mock('@open-mercato/cache', () => ({
  runWithCacheTenant: jest.fn(async (_tenantId: string | null, handler: () => Promise<Response>) => handler()),
}))

import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from '../route'

const CONTAINED_PATHS = [
  ['chat', 'public'],
  ['chat', 'typing'],
  ['chat', 'page', 'launch-test'],
  ['chat', 'widget', 'launch-test'],
  ['chat', 'widgets'],
  ['chat', 'conversations'],
  ['chat', 'messages'],
] as const

const UNRELATED_PATHS = [
  ['chat', 'public', 'extra'],
  ['chat', 'typing', 'extra'],
  ['chat', 'page'],
  ['chat', 'page', 'launch-test', 'extra'],
  ['chat', 'widget'],
  ['chat', 'widget', 'launch-test', 'extra'],
  ['chat', 'widgets', 'extra'],
  ['chat', 'conversations', 'extra'],
  ['chat', 'messages', 'extra'],
  ['chat', 'publicity'],
  ['courses', 'chat'],
] as const

const METHODS = { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } as const
const containedCases = CONTAINED_PATHS.map((slug) => ({ path: slug.join('/'), slug }))
const unrelatedCases = UNRELATED_PATHS.map((slug) => ({ path: slug.join('/'), slug }))

function unreadableRequest(): NextRequest {
  return new Proxy({}, {
    get() {
      throw new Error('request was read before containment')
    },
  }) as NextRequest
}

function context(slug: readonly string[]) {
  return { params: Promise.resolve({ slug: [...slug] }) }
}

describe('production API public-chat launch containment', () => {
  it.each(containedCases)('refuses every method for /api/$path before reading the request', async ({ slug }) => {
    for (const handler of Object.values(METHODS)) {
      const response = await handler(unreadableRequest(), context(slug))

      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      await expect(response.clone().json()).resolves.toEqual({ ok: false, error: 'Not found' })
    }
  })

  it.each(unrelatedCases)('does not widen containment to /api/$path', async ({ slug }) => {
    for (const handler of [DELETE, GET, HEAD, PATCH, POST, PUT]) {
      await expect(handler(unreadableRequest(), context(slug))).rejects.toThrow('request was read before containment')
    }
  })

  it.each(unrelatedCases)('preserves automatic OPTIONS behavior for /api/$path', async ({ slug }) => {
    const response = await OPTIONS(unreadableRequest(), context(slug))

    expect(response.status).toBe(204)
    expect(response.headers.get('allow')).toBe('DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT')
    expect(await response.text()).toBe('')
  })

  it('preserves unrelated GET, HEAD, and OPTIONS production-entrypoint behavior', async () => {
    const slug = ['unrelated', 'echo']
    const getResponse = await GET(new NextRequest('http://localhost/api/unrelated/echo'), context(slug))
    const headResponse = await HEAD(new NextRequest('http://localhost/api/unrelated/echo', { method: 'HEAD' }), context(slug))
    const optionsResponse = await OPTIONS(unreadableRequest(), context(slug))

    expect(getResponse.status).toBe(200)
    expect(await getResponse.text()).toBe('unrelated GET')
    expect(headResponse.status).toBe(200)
    expect(await headResponse.text()).toBe('unrelated GET')
    expect(optionsResponse.status).toBe(204)
    expect(optionsResponse.headers.get('allow')).toBe('DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT')
  })
})
