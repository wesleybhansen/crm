import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import {
  DEAL_CLOSED_PATH,
  JOURNEY_CLOSED_EVENT_TYPE,
  drainOutboundEvents,
  enqueueJourneyClosed,
  isJourneyClosing,
  journeyClosedEventId,
  journeyStageKey,
} from '../outbound-events'
import handler from '../../subscribers/journey-closed-ams'

/*
 * The Customer Journey board's closing (a contact moved into "Closed"/"Sold")
 * sends the same deal-closed event to the marketing app as a deal does, keyed
 * journey-closed:<contactId>:<stage key> (Software Strategy/
 * deal-closed-contract.md, journey case).
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const CONTACT = '44444444-4444-4444-8444-444444444444'
const PROFILE = '55555555-5555-4555-8555-555555555555'
const CHANGED_AT = '2026-09-28T17:00:00.000Z'

const realDecrypt = jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows')
let snapshots: Record<string, Record<string, unknown>> = {}

beforeAll(() => {
  jest.spyOn(realDecrypt, 'decryptRowFields').mockImplementation(async (...args: unknown[]) => args[2] as unknown[])
})
afterAll(() => jest.restoreAllMocks())
beforeEach(() => {
  snapshots = {
    [`customers:customer_entity:${CONTACT}`]: { property_address: '12 Ocean Ave' },
    [`customers:customer_person_profile:${PROFILE}`]: { city: 'Manhattan Beach', side: 'Buyer' },
  }
  jest.doMock('@open-mercato/shared/lib/commands/customFieldSnapshots', () => ({
    loadCustomFieldSnapshot: async (_em: unknown, args: { entityId: string; recordId: string }) =>
      snapshots[`${args.entityId}:${args.recordId}`] ?? {},
  }))
})

function world(opts: { stage?: string; unsubscribes?: Array<Record<string, unknown>> } = {}) {
  return createFakeDb(
    {
      integrations_api_outbound_events: [],
      customer_entities: [{
        id: CONTACT, organization_id: ORG, tenant_id: TENANT, deleted_at: null,
        display_name: 'Dana Buyer', primary_email: 'Dana@Example.com', lifecycle_stage: opts.stage ?? 'Closed',
      }],
      customer_people: [{ id: PROFILE, entity_id: CONTACT, organization_id: ORG, tenant_id: TENANT }],
      email_unsubscribes: opts.unsubscribes ?? [],
      email_preferences: [],
    },
    { integrations_api_outbound_events: [['organization_id', 'event_type', 'subject_id'], ['event_id']] },
  )
}

function ctxFor(knex: unknown) {
  return { resolve: <T,>() => ({ getKnex: () => knex }) as T }
}

function sendDeps(fetchImpl: jest.Mock) {
  return {
    fetchImpl,
    now: () => new Date('2026-09-28T17:00:05.000Z'),
    secret: () => 's',
    baseUrl: () => 'https://ams.example.test',
    resolveOwner: async () => ({ noliUserId: 'noli-user-1', linked: true }),
    hasAmsEntitlement: async () => true,
  }
}

describe('journey closing: which stage changes count', () => {
  it('counts a move into a closed or won stage from an open one', () => {
    expect(isJourneyClosing({ stage: 'Closed', previousStage: 'Under Contract' })).toBe(true)
    expect(isJourneyClosing({ stage: 'Sold', previousStage: null })).toBe(true)
    expect(isJourneyClosing({ stage: 'Closed Won', previousStage: 'Offer' })).toBe(true)
  })

  it('ignores lost stages, open stages, clearing, and moves between two closed stages', () => {
    expect(isJourneyClosing({ stage: 'Closed Lost', previousStage: 'Offer' })).toBe(false)
    expect(isJourneyClosing({ stage: 'Fell through', previousStage: 'Offer' })).toBe(false)
    expect(isJourneyClosing({ stage: 'Showing', previousStage: 'Lead' })).toBe(false)
    expect(isJourneyClosing({ stage: null, previousStage: 'Closed' })).toBe(false)
    expect(isJourneyClosing({ stage: 'Sold', previousStage: 'Closed' })).toBe(false)
  })

  it('builds a stable id from the contact and the stage', () => {
    expect(journeyStageKey('Closed Won')).toBe('closed-won')
    expect(journeyClosedEventId(CONTACT, 'Closed')).toBe(`journey-closed:${CONTACT}:closed`)
    expect(journeyClosedEventId(CONTACT, 'Closed')).toBe(journeyClosedEventId(CONTACT, ' closed '))
    // AMS stores eventId and dealId as strings of at most 200 characters.
    expect(journeyClosedEventId(CONTACT, 'x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })
})

describe('journey-closed-ams subscriber', () => {
  it('records one outbox row per contact closing, however often the event arrives', async () => {
    const knex = world()
    const payload = { id: CONTACT, organizationId: ORG, tenantId: TENANT, stage: 'Closed', previousStage: 'Under Contract', changedAt: CHANGED_AT }
    await handler(payload, ctxFor(knex))
    await handler(payload, ctxFor(knex))
    const rows = knex.db.tables.integrations_api_outbound_events
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event_type: JOURNEY_CLOSED_EVENT_TYPE,
      subject_id: CONTACT,
      event_id: `journey-closed:${CONTACT}:closed`,
      target: 'ams',
    })
  })

  it('records nothing for a lost stage or an ordinary move', async () => {
    const knex = world({ stage: 'Closed Lost' })
    await handler({ id: CONTACT, organizationId: ORG, tenantId: TENANT, stage: 'Closed Lost', previousStage: 'Offer' }, ctxFor(knex))
    await handler({ id: CONTACT, organizationId: ORG, tenantId: TENANT, stage: 'Showing', previousStage: 'Lead' }, ctxFor(knex))
    expect(knex.db.tables.integrations_api_outbound_events).toHaveLength(0)
  })

  it('never throws into the stage change', async () => {
    const broken = { resolve: <T,>() => ({ getKnex: () => { throw new Error('db down') } }) as T }
    await expect(handler({ id: CONTACT, organizationId: ORG, tenantId: TENANT, stage: 'Closed', previousStage: 'Offer' }, broken)).resolves.toBeUndefined()
  })
})

describe('journey closing: delivery to AMS', () => {
  async function closeAndSend(knex: ReturnType<typeof world>) {
    await enqueueJourneyClosed(knex as never, { organizationId: ORG, tenantId: TENANT, contactId: CONTACT, stage: 'Closed', closedAt: new Date(CHANGED_AT) }, new Date(CHANGED_AT))
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    const result = await drainOutboundEvents(knex as never, { em: {}, deps: sendDeps(fetchImpl) })
    return { fetchImpl, result }
  }

  it('sends the deal-closed contract with the stable id as eventId and dealId, the contact as title and client', async () => {
    const knex = world()
    const { fetchImpl, result } = await closeAndSend(knex)
    expect(result).toMatchObject({ claimed: 1, delivered: 1 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`https://ams.example.test${DEAL_CLOSED_PATH}`)
    const id = `journey-closed:${CONTACT}:closed`
    expect(init.headers['Idempotency-Key']).toBe(id)
    expect(JSON.parse(init.body)).toEqual({
      eventId: id,
      noliUserId: 'noli-user-1',
      crmOrganizationId: ORG,
      dealId: id,
      title: 'Dana Buyer',
      closedAt: CHANGED_AT,
      side: 'buyer',
      propertyAddress: '12 Ocean Ave',
      city: 'Manhattan Beach',
      client: { name: 'Dana Buyer', email: 'dana@example.com' },
    })
  })

  it('leaves the client out when the contact opted out of email', async () => {
    const knex = world({ unsubscribes: [{ organization_id: ORG, email: 'dana@example.com', contact_id: null }] })
    const { fetchImpl } = await closeAndSend(knex)
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.client).toBeUndefined()
    expect(body.propertyAddress).toBe('12 Ocean Ave')
  })

  it('leaves the client out on a listing-side closing', async () => {
    snapshots[`customers:customer_person_profile:${PROFILE}`] = { city: 'Manhattan Beach', side: 'Seller' }
    const knex = world()
    const { fetchImpl } = await closeAndSend(knex)
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.side).toBe('listing')
    expect(body.client).toBeUndefined()
  })

  it('skips a contact moved back out of the closed stage before delivery', async () => {
    const knex = world({ stage: 'Under Contract' })
    const { fetchImpl, result } = await closeAndSend(knex)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.skipped).toBe(1)
    expect(knex.db.tables.integrations_api_outbound_events[0]).toMatchObject({ status: 'skipped', last_error: 'journey_not_closed' })
  })
})
