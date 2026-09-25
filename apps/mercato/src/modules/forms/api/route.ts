import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { isPublicSlugTaken, uniquePublicSlug } from '@/lib/public-slug'

export const metadata = {
  GET: { requireAuth: true },
  POST: { requireAuth: true },
  PUT: { requireAuth: true },
  DELETE: { requireAuth: true },
}

function getScope(ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return null
  return { tenantId: auth.tenantId, orgId: auth.orgId, userId: auth.sub }
}

function randomSuffix() { return Math.random().toString(36).substring(2, 6) }

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${base}-${randomSuffix()}`
}

export async function GET(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)

    const search = url.searchParams.get('search') || ''
    const status = url.searchParams.get('status') || ''
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10)))

    let query = knex('forms')
      .where('tenant_id', scope.tenantId)
      .where('organization_id', scope.orgId)
      .where('is_active', true)

    if (search) {
      query = query.where(function () {
        this.where('name', 'ilike', `%${search}%`).orWhere('slug', 'ilike', `%${search}%`)
      })
    }
    if (status) {
      query = query.where('status', status)
    }

    const [{ count: total }] = await query.clone().count()
    const forms = await query
      .select('*')
      .orderBy('updated_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    return NextResponse.json({
      ok: true,
      data: forms,
      pagination: { page, pageSize, total: Number(total), totalPages: Math.ceil(Number(total) / pageSize) },
    })
  } catch (error) {
    console.error('[forms.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list forms' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    const name = (body.name || '').trim()
    if (!name) return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 })

    // Public form links resolve by slug alone: unique across every organisation.
    const slug = await uniquePublicSlug(knex, 'forms', body.slug ? slugify(body.slug) : slugify(name))

    const id = require('crypto').randomUUID()
    const now = new Date()

    await knex('forms').insert({
      id,
      tenant_id: scope.tenantId,
      organization_id: scope.orgId,
      name,
      slug,
      description: body.description || null,
      fields: JSON.stringify(body.fields || []),
      theme: body.theme ? JSON.stringify(body.theme) : JSON.stringify({}),
      settings: body.settings ? JSON.stringify(body.settings) : JSON.stringify({}),
      status: body.status || 'draft',
      template_id: body.templateId || null,
      owner_user_id: scope.userId,
      view_count: 0,
      submission_count: 0,
      created_at: now,
      updated_at: now,
    })

    const form = await knex('forms').where('id', id).first()
    return NextResponse.json({ ok: true, data: form }, { status: 201 })
  } catch (error) {
    console.error('[forms.create]', error)
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    if (!body.id) return NextResponse.json({ ok: false, error: 'Form ID is required' }, { status: 400 })

    const form = await knex('forms')
      .where('id', body.id)
      .where('organization_id', scope.orgId)
      .where('is_active', true)
      .first()
    if (!form) return NextResponse.json({ ok: false, error: 'Form not found' }, { status: 404 })

    if (body.slug && body.slug !== form.slug) {
      const dup = await isPublicSlugTaken(knex, 'forms', slugify(body.slug), { excludeId: body.id })
      if (dup) return NextResponse.json({ ok: false, error: 'A form with this slug already exists' }, { status: 409 })
    }

    const update: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) update.name = body.name
    if (body.slug !== undefined) update.slug = slugify(body.slug)
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

    await knex('forms').where('id', body.id).update(update)
    const updated = await knex('forms').where('id', body.id).first()
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
    const url = new URL(req.url)
    const id = url.searchParams.get('id')

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
  summary: 'Form builder CRUD',
  methods: {
    GET: { summary: 'List forms', tags: ['Forms'] },
    POST: { summary: 'Create a form', tags: ['Forms'] },
    PUT: { summary: 'Update a form', tags: ['Forms'] },
    DELETE: { summary: 'Delete a form', tags: ['Forms'] },
  },
}
