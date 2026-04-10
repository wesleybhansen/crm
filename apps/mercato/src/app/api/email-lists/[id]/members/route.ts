import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await bootstrap()
  const { id: listId } = await params
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const list = await knex('email_lists')
      .where('id', listId)
      .where('organization_id', auth.orgId)
      .first()

    if (!list) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
    }

    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '50', 10)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)

    const members = await knex('email_list_members')
      .join('customer_entities', 'email_list_members.contact_id', 'customer_entities.id')
      .where('email_list_members.list_id', listId)
      .select(
        'email_list_members.contact_id',
        'customer_entities.display_name',
        'customer_entities.primary_email',
        'email_list_members.added_at'
      )
      .limit(limit)
      .offset(offset)

    return NextResponse.json({ ok: true, data: members })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to fetch members' }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await bootstrap()
  const { id: listId } = await params
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const list = await knex('email_lists')
      .where('id', listId)
      .where('organization_id', auth.orgId)
      .first()

    if (!list) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
    }

    const body = await req.json()
    const { contactIds } = body

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'contactIds array is required' }, { status: 400 })
    }

    const now = new Date()
    const rows = contactIds.map((contactId: string) => ({
      id: require('crypto').randomUUID(),
      list_id: listId,
      contact_id: contactId,
      added_at: now,
      tenant_id: list.tenant_id,
      organization_id: list.organization_id,
      created_at: now,
      updated_at: now,
    }))

    await knex('email_list_members')
      .insert(rows)
      .onConflict(['list_id', 'contact_id'])
      .ignore()

    const countResult = await knex('email_list_members')
      .where('list_id', listId)
      .count('* as count')
      .first()

    const memberCount = parseInt(String(countResult?.count || '0'), 10)

    await knex('email_lists')
      .where('id', listId)
      .update({ member_count: memberCount, updated_at: now })

    return NextResponse.json({ ok: true, added: memberCount })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to add members' }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await bootstrap()
  const { id: listId } = await params
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const list = await knex('email_lists')
      .where('id', listId)
      .where('organization_id', auth.orgId)
      .first()

    if (!list) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
    }

    const body = await req.json()
    const { contactIds } = body

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'contactIds array is required' }, { status: 400 })
    }

    await knex('email_list_members')
      .where('list_id', listId)
      .whereIn('contact_id', contactIds)
      .delete()

    const countResult = await knex('email_list_members')
      .where('list_id', listId)
      .count('* as count')
      .first()

    const memberCount = parseInt(String(countResult?.count || '0'), 10)

    await knex('email_lists')
      .where('id', listId)
      .update({ member_count: memberCount, updated_at: new Date() })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to remove members' }, { status: 500 })
  }
}
