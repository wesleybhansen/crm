// ORM-SKIP: complex business logic beyond simple CRUD — convert when touched
export const metadata = { path: '/task-templates/apply', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const openApi: OpenApiRouteDoc = {
  summary: 'Apply a task template',
  methods: {
    POST: {
      summary: 'Apply a task template to a contact',
      tags: ['Task Templates'],
    },
  },
}

// The apply logic lives in lib/task-template-apply.ts so automation rules can
// run it from the queue workers, which cannot load Next route modules.
export { applyTaskTemplate } from '../../../lib/task-template-apply'
import { applyTaskTemplate } from '../../../lib/task-template-apply'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    const { templateId, contactId } = body
    if (!templateId) return NextResponse.json({ ok: false, error: 'templateId required' }, { status: 400 })
    if (!contactId) return NextResponse.json({ ok: false, error: 'contactId required' }, { status: 400 })

    // Verify the contact exists
    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()
    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    const result = await applyTaskTemplate(knex, auth.orgId, auth.tenantId, templateId, contactId)

    if (!result.success) {
      return NextResponse.json({ ok: false, error: result.detail }, { status: 400 })
    }

    return NextResponse.json({ ok: true, data: result }, { status: 201 })
  } catch (error) {
    console.error('[task-templates.apply] POST error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to apply template' }, { status: 500 })
  }
}
