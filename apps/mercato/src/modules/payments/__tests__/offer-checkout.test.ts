/** @jest-environment node */
/**
 * Offers (checkout_offers) and their public checkout,
 * POST /api/payments/public/offers/{id}/checkout (2026-09-25). A marketing
 * page names an offer and where to send the buyer back; the offer fixes the
 * product, price and seller, and the buyer may only be returned to one of the
 * offer's hosts. Also the owner API (/api/payments/offers) and the API-key
 * listing (/api/ext/offers).
 */
import { createFakeKnex } from '../../landing_pages/__tests__/fake-knex'

const stripeCreate = jest.fn()
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
    accounts = { retrieve: async (id: string) => ({ id, charges_enabled: id !== 'acct_disabled' }) }
  },
}))

import { POST as offerCheckout } from '../api/public/offers/[offerId]/checkout/route'
import { GET as ownerList, POST as ownerCreate, PUT as ownerUpdate } from '../api/offers/route'
import { GET as extList } from '../../integrations_api/api/ext/offers/route'
import {
  BAD_RETURN_URL_MESSAGE,
  NOT_SET_UP_MESSAGE,
  allowedReturnUrl,
  clearChargesEnabledCache,
  resetCheckoutLimiters,
} from '../services/public-checkout'

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TEN_A = 'aaaaaaaa-0000-4000-8000-0000000000aa'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001'
const TEN_B = 'bbbbbbbb-0000-4000-8000-0000000000bb'
const PROD_A = 'aaaaaaaa-1111-4000-8000-000000000001'
const PROD_A_SUB = 'aaaaaaaa-1111-4000-8000-000000000003'
const PROD_B = 'bbbbbbbb-1111-4000-8000-000000000001'
const COURSE_A = 'aaaaaaaa-2222-4000-8000-000000000001'
const OFFER_A = 'aaaaaaaa-3333-4000-8000-000000000001'
const OFFER_A_OFF = 'aaaaaaaa-3333-4000-8000-000000000002'
const OFFER_A_MISMATCH = 'aaaaaaaa-3333-4000-8000-000000000003'
const OFFER_A_FOREIGN = 'aaaaaaaa-3333-4000-8000-000000000004'
const OFFER_A_COURSE = 'aaaaaaaa-3333-4000-8000-000000000005'
const OFFER_B = 'bbbbbbbb-3333-4000-8000-000000000001'

function offer(id: string, org: string, tenant: string, extra: Record<string, any>) {
  return {
    id, organization_id: org, tenant_id: tenant, name: null, product_id: null, course_id: null, mode: 'payment',
    success_url_hosts: ['pages.noliai.com', 'shop.alpha.example'], allowed_upsell_offer_ids: [], active: true,
    created_at: new Date('2026-09-25T10:00:00Z'), updated_at: new Date('2026-09-25T10:00:00Z'), ...extra,
  }
}

