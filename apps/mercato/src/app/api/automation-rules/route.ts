import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const TRIGGER_TYPES = [
  'contact_created', 'tag_added', 'tag_removed', 'invoice_paid',
  'form_submitted', 'booking_created', 'deal_won', 'deal_lost', 'course_enrolled',
] as const

const ACTION_TYPES = [
  'send_email', 'send_sms', 'add_tag', 'remove_tag',
  'move_to_stage', 'create_task', 'enroll_in_sequence', 'webhook',
] as const

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const rules = await knex('automation_rules')
      .select('automation_rules.*')
      .select(knex.raw('(SELECT COUNT(*) FROM automation_rule_logs WHERE rule_id = automation_rules.id)::int AS execution_count'))
      .where('automation_rules.organization_id', auth.orgId)
      .orderBy('automation_rules.created_at', 'desc')
    return NextResponse.json({ ok: true, data: rules })
  } catch (error) {
    console.error('[automation-rules] GET error', error)
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
    const { name, triggerType, triggerConfig, actionType, actionConfig } = body

    if (!name?.trim()) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 })
    if (!triggerType || !(TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
      return NextResponse.json({ ok: false, error: `Invalid triggerType. Must be one of: ${TRIGGER_TYPES.join(', ')}` }, { status: 400 })
    }
    if (!actionType || !(ACTION_TYPES as readonly string[]).includes(actionType)) {
      return NextResponse.json({ ok: false, error: `Invalid actionType. Must be one of: ${ACTION_TYPES.join(', ')}` }, { status: 400 })
    }

    const id = require('crypto').randomUUID()
    await knex('automation_rules').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      trigger_type: triggerType,
      trigger_config: JSON.stringify(triggerConfig || {}),
      action_type: actionType,
      action_config: JSON.stringify(actionConfig || {}),
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const rule = await knex('automation_rules').where('id', id).first()
    return NextResponse.json({ ok: true, data: rule }, { status: 201 })
  } catch (error) {
    console.error('[automation-rules] POST error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
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
    const update: Record<string, any> = { updated_at: new Date() }

    if (body.name !== undefined) update.name = body.name.trim()
    if (body.triggerType !== undefined) update.trigger_type = body.triggerType
    if (body.triggerConfig !== undefined) update.trigger_config = JSON.stringify(body.triggerConfig)
    if (body.actionType !== undefined) update.action_type = body.actionType
    if (body.actionConfig !== undefined) update.action_config = JSON.stringify(body.actionConfig)
    if (body.isActive !== undefined) update.is_active = body.isActive

    await knex('automation_rules').where('id', id).where('organization_id', auth.orgId).update(update)
    const rule = await knex('automation_rules').where('id', id).first()
    return NextResponse.json({ ok: true, data: rule })
  } catch (error) {
    console.error('[automation-rules] PUT error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
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

    // Delete logs first (FK constraint)
    await knex('automation_rule_logs').where('rule_id', id).del()
    await knex('automation_rules').where('id', id).where('organization_id', auth.orgId).del()
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[automation-rules] DELETE error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Automation Rules',
  summary: 'Event-driven automation rules engine',
  methods: {
    GET: { summary: 'List automation rules with execution counts', tags: ['Automation Rules'] },
    POST: { summary: 'Create an automation rule', tags: ['Automation Rules'] },
    PUT: { summary: 'Update an automation rule', tags: ['Automation Rules'] },
    DELETE: { summary: 'Delete an automation rule', tags: ['Automation Rules'] },
  },
}
