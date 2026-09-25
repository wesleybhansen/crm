/* Org A cannot create a booking page on a slug org B already uses: the
 * public /book/<slug> link would otherwise resolve to either customer. */
const inserted: Array<Record<string, unknown>> = []
const tables: Record<string, Array<Record<string, unknown>>> = {
  booking_pages: [{ id: 'bp-b', organization_id: 'org-b', slug: 'intro-call' }],
}
const knex: any = (table: string) => {
  let rows = [...(tables[table] ?? [])]
  const api: any = {
    where(c: string, v: unknown) { rows = rows.filter((r) => r[c] === v); return api },
    whereNot(c: string, v: unknown) { rows = rows.filter((r) => r[c] !== v); return api },
    whereNull(c: string) { rows = rows.filter((r) => r[c] == null); return api },
    async first() { return rows[0] },
    async insert(row: Record<string, unknown>) { inserted.push(row); return [row] },
  }
  return api
}
knex.raw = async () => undefined

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({ resolve: () => ({ getKnex: () => knex }) }),
}))

import { POST } from '../route'

const ctx = { auth: { sub: 'user-a', tenantId: 't1', orgId: 'org-a' } }
const req = (body: Record<string, unknown>) =>
  new Request('http://x/api/calendar/booking-pages', { method: 'POST', body: JSON.stringify(body) })

describe('POST /calendar/booking-pages (shared tenant)', () => {
  it('refuses a slug another organisation already uses', async () => {
    const res = await POST(req({ title: 'Intro', slug: 'intro-call' }), ctx)
    expect(res.status).toBe(409)
    expect(inserted).toHaveLength(0)
  })

  it('accepts a free slug', async () => {
    const res = await POST(req({ title: 'Intro', slug: 'a-intro-call' }), ctx)
    expect(res.status).toBeLessThan(300)
    expect(inserted).toHaveLength(1)
  })
})
