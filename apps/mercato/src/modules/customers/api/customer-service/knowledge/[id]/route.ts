// ORM-SKIP: soft-delete a customer_service_knowledge entry, org-scoped
export const metadata = {
  path: '/customer-service/knowledge/[id]',
  DELETE: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// DELETE: soft-delete (is_active = false) a grounding entry. Org-scoped.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const updated = await knex('customer_service_knowledge')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .update({ is_active: false, updated_at: new Date() })

    if (!updated) {
      return NextResponse.json({ ok: false, error: 'Entry not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[customer-service.knowledge.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete entry' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Delete a Customer Service grounding entry',
  methods: {
    DELETE: { summary: 'Soft-delete a grounding entry for the current org', tags: ['Customer Service'] },
  },
}
