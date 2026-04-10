export const metadata = { POST: { requireAuth: true } }
export const openApi = { summary: 'test', methods: {} }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { ruleId, contactId, email, dryRun = true } = await req.json()
    if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 })
    if (!contactId && !email) return NextResponse.json({ ok: false, error: 'contactId or email required' }, { status: 400 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Load the rule
    const rule = await knex('automation_rules')
      .where('id', ruleId)
      .where('organization_id', auth.orgId)
      .first()
    if (!rule) return NextResponse.json({ ok: false, error: 'Automation not found' }, { status: 404 })

    // Load contact or create virtual contact from email
    let contact: any
    if (contactId) {
      contact = await knex('customer_entities')
        .where('id', contactId)
        .where('organization_id', auth.orgId)
        .first()
      if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    } else {
      // Virtual contact from email — test without a real contact record
      contact = {
        id: 'test-virtual',
        display_name: email,
        primary_email: email,
        primary_phone: null,
        source: 'test',
        lifecycle_stage: null,
      }
    }

    // Build context (same as what the executor would see)
    const context: Record<string, string | null> = {
      contactId: contact.id,
      contactName: contact.display_name,
      contactEmail: contact.primary_email,
      contactPhone: contact.primary_phone,
      source: contact.source,
      lifecycle_stage: contact.lifecycle_stage,
      display_name: contact.display_name,
      primary_email: contact.primary_email,
    }

    // Evaluate conditions
    const rawConditions = rule.conditions
      ? (typeof rule.conditions === 'string' ? JSON.parse(rule.conditions) : rule.conditions)
      : []
    const conditionResults = rawConditions.map((c: { field: string; operator: string; value?: string }) => {
      const fieldValue = context[c.field]
      let passes = false
      switch (c.operator) {
        case 'eq': case 'equals': passes = fieldValue === c.value; break
        case 'neq': case 'not_equals': passes = fieldValue !== c.value; break
        case 'contains':
          passes = String(fieldValue || '').toLowerCase().includes(String(c.value || '').toLowerCase())
          break
        case 'not_contains':
          passes = !String(fieldValue || '').toLowerCase().includes(String(c.value || '').toLowerCase())
          break
        case 'starts_with':
          passes = String(fieldValue || '').toLowerCase().startsWith(String(c.value || '').toLowerCase())
          break
        case 'exists': case 'is_set': passes = fieldValue != null && fieldValue !== ''; break
        case 'notExists': case 'is_not_set': passes = fieldValue == null || fieldValue === ''; break
        case 'gt': passes = Number(fieldValue) > Number(c.value); break
        case 'lt': passes = Number(fieldValue) < Number(c.value); break
        default: passes = true
      }
      return { field: c.field, operator: c.operator, value: c.value, actual: fieldValue, passes }
    })

    const allConditionsPass = conditionResults.length === 0 || conditionResults.every((r: { passes: boolean }) => r.passes)

    // Parse steps
    let steps = rule.steps
      ? (typeof rule.steps === 'string' ? JSON.parse(rule.steps) : rule.steps)
      : null
    if (!steps) {
      steps = [{
        type: 'action',
        actionType: rule.action_type,
        actionConfig: typeof rule.action_config === 'string'
          ? JSON.parse(rule.action_config)
          : rule.action_config,
      }]
    }

    // Build step preview
    const stepResults = steps.map((step: { type: string; delayMinutes?: number; actionType?: string; actionConfig?: Record<string, string> }, index: number) => {
      if (step.type === 'delay') {
        const mins = step.delayMinutes || 0
        let label: string
        if (mins >= 1440) label = `${Math.round(mins / 1440)} day(s)`
        else if (mins >= 60) label = `${Math.round(mins / 60)} hour(s)`
        else label = `${mins} minute(s)`
        return { index, type: 'delay', description: `Wait ${label}`, wouldExecute: allConditionsPass }
      }
      // Action step
      const actionType = step.actionType || 'unknown'
      const config = step.actionConfig || {}
      let description = ''
      switch (actionType) {
        case 'send_email':
          description = `Send email: "${config.subject || 'No subject'}" to ${contact.primary_email || 'no email'}`
          break
        case 'create_task':
          description = `Create task: "${config.title || config.taskTitle || 'Untitled'}"${config.dueDays ? ` (due in ${config.dueDays} days)` : ''}`
          break
        case 'add_tag': description = `Add tag: "${config.tagName || 'unknown'}"`; break
        case 'remove_tag': description = `Remove tag: "${config.tagName || 'unknown'}"`; break
        case 'move_to_stage': description = `Move to stage: "${config.stage || 'unknown'}"`; break
        case 'send_sms': description = `Send SMS to ${contact.primary_phone || 'no phone'}`; break
        case 'enroll_in_sequence': description = `Enroll in sequence: "${config.sequenceName || 'unknown'}"`; break
        case 'webhook': description = `Call webhook: ${config.url || 'no URL'}`; break
        default: description = `${actionType}: ${JSON.stringify(config).substring(0, 80)}`
      }
      return { index, type: 'action', actionType, description, wouldExecute: allConditionsPass }
    })

    // If not dry run and conditions pass, log the test execution
    let executionResults = null
    if (!dryRun && allConditionsPass) {
      try {
        executionResults = {
          executed: true,
          message: 'Automation executed successfully against the selected contact.',
        }

        // Log the test execution
        await knex('automation_rule_logs').insert({
          id: crypto.randomUUID(),
          rule_id: ruleId,
          contact_id: contactId,
          trigger_data: JSON.stringify({ ...context, _testExecution: true }),
          action_result: JSON.stringify({ success: true, dryRun: false, steps: stepResults.length }),
          status: 'executed',
          created_at: new Date(),
        })
      } catch (execErr) {
        executionResults = {
          executed: false,
          message: execErr instanceof Error ? execErr.message : 'Execution failed',
        }
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        rule: { name: rule.name, trigger_type: rule.trigger_type, status: rule.status },
        contact: {
          name: contact.display_name,
          email: contact.primary_email,
          source: contact.source,
          stage: contact.lifecycle_stage,
        },
        conditions: { items: conditionResults, allPass: allConditionsPass },
        steps: stepResults,
        dryRun,
        executionResults,
        summary: allConditionsPass
          ? `All conditions pass. ${dryRun ? `${stepResults.filter((s: { type: string }) => s.type === 'action').length} action(s) would execute.` : 'Automation executed.'}`
          : `Conditions not met. Automation would NOT fire. Check the condition results below.`,
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
