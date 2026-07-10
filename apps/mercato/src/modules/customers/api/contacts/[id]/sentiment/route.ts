// ORM-SKIP: small aggregate read over email_messages sentiment
export const metadata = { path: '/contacts/[id]/sentiment', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

/* Recent email tone for a contact (T3b). The sentiment classifier has been
 * labeling inbound email for months; this is the first per-contact consumer.
 * Returns the last few inbound sentiments (newest first) plus the current
 * consecutive-negative streak so the UI can flag at-risk relationships. */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Org+tenant-scoped contact check first — never leak cross-tenant sentiment.
    const contact = await knex('customer_entities')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .whereNull('deleted_at')
      .first('id')
    if (!contact) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const rows = await knex('email_messages')
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .where('contact_id', id)
      .where('direction', 'inbound')
      .whereNotNull('sentiment')
      .orderBy('created_at', 'desc')
      .limit(10)
      .select('sentiment', 'created_at')

    let negativeStreak = 0
    for (const r of rows) {
      if (r.sentiment === 'negative' || r.sentiment === 'urgent') negativeStreak++
      else break
    }

    return NextResponse.json({
      ok: true,
      data: {
        recent: rows.map((r: { sentiment: string; created_at: Date }) => ({ sentiment: r.sentiment, created_at: r.created_at })),
        negativeStreak,
      },
    })
  } catch (error) {
    console.error('[contacts.sentiment]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts', summary: 'Recent email sentiment for a contact',
  methods: { GET: { summary: 'Last inbound email sentiments + negative streak', tags: ['Contacts'] } },
}
