import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import {
  DEAL_CLOSED_PATH,
  OUTBOUND_MAX_ATTEMPTS,
  buildDealClosedPayload,
  dealClosedEventId,
  drainOutboundEvents,
  enqueueDealClosed,
  extractDealLocation,
  nextBackoffMs,
  normalizeDealSide,
  type LoadedDeal,
  type OutboundDeps,
} from '../outbound-events'
import handler from '../../subscribers/deal-closed-ams'

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const DEAL = '33333333-3333-4333-8333-333333333333'
const CLOSED_AT = new Date('2026-09-28T17:00:00.000Z')

function outboxDb() {
  return createFakeDb(
    { integrations_api_outbound_events: [] },
    {
      integrations_api_outbound_events: [
        ['organization_id', 'event_type', 'subject_id'],
        ['event_id'],
      ],
    },
  )
}

function closedDeal(overrides: Partial<LoadedDeal> = {}): LoadedDeal {
  return {
    id: DEAL,
    title: '12 Ocean Ave purchase',
    status: 'open',
    pipelineStage: 'Closed',
    valueAmount: 1250000,
    custom: { property_address: '12 Ocean Ave', city: 'Manhattan Beach', side: 'Buyer' },
    ...overrides,
  }
}

function deps(overrides: Partial<OutboundDeps> = {}, clock = { now: new Date('2026-09-28T17:00:05.000Z') }) {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 202 })
  return {
    fetchImpl,
    clock,
    deps: {
      fetchImpl,
      now: () => clock.now,
      secret: () => 'test-internal-secret',
      baseUrl: () => 'https://ams.example.test',
      resolveOwner: jest.fn().mockResolvedValue({ noliUserId: 'noli-user-1', linked: true }),
      hasAmsEntitlement: jest.fn().mockResolvedValue(true),
      loadDeal: jest.fn().mockResolvedValue(closedDeal()),
      ...overrides,
    } satisfies OutboundDeps,
  }
}

describe('enqueueDealClosed', () => {
  it('records one row per deal, however often the event arrives', async () => {
    const knex = outboxDb()
    const first = await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT })
    const again = await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: new Date('2026-09-29T10:00:00Z') })
    expect(first.inserted).toBe(true)
    expect(again.inserted).toBe(false)
    const rows = knex.db.tables.integrations_api_outbound_events
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event_type: 'deal.closed',
      subject_id: DEAL,
      target: 'ams',
      status: 'pending',
      event_id: dealClosedEventId(DEAL),
    })
    expect(Object.keys(rows[0]).join(' ')).not.toMatch(/title|address/)
  })
})

