export const metadata = { path: '/inbox/contacts', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { decryptRowsForDisplay } from '@/modules/customers/lib/display-decrypt'
import { CONTACT_SEARCH_CANDIDATE_LIMIT, contactMatchesSearch } from '@/modules/customers/lib/contact-search'

// Lightweight contact search for the inbox compose flow
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)
    const q = url.searchParams.get('q') || ''

    if (q.length < 2) return NextResponse.json({ ok: true, data: [] })

    // Name, email and phone are encrypted at rest, so SQL ILIKE can never
    // match them. Load the org's recent contacts (bounded), decrypt, filter
    // and sort in memory, and return decrypted values.
    const candidates = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .select('id', 'display_name', 'primary_email', 'primary_phone')
      .orderBy('created_at', 'desc')
      .limit(CONTACT_SEARCH_CANDIDATE_LIMIT)
    await decryptRowsForDisplay(
      em, CONTACT_ENTITY_KEY, candidates,
      { display_name: 'display_name', primary_email: 'primary_email', primary_phone: 'primary_phone' },
      auth.tenantId, auth.orgId,
    )
    const contacts = candidates
      .filter((c: any) => contactMatchesSearch(c, q, { phone: true }))
      .sort((a: any, b: any) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? ''), undefined, { sensitivity: 'base' }))
      .slice(0, 15)

    return NextResponse.json({ ok: true, data: contacts })
  } catch (error) {
    console.error('[inbox.contacts.search]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
