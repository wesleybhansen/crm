/**
 * Regression: every public route that serves an HTML page (customer-authored
 * or visitor-facing) answers with the CSP sandbox, through the real API
 * dispatcher. Security sweep 2026-09-25, critical finding 1: a customer's
 * landing page ran its own script as crm.noliai.com.
 */
import path from 'node:path'
import { NextRequest } from 'next/server'
import { PUBLIC_SANDBOX_CSP } from '@/lib/public-surface'

jest.mock('@/bootstrap', () => ({
  bootstrap: jest.fn(),
  isBootstrapped: jest.fn(() => true),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(async () => null),
  getAuthFromCookies: jest.fn(async () => null),
  resolveAuthFromRequest: jest.fn(async () => ({ status: 'unauthenticated' })),
  resolveAuthFromCookies: jest.fn(async () => ({ status: 'unauthenticated' })),
}))

jest.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
}))

jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: async () => undefined,
}))

// A chainable stand-in for knex: filters are ignored, every read of a table
// returns its fixture rows (or none), writes succeed.
type Rows = Record<string, Array<Record<string, unknown>>>
const mockState: { rows: Rows } = { rows: {} }

function mockBuilder(table: string): unknown {
  const rows = () => mockState.rows[table.split(/\s+as\s+/i)[0]] ?? []
  const builder: unknown = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(rows()).then(resolve, reject)
      }
      if (prop === 'first') return async () => rows()[0]
      if (['insert', 'update', 'increment', 'decrement', 'del', 'delete'].includes(String(prop))) {
        return () => {
          const done = Promise.resolve([1])
          return Object.assign(done, { returning: async () => rows() })
        }
      }
      if (prop === 'count') return () => Promise.resolve([{ count: rows().length }])
      return () => builder
    },
    apply() {
      return builder
    },
  })
  return builder
}

const mockKnex = Object.assign((table: string) => mockBuilder(table), {
  raw: async () => ({ rows: [] }),
  fn: { now: () => new Date() },
  transaction: async (fn: (trx: unknown) => unknown) => fn(mockKnex),
})

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (key: string) => {
      if (key === 'em') return { getKnex: () => mockKnex, fork: () => ({ getKnex: () => mockKnex }) }
      return null
    },
  }),
}))

// The real public HTML route modules, registered at their real paths.
const MOCK_PUBLIC_HTML_ROUTES = [
  'landing_pages/api/public/by-domain/route',
  'landing_pages/api/public/[slug]/route',
  'landing_pages/api/funnels/public/[slug]/checkout/route',
  'landing_pages/api/funnels/public/[slug]/route',
  'landing_pages/api/templates/preview/[templateId]/route',
  'forms/api/public/[slug]/route',
  'customers/api/surveys/public/[slug]/route',
  'calendar/api/book/[slug]/route',
  'calendar/api/bookings/confirm/route',
  'customers/api/chat/page/[slug]/route',
  'customers/api/crm-events/public/[slug]/route',
  'customers/api/crm-events/kiosk/[token]/route',
  'customers/api/affiliates/signup/route',
  'customers/api/affiliates/dashboard/[code]/route',
  'courses/api/public/[slug]/route',
  'courses/api/student/verify/route',
  'email/api/preferences/[token]/route',
  'gtm/api/unsubscribe/route',
]

function mockRoutePath(file: string, mod: { metadata?: { path?: string } }): string {
  if (mod.metadata?.path) return mod.metadata.path
  const [moduleId, , ...rest] = file.replace(/\/route$/, '').split('/')
  return `/${moduleId}/${rest.join('/')}`
}

jest.mock('@/generated/modules.generated', () => {
  const apis = MOCK_PUBLIC_HTML_ROUTES.map((file) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(`@/modules/${file}`)
    return { path: mockRoutePath(file, mod), metadata: mod.metadata, handlers: mod }
  })
  return { modules: [{ id: 'public-html', apis }] }
})

import { GET } from '@/app/api/[...slug]/route'
import { registerModules } from '@open-mercato/shared/lib/i18n/server'
import { modules as mockedModules } from '@/generated/modules.generated'
import { signEmailToken } from '@/lib/email-token'
import { signUnsubscribeToken } from '@/modules/gtm/lib/unsubscribe'
registerModules(mockedModules as never)

const ORG = '11111111-1111-4111-8111-111111111111'
const ID = '22222222-2222-4222-8222-222222222222'
const PAGE_HTML = '<!DOCTYPE html><html><body><form id="lp-form"></form><script>document.cookie</script></body></html>'
const future = new Date(Date.now() + 7 * 86400000)

