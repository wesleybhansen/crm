/**
 * Browser check: customer pages still work under the CSP sandbox.
 *
 * Serves the REAL public page routes and the REAL endpoints they post to
 * through the real proxy and [...slug] dispatcher, on a local HTTP server
 * with an in-memory database, and drives them in headless Chromium:
 *  - a published landing page form submission,
 *  - a funnel: landing page (lead capture) -> upsell (decline) -> thank-you,
 *  - a survey submission,
 *  - a booking.
 * For each it checks the page runs in an opaque origin (it cannot read the
 * visitor's CRM session cookie), that its post arrives with `Origin: null`
 * and no cookies, and that the page shows its success state.
 *
 * Needs a Playwright Chromium; the suite skips when none is installed
 * (the unit-test CI job has none).
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// In-memory knex stand-in (equality and comparison filters, ordering, writes)
// ---------------------------------------------------------------------------
type Row = Record<string, any>
const mockDb: { tables: Record<string, Row[]> } = { tables: {} }

function mockCol(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? name : name.slice(dot + 1)
}

function mockCompare(a: any, op: string, b: any): boolean {
  const x = a instanceof Date ? a.getTime() : a
  const y = b instanceof Date ? b.getTime() : b
  switch (op) {
    case '>': return x > y
    case '>=': return x >= y
    case '<': return x < y
    case '<=': return x <= y
    case '!=': case '<>': return x !== y
    default: return x === y
  }
}

function mockTable(name: string): unknown {
  const table = name.split(/\s+as\s+/i)[0].trim()
  const filters: Array<(r: Row) => boolean> = []
  let order: { col: string; dir: string } | null = null
  let limit: number | null = null
  const rows = (): Row[] => {
    const all = (mockDb.tables[table] ??= [])
    let out = all.filter((r) => filters.every((f) => f(r)))
    if (order) {
      const { col, dir } = order
      out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1))
    }
    return limit === null ? out : out.slice(0, limit)
  }
  const api: Record<string, unknown> = {
    where(a: any, b?: any, c?: any) {
      if (typeof a === 'function') return proxy // nested groups: not modelled
      if (a && typeof a === 'object') {
        for (const [k, v] of Object.entries(a)) filters.push((r) => r[mockCol(k)] === v)
      } else if (c === undefined) {
        filters.push((r) => r[mockCol(a)] === b)
      } else {
        filters.push((r) => mockCompare(r[mockCol(a)], b, c))
      }
      return proxy
    },
    whereNull(col: string) { filters.push((r) => r[mockCol(col)] == null); return proxy },
    whereNotNull(col: string) { filters.push((r) => r[mockCol(col)] != null); return proxy },
    whereIn(col: string, values: unknown[]) { filters.push((r) => values.includes(r[mockCol(col)])); return proxy },
    orderBy(col: string, dir = 'asc') { order = { col: mockCol(col), dir }; return proxy },
    limit(n: number) { limit = n; return proxy },
    first: async () => rows()[0],
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows()).then(resolve, reject),
    insert(values: Row | Row[]) {
      const list = Array.isArray(values) ? values : [values]
      ;(mockDb.tables[table] ??= []).push(...list.map((v) => ({ ...v })))
      return Object.assign(Promise.resolve(list.map(() => 1)), { returning: async () => list })
    },
    update(values: Row) {
      const hit = rows()
      for (const r of hit) Object.assign(r, values)
      return Object.assign(Promise.resolve(hit.length), { returning: async () => hit })
    },
    increment(col: string, by = 1) {
      for (const r of rows()) r[col] = Number(r[col] ?? 0) + by
      return proxy
    },
    count: async () => [{ count: rows().length }],
    del: async () => {
      const keep = (mockDb.tables[table] ?? []).filter((r) => !rows().includes(r))
      mockDb.tables[table] = keep
      return 1
    },
  }
  api.andWhere = api.where
  const proxy: unknown = new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      return () => proxy // select, leftJoin, forUpdate, ...: not modelled
    },
  })
  return proxy
}

const mockKnex: any = Object.assign((name: string) => mockTable(name), {
  raw: async () => ({ rows: [] }),
  fn: { now: () => new Date() },
  transaction: async (fn: (trx: unknown) => unknown) => fn(mockKnex),
})

// ---------------------------------------------------------------------------
// Module mocks: the database, auth, and side effects the handlers fire.
// ---------------------------------------------------------------------------
jest.mock('@/bootstrap', () => ({ bootstrap: jest.fn(), isBootstrapped: jest.fn(() => true) }))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: async () => null,
  getAuthFromCookies: async () => null,
  resolveAuthFromRequest: async () => ({ status: 'unauthenticated' }),
  resolveAuthFromCookies: async () => ({ status: 'unauthenticated' }),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (key: string) => (key === 'em' ? { getKnex: () => mockKnex } : null),
  }),
}))
const mockCookies: { header: string } = { header: '' }
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const hit = mockCookies.header.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name}=`))
      return hit ? { name, value: hit.slice(name.length + 1) } : undefined
    },
  }),
  headers: async () => new Headers(),
}))
const mockAttribute = jest.fn(async () => undefined)
jest.mock('@/modules/customers/api/affiliates/attribute', () => ({ attributeReferral: (...a: unknown[]) => mockAttribute(...(a as [])) }))
jest.mock('@/modules/customers/lib/contact-write', () => ({ createPersonContact: async () => 'contact-1' }))
jest.mock('@/modules/customers/lib/dedup', () => ({ findOrMergeContact: async () => ({ existing: null }) }))
jest.mock('@open-mercato/shared/lib/encryption/rawWrite', () => ({ encryptRowForRawWrite: async (_e: string, row: unknown) => row }))
jest.mock('@/modules/sequences/services/sequence-triggers', () => ({ checkSequenceTriggers: async () => undefined }))
jest.mock('@/modules/customers/lib/engagement-score', () => ({ trackEngagement: async () => undefined }))
jest.mock('@/modules/customers/api/webhooks/dispatch', () => ({ dispatchWebhook: async () => undefined }))
jest.mock('@open-mercato/core/modules/webhooks/lib/dispatch', () => ({ dispatchWebhook: async () => undefined }))
jest.mock('@/modules/sequences/lib/automation-execute', () => ({ executeAutomationRules: async () => undefined }))
jest.mock('@open-mercato/core/modules/customers/lib/sourceTagging', () => ({ tagContactSource: async () => undefined }))
jest.mock('@/modules/calendar/lib/google-calendar-service', () => ({ getGoogleBusyTimes: async () => [], createGoogleCalendarEvent: async () => null }))
jest.mock('@/modules/calendar/lib/booking-emails', () => ({ sendBookingConfirmationToGuest: async () => undefined, sendBookingNotificationToOwner: async () => undefined }))
jest.mock('@/lib/timeline', () => ({ logTimelineEvent: async () => undefined }))

const MOCK_ROUTES = [
  'landing_pages/api/public/[slug]/submit/route',
  'landing_pages/api/public/[slug]/route',
  'landing_pages/api/funnels/public/[slug]/upsell/route',
  'landing_pages/api/funnels/public/[slug]/route',
  'customers/api/surveys/public/[slug]/submit/route',
  'customers/api/surveys/public/[slug]/route',
  'calendar/api/book/[slug]/route',
  'calendar/api/bookings/route',
]
function mockRoutePath(file: string, mod: { metadata?: { path?: string } }): string {
  if (mod.metadata?.path) return mod.metadata.path
  const [moduleId, , ...rest] = file.replace(/\/route$/, '').split('/')
  return `/${moduleId}/${rest.join('/')}`
}
jest.mock('@/generated/modules.generated', () => ({
  modules: [{
    id: 'public-pages',
    apis: MOCK_ROUTES.map((file) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(`@/modules/${file}`)
      return { path: mockRoutePath(file, mod), metadata: mod.metadata, handlers: mod }
    }),
  }],
}))

import * as dispatcher from '@/app/api/[...slug]/route'
import { registerModules } from '@open-mercato/shared/lib/i18n/server'
import { modules as mockedModules } from '@/generated/modules.generated'
import { PUBLIC_SANDBOX_CSP } from '@/lib/public-surface'
import { renderWizardPageHtml } from '@/modules/landing_pages/services/wizard-publish'
registerModules(mockedModules as never)

// ---------------------------------------------------------------------------
// Chromium
// ---------------------------------------------------------------------------
function findChromium(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright')
    const preferred = chromium.executablePath()
    if (preferred && fs.existsSync(preferred)) return preferred
  } catch {
    return null
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')
  if (!fs.existsSync(cache)) return null
  for (const dir of fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-linux64/chrome',
      'chrome-linux/chrome',
    ]) {
      const candidate = path.join(cache, dir, rel)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

const chromiumPath = findChromium()
const describeInBrowser = chromiumPath ? describe : describe.skip

// ---------------------------------------------------------------------------
// Local server: proxy, then the dispatcher, like Next does.
// ---------------------------------------------------------------------------
type Seen = { method: string; path: string; origin: string | null; cookie: string | null; contentType: string | null; body: string }
const seen: Seen[] = []
let baseUrl = ''
let server: http.Server

async function handle(nreq: http.IncomingMessage, nres: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of nreq) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks)
  const url = new URL(nreq.url ?? '/', baseUrl)
  const method = (nreq.method ?? 'GET').toUpperCase()
  const headers = new Headers()
  for (const [k, v] of Object.entries(nreq.headers)) {
    if (typeof v === 'string') headers.set(k, v)
    else if (Array.isArray(v)) headers.set(k, v.join(', '))
  }
  seen.push({ method, path: url.pathname, origin: headers.get('origin'), cookie: headers.get('cookie'), contentType: headers.get('content-type'), body: body.toString('utf8') })
  mockCookies.header = headers.get('cookie') ?? ''
  const makeRequest = () => new NextRequest(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body })

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const proxy = require('@/proxy').default as (req: NextRequest) => Promise<Response>
  let res = await proxy(makeRequest())
  if (res.headers.get('x-middleware-next') === '1' && url.pathname.startsWith('/api/')) {
    const slug = url.pathname.replace(/^\/api\//, '').split('/')
    const handler = (dispatcher as unknown as Record<string, (r: NextRequest, c: unknown) => Promise<Response>>)[method]
    res = handler
      ? await handler(makeRequest(), { params: Promise.resolve({ slug }) })
      : new Response('Method not allowed', { status: 405 })
  }
  const outHeaders: Record<string, string | string[]> = {}
  res.headers.forEach((value, key) => {
    if (key.startsWith('x-middleware')) return
    if (key === 'set-cookie') return
    outHeaders[key] = value
  })
  const setCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  if (setCookies.length) outHeaders['set-cookie'] = setCookies
  nres.writeHead(res.status, outHeaders)
  nres.end(Buffer.from(await res.arrayBuffer()))
}

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '66666666-6666-4666-8666-666666666666'

function landingHtml(slug: string, formAction: string): string {
  return renderWizardPageHtml({
    wizardVersion: 2,
    simpleLayout: true,
    styleId: 'minimal',
    generatedSections: [{ type: 'hero', headline: 'Join the waitlist', subtitle: 'Early access', ctaText: 'Join' } as never],
    formFields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Email', type: 'email', required: true },
    ],
  }, { title: 'Waitlist', slug }, formAction)
}

function seed(): void {
  const now = new Date()
  mockDb.tables = {
    landing_pages: [
      { id: 'lp-1', slug: 'waitlist', title: 'Waitlist', status: 'published', deleted_at: null, organization_id: ORG, tenant_id: TENANT, published_html: landingHtml('waitlist', `${baseUrl}/api/landing_pages/public/waitlist/submit`) },
      { id: 'lp-2', slug: 'funnel-optin', title: 'Opt in', status: 'published', deleted_at: null, organization_id: ORG, tenant_id: TENANT, published_html: landingHtml('funnel-optin', `${baseUrl}/api/landing_pages/public/funnel-optin/submit`) },
    ],
    landing_page_forms: [
      { id: 'form-1', landing_page_id: 'lp-1', fields: JSON.stringify([{ name: 'email', label: 'Email', required: true }]), success_message: 'You are on the list.' },
      { id: 'form-2', landing_page_id: 'lp-2', fields: '[]', success_message: 'Thanks!' },
    ],
    funnels: [{ id: 'fun-1', slug: 'launch', is_published: true, organization_id: ORG }],
    funnel_steps: [
      { id: 'step-1', funnel_id: 'fun-1', step_order: 1, step_type: 'lead_capture', page_id: 'lp-2', config: '{}' },
      { id: 'step-2', funnel_id: 'fun-1', step_order: 2, step_type: 'upsell', product_id: null, config: JSON.stringify({ headline: 'VIP pass', price: 49 }) },
      { id: 'step-3', funnel_id: 'fun-1', step_order: 3, step_type: 'thank_you', config: JSON.stringify({ message: 'Thanks for joining the launch' }) },
    ],
    surveys: [{ id: 'sv-1', slug: 'nps', title: 'How did we do?', is_active: true, organization_id: ORG, tenant_id: TENANT, fields: JSON.stringify([{ id: 'q1', type: 'text', label: 'Comments', required: true }]), thank_you_message: 'Thanks for the feedback' }],
    booking_pages: [{ id: 'bp-1', slug: 'intro', title: 'Intro call', is_active: true, organization_id: ORG, tenant_id: TENANT, duration_minutes: 30, auto_confirm: true, owner_user_id: null, availability: JSON.stringify({ mon: { start: '09:00', end: '17:00' }, tue: { start: '09:00', end: '17:00' }, wed: { start: '09:00', end: '17:00' }, thu: { start: '09:00', end: '17:00' }, fri: { start: '09:00', end: '17:00' }, sat: { start: '09:00', end: '17:00' }, sun: { start: '09:00', end: '17:00' } }), created_at: now }],
  }
}

describeInBrowser('customer pages under the CSP sandbox (Chromium)', () => {
  jest.setTimeout(90_000)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any

  beforeAll(async () => {
    process.env.OM_TEST_MODE = '1'
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    server = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error?.stack ?? error))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`
    process.env.APP_URL = baseUrl
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright')
    browser = await chromium.launch({ executablePath: chromiumPath! })
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    delete process.env.OM_TEST_MODE
  })

  beforeEach(async () => {
    seed()
    seen.length = 0
    mockAttribute.mockClear()
    context = await browser.newContext()
    // A signed-in CRM user (the attacker's target) with a referral cookie.
    await context.addCookies([
      { name: '__session', value: 'victim-session-token', url: baseUrl, sameSite: 'Lax' },
      { name: 'affiliate_ref', value: 'partner_7', url: baseUrl, sameSite: 'Lax' },
    ])
  })

  afterEach(async () => {
    await context?.close()
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function expectOpaqueOrigin(page: any): Promise<void> {
    const probe = await page.evaluate(() => {
      const read = (fn: () => unknown) => { try { return String(fn()) } catch (e) { return `blocked:${(e as Error).name}` } }
      return { origin: window.origin, cookie: read(() => document.cookie), storage: read(() => window.localStorage.length) }
    })
    expect(probe).toEqual({ origin: 'null', cookie: 'blocked:SecurityError', storage: 'blocked:SecurityError' })
  }

  function postsTo(pathname: string): Seen[] {
    return seen.filter((s) => s.path === pathname && s.method === 'POST')
  }

  it('landing page: the form submits, cross-origin and cookie-less, and shows the thank-you', async () => {
    const page = await context.newPage()
    const res = await page.goto(`${baseUrl}/api/landing_pages/public/waitlist`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-security-policy']).toBe(PUBLIC_SANDBOX_CSP)
    await expectOpaqueOrigin(page)

    await page.fill('#name', 'Dana Visitor')
    await page.fill('#email', 'dana@example.com')
    await page.click('#lp-form [type="submit"]')
    await page.waitForSelector('#lp-success', { state: 'visible', timeout: 10_000 })
    expect(await page.textContent('#lp-success p')).toBe('You are on the list.')

    const [post] = postsTo('/api/landing_pages/public/waitlist/submit')
    expect(post).toMatchObject({ origin: 'null', cookie: null })
    expect(post.contentType).toMatch(/^application\/json/)
    expect(seen.some((s) => s.method === 'OPTIONS' && s.path === '/api/landing_pages/public/waitlist/submit')).toBe(true)
    const stored = JSON.parse(mockDb.tables.form_submissions[0].data)
    expect(stored).toMatchObject({ name: 'Dana Visitor', email: 'dana@example.com' })
    expect(stored).not.toHaveProperty('_aff_ref')
    // The referral cookie reached the submit handler via the hidden field.
    expect(mockAttribute).toHaveBeenCalledWith(mockKnex, ORG, TENANT, 'dana@example.com', undefined, 'partner_7')
  })

  it('funnel: opt-in page advances to the upsell, declining lands on the thank-you page', async () => {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/api/landing_pages/funnels/public/launch`)
    expect(page.url()).toContain('/api/landing_pages/public/funnel-optin?funnel_sid=')
    await expectOpaqueOrigin(page)

    await page.fill('#name', 'Funnel Visitor')
    await page.fill('#email', 'funnel@example.com')
    await Promise.all([
      page.waitForURL(/step=step-2/, { timeout: 10_000 }),
      page.click('#lp-form [type="submit"]'),
    ])
    await page.waitForSelector('text=VIP pass')
    const upsellResponse = seen.filter((s) => s.path === '/api/landing_pages/funnels/public/launch' && s.method === 'GET').pop()
    expect(upsellResponse).toBeTruthy()
    await expectOpaqueOrigin(page)
    expect(mockDb.tables.funnel_sessions[0]).toMatchObject({ email: 'funnel@example.com', current_step_id: 'step-2' })

    await Promise.all([
      page.waitForURL(/step=step-3/, { timeout: 10_000 }),
      page.click('.btn-decline'),
    ])
    await page.waitForSelector('text=Thanks for joining the launch')
    const [decline] = postsTo('/api/landing_pages/funnels/public/launch/upsell')
    expect(decline).toMatchObject({ origin: 'null', cookie: null })
  })

  it('survey: submits and shows the thank-you card', async () => {
    const page = await context.newPage()
    const res = await page.goto(`${baseUrl}/api/surveys/public/nps`)
    expect(res.headers()['content-security-policy']).toBe(PUBLIC_SANDBOX_CSP)
    await expectOpaqueOrigin(page)
    await page.fill('input[name="field_q1"]', 'Great service')
    await page.click('button[type="submit"]')
    await page.waitForSelector('#thank-you-card', { state: 'visible', timeout: 10_000 })
    expect(await page.textContent('#thank-you-msg')).toBe('Thanks for the feedback')
    const [post] = postsTo('/api/surveys/public/nps/submit')
    expect(post).toMatchObject({ origin: 'null', cookie: null })
    expect(mockDb.tables.survey_responses).toHaveLength(1)
  })

  it('booking page: picks a slot, books it and shows the confirmation', async () => {
    const page = await context.newPage()
    const res = await page.goto(`${baseUrl}/api/calendar/book/intro`)
    expect(res.headers()['content-security-policy']).toBe(PUBLIC_SANDBOX_CSP)
    await expectOpaqueOrigin(page)
    await page.click('.calendar-day[data-date]')
    await page.locator('#time-grid button').first().click()
    await page.waitForSelector('#guestName', { state: 'visible' })
    await page.fill('#guestName', 'Booker')
    await page.fill('#guestEmail', 'booker@example.com')
    await page.click('#submit-btn')
    await page.waitForSelector('#success-container', { state: 'visible', timeout: 10_000 })
    const [post] = postsTo('/api/calendar/bookings')
    expect(post).toMatchObject({ origin: 'null', cookie: null })
    expect(mockDb.tables.bookings).toHaveLength(1)
    expect(mockDb.tables.bookings[0]).toMatchObject({ guest_email: 'booker@example.com', status: 'confirmed' })
  })

  it('a same-site page cannot ride the CRM session to make a change (CSRF)', async () => {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/api/surveys/public/nps`)
    // From the CRM origin's point of view, a text/plain no-cors POST from
    // another origin carrying the session cookie is exactly the sweep repro.
    const status = await new Promise<number>((resolve) => {
      const req = http.request(`${baseUrl}/api/calendar/booking-pages`, {
        method: 'POST',
        headers: { cookie: '__session=victim-session-token', origin: 'https://noliai.com', 'sec-fetch-site': 'same-site', 'content-type': 'text/plain' },
      }, (r) => { r.resume(); resolve(r.statusCode ?? 0) })
      req.end('{"title":"[e2e] csrf probe"}')
    })
    expect(status).toBe(403)
  })
})
