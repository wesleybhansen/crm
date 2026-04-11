// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD
export const metadata = { path: '/ai/needs-attention', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Get negative/urgent emails from the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const alerts = await knex('email_messages as em')
      .leftJoin('customer_entities as ce', 'ce.id', 'em.contact_id')
      .where('em.organization_id', auth.orgId)
      .where('em.direction', 'inbound')
      .whereIn('em.sentiment', ['negative', 'urgent'])
      .where('em.created_at', '>=', sevenDaysAgo)
      .orderBy('em.created_at', 'desc')
      .limit(10)
      .select(
        'em.id',
        'em.subject',
        'em.from_address',
        'em.sentiment',
        'em.contact_id',
        'em.created_at',
        'ce.display_name as contact_name'
      )

    const items = alerts.map(a => ({
      id: a.id,
      type: a.sentiment,
      title: a.sentiment === 'urgent'
        ? `Urgent: ${a.subject || 'No subject'}`
        : `Negative: ${a.subject || 'No subject'}`,
      description: `From ${a.contact_name || a.from_address}`,
      contactId: a.contact_id,
      timestamp: a.created_at,
    }))

    return NextResponse.json({ ok: true, data: items })
  } catch (error) {
    console.error('[ai.needs-attention]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'AI', summary: 'Needs attention alerts',
  methods: { GET: { summary: 'Get emails flagged as negative or urgent by AI', tags: ['AI'] } },
}
