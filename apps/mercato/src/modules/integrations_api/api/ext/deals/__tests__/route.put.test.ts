/** @jest-environment node */

/**
 * PUT /ext/deals is what the pipeline board calls on a drag. Moving a deal
 * into Won used to change only its stage, so the status stayed 'open' and
 * reports never counted the win. The move now sets the status (won, lost, or
 * back to open), stores canonical values, and fires `customers.deal.closed`
 * exactly once per close.
 */

type Row = Record<string, any>

let deal: Row
const updates: Array<{ table: string; where: Array<[string, unknown]>; patch: Row }> = []

function fakeKnex() {
  return (table: string) => {
    const where: Array<[string, unknown]> = []
    const query: any = {
      where: (field: string, value: unknown) => { where.push([field, value]); return query },
      whereNull: () => query,
      join: () => query,
      select: () => query,
      limit: () => query,
      orderBy: () => query,
      first: async () => {
        if (table === 'customer_deals') return { ...deal }
        if (table === 'organizations') return { owner_user_id: 'org-owner' }
        return undefined
      },
      update: async (patch: Row) => {
        updates.push({ table, where: [...where], patch })
        if (table === 'customer_deals') Object.assign(deal, patch)
        return 1
      },
      then: (resolve: (rows: Row[]) => unknown) => Promise.resolve(resolve([])),
    }
    return query
  }
}

const emitEvent = jest.fn(async () => undefined)
const createNotification = jest.fn(async () => ({}))
const em = { getKnex: () => fakeKnex() }

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (name: string) => (name === 'em' ? em : name === 'eventBus' ? { emitEvent } : undefined),
  }),
}))
jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  CONTACT_ENTITY_KEY: 'customers:customer_entity',
  DEAL_ENTITY_KEY: 'customers:customer_deal',
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: Row[]) => rows),
}))
jest.mock('@open-mercato/core/modules/notifications/lib/notificationService', () => ({
  resolveNotificationService: () => ({ create: (...args: unknown[]) => (createNotification as any)(...args) }),
}))
const attributeDealWin = jest.fn(async () => false)
jest.mock('@/modules/customers/api/affiliates/deal-attribution', () => ({
  attributeDealWin: (...args: unknown[]) => (attributeDealWin as any)(...args),
}))

import { PUT } from '../route'

const ctx = { auth: { tenantId: 't1', orgId: 'o1' } }
const put = async (body: Row) => {
  const res = await PUT(new Request('http://x/api/ext/deals', { method: 'PUT', body: JSON.stringify(body) }), ctx)
  return { status: res.status, json: await res.json() }
}
const eventsNamed = (id: string) => emitEvent.mock.calls.filter((call: unknown[]) => call[0] === id)

describe('PUT /ext/deals (pipeline board drag)', () => {
  beforeEach(() => {
    updates.length = 0
    emitEvent.mockClear()
    createNotification.mockClear()
    attributeDealWin.mockClear()
    deal = {
      id: 'd1', tenant_id: 't1', organization_id: 'o1', title: 'Acme', status: 'open', pipeline_stage: 'Negotiation',
      owner_user_id: null, value_amount: '1200', value_currency: 'USD',
    }
  })

  it('dragging into Won stores status win, scoped to the tenant and organization', async () => {
    const { json } = await put({ id: 'd1', pipeline_stage: 'Won' })
    expect(json).toEqual({ ok: true, data: { id: 'd1', pipeline_stage: 'Won', status: 'win' } })
    expect(updates).toHaveLength(1)
    expect(updates[0].patch).toMatchObject({ pipeline_stage: 'Won', status: 'win' })
    expect(updates[0].where).toEqual(expect.arrayContaining([['id', 'd1'], ['tenant_id', 't1'], ['organization_id', 'o1']]))
  })

  it('fires customers.deal.closed exactly once for the close, and the stage event carries the new status', async () => {
    await put({ id: 'd1', pipeline_stage: 'Won' })
    expect(eventsNamed('customers.deal.closed')).toHaveLength(1)
    expect(eventsNamed('customers.deal.closed')[0][1]).toMatchObject({ id: 'd1', status: 'win', stage: 'Won' })
    expect(eventsNamed('customers.deal.stage_changed')).toHaveLength(1)
    expect(eventsNamed('customers.deal.stage_changed')[0][1]).toMatchObject({ stage: 'Won', previousStage: 'Negotiation', status: 'win' })
    // Won gets its own bell (the stage bell skips won/lost), to the org owner when the deal has no owner.
    expect(createNotification).toHaveBeenCalledTimes(1)
    expect((createNotification.mock.calls[0] as unknown[])[0]).toMatchObject({ type: 'customers.deal.won', recipientUserId: 'org-owner' })
    expect(attributeDealWin).not.toHaveBeenCalled() // no linked contacts in this fake
  })

  it('does not fire a second close when a won deal is saved into Won again', async () => {
    deal.status = 'win'
    deal.pipeline_stage = 'Won'
    await put({ id: 'd1', pipeline_stage: 'Won' })
    expect(eventsNamed('customers.deal.closed')).toHaveLength(0)
    expect(updates[0].patch).not.toHaveProperty('status')
    expect(createNotification).not.toHaveBeenCalled()
  })

  it('dragging into Lost stores lost (never loose) and fires no close', async () => {
    const { json } = await put({ id: 'd1', pipeline_stage: 'Lost' })
    expect(json.data.status).toBe('lost')
    expect(eventsNamed('customers.deal.closed')).toHaveLength(0)
    expect(createNotification).toHaveBeenCalledTimes(1)
    expect((createNotification.mock.calls[0] as unknown[])[0]).toMatchObject({ type: 'customers.deal.lost' })
  })

  it('dragging a won deal back to an ordinary stage reopens it', async () => {
    deal.status = 'win'
    deal.pipeline_stage = 'Won'
    const { json } = await put({ id: 'd1', pipeline_stage: 'Proposal' })
    expect(json.data.status).toBe('open')
    expect(eventsNamed('customers.deal.closed')).toHaveLength(0)
    expect(createNotification).not.toHaveBeenCalled()
    // ...and moving it to Won again is a new close.
    await put({ id: 'd1', pipeline_stage: 'Won' })
    expect(eventsNamed('customers.deal.closed')).toHaveLength(1)
  })

  it('a move between ordinary stages keeps the status', async () => {
    deal.status = 'in_progress'
    const { json } = await put({ id: 'd1', pipeline_stage: 'Proposal' })
    expect(json.data.status).toBe('in_progress')
    expect(updates[0].patch).not.toHaveProperty('status')
  })

  it('stores a sent status in its canonical spelling and respects it over the stage', async () => {
    let result = await put({ id: 'd1', status: 'loose' })
    expect(result.json.data.status).toBe('lost')
    deal.status = 'open'
    result = await put({ id: 'd1', status: 'won' })
    expect(result.json.data.status).toBe('win')
    deal.status = 'open'
    result = await put({ id: 'd1', pipeline_stage: 'Won', status: 'open' })
    expect(result.json.data.status).toBe('open')
  })
})
