import { applyTaskTemplate } from '@/modules/customers/api/task-templates/apply/route'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'

/**
 * Automation Rules Executor
 *
 * Executes matching automation rules for a given trigger type.
 * Called fire-and-forget from various routes (form submissions, tag assignments, etc.)
 */

// ---------------------------------------------------------------------------
// Condition Evaluation
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, any>, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj)
}

function evaluateConditions(
  conditions: Array<{ field: string; operator: string; value?: any }> | null,
  context: Record<string, any>
): { pass: boolean; reason?: string } {
  if (!conditions || conditions.length === 0) return { pass: true }

  for (const c of conditions) {
    const fieldValue = getNestedValue(context, c.field)
    let passes = false

    switch (c.operator) {
      case 'eq':
        passes = fieldValue === c.value
        break
      case 'neq':
        passes = fieldValue !== c.value
        break
      case 'gt':
        passes = Number(fieldValue) > Number(c.value)
        break
      case 'gte':
        passes = Number(fieldValue) >= Number(c.value)
        break
      case 'lt':
        passes = Number(fieldValue) < Number(c.value)
        break
      case 'lte':
        passes = Number(fieldValue) <= Number(c.value)
        break
      case 'contains':
        passes = String(fieldValue || '').toLowerCase().includes(String(c.value || '').toLowerCase())
        break
      case 'exists':
        passes = fieldValue !== undefined && fieldValue !== null && fieldValue !== ''
        break
      case 'notExists':
        passes = fieldValue === undefined || fieldValue === null || fieldValue === ''
        break
      default:
        passes = true
    }

    if (!passes) {
      return { pass: false, reason: `${c.field} ${c.operator} ${c.value} failed (got: ${fieldValue})` }
    }
  }

  return { pass: true }
}

// ---------------------------------------------------------------------------
// Main Executor
// ---------------------------------------------------------------------------

