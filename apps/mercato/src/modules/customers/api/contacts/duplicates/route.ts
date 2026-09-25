// ORM-SKIP: analytics/aggregation — complex GROUP BY/JSONB/multi-table joins better served by raw SQL
export const metadata = { path: '/contacts/duplicates', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { contactLookupForTenant, emailLookupHashes, normalizeEmailForLookup } from '@/modules/customers/lib/contact-lookup'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // primary_email is encrypted with a random IV, so the stored value can
    // never be grouped in SQL. primary_email_hash (sha256 of the normalized
    // address) can, and a partial unique index on (organization_id,
    // primary_email_hash) for live rows means two HASHED contacts never share
    // an address: every duplicate involves a row without a hash (legacy rows,
    // and the legacy duplicates the backfill deliberately left hash-less).
    // So: decrypt only the hash-less rows, hash their addresses, and pull the
    // hashed rows with those hashes. Complete for the whole organization,
    // instead of decrypting its first 2,000 contacts.
    const MAX_HASHLESS = 20000
    const cols = ['id', 'display_name', 'primary_email', 'primary_email_hash', 'created_at', 'source', 'lifecycle_stage']
    const hashless = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .whereNull('primary_email_hash')
      .whereNotNull('primary_email')
      .whereRaw("primary_email != ''")
      .select(cols)
      .orderBy('created_at', 'asc')
      .limit(MAX_HASHLESS + 1)
    const truncated = hashless.length > MAX_HASHLESS
    const legacy = truncated ? hashless.slice(0, MAX_HASHLESS) : hashless
    await decryptRowFields(em, CONTACT_ENTITY_KEY, legacy, ['display_name', 'primary_email'], auth.tenantId, auth.orgId)

    // Groups are keyed by the normalised address when it is readable (lookup
    // hashes are keyed per tenant and exist in two formats while the rehash
    // rollout runs), else by the stored hash.
    const hasher = await contactLookupForTenant(auth.tenantId)
    const keyed: Array<{ key: string; email: string; row: any }> = []
    const legacyHashes: string[] = []
    for (const row of legacy) {
      // Anything still unreadable is skipped rather than grouped together.
      const email = normalizeEmailForLookup(String(row.primary_email || ''))
      if (!email || !email.includes('@')) continue
      keyed.push({ key: `e:${email}`, email, row })
      legacyHashes.push(...emailLookupHashes(hasher, email))
    }
    // Belt and braces for a database without that unique index: hashed rows
    // that share a hash are grouped in SQL (hashes only, no values).
    const sharedHashes = (await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .whereNotNull('primary_email_hash')
      .groupBy('primary_email_hash')
      .havingRaw('count(*) > 1')
      .select('primary_email_hash')).map((r: { primary_email_hash: string }) => String(r.primary_email_hash))
    const hashes = Array.from(new Set([...legacyHashes, ...sharedHashes]))
    const hashed = hashes.length
      ? await knex('customer_entities')
        .where('organization_id', auth.orgId)
        .whereNull('deleted_at')
        .whereIn('primary_email_hash', hashes)
        .select(cols)
      : []
    await decryptRowFields(em, CONTACT_ENTITY_KEY, hashed, ['display_name', 'primary_email'], auth.tenantId, auth.orgId)
    for (const row of hashed) {
      const email = normalizeEmailForLookup(String(row.primary_email || ''))
      keyed.push({ key: email.includes('@') ? `e:${email}` : `h:${String(row.primary_email_hash)}`, email, row })
    }

    const groups: Record<string, { email: string; contacts: any[] }> = {}
    for (const { key, email, row } of keyed) {
      if (!groups[key]) groups[key] = { email: email.includes('@') ? email : '', contacts: [] }
      if (!groups[key].email && email.includes('@')) groups[key].email = email
      groups[key].contacts.push({
        id: row.id,
        displayName: row.display_name,
        createdAt: row.created_at,
        source: row.source,
        lifecycleStage: row.lifecycle_stage,
      })
    }

    for (const key of Object.keys(groups)) {
      if (groups[key].contacts.length < 2) delete groups[key]
    }

    const data = Object.values(groups).sort((a, b) => b.contacts.length - a.contacts.length)
    // Say so when the scan was capped: a short list must not read as "no duplicates".
    return NextResponse.json({ ok: true, data, scanned: legacy.length + hashed.length, truncated })
  } catch (error) {
    console.error('[contacts.duplicates]', error)
    return NextResponse.json({ ok: false, error: 'Failed to scan for duplicates' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts',
  summary: 'Duplicate contact detection',
  methods: {
    GET: {
      summary: 'Find potential duplicate contacts grouped by email',
      tags: ['Contacts'],
    },
  },
}
