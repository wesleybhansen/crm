import { applyTaskTemplate } from '../task-templates/apply/route'

/**
 * Automation Rules Executor
 *
 * Executes matching automation rules for a given trigger type.
 * Called fire-and-forget from various routes (form submissions, tag assignments, etc.)
 */
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

      const contact = await knex('customer_entities').where('id', context.contactId).first()
      if (!contact?.primary_email) return { success: false, detail: 'Contact has no email' }

      const firstName = (contact.display_name || '').split(' ')[0] || 'there'
      const subject = (actionConfig.subject || 'Automated notification').replace(/\{\{firstName\}\}/g, firstName)
      const bodyHtml = (actionConfig.bodyHtml || actionConfig.body || '<p>Hello {{firstName}},</p>')
        .replace(/\{\{firstName\}\}/g, firstName)

      // Try Resend if configured
      if (process.env.RESEND_API_KEY && actionConfig.fromEmail) {
        try {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: actionConfig.fromEmail,
              to: [contact.primary_email],
              subject,
              html: bodyHtml,
            }),
          })
          const result = await res.json()
          return { success: res.ok, detail: res.ok ? `Email sent via Resend: ${result.id}` : `Resend error: ${JSON.stringify(result)}` }
        } catch (err) {
          console.error('[automation-rules] Resend send failed, falling back to queue:', err)
        }
      }

      // Fallback: queue in email_messages table
      await knex('email_messages').insert({
        id: require('crypto').randomUUID(),
        tenant_id: tenantId,
        organization_id: orgId,
        direction: 'outbound',
        from_address: actionConfig.fromEmail || process.env.EMAIL_FROM || 'noreply@localhost',
        to_address: contact.primary_email,
        subject,
        body_html: bodyHtml,
        contact_id: context.contactId,
        status: 'queued',
        tracking_id: require('crypto').randomUUID(),
        created_at: new Date(),
      })
      return { success: true, detail: `Email queued to ${contact.primary_email}` }
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
        .whereNull('deleted_at')
        .first()

      if (!tag) {
        const tagId = require('crypto').randomUUID()
        const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316']
        await knex('customer_tags').insert({
          id: tagId, tenant_id: tenantId, organization_id: orgId,
          name: actionConfig.tagName.trim(), slug, color: colors[Math.floor(Math.random() * colors.length)],
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
        .where('organization_id', orgId).where('slug', slug).whereNull('deleted_at').first()

      if (tag) {
        await knex('customer_tag_assignments')
          .where('entity_id', context.contactId).where('tag_id', tag.id).del()
      }
      return { success: true, detail: `Tag "${actionConfig.tagName}" removed` }
    }

    case 'move_to_stage': {
      if (!context.contactId || !actionConfig.stage) return { success: false, detail: 'contactId and stage required' }

      await knex('customer_entities')
        .where('id', context.contactId)
        .update({ lifecycle_stage: actionConfig.stage, updated_at: new Date() })
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

    default:
      return { success: false, detail: `Unknown action type: ${actionType}` }
  }
}
