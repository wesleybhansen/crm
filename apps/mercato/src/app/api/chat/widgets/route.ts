import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const widgets = await knex('chat_widgets')
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
    const origin = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
    const data = widgets.map((w: any) => ({
      ...w,
      embedCode: `<script src="${origin}/api/chat/widget/${w.id}" async></script>`,
    }))
    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[chat.widgets.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load widgets' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, greetingMessage, config } = body
    if (!name?.trim()) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 })

    const id = crypto.randomUUID()
    const row: Record<string, unknown> = {
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      created_at: new Date(),
      updated_at: new Date(),
    }
    if (greetingMessage !== undefined) row.greeting_message = greetingMessage
    if (config !== undefined) row.config = JSON.stringify(config)

    await knex('chat_widgets').insert(row)
    const widget = await knex('chat_widgets').where('id', id).first()
    return NextResponse.json({ ok: true, data: widget }, { status: 201 })
  } catch (error) {
    console.error('[chat.widgets.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create widget' }, { status: 500 })
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

    const body = await req.json()
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.greetingMessage !== undefined) updates.greeting_message = body.greetingMessage
    if (body.config !== undefined) updates.config = JSON.stringify(body.config)
    if (body.isActive !== undefined) updates.is_active = body.isActive

    await knex('chat_widgets').where('id', id).andWhere('organization_id', auth.orgId).update(updates)
    const widget = await knex('chat_widgets').where('id', id).first()
    return NextResponse.json({ ok: true, data: widget })
  } catch (error) {
    console.error('[chat.widgets.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update widget' }, { status: 500 })
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

    await knex('chat_widgets').where('id', id).andWhere('organization_id', auth.orgId).delete()
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[chat.widgets.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete widget' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Manage chat widgets',
  methods: {
    GET: { summary: 'List chat widgets', tags: ['Chat'] },
    POST: { summary: 'Create a chat widget', tags: ['Chat'] },
    PUT: { summary: 'Update a chat widget', tags: ['Chat'] },
    DELETE: { summary: 'Delete a chat widget', tags: ['Chat'] },
  },
}
