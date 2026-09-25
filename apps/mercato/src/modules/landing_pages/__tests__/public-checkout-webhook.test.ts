/** @jest-environment node */
/**
 * The Stripe webhook's handling of landing-page checkouts: a paid session is
 * recorded once against the page owner's organization and the buyer's
 * contact (created through the encrypted ORM path), whatever Stripe retries
 * or redelivers concurrently, and only when the event comes from the
 * business account the session was created on.
 */
import { createFakeKnex } from './fake-knex'
import { CLAIM_STALE_MS, claimLandingPageCheckout } from '../../payments/services/public-checkout'

let tables: Record<string, any[]> = {}
const knexFactory = () => createFakeKnex(tables, {
  unique: {
    payment_records: [['organization_id', 'stripe_checkout_session_id']],
    landing_page_checkouts: [['id'], ['stripe_checkout_session_id']],
  },
})
const createPersonContact = jest.fn()
const findOrMergeContact = jest.fn()
const emitEvent = jest.fn(async () => undefined)
const logTimelineEvent = jest.fn(async () => undefined)

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (name: string) => (name === 'eventBus' ? { emitEvent } : { getKnex: () => knexFactory() }),
  }),
}))
jest.mock('@/modules/customers/lib/contact-write', () => ({ createPersonContact: (...args: any[]) => createPersonContact(...args) }))
jest.mock('@/modules/customers/lib/dedup', () => ({ findOrMergeContact: (...args: any[]) => findOrMergeContact(...args) }))
jest.mock('@/modules/email/lib/email-router', () => ({ sendEmailByPurpose: jest.fn(async () => ({ ok: true })) }))
jest.mock('@/lib/timeline', () => ({ logTimelineEvent: (...args: any[]) => logTimelineEvent(...args) }))
jest.mock('stripe', () => ({
  __esModule: true,
  default: class {
    webhooks = {
      constructEvent: (body: string, sig: string) => {
        if (sig !== 'valid') throw new Error('bad signature')
        return JSON.parse(body)
      },
    }
  },
}))

import { POST as webhookPost } from '../../payments/api/stripe/webhook/route'

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001'
const TEN = 'aaaaaaaa-0000-4000-8000-0000000000aa'
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-000000000001'
const CHECKOUT_ID = 'cccccccc-0000-4000-8000-000000000001'
const PRODUCT = 'aaaaaaaa-1111-4000-8000-000000000001'

function event(overrides: { account?: string | null; metadata?: Record<string, string>; sessionId?: string; paymentStatus?: string } = {}) {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type: 'checkout.session.completed',
    ...(overrides.account === null ? {} : { account: overrides.account ?? 'acct_alpha' }),
    data: {
      object: {
        id: overrides.sessionId ?? 'cs_test_lp1',
        payment_status: overrides.paymentStatus ?? 'paid',
        amount_total: 14900,
        currency: 'usd',
        payment_intent: 'pi_test_1',
        customer_email: 'buyer@example.com',
        customer_details: { email: 'buyer@example.com', name: 'Pat Buyer' },
        metadata: {
          type: 'landing_page', source: 'landing_page', landingPageCheckoutId: CHECKOUT_ID,
          landingPageId: 'alpha-id', landingPageSlug: 'alpha', orgId: ORG, tenantId: TEN, productId: PRODUCT,
          ...(overrides.metadata ?? {}),
        },
      },
    },
  }
}

async function deliver(evt: unknown, sig = 'valid') {
  const res = await webhookPost(new Request('https://crm.example.test/api/payments/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': sig }, body: JSON.stringify(evt),
  }))
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit'
  createPersonContact.mockReset()
  createPersonContact.mockResolvedValue('contact-new')
  findOrMergeContact.mockReset()
  findOrMergeContact.mockResolvedValue({ existing: null })
  emitEvent.mockClear()
  logTimelineEvent.mockReset()
  logTimelineEvent.mockResolvedValue(undefined)
  tables = {
    landing_page_checkouts: [{
      id: CHECKOUT_ID, tenant_id: TEN, organization_id: ORG, landing_page_id: 'alpha-id', source: 'landing_page', item_kind: 'product', item_id: PRODUCT,
      amount: 149, currency: 'usd', mode: 'payment', stripe_account_id: 'acct_alpha', stripe_checkout_session_id: 'cs_test_lp1',
      status: 'pending', claimed_at: null,
    }],
    stripe_connections: [{ organization_id: ORG, tenant_id: TEN, is_active: true, stripe_account_id: 'acct_alpha' }],
    payment_records: [],
    products: [{ id: PRODUCT, organization_id: ORG, tenant_id: TEN, name: 'Alpha coaching', price: 149 }],
    email_lists: [],
  }
})

afterEach(() => jest.restoreAllMocks())

