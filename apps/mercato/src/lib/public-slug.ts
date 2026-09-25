import crypto from 'node:crypto'

/* Public links (booking pages, forms, surveys, landing pages, funnels,
 * courses, chat pages, events, affiliate codes) are resolved by slug with no
 * organisation in the URL, and every Noli customer shares one tenant. A slug
 * must therefore be unique across ALL organisations, or one customer's public
 * link could resolve to another customer's page. Global unique indexes
 * enforce it in the database (migrations 20260924200000); these helpers make
 * the create/rename paths check the same scope first, so a clash is a clean
 * 409 or an automatic suffix instead of a failed insert.
 *
 * `liveOnly` mirrors the index predicate: tables whose public lookup and
 * unique index skip soft-deleted rows (landing_pages, courses, events) pass
 * true. Relative imports only. */

type KnexLike = (table: string) => any

export type PublicSlugOptions = {
  column?: string
  excludeId?: string | null
  liveOnly?: boolean
}

export async function isPublicSlugTaken(
  knex: KnexLike,
  table: string,
  slug: string,
  options: PublicSlugOptions = {},
): Promise<boolean> {
  const column = options.column ?? 'slug'
  let q = knex(table).where(column, slug)
  if (options.liveOnly) q = q.whereNull('deleted_at')
  if (options.excludeId) q = q.whereNot('id', options.excludeId)
  const row = await q.first('id')
  return !!row
}

/** Returns `base` when it is free across every organisation, else `base-xxxxxx`. */
export async function uniquePublicSlug(
  knex: KnexLike,
  table: string,
  base: string,
  options: PublicSlugOptions = {},
): Promise<string> {
  if (!(await isPublicSlugTaken(knex, table, base, options))) return base
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`
    if (!(await isPublicSlugTaken(knex, table, candidate, options))) return candidate
  }
  return `${base}-${crypto.randomUUID()}`
}
