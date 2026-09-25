/** @jest-environment node */
/**
 * Public landing-page checkout (2026-09-25). Wizard pages called
 * /api/landing-page-checkout, which never existed; the only checkout route
 * required a signed-in CRM user. These tests pin the public replacement:
 * the page decides what is sold and at what price, the session is created on
 * the page owner's own connected Stripe account, and nothing a buyer sends
 * can pick another product, another business, or a price.
 */
import { createFakeKnex } from './fake-knex'

const stripeCreate = jest.fn()
const accountsRetrieve = jest.fn()
let tables: Record<string, any[]> = {}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: () => ({ getKnex: () => createFakeKnex(tables, { unique: { landing_page_checkouts: [['id'], ['stripe_checkout_session_id']] } }) }),
  }),
}))
jest.mock('stripe', () => ({
  __esModule: true,
  default: class {
    checkout = { sessions: { create: (params: any, opts: any) => stripeCreate(params, opts) } }
    accounts = { retrieve: (id: string) => accountsRetrieve(id) }
  },
}))

import { POST as checkoutPost } from '../api/public/[slug]/checkout/route'
import { GET as thankYouGet } from '../api/public/[slug]/thank-you/route'
import {
  NOT_SET_UP_MESSAGE,
  WRONG_PRODUCT_MESSAGE,
  clearChargesEnabledCache,
  resetCheckoutLimiters,
} from '../../payments/services/public-checkout'

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TEN_A = 'aaaaaaaa-0000-4000-8000-0000000000aa'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001'
const TEN_B = 'bbbbbbbb-0000-4000-8000-0000000000bb'
const PROD_A = 'aaaaaaaa-1111-4000-8000-000000000001'
const PROD_A_OTHER = 'aaaaaaaa-1111-4000-8000-000000000002'
const PROD_A_SUB = 'aaaaaaaa-1111-4000-8000-000000000003'
const PROD_B = 'bbbbbbbb-1111-4000-8000-000000000001'
const COURSE_A = 'aaaaaaaa-2222-4000-8000-000000000001'

function page(slug: string, org: string, tenant: string, productId: string | null, extra: Record<string, any> = {}) {
  return {
    id: `${slug}-id`, slug, organization_id: org, tenant_id: tenant, status: 'published', deleted_at: null,
    title: slug, config: { wizardVersion: 2, productId, thankYouHeadline: 'Thanks, friend' }, ...extra,
  }
}

beforeEach(() => {
  stripeCreate.mockReset()
  stripeCreate.mockImplementation(async (_params: any, opts: any) => {
    const n = stripeCreate.mock.calls.length
    return { id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, _opts: opts }
  })
  accountsRetrieve.mockReset()
  accountsRetrieve.mockImplementation(async (id: string) => ({ id, charges_enabled: id !== 'acct_disabled' }))
  clearChargesEnabledCache()
  resetCheckoutLimiters()
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit'
  process.env.APP_URL = 'https://crm.example.test'
  tables = {
    landing_pages: [
      page('alpha', ORG_A, TEN_A, PROD_A),
      page('alpha-sub', ORG_A, TEN_A, PROD_A_SUB),
      page('alpha-course', ORG_A, TEN_A, `course:${COURSE_A}`),
      page('alpha-none', ORG_A, TEN_A, null),
      page('alpha-draft', ORG_A, TEN_A, PROD_A, { status: 'draft' }),
      page('alpha-deleted', ORG_A, TEN_A, PROD_A, { deleted_at: new Date() }),
      // A page whose saved config names ANOTHER business's product.
      page('alpha-foreign', ORG_A, TEN_A, PROD_B),
      page('bravo', ORG_B, TEN_B, PROD_B),
    ],
    products: [
      { id: PROD_A, organization_id: ORG_A, tenant_id: TEN_A, name: 'Alpha coaching', description: 'One session', price: 149, currency: 'USD', billing_type: 'one_time', is_active: true, deleted_at: null },
      { id: PROD_A_OTHER, organization_id: ORG_A, tenant_id: TEN_A, name: 'Alpha cheap', price: 1, currency: 'USD', billing_type: 'one_time', is_active: true, deleted_at: null },
      { id: PROD_A_SUB, organization_id: ORG_A, tenant_id: TEN_A, name: 'Alpha club', price: 29, currency: 'USD', billing_type: 'recurring', recurring_interval: 'month', trial_days: 7, collect_phone: true, is_active: true, deleted_at: null },
      { id: PROD_B, organization_id: ORG_B, tenant_id: TEN_B, name: 'Bravo secret', price: 999, currency: 'USD', billing_type: 'one_time', is_active: true, deleted_at: null },
    ],
    courses: [
      { id: COURSE_A, organization_id: ORG_A, tenant_id: TEN_A, title: 'Alpha course', price: 59, currency: 'USD', is_published: true, is_free: false, deleted_at: null },
    ],
    stripe_connections: [
      { organization_id: ORG_A, is_active: true, stripe_account_id: 'acct_alpha' },
      { organization_id: ORG_B, is_active: true, stripe_account_id: 'acct_bravo' },
    ],
    landing_page_checkouts: [],
    business_profiles: [{ organization_id: ORG_A, business_name: 'Alpha Studio' }],
  }
})

