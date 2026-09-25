/** @jest-environment node */

/*
 * 2026-09-25 review, M7: the public funnel checkout loaded the step and the
 * session by id alone and charged any product id sent as an order bump. A
 * step id / sid leaks through redirect query strings, so another funnel's
 * step could be rendered and priced, and any product could be added.
 */
type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const stripeCreate = jest.fn(async (_params: any) => ({ id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' }))

function fakeKnex() {
  return (table: string) => {
    const filters: Array<[string, string, unknown]> = []
    let order: string | null = null
    const rows = () => (tables[table] ?? []).filter((row) => filters.every(([col, op, val]) => (op === '>' ? row[col] > (val as any) : row[col] === val)))
    const q: any = {
      where(col: string, opOrVal: unknown, maybe?: unknown) {
        if (maybe === undefined) filters.push([col, '=', opOrVal])
        else filters.push([col, String(opOrVal), maybe])
        return q
      },
      orderBy(col: string) { order = col; return q },
      async first() {
        const list = rows()
        if (order) list.sort((a, b) => (a[order!] > b[order!] ? 1 : -1))
        return list[0]
      },
      async insert(row: Row) { (tables[table] ??= []).push({ ...row }) },
      async update(patch: Row) { for (const row of rows()) Object.assign(row, patch); return 1 },
    }
    return q
  }
}

jest.mock('@/bootstrap', () => ({ bootstrap: async () => undefined }))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: () => ({ getKnex: () => fakeKnex() }) }),
}))
jest.mock('stripe', () => ({
  __esModule: true,
  default: class { checkout = { sessions: { create: (params: any) => stripeCreate(params) } } },
}))

import { GET as checkoutGet, POST as checkoutPost } from '../checkout/route'
import { POST as advancePost } from '../advance/route'

const ORG_A = 'org-a'
const ORG_B = 'org-b'

beforeEach(() => {
  stripeCreate.mockClear()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  for (const key of Object.keys(tables)) delete tables[key]
  tables.funnels = [
    { id: 'fa', slug: 'alpha', is_published: true, organization_id: ORG_A, tenant_id: 'ta' },
    { id: 'fb', slug: 'bravo', is_published: true, organization_id: ORG_B, tenant_id: 'tb' },
  ]
  tables.funnel_steps = [
    { id: 'sa', funnel_id: 'fa', step_type: 'checkout', step_order: 1, product_id: 'pa', config: { order_bumps: [{ product_id: 'pa-bump' }] } },
    { id: 'sb', funnel_id: 'fb', step_type: 'checkout', step_order: 1, product_id: 'pb', config: {} },
  ]
  tables.products = [
    { id: 'pa', organization_id: ORG_A, tenant_id: 'ta', name: 'Alpha course', price: 100, currency: 'usd' },
    { id: 'pa-bump', organization_id: ORG_A, tenant_id: 'ta', name: 'Alpha bump', price: 10, currency: 'usd' },
    { id: 'pa-other', organization_id: ORG_A, tenant_id: 'ta', name: 'Alpha not offered', price: 1, currency: 'usd' },
    { id: 'pb', organization_id: ORG_B, tenant_id: 'tb', name: 'Bravo secret', price: 999, currency: 'usd' },
  ]
  tables.funnel_sessions = [
    { id: 'sid-b', funnel_id: 'fb', organization_id: ORG_B, email: 'b@x.test', current_step_id: 'sb', status: 'active' },
  ]
  tables.stripe_connections = [{ organization_id: ORG_A, is_active: true, stripe_account_id: 'acct_a' }]
  tables.funnel_orders = []
})

const post = (slug: string, body: unknown) =>
  checkoutPost(new Request(`https://crm.test/api/landing_pages/funnels/public/${slug}/checkout`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ slug }) })

describe('public funnel checkout scope', () => {
  it('a step of another funnel is not found, on GET and POST', async () => {
    const page = await checkoutGet(new Request('https://crm.test/api/landing_pages/funnels/public/alpha/checkout?step=sb'), { params: Promise.resolve({ slug: 'alpha' }) })
    expect(page.status).toBe(404)
    expect(await page.text()).not.toContain('Bravo secret')
    const res = await post('alpha', { stepId: 'sb', email: 'v@x.test' })
    expect(res.status).toBe(404)
    expect(stripeCreate).not.toHaveBeenCalled()
  })

  it('charges only the bumps the step offers, each once, never a foreign or unlisted product', async () => {
    const res = await post('alpha', { stepId: 'sa', email: 'v@x.test', bumpProductIds: ['pa-bump', 'pa-bump', 'pa-other', 'pb'] })
    expect(res.status).toBe(200)
    const items = stripeCreate.mock.calls[0][0].line_items.map((item: any) => item.price_data.product_data.name)
    expect(items).toEqual(['Alpha course', 'Alpha bump'])
    expect(tables.funnel_orders.map((o) => o.product_id).sort()).toEqual(['pa', 'pa-bump'])
  })

  it('a sid from another funnel is not reused: a fresh session is created for this funnel', async () => {
    await post('alpha', { stepId: 'sa', sid: 'sid-b', email: 'v@x.test' })
    expect(tables.funnel_sessions.find((s) => s.id === 'sid-b')?.email).toBe('b@x.test')
    expect(tables.funnel_sessions.filter((s) => s.funnel_id === 'fa')).toHaveLength(1)
  })

  it('advance refuses a session of another funnel', async () => {
    const res = await advancePost(
      new Request('https://crm.test/api/landing_pages/funnels/public/alpha/advance', { method: 'POST', body: JSON.stringify({ sid: 'sid-b', email: 'hijack@x.test' }) }),
      { params: Promise.resolve({ slug: 'alpha' }) },
    )
    expect(res.status).toBe(404)
    expect(tables.funnel_sessions.find((s) => s.id === 'sid-b')?.email).toBe('b@x.test')
  })
})
