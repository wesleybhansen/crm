export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true }, DELETE: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'


const TRIGGER_TYPES = [
  'contact_created', 'contact_updated', 'company_created',
  'tag_added', 'tag_removed',
  'deal_created', 'deal_won', 'deal_lost', 'stage_change',
  'invoice_paid', 'invoice_overdue',
  'form_submitted', 'booking_created', 'course_enrolled',
  'schedule',
] as const

const ACTION_TYPES = [
  'send_email', 'send_sms', 'send_survey', 'add_tag', 'remove_tag',
  'move_to_stage', 'create_task', 'enroll_in_sequence', 'webhook',
] as const

const VALID_STATUSES = ['active', 'paused', 'error', 'draft'] as const

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const status = url.searchParams.get('status')
    const search = url.searchParams.get('search')

    let query = knex('automation_rules')
      .select('automation_rules.*')
      .select(knex.raw('COALESCE((SELECT COUNT(*) FROM automation_rule_logs WHERE rule_id = automation_rules.id), 0)::int AS execution_count'))
      .select(knex.raw('(SELECT MAX(created_at) FROM automation_rule_logs WHERE rule_id = automation_rules.id) AS last_executed_at'))
      .where('automation_rules.organization_id', auth.orgId)
      .orderBy('automation_rules.created_at', 'desc')

    if (status && (VALID_STATUSES as readonly string[]).includes(status)) {
      query = query.where('automation_rules.status', status)
    }

    if (search?.trim()) {
      query = query.where('automation_rules.name', 'ilike', `%${search.trim()}%`)
    }

    const rules = await query
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
    const { name, description, triggerType, triggerConfig, actionType, actionConfig, conditions, status, templateId, steps } = body

    if (!name?.trim()) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 })
    if (!triggerType || !(TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
      return NextResponse.json({ ok: false, error: `Invalid triggerType. Must be one of: ${TRIGGER_TYPES.join(', ')}` }, { status: 400 })
    }
    // When steps are provided, actionType/actionConfig are optional (backward compat)
    const hasSteps = Array.isArray(steps) && steps.length > 0
    if (!hasSteps && (!actionType || !(ACTION_TYPES as readonly string[]).includes(actionType))) {
      return NextResponse.json({ ok: false, error: `Invalid actionType. Must be one of: ${ACTION_TYPES.join(', ')}` }, { status: 400 })
    }

    const ruleStatus = status && (VALID_STATUSES as readonly string[]).includes(status) ? status : 'active'

    // For backward compat: if only one action step and no delays, store as legacy single-action
    const effectiveActionType = hasSteps ? (steps.find((s: any) => s.type === 'action')?.actionType || 'send_email') : actionType
    const effectiveActionConfig = hasSteps ? (steps.find((s: any) => s.type === 'action')?.actionConfig || {}) : (actionConfig || {})

    const id = require('crypto').randomUUID()
    await knex('automation_rules').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      description: description?.trim() || null,
      trigger_type: triggerType,
      trigger_config: JSON.stringify(triggerConfig || {}),
      action_type: effectiveActionType,
      action_config: JSON.stringify(effectiveActionConfig),
      conditions: conditions ? JSON.stringify(conditions) : null,
      steps: hasSteps ? JSON.stringify(steps) : null,
      status: ruleStatus,
      is_active: ruleStatus === 'active',
      template_id: templateId || null,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const rule = await knex('automation_rules').where('id', id).first()
    return NextResponse.json({ ok: true, data: rule }, { status: 201 })
  } catch (error) {
    console.error('[automation-rules] POST error', error)
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
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
    if (body.description !== undefined) update.description = body.description?.trim() || null
    if (body.triggerType !== undefined) update.trigger_type = body.triggerType
    if (body.triggerConfig !== undefined) update.trigger_config = JSON.stringify(body.triggerConfig)
    if (body.actionType !== undefined) update.action_type = body.actionType
    if (body.actionConfig !== undefined) update.action_config = JSON.stringify(body.actionConfig)
    if (body.conditions !== undefined) update.conditions = body.conditions ? JSON.stringify(body.conditions) : null
    if (body.steps !== undefined) {
      update.steps = Array.isArray(body.steps) && body.steps.length > 0 ? JSON.stringify(body.steps) : null
    }
    if (body.status !== undefined) {
      update.status = body.status
      update.is_active = body.status === 'active'
    }
    if (body.isActive !== undefined) {
      update.is_active = body.isActive
      update.status = body.isActive ? 'active' : 'paused'
    }

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

    const rule = await knex('automation_rules').where('id', id).where('organization_id', auth.orgId).first()
    if (!rule) return NextResponse.json({ ok: false, error: 'Rule not found' }, { status: 404 })

    // Preserve rule name in logs before unlinking
    await knex('automation_rule_logs')
      .where('rule_id', id)
      .update({ deleted_rule_name: rule.name })

    // Unlink logs from the rule (soft-handle)
    await knex('automation_rule_logs')
      .where('rule_id', id)
      .update({ rule_id: null })

    // Delete the rule
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
    GET: { summary: 'List automation rules with execution counts, optional status/search filters', tags: ['Automation Rules'] },
    POST: { summary: 'Create an automation rule with full field support', tags: ['Automation Rules'] },
    PUT: { summary: 'Partially update an automation rule', tags: ['Automation Rules'] },
    DELETE: { summary: 'Delete an automation rule, preserving log history', tags: ['Automation Rules'] },
  },
}
