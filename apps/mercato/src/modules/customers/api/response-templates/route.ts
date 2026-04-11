// ORM-SKIP: needs entity definition — Phase 2 conversion
export const metadata = { path: '/response-templates', GET: { requireAuth: true }, POST: { requireAuth: true }, DELETE: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const templates = await knex('response_templates')
      .where('organization_id', auth.orgId)
      .orderBy('name')

    return NextResponse.json({ ok: true, data: templates })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, subject, bodyText, category } = body

    if (!name?.trim() || !bodyText?.trim()) {
      return NextResponse.json({ ok: false, error: 'name and bodyText are required' }, { status: 400 })
    }

    const id = require('crypto').randomUUID()
    await knex('response_templates').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      subject: subject?.trim() || null,
      body_text: bodyText.trim(),
      category: category || 'general',
      created_at: new Date(),
      updated_at: new Date(),
    })

    const template = await knex('response_templates').where('id', id).first()
    return NextResponse.json({ ok: true, data: template }, { status: 201 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    await knex('response_templates').where('id', id).where('organization_id', auth.orgId).del()
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