const FIXTURES: Rows = {
  landing_pages: [{ id: ID, slug: 'p', title: 'Page', status: 'published', published_html: PAGE_HTML, organization_id: ORG, tenant_id: ORG, custom_domain: 'example.com' }],
  landing_page_forms: [],
  funnels: [{ id: ID, slug: 'f', name: 'Funnel', is_published: true, organization_id: ORG }],
  funnel_steps: [{ id: ID, funnel_id: ID, step_order: 1, step_type: 'thank_you', config: '{"message":"Thanks"}' }],
  funnel_sessions: [{ id: ID, funnel_id: ID, status: 'active', current_step_id: ID }],
  funnel_orders: [],
  forms: [{ id: ID, slug: 'contact', name: 'Contact', title: 'Contact', status: 'published', is_active: true, organization_id: ORG, fields: '[]', settings: '{}' }],
  surveys: [{ id: ID, slug: 'nps', title: 'NPS', is_active: true, status: 'active', organization_id: ORG, fields: '[]' }],
  booking_pages: [{ id: ID, slug: 'call', title: 'Call', duration_minutes: 30, is_active: true, organization_id: ORG, owner_user_id: ID, availability: '{}' }],
  bookings: [{ id: ID, booking_page_id: ID, guest_name: '<img src=x onerror=alert(1)>', start_time: future, end_time: future, status: 'pending' }],
  chat_widgets: [{ id: ID, slug: 'help', name: 'Help', is_active: true, organization_id: ORG, brand_color: '#123456' }],
  events: [{ id: ID, slug: 'launch', title: 'Launch', status: 'published', organization_id: ORG, start_time: future, end_time: future, event_type: 'virtual', kiosk_token: 'tok' }],
  affiliates: [{ id: ID, affiliate_code: 'code', name: 'Aff', email: 'a@example.com', status: 'active', organization_id: ORG }],
  courses: [{ id: ID, slug: 'course', title: 'Course', is_published: true, organization_id: ORG, price: 0 }],
  course_modules: [],
  course_lessons: [],
  customer_entities: [{ id: ID, organization_id: ORG, tenant_id: ORG, display_name: 'Guest', primary_email: 'guest@example.com' }],
  email_preference_categories: [{ id: ID, organization_id: ORG, name: 'News', slug: 'news' }],
  email_preferences: [],
  gtm_enrollments: [],
}

async function get(pathname: string): Promise<Response> {
  const url = new URL(`http://localhost:3000/api${pathname}`)
  const slug = url.pathname.replace(/^\/api\//, '').split('/')
  return GET(new NextRequest(url), { params: Promise.resolve({ slug }) })
}

const REQUESTS = [
  '/landing_pages/public/p',
  '/landing_pages/public/by-domain?host=example.com',
  '/landing_pages/funnels/public/f',
  '/landing_pages/funnels/public/f/checkout?sid=' + ID,
  '/landing_pages/templates/preview/booking-bold',
  '/forms/public/contact',
  '/surveys/public/nps',
  '/calendar/book/call',
  '/calendar/bookings/confirm?token=t',
  '/calendar/bookings/confirm',
  '/chat/page/help',
  '/crm-events/public/launch',
  '/crm-events/kiosk/tok',
  '/affiliates/signup?org=' + ORG,
  '/affiliates/dashboard/code',
  '/courses/public/course',
  '/courses/student/verify',
  `/email/preferences/${signEmailToken(ID, ORG)}`,
  `/gtm/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(ID, 'a'.repeat(64), 'test-unsubscribe-secret') ?? '')}`,
]

describe('public HTML routes answer with the CSP sandbox', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    jest.spyOn(console, "error").mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    mockState.rows = {}
  })

  it.each(REQUESTS)('%s: every HTML response is sandboxed, with or without data', async (pathname) => {
    let htmlResponses = 0
    for (const rows of [FIXTURES, {}]) {
      mockState.rows = rows
      const res = await get(pathname)
      const type = res.headers.get('content-type') ?? ''
      if (/text\/html/i.test(type)) {
        htmlResponses++
        expect({ pathname, csp: res.headers.get('content-security-policy') }).toEqual({ pathname, csp: PUBLIC_SANDBOX_CSP })
      }
    }
    // Each route is in this list because it serves HTML: make sure it did.
    expect({ pathname, served: htmlResponses > 0 }).toEqual({ pathname, served: true })
  })

  it('serves the published landing page itself sandboxed, scripts and all', async () => {
    mockState.rows = FIXTURES
    const res = await get('/landing_pages/public/p')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(PUBLIC_SANDBOX_CSP)
    expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    const body = await res.text()
    expect(body).toContain('<script>document.cookie</script>')
  })

  it('escapes the guest name on the booking confirmation page', async () => {
    mockState.rows = FIXTURES
    const res = await get('/calendar/bookings/confirm?token=t')
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).not.toContain('<img src=x')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('registers every listed route file', () => {
    for (const file of MOCK_PUBLIC_HTML_ROUTES) {
      expect(require.resolve(path.join(__dirname, '../modules', `${file}.ts`))).toBeTruthy()
    }
  })
})
