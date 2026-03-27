import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const campaigns = await knex('email_campaigns')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .limit(50)

    return NextResponse.json({ ok: true, data: campaigns })
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
    const { name, subject, bodyHtml, segmentFilter, templateId } = body

    if (!name || !subject || !bodyHtml) {
      return NextResponse.json({ ok: false, error: 'name, subject, and bodyHtml required' }, { status: 400 })
    }

    const id = require('crypto').randomUUID()
    await knex('email_campaigns').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      name, subject, body_html: bodyHtml,
      template_id: templateId || null,
      status: 'draft',
      segment_filter: segmentFilter ? JSON.stringify(segmentFilter) : null,
      stats: JSON.stringify({ total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0 }),
      created_at: new Date(),
    })

    return NextResponse.json({ ok: true, data: { id } }, { status: 201 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
