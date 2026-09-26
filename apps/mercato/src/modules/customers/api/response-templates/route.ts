// ORM-SKIP: small raw CRUD over response_templates (no entity yet)
export const metadata = {
  path: '/response-templates',
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
  PUT: { requireAuth: true, requireFeatures: ['email.send'] },
  DELETE: { requireAuth: true, requireFeatures: ['email.send'] },
}

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { normalizeResponseTemplateInput } from '../../lib/response-templates'

/* Saved replies ("response templates"). Created and edited in Customer Service
 * settings; offered in the email composer and in the Customer Service queue.
 * Every query is scoped to the caller's tenant and organization. */

const COLUMNS = ['id', 'name', 'subject', 'body_text', 'category', 'created_at', 'updated_at']

async function knexFor() {
  const container = await createRequestContainer()
  return (container.resolve('em') as EntityManager).getKnex()
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const knex = await knexFor()
    const templates = await knex('response_templates')
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .orderBy('name')
      .select(COLUMNS)
    return NextResponse.json({ ok: true, data: templates })
  } catch (error) {
    console.error('[response-templates.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load templates' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const input = normalizeResponseTemplateInput(await req.json().catch(() => null))
    if (!input.ok) return NextResponse.json({ ok: false, error: input.error }, { status: 400 })

    const knex = await knexFor()
    const id = crypto.randomUUID()
    const now = new Date()
    await knex('response_templates').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      ...input.value,
      created_at: now,
      updated_at: now,
    })

    const template = await knex('response_templates')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .select(COLUMNS)
      .first()
    return NextResponse.json({ ok: true, data: template }, { status: 201 })
  } catch (error) {
    console.error('[response-templates.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save the template' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json().catch(() => null)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
    const input = normalizeResponseTemplateInput(body)
    if (!input.ok) return NextResponse.json({ ok: false, error: input.error }, { status: 400 })

    const knex = await knexFor()
    const updated = await knex('response_templates')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .update({ ...input.value, updated_at: new Date() })
    if (!updated) return NextResponse.json({ ok: false, error: 'Template not found' }, { status: 404 })

    const template = await knex('response_templates')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .select(COLUMNS)
      .first()
    return NextResponse.json({ ok: true, data: template })
  } catch (error) {
    console.error('[response-templates.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save the template' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const knex = await knexFor()
    await knex('response_templates')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .del()
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[response-templates.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete the template' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Response Templates', summary: 'Saved reply templates',
  methods: {
    GET: { summary: 'List response templates', tags: ['Response Templates'] },
    POST: { summary: 'Create a response template', tags: ['Response Templates'] },
    PUT: { summary: 'Update a response template', tags: ['Response Templates'] },
    DELETE: { summary: 'Delete a response template', tags: ['Response Templates'] },
  },
}
