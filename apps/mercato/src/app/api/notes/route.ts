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

    let query = knex('contact_notes').where('organization_id', auth.orgId).orderBy('created_at', 'desc')
    if (contactId) query = query.where('contact_id', contactId)

    const notes = await query.limit(20)
    return NextResponse.json({ ok: true, data: notes })
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
    const { contactId, content } = body
    if (!contactId || !content?.trim()) return NextResponse.json({ ok: false, error: 'contactId and content required' }, { status: 400 })

    const id = require('crypto').randomUUID()
    await knex('contact_notes').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      contact_id: contactId, content: content.trim(),
      author_user_id: auth.sub, created_at: new Date(), updated_at: new Date(),
    })

    const note = await knex('contact_notes').where('id', id).first()
    return NextResponse.json({ ok: true, data: note }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
