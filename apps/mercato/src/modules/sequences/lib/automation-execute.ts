import { applyTaskTemplate } from '../../customers/lib/task-template-apply'
import { sendEmailByPurpose } from '../../email/lib/email-router'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import {
  buildSenderContext,
  htmlifyIfPlainText,
  recordReviewRequest,
  requiresReviewUrl,
  substituteTemplateVars,
} from './template-vars'
import { matchesTriggerConfig } from './automation-trigger-match'
import { conditionContext, conditionsNeedContact, evaluateConditions, parseConditions } from './automation-conditions'
import { loadContactFacts, type ContactFacts } from './automation-contact-facts'

/**
 * Automation Rules Executor
 *
 * Executes matching automation rules for a given trigger type.
 * Called fire-and-forget from various routes (form submissions, tag assignments, etc.)
 * and, for deal won / stage change / invoice paid / booking created / contact
 * created, from the event subscribers through automation-dispatch.ts (once per event).
 *
 * Relative imports only: the dispatch subscribers are bundled into the queue workers.
 */

type ActionResult = { success: boolean; skipped?: boolean; detail?: string; error?: string }

/** What one step of a run did, for the run history and the Test panel. */
export type AutomationStepRun = {
  index: number
  type: 'action' | 'delay'
  actionType?: string
  status: 'executed' | 'skipped' | 'failed' | 'scheduled'
  detail?: string
  executeAt?: string
}

type Scope = { organizationId: string; tenantId: string }

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** skipped when the action said so, failed when it did not succeed, else executed. */
function actionStatus(result: ActionResult): 'executed' | 'skipped' | 'failed' {
  if (result.skipped) return 'skipped'
  return result.success ? 'executed' : 'failed'
}

async function writeRunLog(knex: any, row: { ruleId: string | null; contactId: unknown; triggerData: Record<string, unknown>; result: Record<string, unknown>; status: string }) {
  await knex('automation_rule_logs').insert({
    id: require('crypto').randomUUID(),
    rule_id: row.ruleId,
    contact_id: typeof row.contactId === 'string' && row.contactId ? row.contactId : null,
    trigger_data: JSON.stringify(row.triggerData),
    action_result: JSON.stringify(row.result),
    status: row.status,
    created_at: new Date(),
  }).catch((logErr: any) => {
    console.error('[automation-rules] Failed to log execution:', logErr)
  })
}

// ---------------------------------------------------------------------------
// Main Executor
// ---------------------------------------------------------------------------

