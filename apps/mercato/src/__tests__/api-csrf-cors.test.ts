/**
 * The API pipeline's cross-site request forgery guard and the CORS preflight
 * for the public endpoints sandboxed customer pages call (security sweep
 * 2026-09-25, findings 1 and 2). Both the proxy and the [...slug] dispatcher
 * enforce the guard.
 */
import { NextRequest } from 'next/server'

jest.mock('@/bootstrap', () => ({
  bootstrap: jest.fn(),
  isBootstrapped: jest.fn(() => true),
}))

const mockAuth = { sub: 'u1', tenantId: 't1', orgId: 'o1', roles: ['admin'] }
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(async () => mockAuth),
  resolveAuthFromRequest: jest.fn(async (req: Request) =>
    (req.headers.get('cookie') ?? '').includes('__session=')
      ? { status: 'authenticated', auth: mockAuth }
      : { status: 'unauthenticated' },
  ),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: () => null }),
}))

const mockHandler = jest.fn(async () => Response.json({ ok: true }))

jest.mock('@/generated/modules.generated', () => ({
  modules: [
    {
      id: 'probe',
      apis: [
        {
          path: '/calendar/booking-pages',
          metadata: { POST: { requireAuth: true }, DELETE: { requireAuth: true } },
          handlers: { POST: (...args: unknown[]) => mockHandler(...(args as [])), DELETE: (...args: unknown[]) => mockHandler(...(args as [])) },
        },
        {
          path: '/landing_pages/public/[slug]/submit',
          metadata: { POST: { requireAuth: false } },
          handlers: { POST: (...args: unknown[]) => mockHandler(...(args as [])) },
        },
        {
          path: '/own-cors/thing',
          metadata: { POST: { requireAuth: false } },
          handlers: {
            POST: (...args: unknown[]) => mockHandler(...(args as [])),
            OPTIONS: async () => new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': 'https://partner.example' } }),
          },
        },
        {
          path: '/integrations_api/internal/email-send',
          metadata: { POST: { requireAuth: false } },
          handlers: { POST: (...args: unknown[]) => mockHandler(...(args as [])) },
        },
      ],
    },
  ],
}))

import { POST, DELETE, OPTIONS } from '@/app/api/[...slug]/route'
import { registerModules } from '@open-mercato/shared/lib/i18n/server'
import { modules as mockedModules } from '@/generated/modules.generated'
registerModules(mockedModules as never)

const SESSION_COOKIE = '__session=eyJ.x.y'

function req(pathname: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
  return new NextRequest(new URL(`https://crm.noliai.com${pathname}`), init)
}

function ctx(pathname: string) {
  return { params: Promise.resolve({ slug: pathname.replace(/^\/api\//, '').split('/') }) }
}

describe('dispatcher CSRF guard', () => {
  beforeAll(() => {
    process.env.APP_URL = 'https://crm.noliai.com'
  })
  beforeEach(() => mockHandler.mockClear())

  it('refuses the sweep repro (same-site page, text/plain, session cookie) before the handler runs', async () => {
    const res = await POST(req('/api/calendar/booking-pages', {
      method: 'POST',
      headers: { cookie: SESSION_COOKIE, origin: 'https://noliai.com', 'sec-fetch-site': 'same-site', 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ title: '[e2e] csrf probe' }),
    }), ctx('/api/calendar/booking-pages'))
    expect(res.status).toBe(403)
    expect(mockHandler).not.toHaveBeenCalled()
  })

  it('refuses a same-origin write that is not JSON', async () => {
    const res = await POST(req('/api/calendar/booking-pages', {
      method: 'POST',
      headers: { cookie: SESSION_COOKIE, origin: 'https://crm.noliai.com', 'content-type': 'text/plain' },
      body: '{}',
    }), ctx('/api/calendar/booking-pages'))
    expect(res.status).toBe(415)
    expect(mockHandler).not.toHaveBeenCalled()
  })

  it('lets the CRM UI through', async () => {
    const res = await POST(req('/api/calendar/booking-pages', {
      method: 'POST',
      headers: { cookie: SESSION_COOKIE, origin: 'https://crm.noliai.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    }), ctx('/api/calendar/booking-pages'))
    expect(res.status).toBe(200)
    const del = await DELETE(req('/api/calendar/booking-pages', {
      method: 'DELETE',
      headers: { cookie: SESSION_COOKIE, 'sec-fetch-site': 'same-origin' },
    }), ctx('/api/calendar/booking-pages'))
    expect(del.status).toBe(200)
    expect(mockHandler).toHaveBeenCalledTimes(2)
  })

  it('lets API-key and shared-secret callers through (no session cookie)', async () => {
    const res = await POST(req('/api/integrations_api/internal/email-send', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{}',
    }), ctx('/api/integrations_api/internal/email-send'))
    expect(res.status).toBe(200)
  })

  it('lets a sandboxed page (Origin: null, no cookies) submit a public form, with CORS on the answer', async () => {
    const res = await POST(req('/api/landing_pages/public/my-page/submit', {
      method: 'POST',
      headers: { origin: 'null', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: JSON.stringify({ data: { email: 'a@example.com' } }),
    }), ctx('/api/landing_pages/public/my-page/submit'))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })
})

describe('dispatcher CORS preflight', () => {
  it('answers the preflight for public sandboxed-page endpoints without credentials', async () => {
    const res = await OPTIONS(req('/api/landing_pages/public/my-page/submit', {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    }), ctx('/api/landing_pages/public/my-page/submit'))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS')
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it("runs a module's own OPTIONS handler", async () => {
    const res = await OPTIONS(req('/api/own-cors/thing', { method: 'OPTIONS' }), ctx('/api/own-cors/thing'))
    expect(res.headers.get('access-control-allow-origin')).toBe('https://partner.example')
  })

  it('grants no CORS to anything else', async () => {
    const res = await OPTIONS(req('/api/calendar/booking-pages', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), ctx('/api/calendar/booking-pages'))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('proxy CSRF guard', () => {
  let proxy: (req: NextRequest) => Promise<Response>
  beforeAll(async () => {
    process.env.OM_TEST_MODE = '1'
    jest.resetModules()
    proxy = (await import('@/proxy')).default as unknown as (req: NextRequest) => Promise<Response>
  })
  afterAll(() => {
    delete process.env.OM_TEST_MODE
  })

  it('refuses a cross-site cookie-authenticated API write at the edge', async () => {
    const res = await proxy(new NextRequest(new URL('https://crm.noliai.com/api/customers/people'), {
      method: 'POST',
      headers: { host: 'crm.noliai.com', cookie: SESSION_COOKIE, origin: 'https://noliai.com', 'content-type': 'text/plain' },
      body: '{}',
    }))
    expect(res.status).toBe(403)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('passes same-origin writes and cookie-less public posts on to the dispatcher', async () => {
    const same = await proxy(new NextRequest(new URL('https://crm.noliai.com/api/customers/people'), {
      method: 'POST',
      headers: { host: 'crm.noliai.com', cookie: SESSION_COOKIE, origin: 'https://crm.noliai.com', 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(same.status).toBe(200)
    expect(same.headers.get('x-middleware-next')).toBe('1')
    const sandboxed = await proxy(new NextRequest(new URL('https://crm.noliai.com/api/landing_pages/public/p/submit'), {
      method: 'POST',
      headers: { host: 'crm.noliai.com', origin: 'null', 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(sandboxed.headers.get('x-middleware-next')).toBe('1')
  })
})
