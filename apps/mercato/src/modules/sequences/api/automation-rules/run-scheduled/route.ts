export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

/**
 * Run Scheduled Automations
 *
 * Finds all active automation rules with trigger_type = 'schedule',
 * checks if they are due to run based on their trigger_config,
 * queries for matching records, and executes the automation steps
 * for each matching record.
 */

// ---------------------------------------------------------------------------
// Schedule Query — fetch target records by schedule type
// ---------------------------------------------------------------------------

async function getScheduleTargets(
  knex: any,
  orgId: string,
  config: Record<string, any>,
): Promise<Array<Record<string, any>>> {
  const scheduleType = config.scheduleType || 'manual'

  switch (scheduleType) {
    case 'invoice_overdue': {
      const days = config.daysOverdue || 1
      return knex('invoices')
        .where('organization_id', orgId)
        .where('status', 'sent')
        .whereRaw("due_date < NOW() - make_interval(days => ?)", [days])
        .select('id', 'invoice_number as reference', 'contact_id', 'total', 'due_date')
        .limit(100)
    }

    case 'stale_deals': {
      const days = config.staleDays || 7
      return knex('customer_deals')
        .where('organization_id', orgId)
        .where('status', 'open')
        .whereRaw("updated_at < NOW() - make_interval(days => ?)", [days])
        .select('id', 'title as reference', 'value_amount', 'updated_at')
        .limit(100)
    }

    case 'inactive_contacts': {
      const days = config.inactiveDays || 30
      return knex('customer_entities')
        .where('organization_id', orgId)
        .whereNull('deleted_at')
        .whereRaw("updated_at < NOW() - make_interval(days => ?)", [days])
        .select('id', 'display_name as reference', 'primary_email', 'updated_at')
        .limit(100)
    }

    case 'daily_summary': {
      // Return a single virtual record to trigger the automation once
      return [{ id: 'summary', type: 'daily_summary', reference: 'Daily Summary', date: new Date().toISOString().slice(0, 10) }]
    }

    default:
      // Generic trigger — run once with a virtual record
      return [{ id: 'trigger', type: scheduleType || 'manual', reference: scheduleType || 'Manual Trigger' }]
  }
}

// ---------------------------------------------------------------------------
// Check if a rule is due to run
// ---------------------------------------------------------------------------

function isScheduleDue(triggerConfig: Record<string, any>): boolean {
  const lastRun = triggerConfig.lastRun ? new Date(triggerConfig.lastRun).getTime() : 0
  const now = Date.now()

  // Simple interval-based check: default to running at most once per hour
  const intervalMinutes = triggerConfig.intervalMinutes || 60
  const intervalMs = intervalMinutes * 60 * 1000

  return (now - lastRun) >= intervalMs
}

// ---------------------------------------------------------------------------
// Execute a single action step (reuse logic from execute.ts)
// ---------------------------------------------------------------------------

