import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)
    const contactId = url.searchParams.get('contactId')
    const showDone = url.searchParams.get('done') === 'true'

    let query = knex('tasks').where('organization_id', auth.orgId)
    if (contactId) query = query.where('contact_id', contactId)
    if (!showDone) query = query.where('is_done', false)
    query = query.orderBy('due_date', 'asc').orderBy('created_at', 'desc')

    const tasks = await query.limit(50)
    return NextResponse.json({ ok: true, data: tasks })
  } catch (error) {
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
    const { title, description, contactId, dealId, dueDate } = body
    if (!title?.trim()) return NextResponse.json({ ok: false, error: 'title required' }, { status: 400 })

    const id = require('crypto').randomUUID()
    await knex('tasks').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      title: title.trim(), description: description || null,
      contact_id: contactId || null, deal_id: dealId || null,
      due_date: dueDate || null, is_done: false,
      created_at: new Date(), updated_at: new Date(),
    })

    const task = await knex('tasks').where('id', id).first()
    return NextResponse.json({ ok: true, data: task }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const { id, is_done, title } = body
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const update: Record<string, any> = { updated_at: new Date() }
    if (is_done !== undefined) {
      update.is_done = is_done
      update.completed_at = is_done ? new Date() : null
    }
    if (title !== undefined) update.title = title

    await knex('tasks').where('id', id).where('organization_id', auth.orgId).update(update)
    const task = await knex('tasks').where('id', id).first()
    return NextResponse.json({ ok: true, data: task })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
