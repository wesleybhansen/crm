export const metadata = { path: '/response-templates', GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ResponseTemplate } from '../../data/schema'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const templates = await em.find(ResponseTemplate, {
      organizationId: auth.orgId, tenantId: auth.tenantId,
    }, { orderBy: { name: 'asc' } })
    return NextResponse.json({ ok: true, data: templates.map(t => ({
      id: t.id, tenant_id: t.tenantId, organization_id: t.organizationId,
      name: t.name, subject: t.subject, body_text: t.bodyText,
      category: t.category, created_at: t.createdAt, updated_at: t.updatedAt,
    })) })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const body = await req.json()
    const { name, subject, bodyText, category } = body
    if (!name?.trim() || !bodyText?.trim()) return NextResponse.json({ ok: false, error: 'name and bodyText are required' }, { status: 400 })

    const template = em.create(ResponseTemplate, {
      tenantId: auth.tenantId, organizationId: auth.orgId,
      name: name.trim(), subject: subject?.trim() || null,
      bodyText: bodyText.trim(), category: category || 'general',
    })
    em.persist(template)
    await em.flush()

    return NextResponse.json({ ok: true, data: {
      id: template.id, tenant_id: template.tenantId, organization_id: template.organizationId,
      name: template.name, subject: template.subject, body_text: template.bodyText,
      category: template.category, created_at: template.createdAt, updated_at: template.updatedAt,
    } }, { status: 201 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
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
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    await em.nativeDelete(ResponseTemplate, { id, organizationId: auth.orgId, tenantId: auth.tenantId })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Response Templates', summary: 'Quick response templates',
  methods: {
    GET: { summary: 'List response templates', tags: ['Response Templates'] },
    POST: { summary: 'Create a response template', tags: ['Response Templates'] },
    DELETE: { summary: 'Delete a response template', tags: ['Response Templates'] },
  },
}
