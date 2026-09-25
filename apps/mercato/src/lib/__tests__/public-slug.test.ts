/* Public slugs resolve with no organisation in the URL and every Noli
 * customer shares one tenant: a slug taken by ANY organisation is taken. */
import { isPublicSlugTaken, uniquePublicSlug } from '../public-slug'

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001'

type Row = Record<string, unknown>
function fakeKnex(tables: Record<string, Row[]>) {
  return (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const api: any = {
      where(c: string, v: unknown) { rows = rows.filter((r) => r[c] === v); return api },
      whereNot(c: string, v: unknown) { rows = rows.filter((r) => r[c] !== v); return api },
      whereNull(c: string) { rows = rows.filter((r) => r[c] == null); return api },
      async first() { return rows[0] },
    }
    return api
  }
}

describe('public slug helpers', () => {
  const knex = fakeKnex({
    forms: [{ id: 'f-b', organization_id: ORG_B, slug: 'contact' }],
    landing_pages: [
      { id: 'lp-b', organization_id: ORG_B, slug: 'home', deleted_at: null },
      { id: 'lp-old', organization_id: ORG_A, slug: 'old', deleted_at: new Date() },
    ],
  })

  it('a slug used by another organisation counts as taken', async () => {
    expect(await isPublicSlugTaken(knex, 'forms', 'contact')).toBe(true)
    expect(await isPublicSlugTaken(knex, 'forms', 'fresh')).toBe(false)
  })

  it('excludeId lets a record keep its own slug; liveOnly ignores soft-deleted rows', async () => {
    expect(await isPublicSlugTaken(knex, 'forms', 'contact', { excludeId: 'f-b' })).toBe(false)
    expect(await isPublicSlugTaken(knex, 'landing_pages', 'old', { liveOnly: true })).toBe(false)
    expect(await isPublicSlugTaken(knex, 'landing_pages', 'home', { liveOnly: true })).toBe(true)
  })

  it('uniquePublicSlug suffixes a slug another organisation holds', async () => {
    const slug = await uniquePublicSlug(knex, 'forms', 'contact')
    expect(slug).toMatch(/^contact-[0-9a-f]{6}$/)
    expect(await uniquePublicSlug(knex, 'forms', 'fresh')).toBe('fresh')
  })
})
