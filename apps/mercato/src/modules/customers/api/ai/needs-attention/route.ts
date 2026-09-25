// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD
export const metadata = { path: '/ai/needs-attention', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { decryptAliasedRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { buildAttentionItems } from '../../../lib/needs-attention'

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
      // Read past the 10 shown: repeats and system mail are dropped below.
      .limit(100)
      .select(
        'em.id',
        'em.subject',
        'em.from_address',
        'em.sentiment',
        'em.contact_id',
        'em.created_at',
        'ce.display_name as contact_name'
      )
    // Raw join: open the contact name before it is shown.
    await decryptAliasedRowFields(null, CONTACT_ENTITY_KEY, alerts, { contact_name: 'display_name' }, auth.tenantId, auth.orgId)

    // Automated / Noli system mail is left out and repeats of one thread
    // collapse to one row with a count (QA 2026-09-25 M7, #16).
    const items = buildAttentionItems(alerts, 10)

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