beforeEach(() => {
  stripeCreate.mockReset()
  stripeCreate.mockImplementation(async () => {
    const n = stripeCreate.mock.calls.length
    return { id: `cs_test_o${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_o${n}` }
  })
  clearChargesEnabledCache()
  resetCheckoutLimiters()
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit'
  process.env.APP_URL = 'https://crm.example.test'
  delete process.env.PUBLIC_PAGES_HOST
  tables = {
    products: [
      { id: PROD_A, organization_id: ORG_A, tenant_id: TEN_A, name: 'Alpha coaching', price: 149, currency: 'USD', billing_type: 'one_time', is_active: true, deleted_at: null },
      { id: PROD_A_SUB, organization_id: ORG_A, tenant_id: TEN_A, name: 'Alpha club', price: 29, currency: 'USD', billing_type: 'recurring', recurring_interval: 'month', is_active: true, deleted_at: null },
      { id: PROD_B, organization_id: ORG_B, tenant_id: TEN_B, name: 'Bravo secret', price: 999, currency: 'USD', billing_type: 'one_time', is_active: true, deleted_at: null },
    ],
    courses: [
      { id: COURSE_A, organization_id: ORG_A, tenant_id: TEN_A, title: 'Alpha course', price: 59, currency: 'USD', is_published: true, is_free: false, deleted_at: null },
    ],
    checkout_offers: [
      offer(OFFER_A, ORG_A, TEN_A, { product_id: PROD_A }),
      offer(OFFER_A_OFF, ORG_A, TEN_A, { product_id: PROD_A, active: false }),
      offer(OFFER_A_MISMATCH, ORG_A, TEN_A, { product_id: PROD_A_SUB, mode: 'payment' }),
      // A row pointing at another business's product (tampered or stale).
      offer(OFFER_A_FOREIGN, ORG_A, TEN_A, { product_id: PROD_B }),
      offer(OFFER_A_COURSE, ORG_A, TEN_A, { course_id: COURSE_A }),
      offer(OFFER_B, ORG_B, TEN_B, { product_id: PROD_B, success_url_hosts: ['pages.noliai.com'] }),
    ],
    stripe_connections: [
      { organization_id: ORG_A, is_active: true, stripe_account_id: 'acct_alpha' },
      { organization_id: ORG_B, is_active: true, stripe_account_id: 'acct_bravo' },
    ],
    landing_pages: [{ id: 'lp1', organization_id: ORG_A, custom_domain: 'Go.Alpha.Example', deleted_at: null }],
    landing_page_checkouts: [],
  }
})