describe('Stripe webhook: landing-page checkouts', () => {
  it('records the payment against the org and a new encrypted contact, once, across retries', async () => {
    const evt = event()
    expect((await deliver(evt)).status).toBe(200)
    expect(tables.payment_records).toHaveLength(1)
    expect(tables.payment_records[0]).toMatchObject({ organization_id: ORG, tenant_id: TEN, amount: 149, stripe_checkout_session_id: 'cs_test_lp1', contact_id: 'contact-new' })
    // The contact is created through the ORM helper (encrypted at rest), never a raw insert.
    expect(createPersonContact).toHaveBeenCalledTimes(1)
    expect(createPersonContact.mock.calls[0][1]).toMatchObject({ organizationId: ORG, tenantId: TEN, primaryEmail: 'buyer@example.com' })
    expect(tables.customer_entities).toBeUndefined()
    expect(tables.landing_page_checkouts[0]).toMatchObject({ status: 'paid', contact_id: 'contact-new', payment_record_id: tables.payment_records[0].id })
    expect(emitEvent).toHaveBeenCalledWith('payment_gateways.payment.captured', expect.objectContaining({ organizationId: ORG, contactId: 'contact-new' }))

    // Stripe redelivers the same event, and a second event for the same session arrives.
    const again = await deliver(evt)
    expect(again).toEqual({ status: 200, json: { received: true, duplicate: true } })
    await deliver(event())
    expect(tables.payment_records).toHaveLength(1)
    expect(createPersonContact).toHaveBeenCalledTimes(1)
  })

  it('records an offer checkout the same way', async () => {
    Object.assign(tables.landing_page_checkouts[0], { source: 'offer', offer_id: 'eeeeeeee-0000-4000-8000-000000000001', landing_page_id: null, page_ref: 'ams:page:42' })
    const evt = event({ metadata: { type: 'offer', source: 'offer', offerId: 'eeeeeeee-0000-4000-8000-000000000001', pageRef: 'ams:page:42' } })
    expect((await deliver(evt)).status).toBe(200)
    expect((await deliver(evt)).json).toEqual({ received: true, duplicate: true })
    expect(tables.payment_records).toHaveLength(1)
    expect(tables.payment_records[0]).toMatchObject({ organization_id: ORG, contact_id: 'contact-new' })
    expect(tables.landing_page_checkouts[0]).toMatchObject({ status: 'paid', contact_id: 'contact-new' })
  })

  it('links an existing contact instead of creating one', async () => {
    findOrMergeContact.mockResolvedValue({ existing: { id: 'contact-existing' } })
    await deliver(event())
    expect(createPersonContact).not.toHaveBeenCalled()
    expect(tables.payment_records[0].contact_id).toBe('contact-existing')
    expect(tables.landing_page_checkouts[0].contact_id).toBe('contact-existing')
  })

  it('asks Stripe to retry while another delivery holds the claim, and lets a stale claim be retaken', async () => {
    tables.landing_page_checkouts[0].status = 'processing'
    tables.landing_page_checkouts[0].claimed_at = new Date()
    expect((await deliver(event())).status).toBe(409)
    expect(tables.payment_records).toHaveLength(0)

    tables.landing_page_checkouts[0].claimed_at = new Date(Date.now() - CLAIM_STALE_MS - 1000)
    expect((await deliver(event())).status).toBe(200)
    expect(tables.payment_records).toHaveLength(1)
  })

  it('only one of two concurrent claims wins', async () => {
    const knex = knexFactory()
    const input = { checkoutId: CHECKOUT_ID, sessionId: 'cs_test_lp1', connectedAccountId: 'acct_alpha', metaOrgId: ORG }
    const [a, b] = await Promise.all([claimLandingPageCheckout(knex as any, input), claimLandingPageCheckout(knex as any, input)])
    expect([a.kind, b.kind].sort()).toEqual(['busy', 'claimed'])
  })

  it('hands the claim back when recording fails, so the retry succeeds', async () => {
    logTimelineEvent.mockRejectedValueOnce(new Error('db down'))
    expect((await deliver(event())).status).toBe(400)
    expect(tables.landing_page_checkouts[0].status).toBe('pending')
    // The retry finds the payment already recorded and completes the checkout.
    expect((await deliver(event())).status).toBe(200)
    expect(tables.payment_records).toHaveLength(1)
    expect(tables.landing_page_checkouts[0].status).toBe('paid')
  })

  it('ignores events that are not from the business account the session was created on', async () => {
    // From the platform account (no connected account) or another business's account.
    expect((await deliver(event({ account: null }))).json).toMatchObject({ ignored: true })
    expect((await deliver(event({ account: 'acct_mallory' }))).json).toMatchObject({ ignored: true })
    // Metadata pointing the payment at another organization.
    expect((await deliver(event({ metadata: { orgId: OTHER_ORG } }))).json).toMatchObject({ ignored: true })
    // A session id that is not the one the checkout started.
    expect((await deliver(event({ sessionId: 'cs_test_forged' }))).json).toMatchObject({ ignored: true })
    // An unknown checkout id.
    expect((await deliver(event({ metadata: { landingPageCheckoutId: 'dddddddd-0000-4000-8000-000000000009' } }))).json).toMatchObject({ ignored: true })
    expect(tables.payment_records).toHaveLength(0)
    expect(tables.landing_page_checkouts[0].status).toBe('pending')
  })

  it('waits for delayed payment methods to settle', async () => {
    expect((await deliver(event({ paymentStatus: 'unpaid' }))).json).toMatchObject({ deferred: 'unpaid' })
    expect(tables.landing_page_checkouts[0].status).toBe('pending')
    expect(tables.payment_records).toHaveLength(0)
  })

  it('rejects unsigned events', async () => {
    expect((await deliver(event(), 'forged')).status).toBe(400)
    expect(tables.payment_records).toHaveLength(0)
  })
})