export async function executeAutomationRules(
  knex: any,
  orgId: string,
  tenantId: string,
  triggerType: string,
  context: { contactId?: string; tagId?: string; tagSlug?: string; tagName?: string; formId?: string; dealId?: string; [key: string]: any }
) {
  let rules: any[]
  try {
    rules = await knex('automation_rules')
      .where('organization_id', orgId)
      .where('tenant_id', tenantId)
      .where('trigger_type', triggerType)
      .where('is_active', true)
  } catch (err) {
    console.error('[automation-rules] Error loading rules:', err)
    return
  }

  // The contact's own fields, loaded once and only when a condition needs one.
  let facts: ContactFacts | null | undefined
  const contactFacts = async () => {
    if (facts === undefined) {
      facts = await loadContactFacts(knex, { organizationId: orgId, tenantId }, context.contactId).catch((err) => {
        console.error('[automation-rules] Failed to load contact fields for conditions:', err)
        return null
      })
    }
    return facts
  }

  // One rule failing (a bad config, a missing table) never stops the others.
  for (const rule of rules) {
    try {
      const triggerConfig = parseJson<Record<string, any>>(rule.trigger_config, {})

      // Check if trigger_config matches the context
      if (!matchesTriggerConfig(triggerType, triggerConfig, context)) continue

      // Evaluate rule conditions
      const conditions = parseConditions(rule.conditions)
      if (conditions.length > 0) {
        const evalContext = conditionsNeedContact(conditions, context)
          ? conditionContext(context, await contactFacts())
          : context
        const conditionResult = evaluateConditions(conditions, evalContext)
        if (!conditionResult.pass) {
          if (conditionResult.results.some((r) => r.error)) {
            console.warn(`[automation-rules] Rule ${rule.id} skipped: ${conditionResult.reason}`)
          }
          await writeRunLog(knex, {
            ruleId: rule.id,
            contactId: context.contactId,
            triggerData: { triggerType, ...context },
            result: { skipped: true, reason: conditionResult.reason },
            status: 'skipped',
          })
          continue
        }
      }

      await runRuleSteps(knex, { organizationId: orgId, tenantId }, rule, { ...context, triggerType: context.triggerType ?? triggerType })
    } catch (err) {
      console.error(`[automation-rules] Rule ${rule?.id} failed:`, err)
      await writeRunLog(knex, {
        ruleId: rule?.id ?? null,
        contactId: context.contactId,
        triggerData: { triggerType, ...context },
        result: { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
        status: 'failed',
      })
    }
  }
}

/** Run a rule's steps (or its legacy single action) for one context; logs each step. */
async function runRuleSteps(
  knex: any,
  scope: Scope,
  rule: any,
  context: Record<string, any>,
): Promise<AutomationStepRun[]> {
  const steps = parseJson<unknown>(rule.steps, null)
  if (Array.isArray(steps) && steps.length > 0) {
    return executeSteps(knex, scope.organizationId, scope.tenantId, rule, steps, 0, context)
  }

  // Legacy single-action execution
  const actionConfig = parseJson<Record<string, any>>(rule.action_config, {})
  let actionResult: ActionResult = { success: false }
  let status: AutomationStepRun['status']
  try {
    actionResult = await executeAction(knex, scope.organizationId, scope.tenantId, rule.action_type, actionConfig, { ...context, ruleId: rule.id })
    status = actionStatus(actionResult)
  } catch (err) {
    status = 'failed'
    actionResult = { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
    console.error(`[automation-rules] Action failed for rule ${rule.id}:`, err)
  }
  await writeRunLog(knex, {
    ruleId: rule.id,
    contactId: context.contactId,
    triggerData: { ...context },
    result: actionResult,
    status,
  })
  return [{ index: 0, type: 'action', actionType: rule.action_type, status, detail: actionResult.detail ?? actionResult.error }]
}

/**
 * Run one rule now for one contact, the way a trigger would (the automation
 * Test panel with dry run off). Conditions are the caller's job. Actions
 * really run: emails and texts send, tags and tasks are written, and a delay
 * schedules the remaining steps exactly as a live run does.
 */
export async function runAutomationRuleNow(
  knex: any,
  scope: Scope,
  rule: any,
  context: Record<string, any>,
): Promise<AutomationStepRun[]> {
  return runRuleSteps(knex, scope, rule, { ...context, ruleId: rule.id })
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One honest line about a real run: what ran, what failed, what waits. */
export function summarizeAutomationRun(runs: AutomationStepRun[]): { executed: boolean; message: string } {
  const actions = runs.filter((r) => r.type === 'action')
  const done = actions.filter((r) => r.status === 'executed').length
  const failed = actions.filter((r) => r.status === 'failed')
  const skipped = actions.filter((r) => r.status === 'skipped')
  const waiting = runs.find((r) => r.type === 'delay' && r.status === 'scheduled')
  const parts: string[] = []
  parts.push(`${plural(done, 'action')} done`)
  if (failed.length) parts.push(`${failed.length} failed (${failed[0]!.detail || 'no detail'})`)
  if (skipped.length) parts.push(`${skipped.length} skipped (${skipped[0]!.detail || 'no detail'})`)
  let message = `Ran for real: ${parts.join(', ')}.`
  if (waiting?.executeAt) message += ` The steps after the wait are scheduled for ${waiting.executeAt} and run then.`
  if (!actions.length && !waiting) message = 'Ran for real, but this automation has no actions to run.'
  return { executed: failed.length === 0 && (done > 0 || !!waiting), message }
}

async function executeAction(
  knex: any,
  orgId: string,
  tenantId: string,
  actionType: string,
  actionConfig: Record<string, any>,
  context: Record<string, any>
): Promise<ActionResult> {
  switch (actionType) {
    case 'send_email': {
      if (!context.contactId) return { success: false, detail: 'No contactId in context' }

      // Use ORM decryption to get real email and name
      let contactEmail: string | null = null
      let contactName = ''
      try {
        const { findOneWithDecryption } = await import('@open-mercato/shared/lib/encryption/find')
        const em = knex.client?.em || (await (await import('@open-mercato/shared/lib/di/container')).createRequestContainer()).resolve('em')
        const decrypted = await findOneWithDecryption(em, 'CustomerEntity' as any, { id: context.contactId })
        if (decrypted) {
          contactEmail = (decrypted as any).primaryEmail || (decrypted as any).primary_email || null
          contactName = (decrypted as any).displayName || (decrypted as any).display_name || ''
        }
      } catch {
        // Fallback to raw knex
        const contact = await knex('customer_entities').where('id', context.contactId).first()
        // This fallback read raw, so the ':v1' guard below then dropped the send.
        if (contact) {
          const { decryptRowFields, CONTACT_ENTITY_KEY } = await import('@open-mercato/shared/lib/encryption/decryptRows')
          const fallbackEm = knex.client?.em
            || (await (await import('@open-mercato/shared/lib/di/container')).createRequestContainer()).resolve('em')
          await decryptRowFields(fallbackEm, CONTACT_ENTITY_KEY, [contact], ['primary_email', 'display_name'], tenantId, orgId)
        }
        contactEmail = contact?.primary_email || null
        contactName = contact?.display_name || ''
      }
      // Shared envelope parser: the old ':v1' substring test missed v2 envelopes.
      if (!contactEmail || !String(contactEmail).includes('@') || isEncryptedEnvelope(contactEmail)) {
        return { success: false, detail: 'Contact has no valid email' }
      }

      const firstName = (contactName || '').split(' ')[0] || 'there'
      const rawSubject = actionConfig.subject || 'Automated notification'
      const rawBody = actionConfig.bodyHtml || actionConfig.body || '<p>Hello {{firstName}},</p>'

      const senderCtx = await buildSenderContext(knex, orgId)
      const isReviewRequest = requiresReviewUrl(rawSubject, rawBody)
      if (isReviewRequest && !senderCtx.review_url) {
        // A review request without a link is pointless — skip instead of sending
        // an email with a hole in it. The caller logs this to automation_rule_logs.
        return { success: false, detail: 'Skipped review request: no review link configured. Add your Google, Facebook or Yelp review link on the Reputation page (Settings), then this automation will send.' }
      }

      const varCtx = {
        contact: { first_name: firstName, full_name: contactName || null, email: contactEmail },
        sender: senderCtx,
        reference: (context.reference as string | undefined) || null,
      }
      const subject = substituteTemplateVars(rawSubject, varCtx)
      const bodyHtml = substituteTemplateVars(htmlifyIfPlainText(rawBody), { ...varCtx, html: true })

      const result = await sendEmailByPurpose(knex, orgId, tenantId, 'automations', {
        to: contactEmail,
        subject,
        htmlBody: bodyHtml,
        contactId: context.contactId,
        fromName: actionConfig.fromName,
      })

      // Count review-request sends for the Reputation page stats
      if (result.ok && isReviewRequest && context.contactId) {
        await recordReviewRequest(knex, {
          organizationId: orgId,
          tenantId,
          contactId: context.contactId,
          ruleId: (context.ruleId as string | undefined) || null,
        })
      }

      // Log to contact timeline
      if (result.ok && context.contactId) {
        try {
          const { logTimelineEvent } = await import('../../../lib/timeline')
          await logTimelineEvent(knex, {
            tenantId,
            organizationId: orgId,
            contactId: context.contactId,
            eventType: 'automation_email',
            title: `Automation email: ${subject}`,
            metadata: { ruleId: context.ruleId },
          })
        } catch {}
      }

      return { success: result.ok, detail: result.ok ? `Email sent via ${result.sentVia}: ${result.messageId}` : `Email failed: ${result.error}` }
    }

    case 'send_sms': {
      const { sendAutomationSms } = await import('./automation-sms')
      return sendAutomationSms(knex, { organizationId: orgId, tenantId }, {
        contactId: context.contactId || null,
        message: actionConfig.message,
        ruleId: (context.ruleId as string | undefined) || null,
        reference: (context.reference as string | undefined) || null,
      })
    }

    case 'add_tag': {
      if (!context.contactId || !actionConfig.tagName) return { success: false, detail: 'contactId and tagName required' }

      const slug = actionConfig.tagName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
      let tag = await knex('customer_tags')
        .where('organization_id', orgId)
        .where('slug', slug)
        .first()

      if (!tag) {
        const tagId = require('crypto').randomUUID()
        const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']
        await knex('customer_tags').insert({
          id: tagId, tenant_id: tenantId, organization_id: orgId,
          label: actionConfig.tagName.trim(), slug, color: colors[Math.floor(Math.random() * colors.length)],
          created_at: new Date(), updated_at: new Date(),
        })
        tag = { id: tagId, slug }
      }

      const existing = await knex('customer_tag_assignments')
        .where('entity_id', context.contactId).where('tag_id', tag.id).first()
      if (!existing) {
        await knex('customer_tag_assignments').insert({
          id: require('crypto').randomUUID(),
          tenant_id: tenantId, organization_id: orgId,
          entity_id: context.contactId, tag_id: tag.id, created_at: new Date(),
        })
      }
      return { success: true, detail: `Tag "${actionConfig.tagName}" added` }
    }

    case 'remove_tag': {
      if (!context.contactId || !actionConfig.tagName) return { success: false, detail: 'contactId and tagName required' }

      const slug = actionConfig.tagName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const tag = await knex('customer_tags')
        .where('organization_id', orgId).where('slug', slug).first()

      if (tag) {
        await knex('customer_tag_assignments')
          .where('entity_id', context.contactId).where('tag_id', tag.id).del()
      }
      return { success: true, detail: `Tag "${actionConfig.tagName}" removed` }
    }

    case 'add_to_list': {
      if (!context.contactId || !actionConfig.listId) return { success: false, detail: 'contactId and listId required' }
      try {
        await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at, tenant_id, organization_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
          [require('crypto').randomUUID(), actionConfig.listId, context.contactId, new Date(), tenantId, orgId])
        const [{ count }] = await knex('email_list_members').where('list_id', actionConfig.listId).count()
        await knex('email_lists').where('id', actionConfig.listId).update({ member_count: Number(count), updated_at: new Date() })
        return { success: true, detail: `Contact added to list` }
      } catch (err) {
        return { success: false, detail: err instanceof Error ? err.message : 'Failed to add to list' }
      }
    }

    case 'move_to_stage': {
      if (!context.contactId || !actionConfig.stage) return { success: false, detail: 'contactId and stage required' }

      const prevEntity = await knex('customer_entities').where('id', context.contactId).first()
      const prevStage = prevEntity?.lifecycle_stage || 'none'
      await knex('customer_entities')
        .where('id', context.contactId)
        .update({ lifecycle_stage: actionConfig.stage, updated_at: new Date() })

      // Log to timeline
      const { logTimelineEvent } = await import('../../../lib/timeline')
      await logTimelineEvent(knex, {
        tenantId, organizationId: orgId, contactId: context.contactId,
        eventType: 'lifecycle_change', title: `Stage changed to ${actionConfig.stage}`,
        description: `${prevStage} → ${actionConfig.stage}`,
        metadata: { from: prevStage, to: actionConfig.stage },
      })
      return { success: true, detail: `Moved to stage "${actionConfig.stage}"` }
    }

    case 'create_task': {
      const dueDays = actionConfig.dueDays ? parseInt(actionConfig.dueDays) : 3
      await knex('tasks').insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId, organization_id: orgId,
        title: actionConfig.taskTitle || `Follow up (automation: ${context.triggerType || 'unknown'})`,
        description: actionConfig.taskDescription || null,
        contact_id: context.contactId || null,
        deal_id: context.dealId || null,
        due_date: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000),
        is_done: false,
        created_at: new Date(), updated_at: new Date(),
      })
      return { success: true, detail: `Task created, due in ${dueDays} days` }
    }

    case 'enroll_in_sequence': {
      if (!context.contactId || !actionConfig.sequenceId) return { success: false, detail: 'contactId and sequenceId required' }

      const sequence = await knex('sequences')
        .where('id', actionConfig.sequenceId)
        .where('organization_id', orgId)
        .where('status', 'active')
        .whereNull('deleted_at')
        .first()
      if (!sequence) return { success: false, detail: 'Sequence not found or not active' }

      const existingEnrollment = await knex('sequence_enrollments')
        .where('sequence_id', sequence.id)
        .where('contact_id', context.contactId)
        .where('status', 'active')
        .first()
      if (existingEnrollment) return { success: true, detail: 'Already enrolled in sequence' }

      const enrollmentId = require('crypto').randomUUID()
      const now = new Date()
      try {
        await knex('sequence_enrollments').insert({
          id: enrollmentId, sequence_id: sequence.id,
          contact_id: context.contactId, organization_id: orgId, tenant_id: tenantId,
          status: 'active', current_step_order: 1, enrolled_at: now,
        })
      } catch (err) {
        // enrollments_seq_contact_idx: a concurrent run enrolled first.
        if ((err as { code?: string })?.code === '23505') return { success: true, detail: 'Already enrolled in sequence' }
        throw err
      }

      const firstStep = await knex('sequence_steps')
        .where('sequence_id', sequence.id).where('step_order', 1).first()
      if (firstStep) {
        let scheduledFor = now
        if (firstStep.step_type === 'wait') {
          const stepConfig = typeof firstStep.config === 'string' ? JSON.parse(firstStep.config) : firstStep.config
          if (stepConfig?.delay) {
            const ms = stepConfig.unit === 'days' ? stepConfig.delay * 86400000 : stepConfig.delay * 3600000
            scheduledFor = new Date(now.getTime() + ms)
          }
        }
        await knex('sequence_step_executions').insert({
          id: require('crypto').randomUUID(), enrollment_id: enrollmentId,
          step_id: firstStep.id, status: 'scheduled', scheduled_for: scheduledFor, created_at: now,
        })
      }
      return { success: true, detail: `Enrolled in sequence "${sequence.name}"` }
    }

    case 'webhook': {
      if (!actionConfig.url) return { success: false, detail: 'Webhook URL required' }

      try {
        const res = await fetch(actionConfig.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(actionConfig.headers || {}),
          },
          body: JSON.stringify({
            event: context.triggerType || 'automation_rule',
            timestamp: new Date().toISOString(),
            data: context,
          }),
        })
        return { success: res.ok, detail: `Webhook ${res.ok ? 'delivered' : 'failed'}: ${res.status}` }
      } catch (err) {
        return { success: false, detail: `Webhook error: ${err instanceof Error ? err.message : 'Unknown'}` }
      }
    }

    case 'apply_task_template': {
      if (!actionConfig.templateId) return { success: false, detail: 'templateId required in action config' }
      if (!context.contactId) return { success: false, detail: 'No contactId in context' }

      const result = await applyTaskTemplate(knex, orgId, tenantId, actionConfig.templateId, context.contactId)
      return { success: result.success, detail: result.detail }
    }

    case 'send_survey': {
      if (!context.contactId) return { success: false, detail: 'No contactId in context' }
      if (!actionConfig.surveyId) return { success: false, detail: 'surveyId required' }

      // primary_email / display_name are encrypted at rest: decrypt before
      // they become the recipient and the greeting (the survey used to be
      // addressed to the ciphertext).
      const contact = await knex('customer_entities')
        .where('id', context.contactId)
        .where('organization_id', orgId)
        .select('id', 'primary_email', 'display_name')
        .first()
      if (contact) {
        const { decryptRowFields, CONTACT_ENTITY_KEY } = await import('@open-mercato/shared/lib/encryption/decryptRows')
        const surveyEm = knex.client?.em
          || (await (await import('@open-mercato/shared/lib/di/container')).createRequestContainer()).resolve('em')
        await decryptRowFields(surveyEm, CONTACT_ENTITY_KEY, [contact], ['primary_email', 'display_name'], tenantId, orgId)
        if (isEncryptedEnvelope(contact.display_name)) contact.display_name = ''
      }
      if (!contact?.primary_email || isEncryptedEnvelope(contact.primary_email) || !String(contact.primary_email).includes('@')) {
        return { success: false, detail: 'Contact has no email' }
      }

      const survey = await knex('surveys').where('id', actionConfig.surveyId).where('organization_id', orgId).first()
      if (!survey) return { success: false, detail: 'Survey not found' }

      const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
      const surveyUrl = `${baseUrl}/api/surveys/public/${survey.slug}`
      const firstName = (contact.display_name || '').split(' ')[0] || 'there'
      const subject = (actionConfig.subject || `We'd love your feedback`).replace(/\{\{firstName\}\}/g, firstName)
      const bodyHtml = actionConfig.bodyHtml
        ? actionConfig.bodyHtml.replace(/\{\{firstName\}\}/g, firstName).replace(/\{\{surveyUrl\}\}/g, surveyUrl)
        : `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px">
            <h2 style="font-size:20px;margin:0 0 12px">Hi ${firstName},</h2>
            <p style="color:#475569;font-size:15px;line-height:1.6;margin-bottom:24px">${actionConfig.message || 'We\'d love to hear your thoughts. It only takes a minute.'}</p>
            <a href="${surveyUrl}" style="display:inline-block;background:#3b82f6;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Take the Survey</a>
            <p style="color:#94a3b8;font-size:12px;margin-top:24px">This survey is quick and your feedback helps us improve.</p>
          </div>`

      const surveyResult = await sendEmailByPurpose(knex, orgId, tenantId, 'automations', {
        to: contact.primary_email,
        subject,
        htmlBody: bodyHtml,
        contactId: context.contactId,
      })
      return { success: surveyResult.ok, detail: surveyResult.ok ? `Survey email sent to ${contact.primary_email}` : `Survey email failed: ${surveyResult.error}` }
    }

    default:
      return { success: false, detail: `Unknown action type: ${actionType}` }
  }
}

