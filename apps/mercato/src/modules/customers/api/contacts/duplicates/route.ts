// ORM-SKIP: analytics/aggregation — complex GROUP BY/JSONB/multi-table joins better served by raw SQL
export const metadata = { path: '/contacts/duplicates', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // Duplicate detection cannot be done in SQL here. primary_email is
    // encrypted at rest on the ORM write path and encryption uses a random IV,
    // so the SAME address produces DIFFERENT ciphertext on every row — a
    // GROUP BY on the stored value can never group a duplicate with itself,
    // and no amount of decrypting afterwards fixes a grouping that already
    // happened. Rows written outside the ORM are plaintext, so the table holds
    // a mix and neither form can be trusted as a key.
    //
    // So: read, decrypt, then group on the decrypted address.
    const MAX_SCAN = 2000
    const rows = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNotNull('primary_email')
      .whereRaw("primary_email != ''")
      .whereNull('deleted_at')
      .select('id', 'display_name', 'primary_email', 'created_at', 'source', 'lifecycle_stage')
      .orderBy('created_at', 'asc')
      .limit(MAX_SCAN + 1)

    const truncated = rows.length > MAX_SCAN
    const contacts = truncated ? rows.slice(0, MAX_SCAN) : rows
    await decryptRowFields(
      em, CONTACT_ENTITY_KEY, contacts, ['display_name', 'primary_email'], auth.tenantId, auth.orgId,
    )

    // Group on the decrypted address. Anything still unreadable is skipped
    // rather than grouped together — every undecryptable row would otherwise
    // collide into one bogus "duplicate" set.
    const groups: Record<string, { email: string; contacts: any[] }> = {}
    for (const contact of contacts) {
      const email = String(contact.primary_email || '').trim().toLowerCase()
      if (!email || !email.includes('@')) continue
      if (!groups[email]) groups[email] = { email, contacts: [] }
      groups[email].contacts.push({
        id: contact.id,
        displayName: contact.display_name,
        createdAt: contact.created_at,
        source: contact.source,
        lifecycleStage: contact.lifecycle_stage,
      })
    }

    for (const key of Object.keys(groups)) {
      if (groups[key].contacts.length < 2) delete groups[key]
    }

    const data = Object.values(groups).sort((a, b) => b.contacts.length - a.contacts.length)
    // Say so when the scan was capped: a short list must not read as "no duplicates".
    return NextResponse.json({ ok: true, data, scanned: contacts.length, truncated })
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
