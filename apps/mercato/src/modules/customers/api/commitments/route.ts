import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

/* Commitments CRUD: what was promised, both directions. Rows come from AI
 * extraction (meeting prep / debrief) and manual/Scout adds; this route lists,
 * adds, and resolves them. */

export const metadata = {
  path: '/customers/commitments',
  GET: { requireAuth: true },
  POST: { requireAuth: true },
  PATCH: { requireAuth: true },
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const knex = ((await createRequestContainer()).resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const contactId = url.searchParams.get('contactId')
    const status = url.searchParams.get('status') ?? 'open'

    const rows = await knex('commitments')
      .where('organization_id', auth.orgId)
      .modify((qb) => {
        if (contactId) qb.where('contact_id', contactId)
        if (status !== 'all') qb.where('status', status)
      })
      .orderByRaw('due_at nulls last, created_at desc')
      .limit(100)
      .select('id', 'contact_id', 'deal_id', 'direction', 'description', 'due_at', 'status', 'source', 'created_at', 'resolved_at')
    return NextResponse.json({ ok: true, data: rows })
  } catch (error) {
    console.error('[commitments.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list commitments' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const knex = ((await createRequestContainer()).resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const description = String(body.description ?? '').trim()
    if (description.length < 5 || description.length > 500) {
      return NextResponse.json({ ok: false, error: 'description must be 5-500 characters' }, { status: 400 })
    }
    const contactId = body.contactId ? String(body.contactId) : null
    if (contactId) {
      const contact = await knex('customer_entities')
        .where('id', contactId).where('organization_id', auth.orgId).whereNull('deleted_at')
        .first()
      if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    }
    const dueAt = body.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate)) ? new Date(String(body.dueDate)) : null
    const [row] = await knex('commitments')
      .insert({
        organization_id: auth.orgId,
        tenant_id: auth.tenantId ?? null,
        contact_id: contactId,
        deal_id: body.dealId ? String(body.dealId) : null,
        direction: body.direction === 'theirs' ? 'theirs' : 'ours',
        description,
        due_at: dueAt,
        status: 'open',
        source: body.source === 'debrief' ? 'debrief' : 'manual',
      })
      .returning('*')
    return NextResponse.json({ ok: true, data: row }, { status: 201 })
  } catch (error) {
    console.error('[commitments.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create commitment' }, { status: 500 })
  }
}

export async function PATCH(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const knex = ((await createRequestContainer()).resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const id = String(body.id ?? '')
    const action = String(body.action ?? '')
    if (!id || !['resolve', 'dismiss', 'reopen'].includes(action)) {
      return NextResponse.json({ ok: false, error: 'id and action (resolve|dismiss|reopen) required' }, { status: 400 })
    }
    const status = action === 'resolve' ? 'resolved' : action === 'dismiss' ? 'dismissed' : 'open'
    const updated = await knex('commitments')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .update({
        status,
        resolved_at: status === 'resolved' ? new Date() : null,
        updated_at: new Date(),
      })
    if (!updated) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[commitments.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update commitment' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customers',
  summary: 'Commitments (promises made both directions)',
  methods: {
    GET: { summary: 'Commitments (promises made both directions)' },
  },
}