async function buy(offerId: string, body: unknown, ip = '203.0.113.7') {
  const res = await offerCheckout(
    new Request(`https://crm.example.test/api/payments/public/offers/${offerId}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://pages.noliai.com', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ offerId }) },
  )
  return { status: res.status, json: await res.json() }
}

const RETURN = 'https://pages.noliai.com/alpha/thanks?utm_source=ig#top'

describe('offer checkout', () => {
  it("creates the session on the business's account at the product's price and returns { url }", async () => {
    const res = await buy(OFFER_A, { requestId: 'req-offer-001', email: 'buyer@example.com', returnUrl: RETURN, pageRef: 'ams:page:42' })
    expect(res).toEqual({ status: 200, json: { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_o1' } })
    const [params, opts] = stripeCreate.mock.calls[0]
    expect(opts.stripeAccount).toBe('acct_alpha')
    expect(params.line_items[0].price_data).toMatchObject({ unit_amount: 14900, currency: 'usd' })
    expect(params.success_url).toBe('https://pages.noliai.com/alpha/thanks?utm_source=ig&checkout_session_id={CHECKOUT_SESSION_ID}#top')
    expect(params.cancel_url).toBe('https://pages.noliai.com/alpha/thanks?utm_source=ig&checkout=cancelled#top')
    expect(params.metadata).toMatchObject({ type: 'offer', source: 'offer', offerId: OFFER_A, pageRef: 'ams:page:42', orgId: ORG_A, productId: PROD_A })
    expect(tables.landing_page_checkouts[0]).toMatchObject({ source: 'offer', offer_id: OFFER_A, page_ref: 'ams:page:42', landing_page_id: null, item_id: PROD_A, stripe_account_id: 'acct_alpha' })
  })

  it("never takes a price, product or account from the request", async () => {
    await buy(OFFER_A, { returnUrl: RETURN, price: 1, productId: PROD_B, unit_amount: 1, stripeAccount: 'acct_bravo', orgId: ORG_B })
    const [params, opts] = stripeCreate.mock.calls[0]
    expect(params.line_items[0].price_data.unit_amount).toBe(14900)
    expect(params.line_items[0].price_data.product_data.name).toBe('Alpha coaching')
    expect(opts.stripeAccount).toBe('acct_alpha')
  })

  it("accepts a cancelUrl on the offer's hosts", async () => {
    await buy(OFFER_A, { returnUrl: RETURN, cancelUrl: 'https://shop.alpha.example/offer' })
    expect(stripeCreate.mock.calls[0][0].cancel_url).toBe('https://shop.alpha.example/offer')
  })

  it("refuses return URLs off the offer's hosts", async () => {
    for (const returnUrl of [
      undefined,
      'not a url',
      'http://pages.noliai.com/alpha', // not https
      'https://evil.example/alpha',
      'https://pages.noliai.com.evil.example/alpha', // lookalike
      'https://evil@pages.noliai.com/alpha', // credentials
      'https://crm.example.test/alpha',
      'javascript:alert(1)',
    ]) {
      const res = await buy(OFFER_A, { returnUrl })
      expect({ returnUrl, res }).toEqual({ returnUrl, res: { status: 400, json: { ok: false, error: BAD_RETURN_URL_MESSAGE } } })
    }
    expect((await buy(OFFER_A, { returnUrl: RETURN, cancelUrl: 'https://evil.example/' })).status).toBe(400)
    // Another business's offer does not list this business's custom domain.
    expect((await buy(OFFER_B, { returnUrl: 'https://shop.alpha.example/x' })).json.error).toBe(BAD_RETURN_URL_MESSAGE)
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it("says it isn't set up for inactive offers, foreign products, mode mismatches, and unconnected or disabled accounts", async () => {
    expect((await buy(OFFER_A_OFF, { returnUrl: RETURN })).json.error).toBe(NOT_SET_UP_MESSAGE)
    expect((await buy(OFFER_A_FOREIGN, { returnUrl: RETURN })).json.error).toBe(NOT_SET_UP_MESSAGE)
    expect((await buy(OFFER_A_MISMATCH, { returnUrl: RETURN })).json.error).toBe(NOT_SET_UP_MESSAGE)
    tables.stripe_connections[0].stripe_account_id = 'acct_disabled'
    expect((await buy(OFFER_A, { returnUrl: RETURN })).json.error).toBe(NOT_SET_UP_MESSAGE)
    tables.stripe_connections = tables.stripe_connections.slice(1)
    expect((await buy(OFFER_A, { returnUrl: RETURN })).json.error).toBe(NOT_SET_UP_MESSAGE)
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it('answers 404 for unknown or malformed offer ids', async () => {
    expect((await buy('bbbbbbbb-3333-4000-8000-00000000dead', { returnUrl: RETURN })).status).toBe(404)
    expect((await buy('not-a-uuid', { returnUrl: RETURN })).status).toBe(404)
  })

  it('sells a course offer (email required)', async () => {
    expect((await buy(OFFER_A_COURSE, { returnUrl: RETURN })).status).toBe(400)
    await buy(OFFER_A_COURSE, { returnUrl: RETURN, email: 'student@x.co' })
    expect(stripeCreate.mock.calls[0][0].metadata).toMatchObject({ type: 'course', courseId: COURSE_A, studentEmail: 'student@x.co' })
  })

  it('reuses one session for a double click', async () => {
    const a = await buy(OFFER_A, { returnUrl: RETURN, requestId: 'req-offer-dbl' })
    const b = await buy(OFFER_A, { returnUrl: RETURN, requestId: 'req-offer-dbl' })
    expect(a.json.url).toBe(b.json.url)
    expect(stripeCreate).toHaveBeenCalledTimes(1)
  })

  it('rate limits one visitor per offer', async () => {
    for (let i = 0; i < 10; i++) expect((await buy(OFFER_A, { returnUrl: RETURN })).status).toBe(200)
    expect((await buy(OFFER_A, { returnUrl: RETURN })).status).toBe(429)
    expect((await buy(OFFER_A, { returnUrl: RETURN }, '198.51.100.3')).status).toBe(200)
  })

  it('matches return hosts exactly', () => {
    expect(allowedReturnUrl('https://PAGES.noliai.com/x', ['pages.noliai.com'])).not.toBeNull()
    expect(allowedReturnUrl('https://sub.pages.noliai.com/x', ['pages.noliai.com'])).toBeNull()
    expect(allowedReturnUrl('https://pages.noliai.com:8443/x', ['pages.noliai.com'])).not.toBeNull()
  })
})

const ownerCtx = (org = ORG_A, tenant = TEN_A) => ({ auth: { orgId: org, tenantId: tenant, sub: 'user-1' } })
const json = (url: string, method: string, body?: unknown) => new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

describe('owner offers API', () => {
  it("creates an offer for the business's own product with default hosts", async () => {
    const res = await ownerCreate(json('https://crm.example.test/api/payments/offers', 'POST', { productId: PROD_A_SUB, name: 'Club' }), ownerCtx())
    expect(res.status).toBe(201)
    const { data } = await res.json()
    expect(data).toMatchObject({ name: 'Club', mode: 'subscription', active: true, item: { kind: 'product', id: PROD_A_SUB, amount: 29, interval: 'month' } })
    expect(data.successUrlHosts.sort()).toEqual(['go.alpha.example', 'pages.noliai.com'])
    expect(data.checkoutPath).toBe(`/api/payments/public/offers/${data.id}/checkout`)
  })

  it("refuses another business's product, both or neither item, Noli hosts, and foreign upsells", async () => {
    const create = async (body: unknown) => (await ownerCreate(json('https://crm.example.test/api/payments/offers', 'POST', body), ownerCtx())).status
    expect(await create({ productId: PROD_B })).toBe(400)
    expect(await create({ productId: PROD_A, courseId: COURSE_A })).toBe(400)
    expect(await create({})).toBe(400)
    expect(await create({ productId: PROD_A, successUrlHosts: ['crm.noliai.com'] })).toBe(400)
    expect(await create({ productId: PROD_A, successUrlHosts: ['https://evil path'] })).toBe(400)
    expect(await create({ productId: PROD_A, allowedUpsellOfferIds: [OFFER_B] })).toBe(400)
    expect(await create({ productId: PROD_A, successUrlHosts: ['pages.noliai.com', 'Shop.Alpha.Example'], allowedUpsellOfferIds: [OFFER_A] })).toBe(201)
    expect(tables.checkout_offers.at(-1)).toMatchObject({ success_url_hosts: ['pages.noliai.com', 'shop.alpha.example'], allowed_upsell_offer_ids: [OFFER_A] })
  })

  it("updates only the caller's own offers", async () => {
    const put = (body: unknown, ctx = ownerCtx()) => ownerUpdate(json('https://crm.example.test/api/payments/offers', 'PUT', body), ctx)
    expect((await put({ id: OFFER_B, active: false })).status).toBe(404)
    expect(tables.checkout_offers.find((o) => o.id === OFFER_B).active).toBe(true)
    const res = await put({ id: OFFER_A, active: false, successUrlHosts: ['pages.noliai.com'] })
    expect(res.status).toBe(200)
    expect(tables.checkout_offers.find((o) => o.id === OFFER_A)).toMatchObject({ active: false, success_url_hosts: ['pages.noliai.com'] })
  })

  it("lists only the caller's offers", async () => {
    const res = await ownerList(json('https://crm.example.test/api/payments/offers', 'GET'), ownerCtx(ORG_B, TEN_B))
    const body = await res.json()
    expect(body.data.map((o: any) => o.id)).toEqual([OFFER_B])
  })
})

describe('GET /api/ext/offers (org API key)', () => {
  it("lists the key's organization's active, sellable offers", async () => {
    const res = await extList(new Request('https://crm.example.test/api/ext/offers'), ownerCtx())
    const body = await res.json()
    expect(body.paymentsConnected).toBe(true)
    const ids = body.data.map((o: any) => o.id).sort()
    expect(ids).toEqual([OFFER_A, OFFER_A_COURSE].sort())
    expect(ids).not.toContain(OFFER_B)
    expect(ids).not.toContain(OFFER_A_FOREIGN)
    const a = body.data.find((o: any) => o.id === OFFER_A)
    expect(a).toMatchObject({ item: { name: 'Alpha coaching', amount: 149, currency: 'usd' }, successUrlHosts: ['pages.noliai.com', 'shop.alpha.example'] })
  })

  it('needs an organization', async () => {
    expect((await extList(new Request('https://crm.example.test/api/ext/offers'), { auth: null })).status).toBe(401)
  })
})
