import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80)
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const surveys = await knex('surveys')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .orderBy('created_at', 'desc')
      .limit(100)
    return NextResponse.json({ ok: true, data: surveys })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to load surveys' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { title, description, fields, thankYouMessage } = body

    if (!title?.trim()) return NextResponse.json({ ok: false, error: 'Title is required' }, { status: 400 })
    if (!Array.isArray(fields) || fields.length === 0) return NextResponse.json({ ok: false, error: 'At least one field is required' }, { status: 400 })

    const validTypes = ['text', 'textarea', 'select', 'multi_select', 'radio', 'checkbox', 'rating', 'nps', 'date', 'email', 'phone', 'number']
    for (const field of fields) {
      if (!field.id || !field.type || !field.label?.trim()) {
        return NextResponse.json({ ok: false, error: 'Each field must have id, type, and label' }, { status: 400 })
      }
      if (!validTypes.includes(field.type)) {
        return NextResponse.json({ ok: false, error: `Invalid field type: ${field.type}` }, { status: 400 })
      }
    }

    const baseSlug = slugify(title)
    const suffix = crypto.randomUUID().substring(0, 8)
    const slug = `${baseSlug}-${suffix}`
    const id = crypto.randomUUID()
    const now = new Date()

    await knex('surveys').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      title: title.trim(),
      description: description?.trim() || null,
      slug,
      fields: JSON.stringify(fields),
      thank_you_message: thankYouMessage?.trim() || 'Thank you for your response!',
      is_active: true,
      response_count: 0,
      created_at: now,
      updated_at: now,
    })

    const survey = await knex('surveys').where('id', id).first()
    return NextResponse.json({ ok: true, data: survey }, { status: 201 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to create survey' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    const existing = await knex('surveys').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Survey not found' }, { status: 404 })

    const body = await req.json()
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.title !== undefined) updates.title = body.title.trim()
    if (body.description !== undefined) updates.description = body.description?.trim() || null
    if (body.fields !== undefined) updates.fields = JSON.stringify(body.fields)
    if (body.thankYouMessage !== undefined) updates.thank_you_message = body.thankYouMessage?.trim() || 'Thank you for your response!'
    if (body.isActive !== undefined) updates.is_active = body.isActive

    await knex('surveys').where('id', id).where('organization_id', auth.orgId).update(updates)
    const survey = await knex('surveys').where('id', id).first()
    return NextResponse.json({ ok: true, data: survey })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to update survey' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    await knex('surveys').where('id', id).where('organization_id', auth.orgId).update({ is_active: false, updated_at: new Date() })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to delete survey' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Surveys', summary: 'Survey CRUD',
  methods: {
    GET: { summary: 'List all surveys', tags: ['Surveys'] },
    POST: { summary: 'Create a survey', tags: ['Surveys'] },
    PUT: { summary: 'Update a survey', tags: ['Surveys'] },
    DELETE: { summary: 'Soft-delete a survey', tags: ['Surveys'] },
  },
}