export async function executeAutomationRules(
  knex: any,
  orgId: string,
  tenantId: string,
  triggerType: string,
  context: { contactId?: string; tagSlug?: string; tagName?: string; formId?: string; dealId?: string; [key: string]: any }
) {
  try {
    const rules = await knex('automation_rules')
      .where('organization_id', orgId)
      .where('trigger_type', triggerType)
      .where('is_active', true)

    for (const rule of rules) {
      const triggerConfig = typeof rule.trigger_config === 'string'
        ? JSON.parse(rule.trigger_config)
        : (rule.trigger_config || {})
      const actionConfig = typeof rule.action_config === 'string'
        ? JSON.parse(rule.action_config)
        : (rule.action_config || {})

      // Check if trigger_config matches the context
      if (!matchesTriggerConfig(triggerType, triggerConfig, context)) continue

      // Evaluate rule conditions
      const conditions = typeof rule.conditions === 'string'
        ? JSON.parse(rule.conditions)
        : rule.conditions
      const conditionResult = evaluateConditions(conditions, context)
      if (!conditionResult.pass) {
        await knex('automation_rule_logs').insert({
          id: require('crypto').randomUUID(),
          rule_id: rule.id,
          contact_id: context.contactId || null,
          trigger_data: JSON.stringify({ triggerType, ...context }),
          action_result: JSON.stringify({ skipped: true, reason: conditionResult.reason }),
          status: 'skipped',
          created_at: new Date(),
        }).catch((logErr: any) => {
          console.error('[automation-rules] Failed to log skipped execution:', logErr)
        })
        continue
      }

      // Check if rule has multi-step automation
      const steps = typeof rule.steps === 'string' ? JSON.parse(rule.steps) : rule.steps

      if (Array.isArray(steps) && steps.length > 0) {
        // Multi-step execution
        await executeSteps(knex, orgId, tenantId, rule, steps, 0, context)
      } else {
        // Legacy single-action execution
        let actionResult: any = { success: false }
        let status = 'executed'

        try {
          actionResult = await executeAction(knex, orgId, tenantId, rule.action_type, actionConfig, context)
        } catch (err) {
          status = 'failed'
          actionResult = { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
          console.error(`[automation-rules] Action failed for rule ${rule.id}:`, err)
        }

        // Log execution
        await knex('automation_rule_logs').insert({
          id: require('crypto').randomUUID(),
          rule_id: rule.id,
          contact_id: context.contactId || null,
          trigger_data: JSON.stringify({ triggerType, ...context }),
          action_result: JSON.stringify(actionResult),
          status,
          created_at: new Date(),
        }).catch((logErr: any) => {
          console.error('[automation-rules] Failed to log execution:', logErr)
        })
      }
    }
  } catch (err) {
    console.error('[automation-rules] Error executing rules:', err)
  }
}

function matchesTriggerConfig(
  triggerType: string,
  triggerConfig: Record<string, any>,
  context: Record<string, any>
): boolean {
  // If no trigger_config constraints, match all events of this type
  if (!triggerConfig || Object.keys(triggerConfig).length === 0) return true

  switch (triggerType) {
    case 'tag_added':
    case 'tag_removed':
      if (triggerConfig.tagSlug && triggerConfig.tagSlug !== context.tagSlug) return false
      if (triggerConfig.tagName && triggerConfig.tagName !== context.tagName) return false
      return true

    case 'form_submitted':
      if (triggerConfig.formId && triggerConfig.formId !== context.formId) return false
      if (triggerConfig.landingPageSlug && triggerConfig.landingPageSlug !== context.landingPageSlug) return false
      return true

    case 'deal_won':
    case 'deal_lost':
      if (triggerConfig.pipelineId && triggerConfig.pipelineId !== context.pipelineId) return false
      return true

    case 'contact_created':
      if (triggerConfig.source && triggerConfig.source !== context.source) return false
      return true

    case 'stage_change':
      if (triggerConfig.fromStage && triggerConfig.fromStage !== context.fromStage) return false
      if (triggerConfig.toStage && triggerConfig.toStage !== context.toStage) return false
      return true

    case 'invoice_paid':
    case 'booking_created':
    case 'course_enrolled':
      return true

    default:
      return true
  }
}

async function executeAction(
  knex: any,
  orgId: string,
  tenantId: string,
  actionType: string,
  actionConfig: Record<string, any>,
  context: Record<string, any>
): Promise<{ success: boolean; detail?: string }> {
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
        contactEmail = contact?.primary_email || null
        contactName = contact?.display_name || ''
      }
      if (!contactEmail || contactEmail.includes(':v1')) return { success: false, detail: 'Contact has no valid email' }

      const firstName = (contactName || '').split(' ')[0] || 'there'
      const subject = (actionConfig.subject || 'Automated notification').replace(/\{\{firstName\}\}/g, firstName)
      const bodyHtml = (actionConfig.bodyHtml || actionConfig.body || '<p>Hello {{firstName}},</p>')
        .replace(/\{\{firstName\}\}/g, firstName)

      const result = await sendEmailByPurpose(knex, orgId, tenantId, 'automations', {
        to: contactEmail,
        subject,
        htmlBody: bodyHtml,
        contactId: context.contactId,
        fromName: actionConfig.fromName,
      })

      // Log to contact timeline
      if (result.ok && context.contactId) {
        try {
          const { logTimelineEvent } = await import('@/lib/timeline')
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
      console.log(`[automation-rules] SMS action triggered for contact ${context.contactId}: ${actionConfig.message || 'No message'}`)
      return { success: true, detail: 'SMS logged (provider not configured)' }
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
        await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
          [require('crypto').randomUUID(), actionConfig.listId, context.contactId, new Date()])
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
      const { logTimelineEvent } = await import('@/lib/timeline')
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
      await knex('sequence_enrollments').insert({
        id: enrollmentId, sequence_id: sequence.id,
        contact_id: context.contactId, organization_id: orgId, tenant_id: tenantId,
        status: 'active', current_step_order: 1, enrolled_at: now,
      })

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

      const contact = await knex('customer_entities').where('id', context.contactId).first()
      if (!contact?.primary_email) return { success: false, detail: 'Contact has no email' }

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
) {
  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i]

    if (step.type === 'delay') {
      // Schedule remaining steps for later execution
      const delayMinutes = step.delayMinutes || 60
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

      // Log the delay scheduling
      await knex('automation_rule_logs').insert({
        id: require('crypto').randomUUID(),
        rule_id: rule.id,
        contact_id: context.contactId || null,
        trigger_data: JSON.stringify({ step: i, type: 'delay', delayMinutes }),
        action_result: JSON.stringify({ success: true, detail: `Delay ${delayMinutes} minutes — remaining steps scheduled for ${executeAt.toISOString()}` }),
        status: 'scheduled',
        created_at: new Date(),
      }).catch(() => {})

      return // Stop processing; remaining steps will be picked up by the scheduler
    }

    if (step.type === 'action') {
      const stepActionType = step.actionType || 'send_email'
      const stepActionConfig = step.actionConfig || {}
      let actionResult: any = { success: false }
      let status = 'executed'

      try {
        actionResult = await executeAction(knex, orgId, tenantId, stepActionType, stepActionConfig, context)
      } catch (err) {
        status = 'failed'
        actionResult = { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
        console.error(`[automation-rules] Step ${i} action failed for rule ${rule.id}:`, err)
      }

      await knex('automation_rule_logs').insert({
        id: require('crypto').randomUUID(),
        rule_id: rule.id,
        contact_id: context.contactId || null,
        trigger_data: JSON.stringify({ step: i, actionType: stepActionType, ...context }),
        action_result: JSON.stringify(actionResult),
        status,
        created_at: new Date(),
      }).catch(() => {})

      // If action failed, stop the chain
      if (status === 'failed') return
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduled Steps Processor
// ---------------------------------------------------------------------------

export async function processScheduledSteps(knex: any) {
  const now = new Date()
  const pendingSteps = await knex('automation_scheduled_steps')
    .where('status', 'pending')
    .where('execute_at', '<=', now)
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

      const steps = typeof scheduled.steps === 'string' ? JSON.parse(scheduled.steps) : scheduled.steps
      const context = typeof scheduled.context === 'string' ? JSON.parse(scheduled.context) : scheduled.context

      // Look up the rule to ensure it is still active
      const rule = scheduled.rule_id
        ? await knex('automation_rules').where('id', scheduled.rule_id).first()
        : null

      if (rule && !rule.is_active) {
        // Rule was paused/disabled since scheduling — skip
        await knex('automation_scheduled_steps').where('id', scheduled.id).update({ status: 'skipped' })
        continue
      }

      await executeSteps(
        knex,
        scheduled.organization_id,
        scheduled.tenant_id,
        rule || { id: scheduled.rule_id },
        steps,
        scheduled.current_step,
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