async function executeScheduledAction(
  knex: any,
  orgId: string,
  tenantId: string,
  actionType: string,
  actionConfig: Record<string, any>,
  context: Record<string, any>,
): Promise<{ success: boolean; detail?: string }> {
  switch (actionType) {
    case 'send_email': {
      if (!context.contactId) return { success: false, detail: 'No contactId in context' }
      const contact = await knex('customer_entities').where('id', context.contactId).first()
      if (!contact?.primary_email) return { success: false, detail: 'Contact has no email' }

      const firstName = (contact.display_name || '').split(' ')[0] || 'there'
      const subject = (actionConfig.subject || 'Scheduled notification')
        .replace(/\{\{firstName\}\}/g, firstName)
        .replace(/\{\{reference\}\}/g, context.reference || '')
      const bodyHtml = (actionConfig.bodyHtml || actionConfig.body || '<p>Hello {{firstName}},</p>')
        .replace(/\{\{firstName\}\}/g, firstName)
        .replace(/\{\{reference\}\}/g, context.reference || '')

      if (process.env.RESEND_API_KEY && actionConfig.fromEmail) {
        try {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: actionConfig.fromEmail, to: [contact.primary_email], subject, html: bodyHtml }),
          })
          const result = await res.json()
          return { success: res.ok, detail: res.ok ? `Email sent via Resend: ${result.id}` : `Resend error: ${JSON.stringify(result)}` }
        } catch (err) {
          console.error('[run-scheduled] Resend failed, falling back to queue:', err)
        }
      }

      await knex('email_messages').insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId, organization_id: orgId,
        direction: 'outbound',
        from_address: actionConfig.fromEmail || process.env.EMAIL_FROM || 'noreply@localhost',
        to_address: contact.primary_email, subject, body_html: bodyHtml,
        contact_id: context.contactId, status: 'queued',
        tracking_id: require('crypto').randomUUID(), created_at: new Date(),
      })
      return { success: true, detail: `Email queued to ${contact.primary_email}` }
    }

    case 'create_task': {
      const dueDays = actionConfig.dueDays ? parseInt(actionConfig.dueDays) : 3
      const title = (actionConfig.taskTitle || actionConfig.title || `Scheduled task: ${context.reference || 'follow up'}`)
        .replace(/\{\{reference\}\}/g, context.reference || '')
      await knex('tasks').insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId, organization_id: orgId,
        title, description: actionConfig.taskDescription || null,
        contact_id: context.contactId || null,
        deal_id: context.dealId || null,
        due_date: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000),
        is_done: false, created_at: new Date(), updated_at: new Date(),
      })
      return { success: true, detail: `Task created: ${title}` }
    }

    case 'add_tag': {
      if (!context.contactId || !actionConfig.tagName) return { success: false, detail: 'contactId and tagName required' }
      const slug = actionConfig.tagName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
      let tag = await knex('customer_tags').where('organization_id', orgId).where('slug', slug).first()
      if (!tag) {
        const tagId = require('crypto').randomUUID()
        const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']
        await knex('customer_tags').insert({
          id: tagId, tenant_id: tenantId, organization_id: orgId,
          label: actionConfig.tagName.trim(), slug, color: colors[Math.floor(Math.random() * colors.length)],
          created_at: new Date(), updated_at: new Date(),
        })
        tag = { id: tagId }
      }
      const existing = await knex('customer_tag_assignments').where('entity_id', context.contactId).where('tag_id', tag.id).first()
      if (!existing) {
        await knex('customer_tag_assignments').insert({
          id: require('crypto').randomUUID(), tenant_id: tenantId, organization_id: orgId,
          entity_id: context.contactId, tag_id: tag.id, created_at: new Date(),
        })
      }
      return { success: true, detail: `Tag "${actionConfig.tagName}" added` }
    }

    case 'webhook': {
      if (!actionConfig.url) return { success: false, detail: 'Webhook URL required' }
      try {
        const res = await fetch(actionConfig.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(actionConfig.headers || {}) },
          body: JSON.stringify({ event: 'scheduled_automation', timestamp: new Date().toISOString(), data: context }),
        })
        return { success: res.ok, detail: `Webhook ${res.ok ? 'delivered' : 'failed'}: ${res.status}` }
      } catch (err) {
        return { success: false, detail: `Webhook error: ${err instanceof Error ? err.message : 'Unknown'}` }
      }
    }

    default:
      return { success: true, detail: `Action "${actionType}" logged (no handler for scheduled context)` }
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const body = await req.json().catch(() => ({}))
    const forceRuleId = body.ruleId as string | undefined

    // Find scheduled automation rules
    let query = knex('automation_rules')
      .where('organization_id', auth.orgId)
      .where('trigger_type', 'schedule')
      .where('is_active', true)

    if (forceRuleId) {
      query = query.where('id', forceRuleId)
    }

    const rules = await query

    const results: Array<{
      ruleId: string
      ruleName: string
      targetsFound: number
      executed: number
      skipped: boolean
      error?: string
    }> = []

    for (const rule of rules) {
      const triggerConfig = typeof rule.trigger_config === 'string'
        ? JSON.parse(rule.trigger_config)
        : (rule.trigger_config || {})

      // Check if this rule is due to run (skip check when force-running a specific rule)
      if (!forceRuleId && !isScheduleDue(triggerConfig)) {
        results.push({ ruleId: rule.id, ruleName: rule.name, targetsFound: 0, executed: 0, skipped: true })
        continue
      }

      try {
        const targets = await getScheduleTargets(knex, auth.orgId, triggerConfig)

        // Parse the rule steps or fall back to single action
        const steps = typeof rule.steps === 'string' ? JSON.parse(rule.steps) : rule.steps
        const actionConfig = typeof rule.action_config === 'string' ? JSON.parse(rule.action_config) : (rule.action_config || {})

        let executedCount = 0

        for (const target of targets) {
          const context: Record<string, any> = {
            ...target,
            contactId: target.contact_id || target.id,
            triggerType: 'schedule',
            scheduleType: triggerConfig.scheduleType,
            reference: target.reference || target.id,
          }

          if (Array.isArray(steps) && steps.length > 0) {
            // Multi-step: execute action steps sequentially (delays are ignored in scheduled runs)
            for (const step of steps) {
              if (step.type === 'action') {
                const stepResult = await executeScheduledAction(
                  knex, auth.orgId, auth.tenantId!, step.actionType || 'send_email', step.actionConfig || {}, context,
                )
                await knex('automation_rule_logs').insert({
                  id: require('crypto').randomUUID(),
                  rule_id: rule.id,
                  contact_id: context.contactId !== 'summary' && context.contactId !== 'trigger' ? context.contactId : null,
                  trigger_data: JSON.stringify({ scheduleType: triggerConfig.scheduleType, targetId: target.id }),
                  action_result: JSON.stringify(stepResult),
                  status: stepResult.success ? 'executed' : 'failed',
                  created_at: new Date(),
                }).catch(() => {})
              }
            }
          } else {
            // Single action
            const stepResult = await executeScheduledAction(
              knex, auth.orgId, auth.tenantId!, rule.action_type, actionConfig, context,
            )
            await knex('automation_rule_logs').insert({
              id: require('crypto').randomUUID(),
              rule_id: rule.id,
              contact_id: context.contactId !== 'summary' && context.contactId !== 'trigger' ? context.contactId : null,
              trigger_data: JSON.stringify({ scheduleType: triggerConfig.scheduleType, targetId: target.id }),
              action_result: JSON.stringify(stepResult),
              status: stepResult.success ? 'executed' : 'failed',
              created_at: new Date(),
            }).catch(() => {})
          }

          executedCount++
        }

        // Update lastRun on the trigger_config
        const updatedConfig = { ...triggerConfig, lastRun: new Date().toISOString() }
        await knex('automation_rules')
          .where('id', rule.id)
          .update({ trigger_config: JSON.stringify(updatedConfig), updated_at: new Date() })

        results.push({ ruleId: rule.id, ruleName: rule.name, targetsFound: targets.length, executed: executedCount, skipped: false })
      } catch (err) {
        console.error(`[run-scheduled] Error processing rule ${rule.id}:`, err)
        results.push({
          ruleId: rule.id,
          ruleName: rule.name,
          targetsFound: 0,
          executed: 0,
          skipped: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    return NextResponse.json({ ok: true, data: { rulesChecked: rules.length, results } })
  } catch (error) {
    console.error('[run-scheduled] POST error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Automation Rules',
  summary: 'Run scheduled automation triggers',
  methods: {
    POST: { summary: 'Process due scheduled automations and execute their steps against matching records', tags: ['Automation Rules'] },
  },
}
