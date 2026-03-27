import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const reminders = await knex('reminders')
      .select(
        'reminders.*',
        knex.raw(`
          CASE reminders.entity_type
            WHEN 'contact' THEN (SELECT display_name FROM customer_entities WHERE id = reminders.entity_id LIMIT 1)
            WHEN 'deal' THEN (SELECT title FROM customer_deals WHERE id = reminders.entity_id LIMIT 1)
            WHEN 'task' THEN (SELECT title FROM tasks WHERE id = reminders.entity_id LIMIT 1)
            ELSE NULL
          END AS entity_name
        `),
      )
      .where('reminders.organization_id', auth.orgId)
      .where('reminders.user_id', auth.sub)
      .where('reminders.sent', false)
      .orderBy('reminders.remind_at', 'asc')
      .limit(50)

    return NextResponse.json({ ok: true, data: reminders })
  } catch (error) {
    console.error('[reminders.GET]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const { entityType, entityId, message, remindAt } = body

    if (!entityType || !entityId || !message?.trim() || !remindAt) {
      return NextResponse.json({ ok: false, error: 'entityType, entityId, message, and remindAt are required' }, { status: 400 })
    }

    const remindAtDate = new Date(remindAt)
    if (isNaN(remindAtDate.getTime()) || remindAtDate.getTime() <= Date.now()) {
      return NextResponse.json({ ok: false, error: 'remindAt must be a valid future date' }, { status: 400 })
    }

    const id = require('crypto').randomUUID()
    await knex('reminders').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      user_id: auth.sub,
      entity_type: entityType,
      entity_id: entityId,
      message: message.trim(),
      remind_at: remindAtDate,
      sent: false,
      created_at: new Date(),
    })

    const reminder = await knex('reminders').where('id', id).first()
    return NextResponse.json({ ok: true, data: reminder }, { status: 201 })
  } catch (error) {
    console.error('[reminders.POST]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')

    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    const deleted = await knex('reminders')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('user_id', auth.sub)
      .del()

    if (deleted === 0) return NextResponse.json({ ok: false, error: 'Reminder not found' }, { status: 404 })

    return NextResponse.json({ ok: true, data: { id } })
  } catch (error) {
    console.error('[reminders.DELETE]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Reminders',
  summary: 'Manage reminders',
  methods: {
    GET: { summary: 'List upcoming reminders for the current user', tags: ['Reminders'] },
    POST: { summary: 'Create a reminder', tags: ['Reminders'] },
    DELETE: { summary: 'Delete a reminder by id', tags: ['Reminders'] },
  },
}
