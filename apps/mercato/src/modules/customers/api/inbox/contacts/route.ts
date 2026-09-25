export const metadata = { path: '/inbox/contacts', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { decryptRowsForDisplay } from '@/modules/customers/lib/display-decrypt'
import { blindSearchIds } from '@open-mercato/core/modules/customers/lib/blindSearch'

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

    // Name, email and phone are encrypted at rest: match on the blind index
    // (ranked, org-scoped in SQL), then read and decrypt only the matches.
    const { hits } = await blindSearchIds(em, {
      tenantId: auth.tenantId,
      organizationIds: [auth.orgId],
      entityTypes: ['person', 'company'],
      query: q,
      cap: 15,
    })
    const ids = hits.map((h) => h.entityId)
    const rows = ids.length
      ? await knex('customer_entities')
        .where('organization_id', auth.orgId)
        .whereIn('id', ids)
        .whereNull('deleted_at')
        .select('id', 'display_name', 'primary_email', 'primary_phone')
      : []
    await decryptRowsForDisplay(
      em, CONTACT_ENTITY_KEY, rows,
      { display_name: 'display_name', primary_email: 'primary_email', primary_phone: 'primary_phone' },
      auth.tenantId, auth.orgId,
    )
    const order = new Map(ids.map((id, i) => [id, i]))
    const contacts = rows.sort((a: any, b: any) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

    return NextResponse.json({ ok: true, data: contacts })
  } catch (error) {
    console.error('[inbox.contacts.search]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
