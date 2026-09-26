import { matchesSequenceTrigger } from '../lib/automation-trigger-match'

/**
 * Check for active sequences matching a trigger event and auto-enroll the contact.
 * Called from form submission, tag assignment, deal stage change, etc.
 *
 * Relative imports only: the dispatch subscribers bundle this into the queue workers.
 */
export async function checkSequenceTriggers(
  knex: any,
  orgId: string,
  tenantId: string,
  triggerType: string,
  context: {
    contactId: string
    tagId?: string
    tagSlug?: string
    tagName?: string
    stage?: string
    formId?: string
    bookingPageId?: string | null
    source?: string | null
    courseId?: string | null
    eventId?: string | null
    productId?: string | null
  }
) {
  try {
    const sequences = await knex('sequences')
      .where('organization_id', orgId)
      .where('tenant_id', tenantId)
      .where('trigger_type', triggerType)
      .where('status', 'active')
      .whereNull('deleted_at')

    for (const sequence of sequences) {
      const config = sequence.trigger_config
        ? (typeof sequence.trigger_config === 'string' ? JSON.parse(sequence.trigger_config) : sequence.trigger_config)
        : {}

      // Check trigger config matches (a picked tag is saved by id, recipes save its slug)
      if (!matchesSequenceTrigger(triggerType, config, context)) continue

      // Check not already enrolled
      const existing = await knex('sequence_enrollments')
        .where('sequence_id', sequence.id)
        .where('contact_id', context.contactId)
        .where('status', 'active')
        .first()
      if (existing) continue

      // Enroll
      const enrollmentId = require('crypto').randomUUID()
      const now = new Date()

      await knex('sequence_enrollments').insert({
        id: enrollmentId,
        sequence_id: sequence.id,
        contact_id: context.contactId,
        organization_id: orgId,
        tenant_id: tenantId,
        status: 'active',
        current_step_order: 1,
        enrolled_at: now,
      })

      // Schedule first step
      const firstStep = await knex('sequence_steps')
        .where('sequence_id', sequence.id)
        .where('step_order', 1)
        .first()

      if (firstStep) {
        let scheduledFor = now
        if (firstStep.step_type === 'wait') {
          const stepConfig = typeof firstStep.config === 'string' ? JSON.parse(firstStep.config) : firstStep.config
          if (stepConfig?.delay) {
            scheduledFor = new Date(now.getTime())
            const ms = stepConfig.unit === 'days'
              ? stepConfig.delay * 24 * 60 * 60 * 1000
              : stepConfig.delay * 60 * 60 * 1000
            scheduledFor.setTime(scheduledFor.getTime() + ms)
          }
        }

        await knex('sequence_step_executions').insert({
          id: require('crypto').randomUUID(),
          enrollment_id: enrollmentId,
          step_id: firstStep.id,
          status: 'scheduled',
          scheduled_for: scheduledFor,
          created_at: now,
        })
      }

      console.log(`[sequences.trigger] Auto-enrolled contact ${context.contactId} in sequence "${sequence.name}" (${sequence.id})`)
    }
  } catch (err) {
    console.error('[sequences.trigger] Error checking triggers:', err)
  }
}