describe('drainOutboundEvents', () => {
  it('POSTs the contract payload with the internal bearer and marks it delivered', async () => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const { deps: d, fetchImpl } = deps()
    const result = await drainOutboundEvents(knex as never, { deps: d })
    expect(result).toMatchObject({ claimed: 1, delivered: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`https://ams.example.test${DEAL_CLOSED_PATH}`)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer test-internal-secret')
    expect(init.headers['Idempotency-Key']).toBe(dealClosedEventId(DEAL))
    expect(JSON.parse(init.body)).toEqual({
      eventId: dealClosedEventId(DEAL),
      noliUserId: 'noli-user-1',
      crmOrganizationId: ORG,
      dealId: DEAL,
      title: '12 Ocean Ave purchase',
      closedAt: CLOSED_AT.toISOString(),
      side: 'buyer',
      propertyAddress: '12 Ocean Ave',
      city: 'Manhattan Beach',
      amount: 1250000,
    })
    const row = knex.db.tables.integrations_api_outbound_events[0]
    expect(row.status).toBe('delivered')
    expect(row.attempts).toBe(1)

    await drainOutboundEvents(knex as never, { deps: d })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('uses the contract id, the same on every retry', () => {
    expect(dealClosedEventId(DEAL)).toBe(`deal-closed:${DEAL}`)
  })

  it('does not retry a payload AMS rejects as malformed (400)', async () => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const rejecting = jest.fn().mockResolvedValue({ ok: false, status: 400 })
    const { deps: d, clock } = deps({ fetchImpl: rejecting })
    await drainOutboundEvents(knex as never, { deps: d })
    clock.now = new Date(clock.now.getTime() + 24 * 3600_000)
    await drainOutboundEvents(knex as never, { deps: d })
    expect(rejecting).toHaveBeenCalledTimes(1)
    expect(knex.db.tables.integrations_api_outbound_events[0]).toMatchObject({ status: 'failed', last_status_code: 400 })
  })

  it('adds the buyer as client only on a buyer deal with an address', async () => {
    const row = { id: 'r', organization_id: ORG, tenant_id: TENANT, event_type: 'deal.closed', subject_id: DEAL, event_id: 'e', occurred_at: CLOSED_AT, status: 'sending', attempts: 1, next_attempt_at: CLOSED_AT }
    const client = { name: 'Dana Buyer', email: 'dana@example.com' }
    expect(buildDealClosedPayload(row, closedDeal({ client }), 'u').client).toEqual(client)
    expect(buildDealClosedPayload(row, closedDeal({ client, custom: { property_address: '12 Ocean Ave', side: 'Listing' } }), 'u')).not.toHaveProperty('client')
    expect(buildDealClosedPayload(row, closedDeal({ client, custom: { city: 'Manhattan Beach', side: 'Buyer' } }), 'u')).not.toHaveProperty('client')
    expect(buildDealClosedPayload(row, closedDeal({ client: null }), 'u')).not.toHaveProperty('client')
  })

  it('treats 409 (already received) as delivered', async () => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const { deps: d } = deps({ fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 409 }) })
    await drainOutboundEvents(knex as never, { deps: d })
    expect(knex.db.tables.integrations_api_outbound_events[0].status).toBe('delivered')
  })

  it('retries a failed delivery with backoff, then gives up after the last attempt', async () => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const failing = jest.fn().mockResolvedValue({ ok: false, status: 503 })
    const { deps: d, clock } = deps({ fetchImpl: failing })

    await drainOutboundEvents(knex as never, { deps: d })
    const row = knex.db.tables.integrations_api_outbound_events[0]
    expect(row.status).toBe('pending')
    expect(row.last_status_code).toBe(503)
    expect(new Date(row.next_attempt_at).getTime() - clock.now.getTime()).toBe(nextBackoffMs(1))

    await drainOutboundEvents(knex as never, { deps: d })
    expect(failing).toHaveBeenCalledTimes(1)

    for (let attempt = 2; attempt <= OUTBOUND_MAX_ATTEMPTS; attempt++) {
      clock.now = new Date(new Date(row.next_attempt_at).getTime() + 1)
      await drainOutboundEvents(knex as never, { deps: d })
    }
    expect(failing).toHaveBeenCalledTimes(OUTBOUND_MAX_ATTEMPTS)
    expect(row.status).toBe('failed')
    clock.now = new Date(clock.now.getTime() + 24 * 3600_000)
    await drainOutboundEvents(knex as never, { deps: d })
    expect(failing).toHaveBeenCalledTimes(OUTBOUND_MAX_ATTEMPTS)
  })

  it('retries when a network error happens', async () => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const { deps: d } = deps({ fetchImpl: jest.fn().mockRejectedValue(new Error('ECONNRESET')) })
    const result = await drainOutboundEvents(knex as never, { deps: d })
    expect(result.retried).toBe(1)
    expect(knex.db.tables.integrations_api_outbound_events[0].last_error).toContain('ECONNRESET')
  })

  it.each([
    ['the owner has no AMS entitlement', { hasAmsEntitlement: jest.fn().mockResolvedValue(false) }, 'no_ams_entitlement'],
    ['the deal was reopened', { loadDeal: jest.fn().mockResolvedValue(closedDeal({ pipelineStage: 'Negotiation' })) }, 'deal_not_closed'],
    ['the deal is gone', { loadDeal: jest.fn().mockResolvedValue(null) }, 'deal_missing'],
    ['the org has no Noli user', { resolveOwner: jest.fn().mockResolvedValue({ noliUserId: null, linked: false }) }, 'no_noli_user'],
  ])('skips without sending when %s', async (_label, overrides, reason) => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const { deps: d, fetchImpl } = deps(overrides as Partial<OutboundDeps>)
    await drainOutboundEvents(knex as never, { deps: d })
    expect(fetchImpl).not.toHaveBeenCalled()
    const row = knex.db.tables.integrations_api_outbound_events[0]
    expect(row.status).toBe('skipped')
    expect(row.last_error).toBe(reason)
  })

  it('sends anyway when the entitlement lookup itself fails (AMS ignores unknown orgs)', async () => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const { deps: d, fetchImpl } = deps({ hasAmsEntitlement: jest.fn().mockRejectedValue(new Error('noli-core down')) })
    await drainOutboundEvents(knex as never, { deps: d })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('waits (retries) when the secret is not configured', async () => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const { deps: d, fetchImpl } = deps({ secret: () => null })
    await drainOutboundEvents(knex as never, { deps: d })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(knex.db.tables.integrations_api_outbound_events[0].status).toBe('pending')
  })

  it('never sends ciphertext as the title', () => {
    const payload = buildDealClosedPayload(
      { id: 'r', organization_id: ORG, tenant_id: TENANT, event_type: 'deal.closed', subject_id: DEAL, event_id: 'e', occurred_at: CLOSED_AT, status: 'sending', attempts: 1, next_attempt_at: CLOSED_AT },
      closedDeal({ title: null, custom: {}, valueAmount: null }),
      'noli-user-1',
    )
    expect(payload.title).toBe('Closed deal')
    expect(payload).not.toHaveProperty('amount')
    expect(payload).not.toHaveProperty('side')
  })
})

