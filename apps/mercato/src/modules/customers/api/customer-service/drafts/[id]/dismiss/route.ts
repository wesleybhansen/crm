// ORM-SKIP: marks a customer-service draft action dismissed
export const metadata = {
  path: '/customer-service/drafts/[id]/dismiss',
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// POST: dismiss a customer-service draft (does not send). Org-scoped.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const action = await knex('inbox_proposal_actions')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .where('action_type', 'draft_reply')
      .whereRaw(`metadata->>'feature_source' = ?`, ['customer_service'])
      .first()

    if (!action) return NextResponse.json({ ok: false, error: 'Draft not found' }, { status: 404 })
    if (action.status === 'sent') return NextResponse.json({ ok: false, error: 'Draft already sent' }, { status: 409 })

    const now = new Date()
    await knex('inbox_proposal_actions')
      .where('id', action.id)
      .update({ status: 'dismissed', updated_at: now })
    await knex('inbox_proposals')
      .where('id', action.proposal_id)
      .where('organization_id', auth.orgId)
      .update({ status: 'rejected', reviewed_by_user_id: auth.sub || null, reviewed_at: now, updated_at: now })

    return NextResponse.json({ ok: true, data: { id: action.id, status: 'dismissed' } })
  } catch (error) {
    console.error('[customer-service.dismiss]', error)
    return NextResponse.json({ ok: false, error: 'Failed to dismiss draft' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Dismiss a customer-service draft',
  methods: {
    POST: { summary: 'Dismiss a queued customer-service draft reply', tags: ['Customer Service'] },
  },
}
