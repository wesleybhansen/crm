import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const openApi: OpenApiRouteDoc = {
  GET: { summary: 'List task templates', tags: ['Task Templates'] },
  POST: { summary: 'Create a task template', tags: ['Task Templates'] },
  PUT: { summary: 'Update a task template', tags: ['Task Templates'] },
  DELETE: { summary: 'Delete a task template', tags: ['Task Templates'] },
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const templates = await knex('task_templates')
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')

    return NextResponse.json({ ok: true, data: templates })
  } catch (error) {
    console.error('[task-templates] GET error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch templates' }, { status: 500 })
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

    const { name, description, triggerType, triggerConfig, tasks } = body
    if (!name?.trim()) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 })
    if (!Array.isArray(tasks) || tasks.length === 0) return NextResponse.json({ ok: false, error: 'tasks array required' }, { status: 400 })

    const validTriggerTypes = ['manual', 'deal_won', 'stage_change']
    const resolvedTrigger = validTriggerTypes.includes(triggerType) ? triggerType : 'manual'

    const sanitizedTasks = tasks.map((t: any, idx: number) => ({
      title: t.title || `Task ${idx + 1}`,
      description: t.description || null,
      dueDaysFromTrigger: typeof t.dueDaysFromTrigger === 'number' ? t.dueDaysFromTrigger : idx + 1,
      order: typeof t.order === 'number' ? t.order : idx + 1,
    }))

    const id = require('crypto').randomUUID()
    await knex('task_templates').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      description: description || null,
      trigger_type: resolvedTrigger,
      trigger_config: JSON.stringify(triggerConfig || {}),
      tasks: JSON.stringify(sanitizedTasks),
      created_at: new Date(),
      updated_at: new Date(),
    })

    const template = await knex('task_templates').where('id', id).first()
    return NextResponse.json({ ok: true, data: template }, { status: 201 })
  } catch (error) {
    console.error('[task-templates] POST error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to create template' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    const body = await req.json()
    const update: Record<string, any> = { updated_at: new Date() }

    if (body.name !== undefined) update.name = body.name.trim()
    if (body.description !== undefined) update.description = body.description
    if (body.triggerType !== undefined) update.trigger_type = body.triggerType
    if (body.triggerConfig !== undefined) update.trigger_config = JSON.stringify(body.triggerConfig)
    if (body.tasks !== undefined && Array.isArray(body.tasks)) {
      update.tasks = JSON.stringify(body.tasks.map((t: any, idx: number) => ({
        title: t.title || `Task ${idx + 1}`,
        description: t.description || null,
        dueDaysFromTrigger: typeof t.dueDaysFromTrigger === 'number' ? t.dueDaysFromTrigger : idx + 1,
        order: typeof t.order === 'number' ? t.order : idx + 1,
      })))
    }

    await knex('task_templates').where('id', id).where('organization_id', auth.orgId).update(update)
    const template = await knex('task_templates').where('id', id).first()
    return NextResponse.json({ ok: true, data: template })
  } catch (error) {
    console.error('[task-templates] PUT error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to update template' }, { status: 500 })
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

    await knex('task_templates').where('id', id).where('organization_id', auth.orgId).del()
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[task-templates] DELETE error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete template' }, { status: 500 })
  }
}