// ---------------------------------------------------------------------------
// Multi-Step Executor
// ---------------------------------------------------------------------------

async function executeSteps(
  knex: any,
  orgId: string,
  tenantId: string,
  rule: any,
  steps: Array<{ type: string; actionType?: string; actionConfig?: Record<string, any>; delayMinutes?: number }>,
  startIndex: number,
  context: Record<string, any>,
): Promise<AutomationStepRun[]> {
  const runs: AutomationStepRun[] = []
  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i]

    if (step.type === 'delay') {
      // Schedule remaining steps for later execution. They resume when the
      // box cron calls /api/sequences/automation-rules/run-scheduled (every
      // 10 minutes), which runs processScheduledSteps below. Needs the
      // automation_scheduled_steps table (Migration20260928093000_sequences).
      const delayMinutes = Number(step.delayMinutes) > 0 ? Number(step.delayMinutes) : 60
      const executeAt = new Date(Date.now() + delayMinutes * 60 * 1000)

      await knex('automation_scheduled_steps').insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId,
        organization_id: orgId,
        rule_id: rule.id,
        contact_id: context.contactId || null,
        steps: JSON.stringify(steps),
        current_step: i + 1,
        context: JSON.stringify(context),
        execute_at: executeAt,
        status: 'pending',
        created_at: new Date(),
      })

      const detail = `Wait ${delayMinutes} minutes: the remaining steps are scheduled for ${executeAt.toISOString()}`
      await writeRunLog(knex, {
        ruleId: rule.id,
        contactId: context.contactId,
        triggerData: { step: i, type: 'delay', delayMinutes },
        result: { success: true, detail },
        status: 'scheduled',
      })
      runs.push({ index: i, type: 'delay', status: 'scheduled', detail, executeAt: executeAt.toISOString() })

      return runs // Stop processing; remaining steps will be picked up by the scheduler
    }

    if (step.type === 'action') {
      const stepActionType = step.actionType || 'send_email'
      const stepActionConfig = step.actionConfig || {}
      let actionResult: ActionResult = { success: false }
      let status: AutomationStepRun['status']
      let threw = false

      try {
        actionResult = await executeAction(knex, orgId, tenantId, stepActionType, stepActionConfig, { ...context, ruleId: rule?.id || context.ruleId })
        status = actionStatus(actionResult)
      } catch (err) {
        threw = true
        status = 'failed'
        actionResult = { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
        console.error(`[automation-rules] Step ${i} action failed for rule ${rule.id}:`, err)
      }

      await writeRunLog(knex, {
        ruleId: rule.id,
        contactId: context.contactId,
        triggerData: { step: i, actionType: stepActionType, ...context },
        result: actionResult,
        status,
      })
      runs.push({ index: i, type: 'action', actionType: stepActionType, status, detail: actionResult.detail ?? actionResult.error })

      // An action that threw stops the chain (a failed send that reported
      // back is logged as failed and the chain continues, as before).
      if (threw) return runs
    }
  }
  return runs
}

