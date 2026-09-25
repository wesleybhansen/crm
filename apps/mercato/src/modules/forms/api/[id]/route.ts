import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { uniquePublicSlug } from '@/lib/public-slug'
import { shouldRegenerateSlug, slugifyFormName } from '../../lib/slug'

export const metadata = {
  GET: { requireAuth: true },
  PUT: { requireAuth: true },
  DELETE: { requireAuth: true },
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
    const id = ctx.params?.id

    if (!id) return NextResponse.json({ ok: false, error: 'Form ID is required' }, { status: 400 })

    const form = await knex('forms')
      .where('id', id)
      .where('organization_id', scope.orgId)
      .where('is_active', true)
      .first()

    if (!form) return NextResponse.json({ ok: false, error: 'Form not found' }, { status: 404 })

    const [{ count: submissionCount }] = await knex('form_submissions')
      .where('form_id', id)
      .count()

    return NextResponse.json({
      ok: true,
      data: { ...form, submission_count: Number(submissionCount) },
    })
  } catch (error) {
    console.error('[forms.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to get form' }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const id = ctx.params?.id

    if (!id) return NextResponse.json({ ok: false, error: 'Form ID is required' }, { status: 400 })

    const form = await knex('forms')
      .where('id', id)
      .where('organization_id', scope.orgId)
      .where('is_active', true)
      .first()
    if (!form) return NextResponse.json({ ok: false, error: 'Form not found' }, { status: 404 })

    const body = await req.json()
    const update: Record<string, unknown> = { updated_at: new Date() }

    if (body.name !== undefined) update.name = body.name
    // Until the form is first published nobody holds its link, so a rename
    // renames the slug too ("untitled-form-x1y2" -> "contact-us-a9b8").
    // After that the slug never changes.
    if (shouldRegenerateSlug(form, body.name)) {
      update.slug = await uniquePublicSlug(knex, 'forms', slugifyFormName(String(body.name).trim()), { excludeId: id })
    }
    if (body.description !== undefined) update.description = body.description
    if (body.fields !== undefined) update.fields = JSON.stringify(body.fields)
    if (body.theme !== undefined) update.theme = JSON.stringify(body.theme)
    if (body.settings !== undefined) update.settings = JSON.stringify(body.settings)
    if (body.status !== undefined) {
      update.status = body.status
      if (body.status === 'published' && form.status !== 'published') {
        update.published_at = new Date()
      }
    }

    await knex('forms').where('id', id).update(update)
    const updated = await knex('forms').where('id', id).first()
    return NextResponse.json({ ok: true, data: updated })
  } catch (error) {
    console.error('[forms.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update form' }, { status: 500 })
  }
}

export async function DELETE(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const id = ctx.params?.id

    if (!id) return NextResponse.json({ ok: false, error: 'Form ID is required' }, { status: 400 })

    const form = await knex('forms')
      .where('id', id)
      .where('organization_id', scope.orgId)
      .where('is_active', true)
      .first()
    if (!form) return NextResponse.json({ ok: false, error: 'Form not found' }, { status: 404 })

    await knex('forms').where('id', id).update({
      is_active: false,
      status: 'archived',
      updated_at: new Date(),
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[forms.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete form' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Forms',
  summary: 'Single form operations',
  methods: {
    GET: { summary: 'Get form by ID', tags: ['Forms'] },
    PUT: { summary: 'Update form by ID', tags: ['Forms'] },
    DELETE: { summary: 'Delete form by ID', tags: ['Forms'] },
  },
}
