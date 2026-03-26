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
    const automations = await knex('stage_automations')
      .where('organization_id', auth.orgId)
      .orderBy('trigger_stage')
    return NextResponse.json({ ok: true, data: automations })
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
    const { triggerStage, actionType, actionConfig } = body

    if (!triggerStage || !actionType) {
      return NextResponse.json({ ok: false, error: 'triggerStage and actionType required' }, { status: 400 })
    }

    const id = require('crypto').randomUUID()
    await knex('stage_automations').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      trigger_stage: triggerStage, action_type: actionType,
      action_config: JSON.stringify(actionConfig || {}),
      is_active: true, created_at: new Date(),
    })

    return NextResponse.json({ ok: true, data: { id } }, { status: 201 })
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

    await knex('stage_automations').where('id', id).where('organization_id', auth.orgId).del()
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
