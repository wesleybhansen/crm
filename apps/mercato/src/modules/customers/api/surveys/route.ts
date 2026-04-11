export const metadata = { path: '/surveys', GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'
import { Survey, SurveyResponse } from '../../data/schema'

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80)
}

function serialize(s: Survey) {
  return {
    id: s.id, tenant_id: s.tenantId, organization_id: s.organizationId,
    title: s.title, description: s.description, slug: s.slug,
    fields: s.fields, thank_you_message: s.thankYouMessage,
    is_active: s.isActive, response_count: s.responseCount,
    created_at: s.createdAt, updated_at: s.updatedAt,
  }
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const surveys = await em.find(Survey, {
      organizationId: auth.orgId, tenantId: auth.tenantId,
    }, { orderBy: { createdAt: 'desc' }, limit: 100 })
    return NextResponse.json({ ok: true, data: surveys.map(serialize) })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to load surveys' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
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

    const survey = em.create(Survey, {
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
      title: title.trim(),
      description: description?.trim() || null,
      slug: `${baseSlug}-${suffix}`,
      fields,
      thankYouMessage: thankYouMessage?.trim() || 'Thank you for your response!',
    })
    em.persist(survey)
    await em.flush()

    return NextResponse.json({ ok: true, data: serialize(survey) }, { status: 201 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to create survey' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    const survey = await em.findOne(Survey, { id, organizationId: auth.orgId, tenantId: auth.tenantId })
    if (!survey) return NextResponse.json({ ok: false, error: 'Survey not found' }, { status: 404 })

    const body = await req.json()
    if (body.title !== undefined) survey.title = body.title.trim()
    if (body.description !== undefined) survey.description = body.description?.trim() || null
    if (body.fields !== undefined) survey.fields = body.fields
    if (body.thankYouMessage !== undefined) survey.thankYouMessage = body.thankYouMessage?.trim() || 'Thank you for your response!'
    if (body.isActive !== undefined) survey.isActive = body.isActive

    await em.flush()
    return NextResponse.json({ ok: true, data: serialize(survey) })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to update survey' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    // Delete responses first (cascade), then survey
    await em.nativeDelete(SurveyResponse, { surveyId: id })
    await em.nativeDelete(Survey, { id, organizationId: auth.orgId, tenantId: auth.tenantId })
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
    DELETE: { summary: 'Delete a survey and responses', tags: ['Surveys'] },
  },
}
