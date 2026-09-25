import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { decryptRowsForDisplay } from '@/modules/customers/lib/display-decrypt'

export const metadata = {
  GET: { requireAuth: true },
}

function getScope(ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return null
  return { tenantId: auth.tenantId, orgId: auth.orgId, userId: auth.sub }
}

export async function GET(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const formId = ctx.params?.id
    const url = new URL(req.url)

    if (!formId) return NextResponse.json({ ok: false, error: 'Form ID is required' }, { status: 400 })

    // Verify the form belongs to this org
    const form = await knex('forms')
      .where('id', formId)
      .where('organization_id', scope.orgId)
      .where('is_active', true)
      .first()

    if (!form) return NextResponse.json({ ok: false, error: 'Form not found' }, { status: 404 })

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10)))

    const baseQuery = knex('form_submissions as fs')
      .where('fs.form_id', formId)

    const [{ count: total }] = await baseQuery.clone().count()

    const submissions = await baseQuery
      .clone()
      .leftJoin('customer_entities as ce', 'fs.contact_id', 'ce.id')
      .select(
        'fs.id',
        'fs.form_id',
        'fs.data',
        'fs.contact_id',
        'fs.source_ip',
        'fs.user_agent',
        'fs.referrer',
        'fs.created_at',
        'ce.display_name as contact_name',
        'ce.primary_email as contact_email',
      )
      .orderBy('fs.created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
    // Joined contact name/email are encrypted at rest; this raw read skips the subscriber.
    await decryptRowsForDisplay(
      em, CONTACT_ENTITY_KEY, submissions,
      { contact_name: 'display_name', contact_email: 'primary_email' },
      scope.tenantId, scope.orgId,
    )

    return NextResponse.json({
      ok: true,
      data: submissions,
      pagination: { page, pageSize, total: Number(total), totalPages: Math.ceil(Number(total) / pageSize) },
    })
  } catch (error) {
    console.error('[forms.submissions.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list submissions' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Forms',
  summary: 'Form submissions',
  methods: {
    GET: { summary: 'List submissions for a form', tags: ['Forms'] },
  },
}