async function post(slug: string, body: unknown, ip = '203.0.113.7') {
  const res = await checkoutPost(
    new Request(`https://crm.example.test/api/landing_pages/public/${slug}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  )
  return { status: res.status, json: await res.json() }
}

describe('public landing-page checkout: creating the session', () => {
  it("prices the page's configured product on the business's own connected account", async () => {
    const res = await post('alpha', { productId: PROD_A, email: ' Buyer@Example.com ', name: 'Pat Buyer', requestId: 'req-00000001' })
    expect(res).toEqual({ status: 200, json: { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_1' } })
    expect(stripeCreate).toHaveBeenCalledTimes(1)
    const [params, opts] = stripeCreate.mock.calls[0]
    expect(opts.stripeAccount).toBe('acct_alpha')
    expect(opts.idempotencyKey).toMatch(/^noli-checkout-[0-9a-f]{64}$/)
    expect(params.mode).toBe('payment')
    expect(params.line_items).toEqual([{ price_data: { currency: 'usd', product_data: { name: 'Alpha coaching', description: 'One session' }, unit_amount: 14900 }, quantity: 1 }])
    expect(params.customer_email).toBe('buyer@example.com')
    expect(params.metadata).toMatchObject({ type: 'landing_page', orgId: ORG_A, tenantId: TEN_A, productId: PROD_A, landingPageSlug: 'alpha', customerEmail: 'buyer@example.com', customerName: 'Pat Buyer' })
    expect(params.success_url).toBe('https://crm.example.test/api/landing_pages/public/alpha/thank-you?session_id={CHECKOUT_SESSION_ID}')
    expect(params.cancel_url).toBe('https://crm.example.test/api/landing_pages/public/alpha?checkout=cancelled')
    expect(params).not.toHaveProperty('application_fee_amount')
    const [row] = tables.landing_page_checkouts
    expect(row).toMatchObject({ source: 'landing_page', offer_id: null, page_ref: 'alpha', organization_id: ORG_A, landing_page_id: 'alpha-id', item_kind: 'product', item_id: PROD_A, amount: 149, stripe_account_id: 'acct_alpha', stripe_checkout_session_id: 'cs_test_1', status: 'pending' })
    expect(params.metadata.landingPageCheckoutId).toBe(row.id)
    // No buyer personal data in the checkout row.
    expect(JSON.stringify(row)).not.toContain('buyer@example.com')
  })

  it('works without naming a product (the page decides)', async () => {
    const res = await post('alpha', { email: 'a@b.co' })
    expect(res.status).toBe(200)
    expect(stripeCreate.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(14900)
  })

  it('ignores any price, currency or account the request sends', async () => {
    await post('alpha', { productId: PROD_A, price: 0.01, amount: 1, unit_amount: 1, currency: 'jpy', stripeAccount: 'acct_evil', orgId: ORG_B })
    const [params, opts] = stripeCreate.mock.calls[0]
    expect(params.line_items[0].price_data).toMatchObject({ unit_amount: 14900, currency: 'usd' })
    expect(opts.stripeAccount).toBe('acct_alpha')
    expect(params.metadata.orgId).toBe(ORG_A)
  })

  it("refuses a product that is not the page's configured product (same business)", async () => {
    const res = await post('alpha', { productId: PROD_A_OTHER })
    expect(res).toEqual({ status: 400, json: { ok: false, error: WRONG_PRODUCT_MESSAGE } })
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it("refuses another business's product, by request or by a tampered page config", async () => {
    expect((await post('alpha', { productId: PROD_B })).json.error).toBe(WRONG_PRODUCT_MESSAGE)
    expect((await post('alpha-foreign', { productId: PROD_B })).json.error).toBe(NOT_SET_UP_MESSAGE)
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it('answers 404 for unpublished, deleted and unknown pages', async () => {
    for (const slug of ['alpha-draft', 'alpha-deleted', 'nope']) {
      expect((await post(slug, {})).status).toBe(404)
    }
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it("says the page isn't set up when there is no product, no connected account, charges are off, or no platform key", async () => {
    expect((await post('alpha-none', {})).json).toEqual({ ok: false, error: NOT_SET_UP_MESSAGE })

    tables.stripe_connections = tables.stripe_connections.filter((c) => c.organization_id !== ORG_A)
    expect((await post('alpha', {})).json.error).toBe(NOT_SET_UP_MESSAGE)

    tables.stripe_connections.push({ organization_id: ORG_A, is_active: true, stripe_account_id: 'acct_disabled' })
    expect((await post('alpha', {})).json.error).toBe(NOT_SET_UP_MESSAGE)

    tables.stripe_connections = [{ organization_id: ORG_A, is_active: true, stripe_account_id: 'acct_alpha' }]
    delete process.env.STRIPE_SECRET_KEY
    expect((await post('alpha', {})).json.error).toBe(NOT_SET_UP_MESSAGE)

    tables.products.find((p) => p.id === PROD_A).is_active = false
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit'
    expect((await post('alpha', {})).json.error).toBe(NOT_SET_UP_MESSAGE)
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it('reuses one session for a double click (same request id), and a new one for a new attempt', async () => {
    const first = await post('alpha', { email: 'a@b.co', requestId: 'req-dblclick' })
    const second = await post('alpha', { email: 'a@b.co', requestId: 'req-dblclick' })
    expect(second.json.url).toBe(first.json.url)
    expect(stripeCreate).toHaveBeenCalledTimes(1)
    expect(tables.landing_page_checkouts).toHaveLength(1)
    await post('alpha', { email: 'a@b.co', requestId: 'req-another' })
    expect(stripeCreate).toHaveBeenCalledTimes(2)
  })

  it('sends the same Stripe idempotency key for concurrent duplicates', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    stripeCreate.mockImplementation(async () => { await gate; return { id: 'cs_test_same', url: 'https://checkout.stripe.com/c/pay/cs_test_same' } })
    const a = post('alpha', { email: 'a@b.co', requestId: 'req-concurrent' })
    const b = post('alpha', { email: 'a@b.co', requestId: 'req-concurrent' })
    await new Promise((r) => setTimeout(r, 10))
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.json.url).toBe(rb.json.url)
    expect(stripeCreate.mock.calls[0][1].idempotencyKey).toBe(stripeCreate.mock.calls[1][1].idempotencyKey)
    expect(stripeCreate.mock.calls[0][0]).toEqual(stripeCreate.mock.calls[1][0])
    expect(tables.landing_page_checkouts).toHaveLength(1)
  })

  it('sells subscriptions with the trial and phone collection from the product', async () => {
    await post('alpha-sub', { email: 'a@b.co' })
    const [params] = stripeCreate.mock.calls[0]
    expect(params.mode).toBe('subscription')
    expect(params.line_items[0].price_data.recurring).toEqual({ interval: 'month' })
    expect(params.subscription_data).toMatchObject({ trial_period_days: 7 })
    expect(params.phone_number_collection).toEqual({ enabled: true })
  })

  it('sells a course and requires an email for it', async () => {
    expect((await post('alpha-course', {})).status).toBe(400)
    await post('alpha-course', { email: 'student@x.co', name: 'Sam' })
    const [params] = stripeCreate.mock.calls[0]
    expect(params.metadata).toMatchObject({ type: 'course', courseId: COURSE_A, studentEmail: 'student@x.co', studentName: 'Sam' })
    expect(params.line_items[0].price_data.unit_amount).toBe(5900)
  })

  it('validates the input', async () => {
    expect((await post('alpha', { email: 'not-an-email' })).status).toBe(400)
    expect((await post('alpha', '{not json')).status).toBe(400)
    expect((await post('alpha', JSON.stringify({ name: 'x'.repeat(9000) }))).status).toBe(413)
    expect((await post('alpha', { _hp: 'bot' })).status).toBe(400)
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it('rate limits one visitor per page, and each page overall', async () => {
    for (let i = 0; i < 10; i++) expect((await post('alpha', { requestId: `ip-limit-${i}0000` })).status).toBe(200)
    expect((await post('alpha', { requestId: 'ip-limit-over' })).status).toBe(429)
    // Another visitor is not blocked by the first one's limit.
    expect((await post('alpha', { requestId: 'other-visitor' }, '198.51.100.9')).status).toBe(200)

    resetCheckoutLimiters()
    for (let i = 0; i < 120; i++) await post('bravo', {}, `10.0.${Math.floor(i / 5)}.${i % 5}`)
    expect((await post('bravo', {}, '10.9.9.9')).status).toBe(429)
  })
})

describe('public landing-page checkout: thank-you page', () => {
  it("shows the order only for a session this page started", async () => {
    tables.landing_page_checkouts.push(
      { id: 'c1', landing_page_id: 'alpha-id', organization_id: ORG_A, stripe_checkout_session_id: 'cs_test_abc', item_name: 'Alpha coaching', amount: 149, currency: 'usd', status: 'paid' },
      { id: 'c2', landing_page_id: 'bravo-id', organization_id: ORG_B, stripe_checkout_session_id: 'cs_test_other', item_name: 'Bravo secret', amount: 999, currency: 'usd', status: 'paid' },
    )
    const get = async (slug: string, sid: string) => {
      const res = await thankYouGet(new Request(`https://crm.example.test/api/landing_pages/public/${slug}/thank-you?session_id=${sid}`), { params: Promise.resolve({ slug }) })
      return { status: res.status, type: res.headers.get('content-type'), html: await res.text() }
    }
    const own = await get('alpha', 'cs_test_abc')
    expect(own.status).toBe(200)
    expect(own.type).toContain('text/html')
    expect(own.html).toContain('Thanks, friend')
    expect(own.html).toContain('Alpha Studio')
    expect(own.html).toContain('Alpha coaching')
    expect(own.html).toContain('$149.00')
    expect(own.html).toContain('Payment received')
    expect(own.html).not.toContain('<script')

    const foreign = await get('alpha', 'cs_test_other')
    expect(foreign.html).not.toContain('Bravo secret')
    expect(foreign.html).toContain('Thanks, friend')

    expect((await get('alpha-draft', 'cs_test_abc')).status).toBe(404)
  })
})