describe('deal location fields', () => {
  it.each([
    ['Listing', 'listing'],
    ['Seller side', 'listing'],
    ['Buyer', 'buyer'],
    ['Dual agency', 'both'],
    ['both', 'both'],
    ['referral', null],
  ])('side %s -> %s', (raw, expected) => {
    expect(normalizeDealSide(raw)).toBe(expected)
  })

  it('reads differently named custom fields', () => {
    expect(extractDealLocation({ cf_Property_Address: '9 Via Rosa', City: 'Palos Verdes Estates', 'Deal side': ['Listing'] }))
      .toEqual({ propertyAddress: '9 Via Rosa', city: 'Palos Verdes Estates', side: 'listing' })
  })
})

describe('deal-closed-ams subscriber', () => {
  it('records the closed deal and never throws into the deal update', async () => {
    const knex = outboxDb()
    const ctx = { resolve: <T,>() => ({ getKnex: () => knex }) as T }
    await handler({ id: DEAL, organizationId: ORG, tenantId: TENANT, closedAt: CLOSED_AT.toISOString() }, ctx)
    await handler({ id: DEAL, organizationId: ORG, tenantId: TENANT, closedAt: CLOSED_AT.toISOString() }, ctx)
    expect(knex.db.tables.integrations_api_outbound_events).toHaveLength(1)

    const broken = { resolve: <T,>() => ({ getKnex: () => { throw new Error('db down') } }) as T }
    await expect(handler({ id: DEAL, organizationId: ORG, tenantId: TENANT }, broken)).resolves.toBeUndefined()
  })
})

