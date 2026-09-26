export const metadata = { POST: { requireAuth: true } }
export const openApi = { summary: 'test', methods: {} }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { evaluateConditions, parseConditions, conditionContext } from '../../../lib/automation-conditions'
import { loadContactFacts } from '../../../lib/automation-contact-facts'
import { runAutomationRuleNow, summarizeAutomationRun, type AutomationStepRun } from '../../../lib/automation-execute'

type StepPreview = {
  index: number
  type: 'action' | 'delay'
  actionType?: string
  description: string
  wouldExecute: boolean
  result?: { status: AutomationStepRun['status'] | 'waiting' | 'not_run'; detail?: string }
}

const EMAIL_ONLY_MESSAGE =
  'Nothing was run. To run this automation for real, pick a saved contact; an email address on its own can only be used for a dry run.'

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const ruleId = typeof body?.ruleId === 'string' ? body.ruleId : null
    const contactId = typeof body?.contactId === 'string' && body.contactId ? body.contactId : null
    const email = typeof body?.email === 'string' && body.email ? body.email : null
    const dryRun = body?.dryRun !== false
    if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 })
    if (!contactId && !email) return NextResponse.json({ ok: false, error: 'contactId or email required' }, { status: 400 })

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const scope = { organizationId: auth.orgId, tenantId: auth.tenantId }

    // Load the rule
    const rule = await knex('automation_rules')
      .where('id', ruleId)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .first()
    if (!rule) return NextResponse.json({ ok: false, error: 'Automation not found' }, { status: 404 })

    // The contact's fields exactly as the runner reads them (decrypted, with
    // tags), or a virtual contact built from a typed email address.
    let facts: Record<string, unknown>
    if (contactId) {
      const loaded = await loadContactFacts(knex, scope, contactId)
      if (!loaded) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
      facts = loaded
    } else {
      facts = {
        contact_id: null,
        display_name: email,
        primary_email: email,
        primary_phone: null,
        source: 'test',
        lifecycle_stage: null,
        tags: [],
        name: email,
        email,
        phone: null,
      }
    }

    // Build context (same as what the executor would see)
    const context = conditionContext({ contactId: contactId ?? 'test-virtual', triggerType: rule.trigger_type }, facts)

    // Evaluate conditions with the runner's evaluator
    const outcome = evaluateConditions(parseConditions(rule.conditions), context)
    const conditionResults = outcome.results.map((r) => ({
      field: r.field,
      operator: r.operator,
      value: r.value,
      actual: Array.isArray(r.actual) ? r.actual.join(', ') : r.actual,
      passes: r.passes,
      ...(r.error ? { error: r.error } : {}),
      ...(r.note ? { note: r.note } : {}),
    }))
    const allConditionsPass = outcome.pass

    // Parse steps
    let steps = parseJson<any[] | null>(rule.steps, null)
    if (!Array.isArray(steps) || steps.length === 0) {
      steps = [{
        type: 'action',
        actionType: rule.action_type,
        actionConfig: parseJson<Record<string, unknown>>(rule.action_config, {}),
      }]
    }

    const displayEmail = typeof facts.primary_email === 'string' ? facts.primary_email : null
    const displayPhone = typeof facts.primary_phone === 'string' ? facts.primary_phone : null

    // Build step preview
    const stepResults: StepPreview[] = steps.map((step: { type: string; delayMinutes?: number; actionType?: string; actionConfig?: Record<string, string> }, index: number) => {
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
          description = `Send email: "${config.subject || 'No subject'}" to ${displayEmail || 'no email'}`
          break
        case 'create_task':
          description = `Create task: "${config.title || config.taskTitle || 'Untitled'}"${config.dueDays ? ` (due in ${config.dueDays} days)` : ''}`
          break
        case 'add_tag': description = `Add tag: "${config.tagName || 'unknown'}"`; break
        case 'remove_tag': description = `Remove tag: "${config.tagName || 'unknown'}"`; break
        case 'move_to_stage': description = `Move to stage: "${config.stage || 'unknown'}"`; break
        case 'send_sms': description = `Send SMS to ${displayPhone || 'no phone'}`; break
        case 'enroll_in_sequence': description = `Enroll in sequence: "${config.sequenceName || 'unknown'}"`; break
        case 'webhook': description = `Call webhook: ${config.url || 'no URL'}`; break
        default: description = `${actionType}: ${JSON.stringify(config).substring(0, 80)}`
      }
      return { index, type: 'action', actionType, description, wouldExecute: allConditionsPass }
    })

    // Dry run off and conditions pass: run the rule for real, through the
    // same executor a trigger uses. This used to write a log row saying
    // "executed" and run nothing.
    let executionResults: { executed: boolean; message: string } | null = null
    if (!dryRun && allConditionsPass) {
      if (!contactId) {
        executionResults = { executed: false, message: EMAIL_ONLY_MESSAGE }
      } else {
        try {
          const runs = await runAutomationRuleNow(knex, scope, rule, {
            contactId,
            triggerType: rule.trigger_type,
            _testExecution: true,
          })
          const byIndex = new Map(runs.map((r) => [r.index, r]))
          const wait = runs.find((r) => r.type === 'delay' && r.status === 'scheduled')
          for (const step of stepResults) {
            const run = byIndex.get(step.index)
            if (run) step.result = { status: run.status, detail: run.detail }
            else if (wait && step.index > wait.index) step.result = { status: 'waiting', detail: `Runs after the wait (scheduled for ${wait.executeAt})` }
            else step.result = { status: 'not_run', detail: 'Not run: an earlier step failed' }
          }
          executionResults = summarizeAutomationRun(runs)
        } catch (execErr) {
          executionResults = {
            executed: false,
            message: execErr instanceof Error ? `Run failed: ${execErr.message}` : 'Run failed',
          }
        }
      }
    }

    const actionCount = stepResults.filter((s) => s.type === 'action').length
    return NextResponse.json({
      ok: true,
      data: {
        rule: { name: rule.name, trigger_type: rule.trigger_type, status: rule.status },
        contact: {
          name: facts.display_name ?? null,
          email: displayEmail,
          source: facts.source ?? null,
          stage: facts.lifecycle_stage ?? null,
        },
        conditions: { items: conditionResults, allPass: allConditionsPass },
        steps: stepResults,
        dryRun,
        executionResults,
        summary: allConditionsPass
          ? (dryRun ? `All conditions pass. ${actionCount} action(s) would execute.` : 'All conditions pass.')
          : `Conditions not met. Automation would NOT fire. Check the condition results below.`,
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