// ---------------------------------------------------------------------------
// Scheduled Steps Processor
// ---------------------------------------------------------------------------

export async function processScheduledSteps(knex: any, opts: { organizationId?: string | null; tenantId?: string | null } = {}) {
  const now = new Date()
  let pendingQuery = knex('automation_scheduled_steps')
    .where('status', 'pending')
    .where('execute_at', '<=', now)
  if (opts.organizationId) pendingQuery = pendingQuery.where('organization_id', opts.organizationId)
  if (opts.tenantId) pendingQuery = pendingQuery.where('tenant_id', opts.tenantId)
  const pendingSteps = await pendingQuery
    .orderBy('execute_at', 'asc')
    .limit(50)

  let processed = 0

  for (const scheduled of pendingSteps) {
    try {
      // Mark as processing to prevent double-execution
      const updated = await knex('automation_scheduled_steps')
        .where('id', scheduled.id)
        .where('status', 'pending')
        .update({ status: 'processing' })

      if (updated === 0) continue // Already picked up by another process

      const steps = parseJson<any[]>(scheduled.steps, [])
      const context = parseJson<Record<string, any>>(scheduled.context, {})

      // The rule must still exist, in the same organization and tenant, and be on.
      const rule = scheduled.rule_id
        ? await knex('automation_rules')
          .where('id', scheduled.rule_id)
          .where('organization_id', scheduled.organization_id)
          .where('tenant_id', scheduled.tenant_id)
          .first()
        : null

      if (!rule || !rule.is_active) {
        // Rule was deleted, paused or disabled since scheduling: skip
        await knex('automation_scheduled_steps').where('id', scheduled.id).update({ status: 'skipped' })
        continue
      }

      await executeSteps(
        knex,
        scheduled.organization_id,
        scheduled.tenant_id,
        rule,
        steps,
        Number(scheduled.current_step) || 0,
        context,
      )

      await knex('automation_scheduled_steps').where('id', scheduled.id).update({ status: 'completed' })
      processed++
    } catch (err) {
      console.error(`[automation-rules] Failed to process scheduled step ${scheduled.id}:`, err)
      await knex('automation_scheduled_steps').where('id', scheduled.id).update({ status: 'failed' }).catch(() => {})
    }
  }

  return { processed, total: pendingSteps.length }
}