describe('the buyer as client (default loader)', () => {
  const realDecrypt = jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows')
  beforeAll(() => {
    jest.spyOn(realDecrypt, 'decryptRowFields').mockImplementation(async (...args: unknown[]) => args[2] as unknown[])
  })
  afterAll(() => jest.restoreAllMocks())

  function buyerWorld(unsubscribes: Array<Record<string, unknown>>, preferences: Array<Record<string, unknown>> = []) {
    const knex = createFakeDb(
      {
        integrations_api_outbound_events: [],
        customer_deals: [{ id: DEAL, organization_id: ORG, tenant_id: TENANT, title: '12 Ocean Ave purchase', status: 'win', pipeline_stage: 'Closed', value_amount: '1250000', deleted_at: null }],
        customer_deal_people: [{ id: 'l1', deal_id: DEAL, person_entity_id: 'c-1', created_at: new Date('2026-09-01') }],
        customer_entities: [{ id: 'c-1', organization_id: ORG, primary_email: 'Dana@Example.com', display_name: 'Dana Buyer', deleted_at: null }],
        email_unsubscribes: unsubscribes,
        email_preferences: preferences,
      },
      { integrations_api_outbound_events: [['organization_id', 'event_type', 'subject_id'], ['event_id']] },
    )
    return knex
  }

  async function sendWith(knex: ReturnType<typeof buyerWorld>) {
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    await drainOutboundEvents(knex as never, {
      em: {},
      deps: {
        fetchImpl,
        now: () => new Date('2026-09-28T17:00:05.000Z'),
        secret: () => 's',
        baseUrl: () => 'https://ams.example.test',
        resolveOwner: async () => ({ noliUserId: 'noli-user-1', linked: true }),
        hasAmsEntitlement: async () => true,
      },
    })
    return JSON.parse(fetchImpl.mock.calls[0][1].body)
  }

  beforeEach(() => {
    jest.doMock('@open-mercato/shared/lib/commands/customFieldSnapshots', () => ({
      loadCustomFieldSnapshot: async () => ({ property_address: '12 Ocean Ave', city: 'Manhattan Beach', side: 'buyer' }),
    }))
  })

  it('sends the buyer when they have not opted out', async () => {
    const body = await sendWith(buyerWorld([]))
    expect(body.client).toEqual({ name: 'Dana Buyer', email: 'dana@example.com' })
  })

  it('leaves the buyer out when they opted out of any email category', async () => {
    const optedOut = [{ organization_id: ORG, contact_id: 'c-1', category_slug: 'newsletter', opted_in: false, deleted_at: null }]
    expect((await sendWith(buyerWorld([], optedOut))).client).toBeUndefined()
    const optedIn = [{ organization_id: ORG, contact_id: 'c-1', category_slug: 'newsletter', opted_in: true, deleted_at: null }]
    expect((await sendWith(buyerWorld([], optedIn))).client).toEqual({ name: 'Dana Buyer', email: 'dana@example.com' })
  })

  it('keeps retrying while the AMS endpoint is not live yet (404)', async () => {
    const knex = outboxDb()
    await enqueueDealClosed(knex as never, { organizationId: ORG, tenantId: TENANT, dealId: DEAL, closedAt: CLOSED_AT }, CLOSED_AT)
    const notLive = jest.fn().mockResolvedValue({ ok: false, status: 404 })
    const clock = { now: new Date('2026-09-28T17:00:05.000Z') }
    const d = {
      fetchImpl: notLive,
      now: () => clock.now,
      secret: () => 's',
      baseUrl: () => 'https://ams.example.test',
      resolveOwner: async () => ({ noliUserId: 'u', linked: true }),
      hasAmsEntitlement: async () => true,
      loadDeal: async () => closedDeal(),
    }
    await drainOutboundEvents(knex as never, { deps: d })
    const row = knex.db.tables.integrations_api_outbound_events[0]
    expect(row).toMatchObject({ status: 'pending', last_status_code: 404 })
    clock.now = new Date(new Date(row.next_attempt_at).getTime() + 1)
    d.fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    await drainOutboundEvents(knex as never, { deps: d })
    expect(row.status).toBe('delivered')
  })

  it('leaves the buyer out once they unsubscribed (by contact or by address)', async () => {
    expect((await sendWith(buyerWorld([{ organization_id: ORG, email: 'x@other.com', contact_id: 'c-1' }]))).client).toBeUndefined()
    expect((await sendWith(buyerWorld([{ organization_id: ORG, email: 'dana@example.com', contact_id: null }]))).client).toBeUndefined()
  })
})
