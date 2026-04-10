export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  automationTemplates,
  getTemplateById,
  getRecommendedTemplates,
  type AutomationTemplate,
} from '@/lib/automation-templates'

/**
 * Map template trigger types to automation_rules trigger_type values.
 * Templates use event-bus style IDs; rules use short trigger type keys.
 */
function mapTemplateTriggerType(template: AutomationTemplate): { triggerType: string; triggerConfig: Record<string, any> } {
  const triggerType = template.trigger.type
  const triggerConfig = { ...(template.trigger.config || {}) }

  switch (triggerType) {
    case 'customers.person.created':
      return { triggerType: 'contact_created', triggerConfig }
    case 'customers.person.updated':
      return { triggerType: 'contact_updated', triggerConfig }
    case 'customers.company.created':
      return { triggerType: 'company_created', triggerConfig }
    case 'customers.deal.created':
      return { triggerType: 'deal_created', triggerConfig }
    case 'customers.deal.updated': {
      // Check conditions for stage=won or stage=lost
      const stageCondition = template.conditions?.find(
        (c) => c.field === 'stage' && c.operator === 'eq'
      )
      if (stageCondition?.value === 'won') return { triggerType: 'deal_won', triggerConfig }
      if (stageCondition?.value === 'lost') return { triggerType: 'deal_lost', triggerConfig }
      return { triggerType: 'stage_change', triggerConfig }
    }
    case 'customers.activity.created':
      return { triggerType: 'form_submitted', triggerConfig }
    case 'customers.activity.updated':
      return { triggerType: 'form_submitted', triggerConfig: { ...triggerConfig, _note: 'activity.updated mapped' } }
    case 'customers.comment.created':
      return { triggerType: 'contact_updated', triggerConfig: { ...triggerConfig, _note: 'comment.created mapped' } }
    case 'sales.order.created':
      return { triggerType: 'invoice_paid', triggerConfig: { ...triggerConfig, _note: 'order.created mapped to invoice_paid' } }
    case 'sales.order.updated':
      return { triggerType: 'invoice_paid', triggerConfig: { ...triggerConfig, _note: 'order.updated mapped to invoice_paid' } }
    case 'sales.quote.created':
      return { triggerType: 'invoice_paid', triggerConfig: { ...triggerConfig, _note: 'quote.created mapped' } }
    case 'sales.payment.created':
      return { triggerType: 'invoice_paid', triggerConfig }
    case 'sales.shipment.created':
    case 'sales.shipment.updated':
      return { triggerType: 'booking_created', triggerConfig: { ...triggerConfig, _note: 'shipment event mapped' } }
    case 'sales.return.created':
      return { triggerType: 'booking_created', triggerConfig: { ...triggerConfig, _note: 'return.created mapped' } }
    case 'catalog.product.updated':
      return { triggerType: 'form_submitted', triggerConfig: { ...triggerConfig, _note: 'product.updated mapped' } }
    case 'schedule':
      return { triggerType: 'schedule', triggerConfig: { ...triggerConfig, cron: triggerConfig.cron || triggerConfig.schedule } }
    default:
      return { triggerType: 'form_submitted', triggerConfig: { ...triggerConfig, _note: `Unmapped trigger: ${triggerType}` } }
  }
}

/**
 * Map a template action type to our rules action type.
 * Templates support more action types; we map to the closest match.
 */
function mapTemplateActionType(actionType: string): string {
  switch (actionType) {
    case 'send_email': return 'send_email'
    case 'create_task': return 'create_task'
    case 'add_tag': return 'add_tag'
    case 'remove_tag': return 'remove_tag'
    case 'add_to_list': return 'add_to_list'
    case 'enroll_in_sequence': return 'enroll_in_sequence'
    case 'move_to_stage': return 'move_to_stage'
    case 'call_webhook': return 'webhook'
    case 'call_api': return 'webhook'
    case 'update_entity': return 'move_to_stage'
    case 'emit_event': return 'webhook'
    case 'execute_function': return 'webhook'
    case 'wait': return 'send_email'
    default: return 'webhook'
  }
}

/**
 * Map a schedule template ID to its scheduleType for the run-scheduled processor.
 */
function mapTemplateToScheduleType(templateId: string): string {
  const mapping: Record<string, string> = {
    'sales-stale-deal-alert': 'stale_deals',
    'sales-quote-expiry-reminder': 'daily_summary',
    'sales-invoice-overdue': 'invoice_overdue',
    'marketing-re-engagement': 'inactive_contacts',
    'cs-quarterly-checkin': 'daily_summary',
    'cs-renewal-reminder-60d': 'daily_summary',
    'cs-churn-risk-alert': 'inactive_contacts',
    'cs-onboarding-completion': 'inactive_contacts',
    'cs-anniversary-email': 'daily_summary',
    'ops-daily-pipeline-summary': 'daily_summary',
    'ops-weekly-activity-report': 'daily_summary',
    'notify-escalation-sla-breach': 'daily_summary',
    'notify-daily-task-digest': 'daily_summary',
  }
  return mapping[templateId] || 'daily_summary'
}

/**
 * Map a schedule template ID to its default check interval in minutes.
 */
function mapTemplateToInterval(templateId: string): number {
  const mapping: Record<string, number> = {
    'sales-stale-deal-alert': 10080,       // weekly
    'sales-quote-expiry-reminder': 1440,   // daily
    'sales-invoice-overdue': 1440,         // daily
    'marketing-re-engagement': 10080,      // weekly
    'cs-quarterly-checkin': 10080,         // weekly (user can adjust)
    'cs-renewal-reminder-60d': 1440,       // daily
    'cs-churn-risk-alert': 10080,          // weekly
    'cs-onboarding-completion': 1440,      // daily
    'cs-anniversary-email': 1440,          // daily
    'ops-daily-pipeline-summary': 1440,    // daily
    'ops-weekly-activity-report': 10080,   // weekly
    'notify-escalation-sla-breach': 120,   // every 2 hours
    'notify-daily-task-digest': 1440,      // daily
  }
  return mapping[templateId] || 1440
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const categoriesMap: Record<string, AutomationTemplate[]> = {}
    for (const template of automationTemplates) {
      if (!categoriesMap[template.category]) categoriesMap[template.category] = []
      categoriesMap[template.category].push(template)
    }

    const categories = Object.entries(categoriesMap).map(([name, templates]) => ({
      name,
      templates,
    }))

    const recommended = getRecommendedTemplates()

    return NextResponse.json({
      ok: true,
      data: {
        categories,
        recommended,
      },
    })
  } catch (error) {
    console.error('[automation-templates] GET error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { templateId } = body

    if (!templateId) return NextResponse.json({ ok: false, error: 'templateId is required' }, { status: 400 })

    const template = getTemplateById(templateId)
    if (!template) return NextResponse.json({ ok: false, error: 'Template not found' }, { status: 404 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Map template trigger to rule trigger
    const { triggerType, triggerConfig } = mapTemplateTriggerType(template)
    const isSchedule = triggerType === 'schedule'

    // Convert template actions to multi-step format
    const steps: Array<{ type: string; actionType?: string; actionConfig?: Record<string, any>; delayMinutes?: number }> = []
    for (let i = 0; i < template.actions.length; i++) {
      const action = template.actions[i]
      if (action.type === 'wait') {
        const duration = Number(action.config?.duration || action.config?.delay || 60)
        steps.push({ type: 'delay', delayMinutes: duration })
      } else {
        steps.push({
          type: 'action',
          actionType: mapTemplateActionType(action.type),
          actionConfig: action.config || {},
        })
      }
    }

    // For backward compat: use the first action as the legacy action_type/action_config
    const firstActionStep = steps.find(s => s.type === 'action')
    const actionType = firstActionStep?.actionType || 'send_email'
    const actionConfig = firstActionStep?.actionConfig || {}

    // Only store steps if there are multiple steps or delays
    const hasMultipleSteps = steps.length > 1
    const stepsJson = hasMultipleSteps ? JSON.stringify(steps) : null

    // Map template conditions to rule conditions
    const conditions = template.conditions?.map((c) => ({
      field: c.field,
      operator: c.operator,
      value: c.value,
    })) || null

    // Build schedule-specific trigger config with scheduleType
    const effectiveTriggerConfig = isSchedule
      ? { ...triggerConfig, scheduleType: mapTemplateToScheduleType(template.id), intervalMinutes: mapTemplateToInterval(template.id) }
      : triggerConfig

    const id = require('crypto').randomUUID()
    await knex('automation_rules').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: template.name,
      description: template.description,
      trigger_type: triggerType,
      trigger_config: JSON.stringify(effectiveTriggerConfig),
      action_type: actionType,
      action_config: JSON.stringify(actionConfig),
      steps: stepsJson,
      conditions: conditions ? JSON.stringify(conditions) : null,
      status: 'active',
      is_active: true,
      template_id: templateId,
      created_at: new Date(),
      updated_at: new Date(),
    })

    const rule = await knex('automation_rules').where('id', id).first()
    return NextResponse.json({ ok: true, data: rule }, { status: 201 })
  } catch (error) {
    console.error('[automation-templates] POST error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Automation Templates',
  summary: 'Pre-built automation rule templates',
  methods: {
    GET: { summary: 'List all automation templates grouped by category with recommendations', tags: ['Automation Templates'] },
    POST: { summary: 'Install a template as a draft automation rule', tags: ['Automation Templates'] },
  },
}
